//! Self-update via tauri-plugin-updater, using a feed URL and public key from
//! Settings (Kube Portal has no central update server; publish signed releases,
//! e.g. on GitHub, and point the feed at their latest.json).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::{err, AppState, Result};
use crate::strings;

#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>> {
    let (endpoint, pubkey) = {
        let s = state.settings.lock().unwrap();
        (s.update_endpoint.clone(), s.update_pubkey.clone())
    };
    let endpoint = endpoint
        .filter(|e| !e.trim().is_empty())
        .ok_or(strings::UPDATE_FEED_URL_MISSING)?;
    let pubkey = pubkey
        .filter(|k| !k.trim().is_empty())
        .ok_or(strings::UPDATER_PUBKEY_MISSING)?;
    let url = endpoint
        .trim()
        .parse()
        .map_err(strings::invalid_update_feed_url)?;
    let updater = app
        .updater_builder()
        .pubkey(pubkey.trim())
        .endpoints(vec![url])
        .map_err(err)?
        .build()
        .map_err(err)?;
    let update = updater.check().await.map_err(err)?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Download (signature-verified by the plugin), install, and restart.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<()> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or(strings::NO_UPDATE_PENDING)?;
    let mut downloaded = 0usize;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = progress_app.emit("update-progress", (downloaded, total));
            },
            || {},
        )
        .await
        .map_err(err)?;
    app.restart();
}
