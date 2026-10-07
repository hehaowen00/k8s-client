use std::collections::HashMap;
use std::sync::Arc;

use futures::{AsyncBufReadExt, StreamExt};
use kube::api::{
    Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
};
use kube::core::{ApiResource, GroupVersionKind};
use kube::discovery::{Discovery, Scope};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::state::{err, kerr, AppState, Result};

const FIELD_MANAGER: &str = "kubetab";
const TABLE_ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json;as=Table;v=v1beta1;g=meta.k8s.io,application/json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    #[serde(default)]
    pub verbs: Vec<String>,
}

impl ResourceInfo {
    pub(crate) fn api_resource(&self) -> ApiResource {
        ApiResource {
            group: self.group.clone(),
            version: self.version.clone(),
            api_version: if self.group.is_empty() {
                self.version.clone()
            } else {
                format!("{}/{}", self.group, self.version)
            },
            kind: self.kind.clone(),
            plural: self.plural.clone(),
        }
    }

    pub(crate) fn collection_url(&self, namespace: Option<&str>) -> String {
        let base = if self.group.is_empty() {
            format!("/api/{}", self.version)
        } else {
            format!("/apis/{}/{}", self.group, self.version)
        };
        match namespace {
            Some(ns) if self.namespaced && !ns.is_empty() => {
                format!("{base}/namespaces/{ns}/{}", self.plural)
            }
            _ => format!("{base}/{}", self.plural),
        }
    }

    pub(crate) fn api(&self, client: Client, namespace: Option<&str>) -> Api<DynamicObject> {
        let ar = self.api_resource();
        match namespace {
            Some(ns) if self.namespaced && !ns.is_empty() => {
                Api::namespaced_with(client, ns, &ar)
            }
            _ => Api::all_with(client, &ar),
        }
    }
}

#[tauri::command]
pub async fn reconnect(state: State<'_, AppState>, context: String) -> Result<()> {
    state.reset(&context).await;
    Ok(())
}

#[tauri::command]
pub async fn discover(
    state: State<'_, AppState>,
    context: String,
    refresh: Option<bool>,
) -> Result<Arc<Vec<ResourceInfo>>> {
    discover_resources(&state, &context, refresh.unwrap_or(false)).await
}

pub(crate) async fn discover_resources(state: &AppState, context: &str, refresh: bool) -> Result<Arc<Vec<ResourceInfo>>> {
    if !refresh {
        if let Some(d) = state.cached_discovery(context).await {
            return Ok(d);
        }
    }
    let client = state.client(context).await?;
    let discovery = match Discovery::new(client.clone()).run_aggregated().await {
        Ok(d) => d,
        // Older servers lack aggregated discovery; connection errors shouldn't retry.
        Err(kube::Error::Api(_)) => Discovery::new(client).run().await.map_err(kerr)?,
        Err(e) => return Err(kerr(e)),
    };
    let mut out = Vec::new();
    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            if !caps.supports_operation("list") {
                continue;
            }
            out.push(ResourceInfo {
                group: ar.group,
                version: ar.version,
                kind: ar.kind,
                plural: ar.plural,
                namespaced: caps.scope == Scope::Namespaced,
                verbs: caps.operations.clone(),
            });
        }
    }
    let out = Arc::new(out);
    state.store_discovery(context, out.clone()).await;
    Ok(out)
}

#[tauri::command]
pub async fn list_namespaces(state: State<'_, AppState>, context: String) -> Result<Vec<String>> {
    // Users who can't list namespaces configure the ones they can use.
    let accessible = state.cluster_settings(&context).accessible_namespaces;
    if !accessible.is_empty() {
        return Ok(accessible);
    }
    let client = state.client(&context).await?;
    let api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await.map_err(kerr)?;
    let mut names: Vec<String> = list
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    names.sort();
    Ok(names)
}

// ---------------------------------------------------------------------------
// Live tables: server-side Table rendering + watch, so every kind (CRDs too)
// gets kubectl-style columns.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    format: String,
    priority: i64,
    description: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    uid: String,
    name: String,
    namespace: Option<String>,
    created: Option<String>,
    labels: Value,
    cells: Vec<Value>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TableEvent {
    Reset { columns: Vec<Column>, rows: Vec<Row> },
    Upsert { rows: Vec<Row> },
    Delete { uids: Vec<String> },
    Error { message: String },
}

fn parse_columns(table: &Value) -> Vec<Column> {
    table["columnDefinitions"]
        .as_array()
        .map(|cols| {
            cols.iter()
                .map(|c| Column {
                    name: c["name"].as_str().unwrap_or_default().to_string(),
                    ty: c["type"].as_str().unwrap_or("string").to_string(),
                    format: c["format"].as_str().unwrap_or_default().to_string(),
                    priority: c["priority"].as_i64().unwrap_or(0),
                    description: c["description"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn row_from_meta(meta: &Value, cells: Vec<Value>) -> Row {
    Row {
        uid: meta["uid"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| {
                format!(
                    "{}/{}",
                    meta["namespace"].as_str().unwrap_or_default(),
                    meta["name"].as_str().unwrap_or_default()
                )
            }),
        name: meta["name"].as_str().unwrap_or_default().to_string(),
        namespace: meta["namespace"].as_str().map(String::from),
        created: meta["creationTimestamp"].as_str().map(String::from),
        labels: meta["labels"].clone(),
        cells,
    }
}

fn parse_table_rows(table: &Value) -> Vec<Row> {
    table["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let cells = r["cells"].as_array().cloned().unwrap_or_default();
                    row_from_meta(&r["object"]["metadata"], cells)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fallback for APIs that can't render tables: synthesize Name/Namespace/Age.
fn fallback_columns(namespaced: bool) -> Vec<Column> {
    let mk = |name: &str, ty: &str, format: &str| Column {
        name: name.into(),
        ty: ty.into(),
        format: format.into(),
        priority: 0,
        description: String::new(),
    };
    let mut cols = vec![mk("Name", "string", "name")];
    if namespaced {
        cols.push(mk("Namespace", "string", ""));
    }
    cols.push(mk("Age", "date", ""));
    cols
}

fn fallback_row(obj: &Value, namespaced: bool) -> Row {
    let meta = &obj["metadata"];
    let mut cells = vec![meta["name"].clone()];
    if namespaced {
        cells.push(meta["namespace"].clone());
    }
    cells.push(meta["creationTimestamp"].clone());
    row_from_meta(meta, cells)
}

fn is_table(v: &Value) -> bool {
    v["kind"] == "Table"
}

pub(crate) async fn list_table(
    client: &Client,
    url: &str,
    res: &ResourceInfo,
) -> Result<(Vec<Column>, Vec<Row>, String, bool)> {
    // `url` always ends in '?' or '&' (it may carry label/field selectors).
    let req = http::Request::get(format!("{url}includeObject=Metadata"))
        .header(http::header::ACCEPT, TABLE_ACCEPT)
        .body(vec![])
        .map_err(err)?;
    let v: Value = client.request(req).await.map_err(kerr)?;
    let rv = v["metadata"]["resourceVersion"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if is_table(&v) {
        Ok((parse_columns(&v), parse_table_rows(&v), rv, true))
    } else {
        let rows = v["items"]
            .as_array()
            .map(|items| items.iter().map(|o| fallback_row(o, res.namespaced)).collect())
            .unwrap_or_default();
        Ok((fallback_columns(res.namespaced), rows, rv, false))
    }
}

const WATCH_BACKOFF_MIN: std::time::Duration = std::time::Duration::from_millis(500);
const WATCH_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);

enum WatchOutcome {
    Cancelled,
    /// Watch ended normally (server timeout); resume from resourceVersion.
    Resume,
    /// resourceVersion too old or stream error; relist. Carries an error worth showing (e.g. watch forbidden).
    Relist(Option<String>),
}

async fn watch_table(
    client: &Client,
    url: &str,
    res: &ResourceInfo,
    table_mode: bool,
    rv: &mut String,
    channel: &Channel<TableEvent>,
    token: &tokio_util::sync::CancellationToken,
) -> WatchOutcome {
    let uri = format!(
        "{url}watch=1&resourceVersion={rv}&includeObject=Metadata&timeoutSeconds=290"
    );
    let accept = if table_mode { TABLE_ACCEPT } else { "application/json" };
    let req = match http::Request::get(uri)
        .header(http::header::ACCEPT, accept)
        .body(vec![])
    {
        Ok(r) => r,
        Err(e) => return WatchOutcome::Relist(Some(e.to_string())),
    };
    let stream = tokio::select! {
        _ = token.cancelled() => return WatchOutcome::Cancelled,
        s = client.request_stream(req) => match s {
            Ok(s) => s,
            Err(kube::Error::Api(e)) if e.code == 410 => return WatchOutcome::Relist(None),
            Err(e) => return WatchOutcome::Relist(Some(format!("watch failed: {}", kerr(e)))),
        },
    };
    let mut lines = stream.lines();
    loop {
        let line = tokio::select! {
            _ = token.cancelled() => return WatchOutcome::Cancelled,
            l = lines.next() => l,
        };
        let line = match line {
            None => return WatchOutcome::Resume,
            Some(Err(_)) => return WatchOutcome::Relist(None),
            Some(Ok(l)) => l,
        };
        let Ok(ev) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let obj = &ev["object"];
        let ty = ev["type"].as_str().unwrap_or_default();
        if ty == "ERROR" {
            let msg = (obj["code"].as_i64() != Some(410)).then(|| format!("watch failed: {}", obj["message"].as_str().unwrap_or("unknown error")));
            return WatchOutcome::Relist(msg);
        }
        let rows = if is_table(obj) {
            parse_table_rows(obj)
        } else {
            vec![fallback_row(obj, res.namespaced)]
        };
        // Track the latest resourceVersion so we can resume.
        let latest_rv = if is_table(obj) {
            obj["rows"][0]["object"]["metadata"]["resourceVersion"].as_str()
        } else {
            obj["metadata"]["resourceVersion"].as_str()
        };
        if let Some(r) = latest_rv {
            *rv = r.to_string();
        }
        let event = match ty {
            "ADDED" | "MODIFIED" => TableEvent::Upsert { rows },
            "DELETED" => TableEvent::Delete {
                uids: rows.into_iter().map(|r| r.uid).collect(),
            },
            _ => continue,
        };
        if channel.send(event).is_err() {
            return WatchOutcome::Cancelled;
        }
    }
}

#[tauri::command]
pub async fn watch_resources(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    channel: Channel<TableEvent>,
) -> Result<String> {
    let client = state.client(&context).await?;
    let (id, token) = state.register_stream();
    let mut url = format!("{}?", resource.collection_url(namespace.as_deref()));
    if let Some(l) = label_selector.filter(|s| !s.is_empty()) {
        url.push_str(&format!("labelSelector={}&", urlencode(&l)));
    }
    if let Some(f) = field_selector.filter(|s| !s.is_empty()) {
        url.push_str(&format!("fieldSelector={}&", urlencode(&f)));
    }

    tokio::spawn(async move {
        let mut backoff = 1u64;
        let mut watch_backoff = WATCH_BACKOFF_MIN;
        'outer: loop {
            let (columns, rows, mut rv, table_mode) = match list_table(&client, &url, &resource).await {
                Ok(v) => v,
                Err(e) => {
                    if channel.send(TableEvent::Error { message: e }).is_err() {
                        break;
                    }
                    tokio::select! {
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff)) => {}
                    }
                    backoff = (backoff * 2).min(30);
                    continue;
                }
            };
            backoff = 1;
            if channel.send(TableEvent::Reset { columns, rows }).is_err() {
                break;
            }
            loop {
                let (started, start_rv) = (std::time::Instant::now(), rv.clone());
                let outcome = watch_table(&client, &url, &resource, table_mode, &mut rv, &channel, &token).await;
                // A watch that delivered events or ran a while is healthy; one that keeps ending at once backs off.
                if rv != start_rv || started.elapsed() > std::time::Duration::from_secs(60) {
                    watch_backoff = WATCH_BACKOFF_MIN;
                }
                let relist = match outcome {
                    WatchOutcome::Cancelled => break 'outer,
                    WatchOutcome::Resume => false,
                    WatchOutcome::Relist(msg) => {
                        if let Some(message) = msg {
                            if channel.send(TableEvent::Error { message }).is_err() {
                                break 'outer;
                            }
                        }
                        true
                    }
                };
                if relist || watch_backoff > WATCH_BACKOFF_MIN || started.elapsed() < std::time::Duration::from_secs(1) {
                    tokio::select! {
                        _ = token.cancelled() => break 'outer,
                        _ = tokio::time::sleep(watch_backoff) => {}
                    }
                    watch_backoff = (watch_backoff * 2).min(WATCH_BACKOFF_MAX);
                }
                if relist {
                    continue 'outer;
                }
            }
        }
    });
    Ok(id)
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Full objects of a resource (managedFields stripped), optionally label-filtered. Used by extensions.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    label_selector: Option<String>,
) -> Result<Vec<Value>> {
    let client = state.client(&context).await?;
    let mut lp = ListParams::default();
    if let Some(l) = label_selector.as_deref().filter(|s| !s.is_empty()) {
        lp = lp.labels(l);
    }
    let list = resource.api(client, namespace.as_deref()).list(&lp).await.map_err(kerr)?;
    let ar = resource.api_resource();
    list.items
        .into_iter()
        .map(|o| {
            let mut v = serde_json::to_value(o).map_err(err)?;
            strip_noise(&mut v);
            // List items come without apiVersion/kind; fill them in for callers.
            v["apiVersion"] = Value::String(ar.api_version.clone());
            v["kind"] = Value::String(ar.kind.clone());
            Ok(v)
        })
        .collect()
}

/// Objects of `resource` whose ownerReferences include `owner_uid` (e.g. a CronJob's Jobs).
#[tauri::command]
pub async fn list_owned(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    owner_uid: String,
) -> Result<Vec<Value>> {
    let client = state.client(&context).await?;
    let list = resource
        .api(client, namespace.as_deref())
        .list(&ListParams::default())
        .await
        .map_err(kerr)?;
    let mut out = Vec::new();
    for o in list.items {
        let owned = o.metadata.owner_references.iter().flatten().any(|r| r.uid == owner_uid);
        if owned {
            let mut v = serde_json::to_value(o).map_err(err)?;
            strip_noise(&mut v);
            out.push(v);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn stop_stream(state: State<'_, AppState>, id: String) {
    state.stop_stream(&id);
}

// ---------------------------------------------------------------------------
// Single-object operations
// ---------------------------------------------------------------------------

pub(crate) fn strip_noise(v: &mut Value) {
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }
}

#[tauri::command]
pub async fn get_object(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
) -> Result<Value> {
    let client = state.client(&context).await?;
    let obj = resource
        .api(client, namespace.as_deref())
        .get(&name)
        .await
        .map_err(kerr)?;
    let mut v = serde_json::to_value(obj).map_err(err)?;
    strip_noise(&mut v);
    Ok(v)
}

#[tauri::command]
pub async fn get_yaml(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
) -> Result<String> {
    let v = get_object(state, context, resource, namespace, name).await?;
    serde_yaml::to_string(&v).map_err(err)
}

#[tauri::command]
pub async fn replace_yaml(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
    yaml: String,
    original_yaml: Option<String>,
) -> Result<String> {
    let client = state.client(&context).await?;
    let api = resource.api(client, namespace.as_deref());
    let mut obj: DynamicObject = serde_yaml::from_str(&yaml).map_err(err)?;
    let updated = match api.replace(&name, &PostParams::default(), &obj).await {
        Ok(u) => u,
        // Conflict: the object changed since it was loaded. If only status / bookkeeping
        // changed (a controller updating status), rebase the edit onto the latest version.
        Err(kube::Error::Api(s)) if s.code == 409 => {
            let original: Option<Value> = original_yaml.as_deref().and_then(|y| serde_yaml::from_str(y).ok());
            let latest = api.get(&name).await.map_err(kerr)?;
            let mut latest_v = serde_json::to_value(&latest).map_err(err)?;
            let rebase = match original {
                Some(mut orig) => comparable(&mut orig) == comparable(&mut latest_v),
                None => false,
            };
            if !rebase {
                return Err(format!(
                    "{} — it was changed on the server since you opened it. Reload to see the latest version.",
                    s.message
                ));
            }
            obj.metadata.resource_version = latest.metadata.resource_version.clone();
            api.replace(&name, &PostParams::default(), &obj).await.map_err(kerr)?
        }
        Err(e) => return Err(kerr(e)),
    };
    let mut v = serde_json::to_value(updated).map_err(err)?;
    strip_noise(&mut v);
    serde_yaml::to_string(&v).map_err(err)
}

/// The parts of an object a user edits: drop status and server-managed metadata.
fn comparable(v: &mut Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("status");
        if let Some(m) = o.get_mut("metadata").and_then(Value::as_object_mut) {
            for k in ["resourceVersion", "generation", "managedFields"] {
                m.remove(k);
            }
            // Controllers bump these annotations as part of normal status bookkeeping.
            if let Some(a) = m.get_mut("annotations").and_then(Value::as_object_mut) {
                a.remove("deployment.kubernetes.io/revision");
                if a.is_empty() {
                    m.remove("annotations");
                }
            }
        }
    }
    v.clone()
}

#[tauri::command]
pub async fn delete_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
) -> Result<()> {
    let client = state.client(&context).await?;
    resource
        .api(client, namespace.as_deref())
        .delete(&name, &DeleteParams::background())
        .await
        .map_err(kerr)?;
    Ok(())
}

#[tauri::command]
pub async fn scale_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
    replicas: i32,
) -> Result<()> {
    let client = state.client(&context).await?;
    let patch = json!({ "spec": { "replicas": replicas } });
    resource
        .api(client, namespace.as_deref())
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kerr)?;
    Ok(())
}

/// JSON merge patch on any object (cordon, suspend, and other one-field toggles).
#[tauri::command]
pub async fn patch_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
    patch: Value,
) -> Result<()> {
    let client = state.client(&context).await?;
    resource
        .api(client, namespace.as_deref())
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kerr)?;
    Ok(())
}

#[tauri::command]
pub async fn restart_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceInfo,
    namespace: Option<String>,
    name: String,
) -> Result<()> {
    let client = state.client(&context).await?;
    let now = k8s_openapi::jiff::Timestamp::now().to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        }}}}
    });
    resource
        .api(client, namespace.as_deref())
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(kerr)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    kind: String,
    reason: String,
    message: String,
    count: i64,
    last_seen: Option<String>,
    source: String,
}

#[tauri::command]
pub async fn list_events(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
    uid: String,
) -> Result<Vec<EventInfo>> {
    let client = state.client(&context).await?;
    let api: Api<k8s_openapi::api::core::v1::Event> = match namespace.as_deref() {
        Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
        _ => Api::all(client),
    };
    let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let list = api.list(&lp).await.map_err(kerr)?;
    let mut out: Vec<EventInfo> = list
        .items
        .into_iter()
        .map(|e| {
            let last = e
                .last_timestamp
                .map(|t| t.0.to_string())
                .or_else(|| e.event_time.map(|t| t.0.to_string()))
                .or_else(|| e.metadata.creation_timestamp.map(|t| t.0.to_string()));
            EventInfo {
                kind: e.type_.unwrap_or_default(),
                reason: e.reason.unwrap_or_default(),
                message: e.message.unwrap_or_default(),
                count: e.count.unwrap_or(1) as i64,
                last_seen: last,
                source: e
                    .source
                    .and_then(|s| s.component)
                    .or(e.reporting_component)
                    .unwrap_or_default(),
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(out)
}

/// Server-side apply a (multi-document) manifest.
#[tauri::command]
pub async fn apply_manifest(
    state: State<'_, AppState>,
    context: String,
    yaml: String,
    default_namespace: Option<String>,
) -> Result<Vec<String>> {
    let client = state.client(&context).await?;
    let resources = discover(state.clone(), context.clone(), None).await?;
    let by_gvk: HashMap<(String, String, String), &ResourceInfo> = resources
        .iter()
        .map(|r| ((r.group.clone(), r.version.clone(), r.kind.clone()), r))
        .collect();

    let docs = serde_yaml::Deserializer::from_str(&yaml)
        .map(Value::deserialize)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut applied = Vec::new();
    for v in docs.into_iter().filter(|v| !v.is_null()) {
        let obj: DynamicObject = serde_json::from_value(v).map_err(err)?;
        let types = obj.types.as_ref().ok_or("document missing apiVersion/kind")?;
        let gvk = GroupVersionKind::try_from(types).map_err(err)?;
        let res = by_gvk
            .get(&(gvk.group.clone(), gvk.version.clone(), gvk.kind.clone()))
            .ok_or_else(|| format!("unknown resource type {}/{}", types.api_version, types.kind))?;
        let name = obj.metadata.name.clone().ok_or("document missing metadata.name")?;
        let ns = obj
            .metadata
            .namespace
            .clone()
            .or_else(|| default_namespace.clone())
            .unwrap_or_else(|| client.default_namespace().to_string());
        res.api(client.clone(), Some(&ns))
            .patch(
                &name,
                &PatchParams::apply(FIELD_MANAGER).force(),
                &Patch::Apply(&obj),
            )
            .await
            .map_err(|e| format!("{}/{name}: {}", types.kind, kerr(e)))?;
        applied.push(format!("{}/{name}", types.kind.to_lowercase()));
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------
// Counts & permissions
// ---------------------------------------------------------------------------

/// Object counts per resource via `limit=1` + `remainingItemCount` (no full lists).
/// `None` where the count isn't available (forbidden, or the API omits the count).
#[tauri::command]
pub async fn count_resources(
    state: State<'_, AppState>,
    context: String,
    resources: Vec<ResourceInfo>,
    namespace: Option<String>,
) -> Result<Vec<Option<u64>>> {
    let client = state.client(&context).await?;
    let ns = namespace.filter(|n| !n.is_empty());
    let tasks = resources.iter().map(|r| {
        let client = client.clone();
        let url = format!("{}?limit=1", r.collection_url(ns.as_deref()));
        async move {
            let req = http::Request::get(url)
                .header(
                    http::header::ACCEPT,
                    "application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io,application/json",
                )
                .body(vec![])
                .ok()?;
            let v: Value = client.request(req).await.ok()?;
            let items = v["items"].as_array().map(|a| a.len() as u64)?;
            let more = v["metadata"]["remainingItemCount"].as_u64();
            let has_continue = v["metadata"]["continue"].as_str().is_some_and(|c| !c.is_empty());
            match (more, has_continue) {
                (Some(m), _) => Some(items + m),
                (None, false) => Some(items),
                // More pages but no count: unknown.
                (None, true) => None,
            }
        }
    });
    Ok(futures::future::join_all(tasks).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    group: String,
    resource: String,
    #[serde(default)]
    subresource: Option<String>,
    verb: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// `kubectl auth can-i` for a batch of checks (SelfSubjectAccessReview).
/// Checks that can't be evaluated come back `true` so the UI never hides actions by mistake.
#[tauri::command]
pub async fn can_i(state: State<'_, AppState>, context: String, checks: Vec<AccessCheck>) -> Result<Vec<bool>> {
    use k8s_openapi::api::authorization::v1::{ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec};
    let client = state.client(&context).await?;
    let api: Api<SelfSubjectAccessReview> = Api::all(client);
    let tasks = checks.into_iter().map(|c| {
        let api = api.clone();
        async move {
            let review = SelfSubjectAccessReview {
                spec: SelfSubjectAccessReviewSpec {
                    resource_attributes: Some(ResourceAttributes {
                        group: Some(c.group),
                        resource: Some(c.resource),
                        subresource: c.subresource,
                        verb: Some(c.verb),
                        namespace: c.namespace.filter(|n| !n.is_empty()),
                        name: c.name,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            };
            match api.create(&PostParams::default(), &review).await {
                Ok(r) => r.status.map(|s| s.allowed).unwrap_or(true),
                Err(_) => true,
            }
        }
    });
    Ok(futures::future::join_all(tasks).await)
}
