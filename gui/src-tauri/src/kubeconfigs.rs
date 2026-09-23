//! Kubeconfig sources: the default kubeconfig ($KUBECONFIG or ~/.kube/config)
//! plus any number of user-added folders, each file of which is a kubeconfig.
//!
//! Every context gets a unique id. Contexts keep their own name as the id unless
//! another source already uses it, in which case the file name is appended.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use kube::config::Kubeconfig;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::state::{err, AppState, Result};

/// Skip anything bigger than this; kubeconfigs are small and folders may hold other files.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ContextEntry {
    pub id: String,
    /// Context name inside its kubeconfig.
    pub name: String,
    /// `None` = the default kubeconfig (may merge several $KUBECONFIG paths).
    pub file: Option<PathBuf>,
    cluster: String,
    user: Option<String>,
    namespace: Option<String>,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    /// Unique id used everywhere else in the app.
    name: String,
    context_name: String,
    source: Option<String>,
    cluster: String,
    user: Option<String>,
    namespace: Option<String>,
    current: bool,
}

impl From<&ContextEntry> for ContextInfo {
    fn from(e: &ContextEntry) -> Self {
        ContextInfo {
            name: e.id.clone(),
            context_name: e.name.clone(),
            source: e.file.as_ref().map(|p| p.display().to_string()),
            cluster: e.cluster.clone(),
            user: e.user.clone(),
            namespace: e.namespace.clone(),
            current: e.current,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    path: String,
    files: usize,
    contexts: usize,
    errors: Vec<String>,
    /// Kube Portal's own folder of pasted kubeconfigs.
    managed: bool,
}

/// Files that make up the default kubeconfig ($KUBECONFIG entries or ~/.kube/config).
pub fn default_source_files() -> Vec<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    match std::env::var("KUBECONFIG") {
        Ok(v) if !v.is_empty() => v.split(sep).filter(|s| !s.is_empty()).map(PathBuf::from).collect(),
        _ => dirs::home_dir().map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default(),
    }
}

/// Canonical default kubeconfig paths, so folder scans don't list them twice.
fn default_paths() -> HashSet<PathBuf> {
    default_source_files().into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

fn candidate_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| {
            // Follow symlinks; keep regular, reasonably small files.
            std::fs::metadata(e.path())
                .map(|m| m.is_file() && m.len() <= MAX_FILE_BYTES)
                .unwrap_or(false)
        })
        // Any file name is fine (".cfg", ".kubeconfig", none…); content decides.
        .map(|e| e.path())
        .collect();
    files.sort();
    Ok(files)
}

/// Cheap pre-check before handing a file to kube-client.
///
/// Besides skipping obvious non-kubeconfigs quickly, this guards against a panic in
/// `Kubeconfig::read_from` (kube-client 4.2 indexes out of bounds on UTF-16 files with
/// an odd byte count), which would abort the app since release builds use panic=abort.
fn looks_like_kubeconfig(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let text = match bytes.as_slice() {
        [0xFF, 0xFE, rest @ ..] | [0xFE, 0xFF, rest @ ..] => {
            if rest.len() % 2 != 0 {
                return false;
            }
            let le = bytes[0] == 0xFF;
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                .collect();
            match String::from_utf16(&units) {
                Ok(t) => t,
                Err(_) => return false,
            }
        }
        _ => match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => return false,
        },
    };
    text.contains("contexts")
}

fn entries_from(kc: &Kubeconfig, file: Option<&Path>) -> Vec<ContextEntry> {
    kc.contexts
        .iter()
        .map(|c| {
            let ctx = c.context.clone().unwrap_or_default();
            ContextEntry {
                id: c.name.clone(),
                name: c.name.clone(),
                file: file.map(Path::to_path_buf),
                cluster: ctx.cluster,
                user: ctx.user,
                namespace: ctx.namespace,
                // Only the default kubeconfig's current-context is meaningful.
                current: file.is_none() && kc.current_context.as_deref() == Some(c.name.as_str()),
            }
        })
        .collect()
}

/// Scan all sources. Never fails outright: problems are reported per folder.
pub fn scan(folders: &[PathBuf], managed: Option<&Path>) -> (Vec<ContextEntry>, Vec<FolderInfo>, Option<String>) {
    let mut entries = Vec::new();
    let mut default_error = None;
    match Kubeconfig::read() {
        Ok(kc) => entries.extend(entries_from(&kc, None)),
        Err(e) => {
            // A missing default kubeconfig is fine when folders supply contexts.
            let missing = default_paths().is_empty();
            if !missing {
                default_error = Some(e.to_string());
            }
        }
    }

    let skip = default_paths();
    let mut seen_files = HashSet::new();
    let mut infos = Vec::new();
    let all: Vec<(PathBuf, bool)> = managed
        .map(|m| (m.to_path_buf(), true))
        .into_iter()
        .chain(folders.iter().map(|f| (f.clone(), false)))
        .collect();
    for (folder, is_managed) in &all {
        let mut info = FolderInfo {
            path: folder.display().to_string(),
            files: 0,
            contexts: 0,
            errors: vec![],
            managed: *is_managed,
        };
        match candidate_files(folder) {
            // The managed folder may simply not exist yet.
            Err(_) if *is_managed => {}
            Err(e) => info.errors.push(e.to_string()),
            Ok(files) => {
                for file in files {
                    let canon = file.canonicalize().unwrap_or_else(|_| file.clone());
                    if skip.contains(&canon) || !seen_files.insert(canon) {
                        continue;
                    }
                    if !looks_like_kubeconfig(&file) {
                        continue;
                    }
                    match Kubeconfig::read_from(&file) {
                        Ok(kc) if !kc.contexts.is_empty() => {
                            info.files += 1;
                            info.contexts += kc.contexts.len();
                            entries.extend(entries_from(&kc, Some(&file)));
                        }
                        // Not a kubeconfig, unparseable, or empty: skip silently.
                        _ => {}
                    }
                }
            }
        }
        infos.push(info);
    }

    // Make ids unique: first come keeps its name, later duplicates get "name (file)".
    let mut used: HashSet<String> = HashSet::new();
    for e in entries.iter_mut() {
        if used.contains(&e.id) {
            let file = e
                .file
                .as_ref()
                .and_then(|f| f.file_name())
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "kubeconfig".into());
            let mut id = format!("{} ({file})", e.name);
            let mut n = 2;
            while used.contains(&id) {
                id = format!("{} ({file} {n})", e.name);
                n += 1;
            }
            e.id = id;
        }
        used.insert(e.id.clone());
    }
    (entries, infos, default_error)
}

/// Load the kubeconfig that holds `entry`.
pub fn load(entry: &ContextEntry) -> Result<Kubeconfig> {
    match &entry.file {
        Some(p) => Kubeconfig::read_from(p).map_err(err),
        None => Kubeconfig::read().map_err(err),
    }
}

pub fn index(entries: &[ContextEntry]) -> HashMap<String, ContextEntry> {
    entries.iter().map(|e| (e.id.clone(), e.clone())).collect()
}

// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_contexts(state: State<'_, AppState>) -> Result<Vec<ContextInfo>> {
    let (entries, _, default_error) = state.rescan().await;
    if entries.is_empty() {
        if let Some(e) = default_error {
            return Err(e);
        }
    }
    Ok(entries.iter().map(ContextInfo::from).collect())
}

#[tauri::command]
pub async fn list_kubeconfig_folders(state: State<'_, AppState>) -> Result<Vec<FolderInfo>> {
    let (_, folders, _) = state.rescan().await;
    Ok(folders)
}

#[tauri::command]
pub async fn add_kubeconfig_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FolderInfo>> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    let settings = {
        let mut s = state.settings.lock().unwrap();
        if !s.kubeconfig_folders.contains(&path) {
            s.kubeconfig_folders.push(path);
        }
        s.clone()
    };
    crate::settings::save(&settings)?;
    crate::settings::restart_watcher(&app);
    Ok(state.rescan().await.1)
}

#[tauri::command]
pub async fn remove_kubeconfig_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<FolderInfo>> {
    let settings = {
        let mut s = state.settings.lock().unwrap();
        s.kubeconfig_folders.retain(|f| f != Path::new(&path));
        s.clone()
    };
    crate::settings::save(&settings)?;
    crate::settings::restart_watcher(&app);
    Ok(state.rescan().await.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1:1\ncontexts:\n- name: ok\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user: {}\n";

    #[test]
    fn invalid_files_are_ignored() {
        let dir = std::env::temp_dir().join(format!("kubetab-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.cfg"), VALID).unwrap();
        std::fs::write(dir.join("broken.yaml"), "clusters: [\n  broken").unwrap();
        std::fs::write(dir.join("values.yaml"), "name: x\nitems: [1]\n").unwrap();
        // UTF-16 BOM + odd length: panics inside kube-client if passed through.
        std::fs::write(dir.join("binary"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(dir.join("latin1"), [b'c', b'o', 0xe9, 0xff]).unwrap();

        let (entries, infos, _) = scan(std::slice::from_ref(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();

        let from_folder: Vec<_> = entries.iter().filter(|e| e.file.is_some()).collect();
        assert_eq!(from_folder.len(), 1);
        assert_eq!(from_folder[0].name, "ok");
        assert_eq!(infos[0].files, 1);
        assert!(infos[0].errors.is_empty(), "{:?}", infos[0].errors);
    }
}
