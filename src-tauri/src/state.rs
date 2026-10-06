use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kube::config::KubeConfigOptions;
use kube::{Client, Config};
use tokio::sync::{mpsc, Mutex as AsyncMutex, OnceCell};
use tokio_util::sync::CancellationToken;

use crate::kube_ops::ResourceInfo;
use crate::kubeconfigs::{self, ContextEntry, FolderInfo};

/// Input sent to an interactive session (pod exec or local pty).
pub enum SessionInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

#[derive(Default)]
pub struct AppState {
    clients: AsyncMutex<HashMap<String, Arc<OnceCell<Client>>>>,
    discovery: AsyncMutex<HashMap<String, Arc<Vec<ResourceInfo>>>>,
    streams: Mutex<HashMap<String, CancellationToken>>,
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<SessionInput>>>,
    /// Persisted settings (folders, per-cluster options, …).
    pub settings: Mutex<crate::settings::Settings>,
    /// Kube Portal's own folder of pasted kubeconfigs.
    pub managed_dir: Mutex<Option<PathBuf>>,
    /// Context id -> where it comes from; rebuilt on every rescan.
    registry: AsyncMutex<HashMap<String, ContextEntry>>,
    /// Detected Prometheus per context (None inside = looked, not found).
    prometheus: Mutex<HashMap<String, Option<crate::metrics::PrometheusTarget>>>,
}

pub type Result<T> = std::result::Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Human-readable kube errors: surface the API server's message instead of the Debug dump.
pub fn kerr(e: kube::Error) -> String {
    match e {
        kube::Error::Api(s) if !s.message.is_empty() => {
            if s.reason.is_empty() {
                s.message
            } else {
                format!("{} ({} {})", s.message, s.code, s.reason)
            }
        }
        e => {
            // Walk the source chain so connection errors say *why* ("no route to host").
            let mut msg = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                let part = s.to_string();
                if !msg.contains(&part) {
                    msg.push_str(": ");
                    msg.push_str(&part);
                }
                src = s.source();
            }
            msg
        }
    }
}

impl AppState {
    /// Re-read every kubeconfig source. Clients whose context moved or changed are dropped.
    pub async fn rescan(&self) -> (Vec<ContextEntry>, Vec<FolderInfo>, Option<String>) {
        let folders = self.settings.lock().unwrap().kubeconfig_folders.clone();
        let managed = self.managed_dir.lock().unwrap().clone();
        let (entries, infos, default_error) =
            tokio::task::spawn_blocking(move || kubeconfigs::scan(&folders, managed.as_deref()))
                .await
                .unwrap_or_default();
        let next = kubeconfigs::index(&entries);
        let mut registry = self.registry.lock().await;
        let stale: Vec<String> = registry
            .iter()
            .filter(|(id, e)| next.get(*id) != Some(*e))
            .map(|(id, _)| id.clone())
            .collect();
        *registry = next;
        drop(registry);
        for id in stale {
            self.reset(&id).await;
        }
        (entries, infos, default_error)
    }

    /// One client per context. Concurrent first calls share a single build (one exec-auth run, e.g. `aws eks get-token`).
    pub async fn client(&self, context: &str) -> Result<Client> {
        let cell = self.clients.lock().await.entry(context.to_string()).or_default().clone();
        // Errors aren't cached: the next call retries.
        cell.get_or_try_init(|| self.build_client(context)).await.cloned()
    }

    async fn build_client(&self, context: &str) -> Result<Client> {
        let mut entry = self.registry.lock().await.get(context).cloned();
        if entry.is_none() {
            self.rescan().await;
            entry = self.registry.lock().await.get(context).cloned();
        }
        let entry = entry.ok_or_else(|| format!("context \"{context}\" not found in any kubeconfig"))?;
        let kubeconfig = kubeconfigs::load(&entry)?;
        let opts = KubeConfigOptions {
            context: Some(entry.name.clone()),
            ..Default::default()
        };
        let mut config = Config::from_custom_kubeconfig(kubeconfig, &opts)
            .await
            .map_err(err)?;
        let proxy = self.cluster_settings(context).proxy_url.filter(|p| !p.trim().is_empty());
        if let Some(p) = proxy {
            config.proxy_url = Some(p.trim().parse().map_err(|e| format!("invalid proxy URL {p}: {e}"))?);
        }
        // Client::try_from runs exec auth plugins synchronously; keep them off the async workers.
        tokio::task::spawn_blocking(move || Client::try_from(config))
            .await
            .map_err(err)?
            .map_err(err)
    }

    /// Write a kubeconfig whose current-context is `context` (for local terminals) and return its path.
    /// Credentials are copied as-is, so the file is created with owner-only permissions.
    pub async fn scoped_kubeconfig(&self, app: &tauri::AppHandle, context: &str) -> Result<PathBuf> {
        use tauri::Manager;
        let mut entry = self.registry.lock().await.get(context).cloned();
        if entry.is_none() {
            self.rescan().await;
            entry = self.registry.lock().await.get(context).cloned();
        }
        let entry = entry.ok_or_else(|| format!("context \"{context}\" not found"))?;
        let mut kc = kubeconfigs::load(&entry)?;
        kc.current_context = Some(entry.name.clone());
        let yaml = serde_yaml::to_string(&kc).map_err(err)?;
        let dir = app.path().app_cache_dir().map_err(err)?.join("kubeconfigs");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let safe: String = context
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = dir.join(format!("{safe}.yaml"));
        crate::settings::write_private(&path, yaml.as_bytes()).map_err(err)?;
        Ok(path)
    }

    /// Drop cached client + discovery so the next call re-reads the kubeconfig.
    pub fn cluster_settings(&self, context: &str) -> crate::settings::ClusterSettings {
        self.settings.lock().unwrap().clusters.get(context).cloned().unwrap_or_default()
    }

    pub fn prometheus(&self, context: &str) -> Option<Option<crate::metrics::PrometheusTarget>> {
        self.prometheus.lock().unwrap().get(context).cloned()
    }

    pub fn set_prometheus(&self, context: &str, t: Option<crate::metrics::PrometheusTarget>) {
        self.prometheus.lock().unwrap().insert(context.to_string(), t);
    }

    pub async fn reset(&self, context: &str) {
        self.prometheus.lock().unwrap().remove(context);
        self.clients.lock().await.remove(context);
        self.discovery.lock().await.remove(context);
    }

    pub async fn cached_discovery(&self, context: &str) -> Option<Arc<Vec<ResourceInfo>>> {
        self.discovery.lock().await.get(context).cloned()
    }

    pub async fn store_discovery(&self, context: &str, res: Arc<Vec<ResourceInfo>>) {
        self.discovery.lock().await.insert(context.to_string(), res);
    }

    pub fn register_stream(&self) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.streams
            .lock()
            .unwrap()
            .insert(id.clone(), token.clone());
        (id, token)
    }

    pub fn stop_stream(&self, id: &str) {
        if let Some(t) = self.streams.lock().unwrap().remove(id) {
            t.cancel();
        }
    }

    pub fn register_session(&self, id: &str, tx: mpsc::UnboundedSender<SessionInput>) {
        self.sessions.lock().unwrap().insert(id.to_string(), tx);
    }

    pub fn session_send(&self, id: &str, input: SessionInput) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let tx = sessions.get(id).ok_or("session not found")?;
        tx.send(input).map_err(|_| "session closed".to_string())
    }

    pub fn remove_session(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }
}

