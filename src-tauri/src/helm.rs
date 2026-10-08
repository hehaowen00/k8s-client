//! Helm integration via the `helm` CLI (as Lens does), pointed at a tab's cluster
//! through a scoped kubeconfig. Uses the user's Helm repositories and cache.

use std::path::PathBuf;
use std::process::Stdio;

use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::process::Command;

use crate::state::{err, AppState, Result};

struct Helm {
    kubeconfig: Option<PathBuf>,
    binary: String,
    proxy: Option<String>,
}

impl Helm {
    async fn for_context(app: &AppHandle, state: &AppState, context: Option<&str>) -> Result<Self> {
        let kubeconfig = match context {
            Some(c) => Some(state.scoped_kubeconfig(app, c).await?),
            None => None,
        };
        // Settings > env > PATH.
        let binary = state
            .settings
            .lock()
            .unwrap()
            .helm_path
            .clone()
            .filter(|p| !p.trim().is_empty())
            .or_else(|| std::env::var("KUBE_PORTAL_HELM").ok())
            // Older name.
            .or_else(|| std::env::var("KUBETAB_HELM").ok())
            .unwrap_or_else(|| "helm".into());
        let proxy = context.and_then(|c| state.cluster_settings(c).proxy_url).filter(|p| !p.trim().is_empty());
        Ok(Helm { kubeconfig, binary, proxy })
    }

    async fn run(&self, args: &[&str]) -> Result<String> {
        let mut cmd = Command::new(&self.binary);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(k) = &self.kubeconfig {
            cmd.env("KUBECONFIG", k);
        }
        if let Some(p) = &self.proxy {
            cmd.env("HTTPS_PROXY", p).env("HTTP_PROXY", p);
        }
        let out = cmd.output().await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "helm not found — install Helm (https://helm.sh) or set its path in Settings".to_string()
            } else {
                e.to_string()
            }
        })?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() { format!("helm {} failed", args.first().unwrap_or(&"")) } else { stderr });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    async fn json(&self, args: &[&str]) -> Result<Value> {
        let text = self.run(args).await?;
        if text.trim().is_empty() {
            return Ok(Value::Array(vec![]));
        }
        serde_json::from_str(&text).map_err(|e| format!("unexpected helm output: {e}"))
    }
}

/// Values file for install/upgrade, owner-only since values often hold secrets. Removed on drop.
struct TempValues(PathBuf);

impl TempValues {
    fn new(app: &AppHandle, yaml: &str) -> Result<Self> {
        let dir = app.path().app_cache_dir().map_err(err)?.join("helm");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let path = dir.join(format!("values-{}.yaml", uuid::Uuid::new_v4().simple()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        opts.open(&path).and_then(|mut f| f.write_all(yaml.as_bytes())).map_err(err)?;
        Ok(TempValues(path))
    }
    fn arg(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
}

impl Drop for TempValues {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn helm_list(app: AppHandle, state: State<'_, AppState>, context: String, namespace: Option<String>) -> Result<Value> {
    let ns = namespace.filter(|n| !n.is_empty());
    let ns_key = ns.clone().unwrap_or_default();
    // `helm list` reads every release secret in full; skip it while their metadata is unchanged.
    let fingerprint = release_fingerprint(&state, &context, ns.as_deref()).await;
    if let Some(cached) = fingerprint.and_then(|fp| state.helm_list_cached(&context, &ns_key, fp)) {
        return Ok(cached);
    }
    let helm = Helm::for_context(&app, &state, Some(&context)).await?;
    // Explicit states instead of `--all` (removed in Helm 4); works on Helm 3 and 4.
    let mut args = vec!["list", "--deployed", "--failed", "--pending", "--uninstalling", "-o", "json", "--max", "5000"];
    match &ns {
        Some(n) => args.extend(["-n", n.as_str()]),
        None => args.push("-A"),
    }
    let list = helm.json(&args).await?;
    if let Some(fp) = fingerprint {
        state.store_helm_list(&context, &ns_key, fp, list.clone());
    }
    Ok(list)
}

/// Hash of the Helm release secrets' resourceVersions (metadata only, from the watch cache).
/// None when there's nothing to go on, e.g. no access or the ConfigMap storage driver.
async fn release_fingerprint(state: &AppState, context: &str, namespace: Option<&str>) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let client = state.client(context).await.ok()?;
    let api: Api<Secret> = match namespace {
        Some(n) => Api::namespaced(client, n),
        None => Api::all(client),
    };
    let list = api.list_metadata(&ListParams::default().match_any().labels("owner=helm")).await.ok()?;
    if list.items.is_empty() {
        return None;
    }
    let mut versions: Vec<(Option<String>, Option<String>, Option<String>)> = list
        .items
        .into_iter()
        .map(|s| (s.metadata.namespace, s.metadata.name, s.metadata.resource_version))
        .collect();
    versions.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    versions.hash(&mut h);
    Some(h.finish())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetails {
    values: String,
    computed_values: String,
    manifest: String,
    notes: String,
    history: Value,
    status: Value,
}

#[tauri::command]
pub async fn helm_release(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
) -> Result<ReleaseDetails> {
    let helm = Helm::for_context(&app, &state, Some(&context)).await?;
    let ns = namespace.as_str();
    let n = name.as_str();
    let a_values = ["get", "values", n, "-n", ns, "-o", "yaml"];
    let a_all = ["get", "values", n, "-n", ns, "--all", "-o", "yaml"];
    let a_manifest = ["get", "manifest", n, "-n", ns];
    let a_notes = ["get", "notes", n, "-n", ns];
    let a_history = ["history", n, "-n", ns, "-o", "json", "--max", "50"];
    let a_status = ["status", n, "-n", ns, "-o", "json"];
    let (values, computed, manifest, notes, history, status) = tokio::join!(
        helm.run(&a_values),
        helm.run(&a_all),
        helm.run(&a_manifest),
        helm.run(&a_notes),
        helm.json(&a_history),
        helm.json(&a_status),
    );
    let clean = |s: String| if s.trim() == "null" { String::new() } else { s };
    Ok(ReleaseDetails {
        values: clean(values?),
        computed_values: clean(computed.unwrap_or_default()),
        manifest: manifest.unwrap_or_default(),
        // Charts without NOTES.txt make `get notes` fail; that's fine.
        notes: notes.unwrap_or_default(),
        history: history.unwrap_or(Value::Array(vec![])),
        status: status.unwrap_or(Value::Null),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    context: String,
    namespace: String,
    name: String,
    chart: String,
    version: Option<String>,
    values: String,
    create_namespace: Option<bool>,
    /// Upgrade instead of install.
    upgrade: Option<bool>,
}

#[tauri::command]
pub async fn helm_install(app: AppHandle, state: State<'_, AppState>, req: InstallRequest) -> Result<String> {
    let helm = Helm::for_context(&app, &state, Some(&req.context)).await?;
    let values = TempValues::new(&app, &req.values)?;
    let values_arg = values.arg();
    let upgrade = req.upgrade.unwrap_or(false);
    let mut args: Vec<&str> = vec![
        if upgrade { "upgrade" } else { "install" },
        &req.name,
        &req.chart,
        "-n",
        &req.namespace,
        "-f",
        &values_arg,
        "-o",
        "json",
    ];
    if let Some(v) = req.version.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["--version", v]);
    }
    if !upgrade && req.create_namespace.unwrap_or(false) {
        args.push("--create-namespace");
    }
    let v = helm.json(&args).await?;
    Ok(v["info"]["notes"].as_str().unwrap_or_default().to_string())
}

#[tauri::command]
pub async fn helm_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
    revision: u32,
) -> Result<()> {
    let helm = Helm::for_context(&app, &state, Some(&context)).await?;
    let rev = revision.to_string();
    helm.run(&["rollback", &name, &rev, "-n", &namespace]).await?;
    Ok(())
}

#[tauri::command]
pub async fn helm_uninstall(app: AppHandle, state: State<'_, AppState>, context: String, namespace: String, name: String) -> Result<()> {
    let helm = Helm::for_context(&app, &state, Some(&context)).await?;
    helm.run(&["uninstall", &name, "-n", &namespace]).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Repositories & charts (not cluster-specific)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn helm_repos(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let helm = Helm::for_context(&app, &state, None).await?;
    match helm.json(&["repo", "list", "-o", "json"]).await {
        Ok(v) => Ok(v),
        // `helm repo list` errors when no repositories are configured.
        Err(e) if e.contains("no repositories") => Ok(Value::Array(vec![])),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn helm_repo_add(app: AppHandle, state: State<'_, AppState>, name: String, url: String) -> Result<()> {
    let helm = Helm::for_context(&app, &state, None).await?;
    helm.run(&["repo", "add", &name, &url, "--force-update"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn helm_repo_remove(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<()> {
    let helm = Helm::for_context(&app, &state, None).await?;
    helm.run(&["repo", "remove", &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn helm_repo_update(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let helm = Helm::for_context(&app, &state, None).await?;
    helm.run(&["repo", "update"]).await
}

/// Search the local repo index. Empty query lists every chart (latest versions).
#[tauri::command]
pub async fn helm_search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: Option<String>,
    versions: Option<bool>,
) -> Result<Value> {
    let helm = Helm::for_context(&app, &state, None).await?;
    let q = query.unwrap_or_default();
    let mut args = vec!["search", "repo", "-o", "json"];
    if versions.unwrap_or(false) {
        args.push("--versions");
    }
    if !q.is_empty() {
        args.push(&q);
    }
    match helm.json(&args).await {
        Ok(v) => Ok(v),
        Err(e) if e.contains("no repositories") => Ok(Value::Array(vec![])),
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartInfo {
    values: String,
    readme: String,
    chart: String,
}

#[tauri::command]
pub async fn helm_chart_info(app: AppHandle, state: State<'_, AppState>, chart: String, version: Option<String>) -> Result<ChartInfo> {
    let helm = Helm::for_context(&app, &state, None).await?;
    let mut base: Vec<&str> = vec![];
    if let Some(v) = version.as_deref().filter(|v| !v.is_empty()) {
        base.extend(["--version", v]);
    }
    let with = |sub: &'static str| {
        let mut a = vec!["show", sub, chart.as_str()];
        a.extend(base.iter().copied());
        a
    };
    let (a_values, a_readme, a_chart) = (with("values"), with("readme"), with("chart"));
    let (values, readme, meta) = tokio::join!(helm.run(&a_values), helm.run(&a_readme), helm.run(&a_chart));
    Ok(ChartInfo {
        values: values?,
        readme: readme.unwrap_or_default(),
        chart: meta.unwrap_or_default(),
    })
}
