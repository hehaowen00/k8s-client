// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    import_shell_env();
    kube_portal_lib::run()
}

/// GUI apps launched from Finder/Dock get launchd's bare env (no KUBECONFIG, minimal PATH),
/// so kubeconfigs and exec plugins like `aws` aren't found. Pull in the login shell's env.
/// Runs before any threads exist, so set_var is safe.
#[cfg(unix)]
fn import_shell_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Marker skips anything rc files print; -i so ~/.zshrc exports are included.
    let Ok(out) = std::process::Command::new(shell)
        .args(["-ilc", "printf '\\0__ENV__\\0'; env -0"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return;
    };
    let out = String::from_utf8_lossy(&out.stdout);
    let Some((_, env)) = out.split_once("\0__ENV__\0") else {
        return;
    };
    for (k, v) in env.split('\0').filter_map(|kv| kv.split_once('=')) {
        if k == "PATH" || std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
}

#[cfg(not(unix))]
fn import_shell_env() {}
