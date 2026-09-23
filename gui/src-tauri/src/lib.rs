mod extensions;
mod helm;
mod kube_ops;
mod kubectl;
mod kubeconfigs;
mod metrics;
mod multi_logs;
mod nodeops;
mod portforward;
mod settings;
mod state;
mod streams;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(updates::PendingUpdate::default())
        .manage(state::AppState::default())
        .manage(portforward::Forwards::default())
        .manage(settings::KubeconfigWatcher(std::sync::Mutex::new(None)))
        .setup(|app| {
            use tauri::Manager;
            let st = app.state::<state::AppState>();
            *st.settings.lock().unwrap() = settings::load(app.handle());
            *st.managed_dir.lock().unwrap() = settings::managed_dir(app.handle()).ok();
            settings::restart_watcher(app.handle());
            Ok(())
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
            kube_ops::list_owned,
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
            metrics::cluster_overview,
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
            kube_ops::list_events,
            kube_ops::apply_manifest,
            streams::stream_logs,
            multi_logs::stream_multi_logs,
            portforward::start_port_forward,
            portforward::stop_port_forward,
            portforward::list_port_forwards,
            streams::exec_start,
            streams::session_write,
            streams::session_resize,
            streams::session_close,
            streams::pty_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
