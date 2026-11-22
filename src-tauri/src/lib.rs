mod extensions;
mod helm;
mod kube_ops;
mod kubeconfigs;
mod kubectl;
mod mcp;
mod metrics;
mod multi_logs;
mod nodeops;
mod overview;
mod portforward;
mod settings;
mod state;
mod streams;
mod strings;
mod updates;
mod watch;

/// The default macOS menu, with a Settings item (Cmd+,) and short About / Hide / Quit labels.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_submenu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(strings::MENU_ABOUT), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "settings",
                strings::MENU_SETTINGS,
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(strings::MENU_HIDE))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(strings::MENU_QUIT))?,
        ],
    )?;
    let menu = Menu::default(app)?;
    menu.remove_at(0)?;
    menu.insert(&app_submenu, 0)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(updates::PendingUpdate::default())
        .manage(state::AppState::default())
        .manage(portforward::Forwards::default())
        .manage(mcp::McpServer::default())
        .manage(settings::KubeconfigWatcher(std::sync::Mutex::new(None)))
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_window_state::AppHandleExt;
            // Open maximized on first launch; afterwards the window-state plugin restores
            // the last size, position and maximized state.
            let has_saved_state = app
                .path()
                .app_config_dir()
                .map(|d| d.join(app.handle().filename()).exists())
                .unwrap_or(false);
            if !has_saved_state {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.maximize();
                }
            }
            let st = app.state::<state::AppState>();
            settings::migrate_legacy(app.handle());
            *st.settings.lock().unwrap() = settings::load();
            *st.managed_dir.lock().unwrap() = settings::managed_dir().ok();
            settings::restart_watcher(app.handle());
            mcp::restart(app.handle());
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            if event.id() == "settings" {
                let _ = app.emit("open-settings", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            kubeconfigs::list_contexts,
            settings::get_settings,
            updates::update_check,
            extensions::list_extensions,
            extensions::set_extension_enabled,
            extensions::extensions_folder,
            updates::update_install,
            settings::save_settings,
            settings::add_kubeconfig,
            settings::remove_added_kubeconfig,
            kubeconfigs::list_kubeconfig_folders,
            kubeconfigs::add_kubeconfig_folder,
            kubeconfigs::remove_kubeconfig_folder,
            kube_ops::reconnect,
            kube_ops::discover,
            kube_ops::list_namespaces,
            kube_ops::watch_resources,
            kube_ops::stop_stream,
            kube_ops::watch_objects,
            kube_ops::list_objects,
            kube_ops::count_resources,
            kube_ops::can_i,
            kube_ops::get_object,
            kube_ops::get_yaml,
            kube_ops::replace_yaml,
            kube_ops::delete_resource,
            kube_ops::scale_resource,
            kube_ops::restart_resource,
            kube_ops::patch_resource,
            metrics::pod_metrics,
            metrics::node_metrics,
            metrics::prometheus_detect,
            metrics::prometheus_range,
            overview::cluster_overview,
            helm::helm_list,
            helm::helm_release,
            helm::helm_install,
            helm::helm_rollback,
            helm::helm_uninstall,
            helm::helm_repos,
            helm::helm_repo_add,
            helm::helm_repo_remove,
            helm::helm_repo_update,
            helm::helm_search,
            helm::helm_chart_info,
            nodeops::drain_node,
            nodeops::node_shell_create,
            nodeops::trigger_cronjob,
            kube_ops::apply_manifest,
            streams::stream_logs,
            streams::save_text,
            multi_logs::stream_multi_logs,
            portforward::start_port_forward,
            portforward::stop_port_forward,
            portforward::list_port_forwards,
            streams::exec_start,
            streams::session_write,
            streams::session_resize,
            streams::session_close,
            streams::pty_start,
            mcp::mcp_status,
            mcp::mcp_access_log,
            mcp::mcp_clear_log,
            mcp::mcp_regenerate_token,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let st = app.state::<state::AppState>();
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        st.delete_node_shells(),
                    )
                    .await;
                });
            }
        });
}
