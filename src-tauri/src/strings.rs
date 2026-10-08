//! User-facing text shown by the backend: menus, dialogs and error messages.

use std::fmt::Display;

// Menu
pub const MENU_ABOUT: &str = "About";
pub const MENU_SETTINGS: &str = "Settings";
pub const MENU_HIDE: &str = "Hide";
pub const MENU_QUIT: &str = "Quit";

// Resource tables
pub const COL_NAME: &str = "Name";
pub const COL_NAMESPACE: &str = "Namespace";
pub const COL_AGE: &str = "Age";

pub const DOC_MISSING_TYPE: &str = "Document missing apiVersion/kind";
pub const DOC_MISSING_NAME: &str = "Document missing metadata.name";

pub fn edit_conflict(server_message: impl Display) -> String {
    format!("{server_message} — it was changed on the server since you opened it. Reload to see the latest version.")
}

pub fn unknown_resource_type(api_version: impl Display, kind: impl Display) -> String {
    format!("Unknown resource type {api_version}/{kind}")
}

// Clusters and kubeconfigs
pub const NO_HOME_DIR: &str = "No home directory";
pub const KUBECONFIG_NO_CONTEXTS: &str = "The kubeconfig has no contexts";
pub const KUBECONFIG_NOT_REMOVABLE: &str =
    "Only kubeconfigs added in Kube Portal can be removed here";

pub fn invalid_kubeconfig(e: impl Display) -> String {
    format!("Not a valid kubeconfig: {e}")
}

pub fn not_a_folder(path: impl Display) -> String {
    format!("{path} is not a folder")
}

pub fn context_not_found_in_kubeconfigs(context: &str) -> String {
    format!("Context \"{context}\" not found in any kubeconfig")
}

pub fn context_not_found(context: &str) -> String {
    format!("Context \"{context}\" not found")
}

pub fn invalid_proxy_url(url: impl Display, e: impl Display) -> String {
    format!("Invalid proxy URL {url}: {e}")
}

// Watches
pub const UNKNOWN_ERROR: &str = "unknown error";

pub fn watch_failed(e: impl Display) -> String {
    format!("Watch failed: {e}")
}

// Overview
pub const PODS_STILL_LOADING: &str = "Pods are still loading";

// Metrics
pub const PROMETHEUS_NOT_AVAILABLE: &str = "Prometheus not available";
pub const PROMETHEUS_QUERY_FAILED: &str = "Prometheus query failed";

// Logs, exec and terminal sessions
pub const LOGS_SELECTOR_OR_POD_REQUIRED: &str = "Either a selector or a pod is required";
pub const CONTAINER_NOT_FOUND: &str = "Container not found";
pub const NO_STDOUT: &str = "No stdout";
pub const SESSION_NOT_FOUND: &str = "Session not found";
pub const SESSION_CLOSED: &str = "Session closed";

pub fn using_kubectl_from_path(e: impl Display) -> String {
    format!("Using kubectl from PATH ({e})")
}

pub fn exited_with_code(code: impl Display) -> String {
    format!("exited with code {code}")
}

// kubectl download
pub const KUBECTL_UNSUPPORTED_PLATFORM: &str = "Unsupported platform for kubectl download";
pub const KUBECTL_BAD_PATH: &str = "Bad kubectl path";

pub fn downloading_kubectl(version: &str) -> String {
    format!("Downloading kubectl {version} to match the cluster")
}

pub fn download_progress(pct: u32) -> String {
    format!("  {pct}%")
}

pub fn kubectl_checksum_error(e: impl Display) -> String {
    format!("kubectl checksum: {e}")
}

pub fn kubectl_download_error(e: impl Display) -> String {
    format!("kubectl download: {e}")
}

pub fn kubectl_checksum_mismatch(expected: &str, actual: &str) -> String {
    format!("kubectl checksum mismatch (expected {expected}, got {actual})")
}

// Helm
pub const HELM_NOT_FOUND: &str =
    "Helm not found — install Helm (https://helm.sh) or set its path in Settings";

pub fn helm_failed(command: &str) -> String {
    format!("helm {command} failed")
}

pub fn helm_unexpected_output(e: impl Display) -> String {
    format!("Unexpected helm output: {e}")
}

// Port forwarding and local listeners
pub const SERVICE_NO_SPEC: &str = "Service has no spec";
pub const PORT_FORWARD_STREAM_UNAVAILABLE: &str = "Port-forward stream unavailable";

pub fn service_no_selector(svc: &str) -> String {
    format!("Service {svc} has no selector; cannot pick a pod")
}

pub fn service_no_port(svc: &str, port: u16) -> String {
    format!("Service {svc} has no port {port}")
}

pub fn no_ready_pods(svc: &str) -> String {
    format!("No ready pods behind service {svc}")
}

pub fn no_container_port(name: &str) -> String {
    format!("No container port named {name}")
}

pub fn cannot_listen(port: u16, e: impl Display) -> String {
    format!("Cannot listen on 127.0.0.1:{port}: {e}")
}

// Node operations
pub const NODE_SHELL_TIMEOUT: &str = "Timed out waiting for node shell pod to start";

pub fn drain_unmanaged_pod(key: &str) -> String {
    format!("{key}: not managed by a controller; delete it yourself if it can go")
}

pub fn node_shell_ended(message: &str) -> String {
    format!("Node shell pod ended: {message}")
}

pub fn node_shell_failed(reason: &str, message: &str) -> String {
    format!("Node shell pod failed: {reason} {message}")
}

// Extensions
pub const EXT_MODULE_TOO_LARGE: &str = "Module is larger than 5 MB";

pub fn ext_outside_folder(main: impl Display) -> String {
    format!("{main} is outside the extension folder")
}

pub fn ext_not_found(main: impl Display) -> String {
    format!("{main} not found")
}

// Updates
pub const UPDATE_FEED_URL_MISSING: &str = "Set an update feed URL in Settings → Updates first";
pub const UPDATER_PUBKEY_MISSING: &str = "Set the updater public key in Settings → Updates first";
pub const NO_UPDATE_PENDING: &str = "No update pending — check for updates first";

pub fn invalid_update_feed_url(e: impl Display) -> String {
    format!("Invalid update feed URL: {e}")
}
