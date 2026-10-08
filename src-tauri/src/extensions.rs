//! Kube Portal extensions: folders under <app config>/extensions/<id>/ with an
//! optional extension.json ({ name, version, description, main }) and a JS
//! module (default: index.js). The UI imports enabled extensions at startup.
//! Extensions are trusted code with the same access as the app (like Lens).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::{err, AppState, Result};
use crate::strings;

const MAX_SOURCE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Manifest {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    main: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    enabled: bool,
    /// Module source, only for enabled extensions.
    source: Option<String>,
    error: Option<String>,
}

pub fn extensions_dir() -> Result<PathBuf> {
    Ok(crate::settings::config_dir()?.join("extensions"))
}

#[tauri::command]
pub fn list_extensions(state: State<'_, AppState>) -> Result<Vec<ExtensionInfo>> {
    let dir = extensions_dir()?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let disabled = state.settings.lock().unwrap().disabled_extensions.clone();
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        if !path.is_dir() || e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let id = e.file_name().to_string_lossy().to_string();
        let manifest: Manifest = std::fs::read_to_string(path.join("extension.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let main = manifest.main.clone().unwrap_or_else(|| "index.js".into());
        let enabled = !disabled.contains(&id);
        let mut info = ExtensionInfo {
            name: manifest.name.clone().unwrap_or_else(|| id.clone()),
            version: manifest.version.clone().unwrap_or_default(),
            description: manifest.description.clone().unwrap_or_default(),
            id,
            enabled,
            source: None,
            error: None,
        };
        // Keep the entry inside the extension's folder.
        let main_path = path.join(&main);
        match main_path.canonicalize() {
            Ok(p) if p.starts_with(path.canonicalize().unwrap_or(path.clone())) => {
                if enabled {
                    match std::fs::metadata(&p) {
                        Ok(m) if m.len() > MAX_SOURCE_BYTES => {
                            info.error = Some(strings::EXT_MODULE_TOO_LARGE.into())
                        }
                        Ok(_) => match std::fs::read_to_string(&p) {
                            Ok(src) => info.source = Some(src),
                            Err(e) => info.error = Some(e.to_string()),
                        },
                        Err(e) => info.error = Some(e.to_string()),
                    }
                }
            }
            Ok(_) => info.error = Some(strings::ext_outside_folder(main)),
            Err(_) => info.error = Some(strings::ext_not_found(main)),
        }
        out.push(info);
    }
    Ok(out)
}

#[tauri::command]
pub fn set_extension_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Result<()> {
    let settings = {
        let mut s = state.settings.lock().unwrap();
        s.disabled_extensions.retain(|d| d != &id);
        if !enabled {
            s.disabled_extensions.push(id);
        }
        s.clone()
    };
    crate::settings::save(&settings)
}

#[tauri::command]
pub fn extensions_folder() -> Result<String> {
    let dir = extensions_dir()?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().to_string())
}
