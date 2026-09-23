//! Persistent app settings (settings.json in the app config dir), kubeconfigs
//! pasted into Kube Portal, and a file watcher that notifies the UI when any
//! kubeconfig source changes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use kube::config::Kubeconfig;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{err, AppState, Result};

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClusterSettings {
    pub display_name: Option<String>,
    /// CSS colour for the cluster's dot / avatar.
    pub color: Option<String>,
    pub default_namespace: Option<String>,
    /// For users who can't list namespaces: shown instead of listing, and "all namespaces" spans these.
    pub accessible_namespaces: Vec<String>,
    /// http(s):// or socks5:// proxy for API server traffic.
    pub proxy_url: Option<String>,
    /// Shown in the hotbar.
    pub pinned: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Older versions wrote snake_case.
    #[serde(alias = "kubeconfig_folders")]
    pub kubeconfig_folders: Vec<PathBuf>,
    pub clusters: BTreeMap<String, ClusterSettings>,
    /// "system" | "dark" | "light"
    pub theme: String,
    pub helm_path: Option<String>,
    pub kubectl_path: Option<String>,
    /// Download kubectl matching each cluster's version for cluster terminals.
    pub kubectl_auto: bool,
    pub terminal_shell: Option<String>,
    pub terminal_font_size: u16,
    /// Updater feed (a latest.json URL) and the matching minisign public key.
    pub update_endpoint: Option<String>,
    pub update_pubkey: Option<String>,
    /// Extension ids (folder names) turned off in Settings.
    pub disabled_extensions: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            kubeconfig_folders: vec![],
            clusters: BTreeMap::new(),
            theme: "system".into(),
            helm_path: None,
            kubectl_path: None,
            kubectl_auto: true,
            terminal_shell: None,
            terminal_font_size: 13,
            update_endpoint: None,
            update_pubkey: None,
            disabled_extensions: vec![],
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

/// Folder holding kubeconfigs added through "Add cluster"; always scanned.
pub fn managed_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("kubeconfigs"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<()> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(s).map_err(err)?).map_err(err)
}

pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(data)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<Settings> {
    let previous = state.settings.lock().unwrap().clone();
    save(&app, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    // Proxy changes need a fresh client.
    for (id, c) in &settings.clusters {
        if previous.clusters.get(id).map(|p| &p.proxy_url) != Some(&c.proxy_url) {
            state.reset(id).await;
        }
    }
    if previous.kubeconfig_folders != settings.kubeconfig_folders {
        state.rescan().await;
        restart_watcher(&app);
    }
    Ok(settings)
}

/// Save a pasted kubeconfig into Kube Portal's own folder and return the contexts it added.
#[tauri::command]
pub async fn add_kubeconfig(app: AppHandle, state: State<'_, AppState>, name: String, yaml: String) -> Result<Vec<String>> {
    let kc = Kubeconfig::from_yaml(&yaml).map_err(|e| format!("not a valid kubeconfig: {e}"))?;
    if kc.contexts.is_empty() {
        return Err("the kubeconfig has no contexts".into());
    }
    let safe: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let safe = if safe.trim_matches('-').is_empty() { "cluster".to_string() } else { safe };
    let dir = managed_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut path = dir.join(format!("{safe}.yaml"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{safe}-{n}.yaml"));
        n += 1;
    }
    write_private(&path, yaml.as_bytes()).map_err(err)?;
    let (entries, _, _) = state.rescan().await;
    Ok(entries.into_iter().filter(|e| e.file.as_deref() == Some(&path)).map(|e| e.id).collect())
}

/// Delete a kubeconfig that was added through Kube Portal (only files in the managed folder).
#[tauri::command]
pub async fn remove_added_kubeconfig(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<()> {
    let dir = managed_dir(&app)?.canonicalize().map_err(err)?;
    let file = PathBuf::from(&path).canonicalize().map_err(err)?;
    if file.parent() != Some(dir.as_path()) {
        return Err("only kubeconfigs added in Kube Portal can be removed here".into());
    }
    std::fs::remove_file(&file).map_err(err)?;
    state.rescan().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

pub struct KubeconfigWatcher(pub Mutex<Option<RecommendedWatcher>>);

/// (Re)watch every kubeconfig source; emits "kubeconfigs-changed" (debounced) on changes.
pub fn restart_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut dirs: Vec<PathBuf> = state.settings.lock().unwrap().kubeconfig_folders.clone();
    if let Ok(m) = managed_dir(app) {
        let _ = std::fs::create_dir_all(&m);
        dirs.push(m);
    }
    // The default kubeconfig's directories ($KUBECONFIG entries or ~/.kube).
    for p in crate::kubeconfigs::default_source_files() {
        if let Some(parent) = p.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs.sort();
    dirs.dedup();

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if !matches!(ev.kind, notify::EventKind::Access(_)) {
                let _ = tx.send(());
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };
    for d in &dirs {
        let _ = watcher.watch(d, RecursiveMode::NonRecursive);
    }
    // Debounce bursts (editors write several events per save).
    let handle = app.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                h.state::<AppState>().rescan().await;
                let _ = h.emit("kubeconfigs-changed", ());
            });
        }
    });
    *app.state::<KubeconfigWatcher>().0.lock().unwrap() = Some(watcher);
}
