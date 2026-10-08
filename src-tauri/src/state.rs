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
    /// Last `helm list` per (context, namespace), keyed by a fingerprint of the release secrets.
    helm_lists: Mutex<HashMap<(String, String), (u64, serde_json::Value)>>,
    /// Live overview watches per (context, namespace).
    overviews: Mutex<HashMap<(String, String), Arc<crate::overview::OverviewWatch>>>,
    /// Node-shell pods created this run as (context, pod), deleted on exit in case their tab didn't.
    node_shells: Mutex<Vec<(String, String)>>,
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
        // Hashed so that context names differing only in punctuation can't share a file.
        use sha2::{Digest, Sha256};
        let path = dir.join(format!("{}.yaml", hex::encode(&Sha256::digest(context.as_bytes())[..16])));
        // Helm polls through here every few seconds; only write when the kubeconfig actually changed.
        if std::fs::read(&path).ok().as_deref() != Some(yaml.as_bytes()) {
            crate::settings::write_private(&path, yaml.as_bytes()).map_err(err)?;
        }
        Ok(path)
    }

    pub fn cluster_settings(&self, context: &str) -> crate::settings::ClusterSettings {
        self.settings.lock().unwrap().clusters.get(context).cloned().unwrap_or_default()
    }

    pub fn prometheus(&self, context: &str) -> Option<Option<crate::metrics::PrometheusTarget>> {
        self.prometheus.lock().unwrap().get(context).cloned()
    }

    pub fn set_prometheus(&self, context: &str, t: Option<crate::metrics::PrometheusTarget>) {
        self.prometheus.lock().unwrap().insert(context.to_string(), t);
    }

    pub fn helm_list_cached(&self, context: &str, namespace: &str, fingerprint: u64) -> Option<serde_json::Value> {
        let lists = self.helm_lists.lock().unwrap();
        lists
            .get(&(context.to_string(), namespace.to_string()))
            .filter(|(fp, _)| *fp == fingerprint)
            .map(|(_, v)| v.clone())
    }

    pub fn store_helm_list(&self, context: &str, namespace: &str, fingerprint: u64, list: serde_json::Value) {
        self.helm_lists.lock().unwrap().insert((context.to_string(), namespace.to_string()), (fingerprint, list));
    }

    pub fn overview(&self, key: &(String, String)) -> Option<Arc<crate::overview::OverviewWatch>> {
        self.overviews.lock().unwrap().get(key).cloned()
    }

    /// The overview for `key`, starting one with `start` if needed. True when it was just started.
    pub fn overview_or_insert(
        &self,
        key: &(String, String),
        start: impl FnOnce() -> crate::overview::OverviewWatch,
    ) -> (Arc<crate::overview::OverviewWatch>, bool) {
        let mut overviews = self.overviews.lock().unwrap();
        if let Some(w) = overviews.get(key) {
            return (w.clone(), false);
        }
        let w = Arc::new(start());
        overviews.insert(key.clone(), w.clone());
        (w, true)
    }

    pub fn remove_overview(&self, key: &(String, String), watch: &Arc<crate::overview::OverviewWatch>) {
        let mut overviews = self.overviews.lock().unwrap();
        if overviews.get(key).is_some_and(|w| Arc::ptr_eq(w, watch)) {
            overviews.remove(key);
        }
    }

    /// Drop cached client + discovery so the next call re-reads the kubeconfig.
    pub async fn reset(&self, context: &str) {
        self.overviews.lock().unwrap().retain(|(c, _), w| {
            if c == context {
                w.stop();
            }
            c != context
        });
        self.prometheus.lock().unwrap().remove(context);
        self.helm_lists.lock().unwrap().retain(|(c, _), _| c != context);
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

    pub fn track_node_shell(&self, context: &str, pod: &str) {
        self.node_shells.lock().unwrap().push((context.to_string(), pod.to_string()));
    }

    /// Best-effort delete of every node-shell pod from this run (already-deleted ones just 404).
    pub async fn delete_node_shells(&self) {
        let pods = std::mem::take(&mut *self.node_shells.lock().unwrap());
        let deletes = pods.into_iter().map(|(context, pod)| async move {
            if let Ok(client) = self.client(&context).await {
                let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client, crate::nodeops::NODE_SHELL_NAMESPACE);
                let _ = api.delete(&pod, &Default::default()).await;
            }
        });
        futures::future::join_all(deletes).await;
    }
}

