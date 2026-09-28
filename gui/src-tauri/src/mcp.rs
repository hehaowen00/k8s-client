//! Built-in MCP server: Streamable HTTP (plain JSON responses) on 127.0.0.1, bearer-token auth, read-only.
//! Each cluster exposes only what Settings → Clusters → MCP access allows, re-read on every call.
//! Every tool call is recorded in an in-memory access log shown in Settings.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, ListParams, LogParams};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::kube_ops::{self, ResourceInfo};
use crate::settings::McpAccess;
use crate::state::{err, kerr, AppState, Result};

const MAX_ROWS: usize = 500;
const LOG_SIZE: usize = 500;

#[derive(Default)]
pub struct McpServer {
    stop: Mutex<Option<CancellationToken>>,
    /// None = stopped; Some(Ok(url)) running; Some(Err) failed to start.
    status: Mutex<Option<std::result::Result<String, String>>>,
    log: Mutex<VecDeque<AccessEntry>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    time_ms: u64,
    tool: String,
    cluster: String,
    target: String,
    /// "ok" | "denied" | "error"
    outcome: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    running: bool,
    url: Option<String>,
    error: Option<String>,
}

/// Why a call failed: the user's rules said no, or the cluster did.
enum Fail {
    Denied(String),
    Error(String),
}

impl From<String> for Fail {
    fn from(e: String) -> Self {
        Fail::Error(e)
    }
}

type ToolResult = std::result::Result<(String, String), Fail>; // (text for the model, detail for the log)

/// Stop the server (if any) and start it again when enabled in settings.
pub fn restart(app: &AppHandle) {
    let srv = app.state::<McpServer>();
    if let Some(t) = srv.stop.lock().unwrap().take() {
        t.cancel();
    }
    let (enabled, port, token) = {
        let st = app.state::<AppState>();
        let mut s = st.settings.lock().unwrap();
        if s.mcp_enabled && s.mcp_token.is_none() {
            s.mcp_token = Some(uuid::Uuid::new_v4().simple().to_string());
            let _ = crate::settings::save(&s);
        }
        (s.mcp_enabled, s.mcp_port, s.mcp_token.clone().unwrap_or_default())
    };
    if !enabled {
        *srv.status.lock().unwrap() = None;
        let _ = app.emit("mcp-status", ());
        return;
    }
    let cancel = CancellationToken::new();
    *srv.stop.lock().unwrap() = Some(cancel.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The previous listener may still be releasing the port.
        let mut bound = Err(std::io::Error::other("unbound"));
        for _ in 0..10 {
            bound = TcpListener::bind(("127.0.0.1", port)).await;
            if bound.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let srv = app.state::<McpServer>();
        let listener = match bound {
            Ok(l) => l,
            Err(e) => {
                *srv.status.lock().unwrap() = Some(Err(format!("can't listen on 127.0.0.1:{port}: {e}")));
                let _ = app.emit("mcp-status", ());
                return;
            }
        };
        *srv.status.lock().unwrap() = Some(Ok(format!("http://127.0.0.1:{port}/mcp")));
        let _ = app.emit("mcp-status", ());
        loop {
            let stream = tokio::select! {
                _ = cancel.cancelled() => break,
                r = listener.accept() => match r { Ok((s, _)) => s, Err(_) => continue },
            };
            let (app, token, cancel) = (app.clone(), token.clone(), cancel.clone());
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| handle(app.clone(), token.clone(), req));
                let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc);
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = conn => {}
                }
            });
        }
    });
}

fn reply(code: StatusCode, body: Value) -> Response<Full<Bytes>> {
    let bytes = if body.is_null() { vec![] } else { serde_json::to_vec(&body).unwrap_or_default() };
    Response::builder()
        .status(code)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}

async fn handle(app: AppHandle, token: String, req: Request<Incoming>) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    // DNS-rebinding guard (the spec requires Origin validation); non-browser clients send no Origin.
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
        let local = ["http://localhost", "http://127.0.0.1"]
            .iter()
            .any(|p| origin == *p || origin.starts_with(&format!("{p}:")));
        if !local {
            return Ok(reply(StatusCode::FORBIDDEN, Value::Null));
        }
    }
    // ponytail: plain string compare; constant-time compare if this ever listens beyond loopback.
    let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok());
    if auth != Some(&format!("Bearer {token}")) {
        return Ok(reply(StatusCode::UNAUTHORIZED, json!({"error": "missing or wrong bearer token"})));
    }
    if req.uri().path() != "/mcp" {
        return Ok(reply(StatusCode::NOT_FOUND, Value::Null));
    }
    // No server-initiated streams: GET (SSE) and DELETE (sessions) aren't offered.
    if req.method() != Method::POST {
        return Ok(reply(StatusCode::METHOD_NOT_ALLOWED, Value::Null));
    }
    let Ok(body) = req.into_body().collect().await else {
        return Ok(reply(StatusCode::BAD_REQUEST, Value::Null));
    };
    let Ok(msg) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
        return Ok(reply(StatusCode::BAD_REQUEST, json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}})));
    };
    // Notifications and responses carry no id.
    let Some(id) = msg.get("id").cloned() else {
        return Ok(reply(StatusCode::ACCEPTED, Value::Null));
    };
    let out = match rpc(&app, msg["method"].as_str().unwrap_or_default(), &msg["params"]).await {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    };
    Ok(reply(StatusCode::OK, out))
}

async fn rpc(app: &AppHandle, method: &str, params: &Value) -> std::result::Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            let version = if ["2025-06-18", "2025-03-26", "2024-11-05"].contains(&asked) { asked } else { "2025-06-18" };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "kube-portal", "version": app.package_info().version.to_string()},
                "instructions": "Read-only access to the Kubernetes clusters the user shared from Kube Portal. Start with list_clusters to see which clusters, resource types and data are allowed.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let args = &params["arguments"];
            let res = call_tool(app, name, args).await;
            let cluster = args["cluster"].as_str().unwrap_or_default().to_string();
            let target = describe(name, args);
            let (outcome, detail, text, is_error) = match res {
                Ok((text, detail)) => ("ok", detail, text, false),
                Err(Fail::Denied(m)) => ("denied", m.clone(), m, true),
                Err(Fail::Error(m)) => ("error", m.clone(), m, true),
            };
            record(app, AccessEntry {
                time_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                tool: name.to_string(),
                cluster,
                target,
                outcome: outcome.into(),
                detail,
            });
            Ok(json!({"content": [{"type": "text", "text": text}], "isError": is_error}))
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    }
}

fn record(app: &AppHandle, entry: AccessEntry) {
    let srv = app.state::<McpServer>();
    let mut log = srv.log.lock().unwrap();
    if log.len() == LOG_SIZE {
        log.pop_front();
    }
    log.push_back(entry.clone());
    let _ = app.emit("mcp-access", entry);
}

/// Short "what was asked for" for the access log.
fn describe(tool: &str, a: &Value) -> String {
    let s = |k: &str| a[k].as_str().unwrap_or_default();
    let ns = |k: &str| if s(k).is_empty() { String::new() } else { format!(" in {}", s(k)) };
    match tool {
        "list_resources" => format!("{}{}{}", s("resource"), ns("namespace"), if s("labelSelector").is_empty() { String::new() } else { format!(" [{}]", s("labelSelector")) }),
        "get_resource" => format!("{}/{}{}", s("resource"), s("name"), ns("namespace")),
        "get_logs" => format!("pod/{}{}{}", s("pod"), if s("container").is_empty() { String::new() } else { format!(" ({})", s("container")) }, ns("namespace")),
        "list_events" => format!("events{}{}", if s("name").is_empty() { String::new() } else { format!(" for {}", s("name")) }, ns("namespace")),
        _ => String::new(),
    }
}

fn tools() -> Value {
    let cluster = json!({"type": "string", "description": "Cluster id from list_clusters"});
    let ns = json!({"type": "string", "description": "Namespace; omit for every allowed namespace"});
    json!([
        {
            "name": "list_clusters",
            "description": "Clusters shared with you, and per cluster the allowed resource types, namespaces and data (objects / logs / events).",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "list_resources",
            "description": "kubectl-style table (the columns `kubectl get` shows) of one allowed resource type.",
            "inputSchema": {"type": "object", "required": ["cluster", "resource"], "properties": {
                "cluster": cluster, "namespace": ns,
                "resource": {"type": "string", "description": "Resource type id from list_clusters, e.g. pods or deployments.apps"},
                "labelSelector": {"type": "string"},
            }},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "get_resource",
            "description": "Full manifest (YAML) of one object. Only where the cluster allows objects; Secret values are always redacted.",
            "inputSchema": {"type": "object", "required": ["cluster", "resource", "name"], "properties": {
                "cluster": cluster, "resource": {"type": "string"}, "name": {"type": "string"},
                "namespace": {"type": "string", "description": "Required for namespaced resources"},
            }},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "get_logs",
            "description": "Recent log lines of a pod container. Only where the cluster allows logs.",
            "inputSchema": {"type": "object", "required": ["cluster", "namespace", "pod"], "properties": {
                "cluster": cluster, "namespace": {"type": "string"}, "pod": {"type": "string"},
                "container": {"type": "string"},
                "tailLines": {"type": "integer", "description": "Default 200, max 2000"},
                "previous": {"type": "boolean", "description": "Logs of the previous (crashed) container"},
            }},
            "annotations": {"readOnlyHint": true},
        },
        {
            "name": "list_events",
            "description": "Recent events, newest first, optionally for one object name. Only where the cluster allows events.",
            "inputSchema": {"type": "object", "required": ["cluster"], "properties": {
                "cluster": cluster, "namespace": ns, "name": {"type": "string", "description": "Involved object name"},
            }},
            "annotations": {"readOnlyHint": true},
        },
    ])
}

fn arg<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a[k].as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn need<'a>(a: &'a Value, k: &str) -> std::result::Result<&'a str, Fail> {
    arg(a, k).ok_or_else(|| Fail::Error(format!("missing argument: {k}")))
}

/// Resource type id as users write it in settings: `pods`, `deployments.apps`.
pub fn resource_id(r: &ResourceInfo) -> String {
    if r.group.is_empty() {
        r.plural.clone()
    } else {
        format!("{}.{}", r.plural, r.group)
    }
}

fn access(state: &AppState, cluster: &str) -> std::result::Result<McpAccess, Fail> {
    let a = state.cluster_settings(cluster).mcp;
    // Unknown clusters look the same as unshared ones.
    if !a.enabled {
        return Err(Fail::Denied(format!("cluster \"{cluster}\" is not shared over MCP")));
    }
    Ok(a)
}

fn check_ns(a: &McpAccess, ns: &str) -> std::result::Result<(), Fail> {
    if a.namespaces.is_empty() || a.namespaces.iter().any(|n| n == ns) {
        Ok(())
    } else {
        Err(Fail::Denied(format!("namespace \"{ns}\" is not shared")))
    }
}

/// Namespaces to query: the one asked for (if allowed), else all (None) or each allowed one.
fn target_namespaces(a: &McpAccess, asked: Option<&str>) -> std::result::Result<Vec<Option<String>>, Fail> {
    match asked {
        Some(ns) => check_ns(a, ns).map(|_| vec![Some(ns.to_string())]),
        None if a.namespaces.is_empty() => Ok(vec![None]),
        None => Ok(a.namespaces.iter().cloned().map(Some).collect()),
    }
}

async fn resolve(state: &AppState, cluster: &str, a: &McpAccess, id: &str) -> std::result::Result<ResourceInfo, Fail> {
    if !a.resources.iter().any(|r| r == id) {
        return Err(Fail::Denied(format!("resource type \"{id}\" is not shared on this cluster")));
    }
    let all = kube_ops::discover_resources(state, cluster, false).await?;
    all.iter()
        .find(|r| resource_id(r) == id)
        .cloned()
        .ok_or_else(|| Fail::Error(format!("the cluster has no resource type \"{id}\"")))
}

async fn call_tool(app: &AppHandle, name: &str, a: &Value) -> ToolResult {
    let state = app.state::<AppState>();
    let state: &AppState = &state;
    match name {
        "list_clusters" => {
            let clusters = state.settings.lock().unwrap().clusters.clone();
            let shared: Vec<Value> = clusters
                .iter()
                .filter(|(_, c)| c.mcp.enabled)
                .map(|(id, c)| json!({
                    "cluster": id,
                    "name": c.display_name.clone().unwrap_or_else(|| id.clone()),
                    "resources": c.mcp.resources,
                    "namespaces": if c.mcp.namespaces.is_empty() { json!("all") } else { json!(c.mcp.namespaces) },
                    "objects": c.mcp.objects,
                    "logs": c.mcp.logs,
                    "events": c.mcp.events,
                }))
                .collect();
            let detail = format!("{} cluster(s)", shared.len());
            Ok((serde_json::to_string_pretty(&shared).map_err(err)?, detail))
        }
        "list_resources" => {
            let cluster = need(a, "cluster")?;
            let acc = access(state, cluster)?;
            let res = resolve(state, cluster, &acc, need(a, "resource")?).await?;
            let targets = if res.namespaced { target_namespaces(&acc, arg(a, "namespace"))? } else { vec![None] };
            let client = state.client(cluster).await?;
            let mut columns = Vec::new();
            let mut rows = Vec::new();
            for ns in targets {
                let mut url = format!("{}?", res.collection_url(ns.as_deref()));
                if let Some(l) = arg(a, "labelSelector") {
                    url.push_str(&format!("labelSelector={}&", kube_ops::urlencode(l)));
                }
                let (cols, r, _, _) = kube_ops::list_table(&client, &url, &res).await?;
                columns = cols;
                rows.extend(r);
            }
            let total = rows.len();
            let rows: Vec<Value> = rows
                .into_iter()
                .take(MAX_ROWS)
                .filter_map(|r| {
                    let mut v = serde_json::to_value(r).ok()?;
                    v.as_object_mut()?.remove("uid");
                    Some(v)
                })
                .collect();
            let names: Vec<Value> = columns.into_iter().filter_map(|c| serde_json::to_value(c).ok().map(|v| v["name"].clone())).collect();
            let out = json!({"columns": names, "rows": rows, "total": total, "truncated": total > MAX_ROWS});
            Ok((serde_json::to_string(&out).map_err(err)?, format!("{total} row(s)")))
        }
        "get_resource" => {
            let cluster = need(a, "cluster")?;
            let acc = access(state, cluster)?;
            if !acc.objects {
                return Err(Fail::Denied("full objects are not shared on this cluster; use list_resources".into()));
            }
            let res = resolve(state, cluster, &acc, need(a, "resource")?).await?;
            let ns = if res.namespaced {
                let ns = need(a, "namespace")?;
                check_ns(&acc, ns)?;
                Some(ns)
            } else {
                None
            };
            let client = state.client(cluster).await?;
            let obj = res.api(client, ns).get(need(a, "name")?).await.map_err(kerr)?;
            let mut v = serde_json::to_value(obj).map_err(err)?;
            kube_ops::strip_noise(&mut v);
            if res.kind == "Secret" {
                for key in ["data", "stringData"] {
                    if let Some(m) = v.get_mut(key).and_then(Value::as_object_mut) {
                        m.values_mut().for_each(|x| *x = json!("<redacted>"));
                    }
                }
            }
            let yaml = serde_yaml::to_string(&v).map_err(err)?;
            let detail = format!("{} bytes", yaml.len());
            Ok((yaml, detail))
        }
        "get_logs" => {
            let cluster = need(a, "cluster")?;
            let acc = access(state, cluster)?;
            if !acc.logs {
                return Err(Fail::Denied("logs are not shared on this cluster".into()));
            }
            let ns = need(a, "namespace")?;
            check_ns(&acc, ns)?;
            let client = state.client(cluster).await?;
            let lp = LogParams {
                container: arg(a, "container").map(String::from),
                tail_lines: Some(a["tailLines"].as_i64().unwrap_or(200).clamp(1, 2000)),
                previous: a["previous"].as_bool().unwrap_or(false),
                ..Default::default()
            };
            let text = Api::<Pod>::namespaced(client, ns).logs(need(a, "pod")?, &lp).await.map_err(kerr)?;
            let detail = format!("{} line(s)", text.lines().count());
            Ok((text, detail))
        }
        "list_events" => {
            let cluster = need(a, "cluster")?;
            let acc = access(state, cluster)?;
            if !acc.events {
                return Err(Fail::Denied("events are not shared on this cluster".into()));
            }
            let client = state.client(cluster).await?;
            let mut lp = ListParams::default();
            if let Some(n) = arg(a, "name") {
                lp = lp.fields(&format!("involvedObject.name={n}"));
            }
            let mut events = Vec::new();
            for ns in target_namespaces(&acc, arg(a, "namespace"))? {
                let api: Api<Event> = match ns.as_deref() {
                    Some(ns) => Api::namespaced(client.clone(), ns),
                    None => Api::all(client.clone()),
                };
                events.extend(api.list(&lp).await.map_err(kerr)?.items);
            }
            let when = |e: &Event| {
                e.last_timestamp.as_ref().map(|t| t.0.to_string())
                    .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()))
                    .or_else(|| e.metadata.creation_timestamp.as_ref().map(|t| t.0.to_string()))
                    .unwrap_or_default()
            };
            events.sort_by_key(|e| std::cmp::Reverse(when(e)));
            let total = events.len();
            let lines: Vec<String> = events
                .iter()
                .take(MAX_ROWS)
                .map(|e| {
                    let o = &e.involved_object;
                    format!(
                        "{} {} {} {}/{}{} x{}: {}",
                        when(e),
                        e.type_.as_deref().unwrap_or_default(),
                        e.reason.as_deref().unwrap_or_default(),
                        o.kind.as_deref().unwrap_or_default(),
                        o.name.as_deref().unwrap_or_default(),
                        o.namespace.as_deref().map(|n| format!(" ({n})")).unwrap_or_default(),
                        e.count.unwrap_or(1),
                        e.message.as_deref().unwrap_or_default().trim(),
                    )
                })
                .collect();
            Ok((lines.join("\n"), format!("{total} event(s)")))
        }
        _ => Err(Fail::Error(format!("unknown tool: {name}"))),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mcp_status(srv: State<'_, McpServer>) -> McpStatus {
    match srv.status.lock().unwrap().clone() {
        None => McpStatus { running: false, url: None, error: None },
        Some(Ok(url)) => McpStatus { running: true, url: Some(url), error: None },
        Some(Err(e)) => McpStatus { running: false, url: None, error: Some(e) },
    }
}

#[tauri::command]
pub fn mcp_access_log(srv: State<'_, McpServer>) -> Vec<AccessEntry> {
    srv.log.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn mcp_clear_log(srv: State<'_, McpServer>) {
    srv.log.lock().unwrap().clear();
}

/// New token; connected clients must be reconfigured.
#[tauri::command]
pub fn mcp_regenerate_token(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut s = state.settings.lock().unwrap();
        s.mcp_token = Some(token.clone());
        crate::settings::save(&s)?;
    }
    restart(&app);
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_rules() {
        let all = McpAccess { enabled: true, ..Default::default() };
        let some = McpAccess { enabled: true, namespaces: vec!["a".into(), "b".into()], ..Default::default() };
        assert!(matches!(target_namespaces(&all, None).ok().as_deref(), Some([None])));
        assert!(matches!(target_namespaces(&all, Some("x")).ok().as_deref(), Some([Some(n)]) if n == "x"));
        assert_eq!(target_namespaces(&some, None).ok().unwrap().len(), 2);
        assert!(matches!(target_namespaces(&some, Some("x")), Err(Fail::Denied(_))));
        assert!(check_ns(&some, "b").is_ok());
        let core = ResourceInfo { group: "".into(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true, verbs: vec![] };
        let apps = ResourceInfo { group: "apps".into(), plural: "deployments".into(), ..core.clone() };
        assert_eq!(resource_id(&core), "pods");
        assert_eq!(resource_id(&apps), "deployments.apps");
    }
}
