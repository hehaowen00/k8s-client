//! Resource metrics: live usage from metrics-server, history from Prometheus
//! (auto-detected, queried through the API server's service proxy), and the
//! aggregate numbers behind the cluster overview.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Event, Node, Pod, Service};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::state::{err, kerr, AppState, Result};

/// Parse a Kubernetes quantity ("250m", "1.5", "128Mi", "1e3", "12345n") to a plain number
/// (cores for CPU, bytes for memory).
pub fn parse_quantity(q: &str) -> f64 {
    let q = q.trim();
    let split = q
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(q.len());
    let (num, suffix) = q.split_at(split);
    // Exponent form: "1e3", "1.5E-3".
    if let Some(rest) = suffix.strip_prefix(['e', 'E']) {
        if let (Ok(n), Ok(e)) = (num.parse::<f64>(), rest.parse::<i32>()) {
            return n * 10f64.powi(e);
        }
    }
    let n: f64 = num.parse().unwrap_or(0.0);
    let mult = match suffix {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024f64.powi(2),
        "Gi" => 1024f64.powi(3),
        "Ti" => 1024f64.powi(4),
        "Pi" => 1024f64.powi(5),
        "Ei" => 1024f64.powi(6),
        _ => 1.0,
    };
    n * mult
}

fn qty(map: &Option<BTreeMap<String, Quantity>>, key: &str) -> f64 {
    map.as_ref().and_then(|m| m.get(key)).map(|q| parse_quantity(&q.0)).unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    namespace: Option<String>,
    name: String,
    cpu: f64,
    memory: f64,
    containers: Vec<ContainerUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    name: String,
    cpu: f64,
    memory: f64,
}

async fn raw_json(client: &Client, path: &str) -> Result<Value> {
    let req = http::Request::get(path).body(vec![]).map_err(err)?;
    client.request::<Value>(req).await.map_err(kerr)
}

fn usage_of(v: &Value) -> (f64, f64) {
    (
        v["cpu"].as_str().map(parse_quantity).unwrap_or(0.0),
        v["memory"].as_str().map(parse_quantity).unwrap_or(0.0),
    )
}

/// Current pod usage from metrics-server. `namespace` None = all; `selector` narrows to a workload.
#[tauri::command]
pub async fn pod_metrics(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
    selector: Option<String>,
) -> Result<Vec<Usage>> {
    let client = state.client(&context).await?;
    let mut path = match namespace.as_deref().filter(|n| !n.is_empty()) {
        Some(ns) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"),
        None => "/apis/metrics.k8s.io/v1beta1/pods".into(),
    };
    if let Some(sel) = selector.filter(|s| !s.is_empty()) {
        path.push_str("?labelSelector=");
        path.push_str(&urlencode(&sel));
    }
    let v = raw_json(&client, &path).await?;
    Ok(v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let containers: Vec<ContainerUsage> = item["containers"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| {
                    let (cpu, memory) = usage_of(&c["usage"]);
                    ContainerUsage { name: c["name"].as_str().unwrap_or_default().into(), cpu, memory }
                })
                .collect();
            Usage {
                namespace: item["metadata"]["namespace"].as_str().map(String::from),
                name: item["metadata"]["name"].as_str().unwrap_or_default().into(),
                cpu: containers.iter().map(|c| c.cpu).sum(),
                memory: containers.iter().map(|c| c.memory).sum(),
                containers,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn node_metrics(state: State<'_, AppState>, context: String) -> Result<Vec<Usage>> {
    let client = state.client(&context).await?;
    let v = raw_json(&client, "/apis/metrics.k8s.io/v1beta1/nodes").await?;
    Ok(v["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let (cpu, memory) = usage_of(&item["usage"]);
            Usage {
                namespace: None,
                name: item["metadata"]["name"].as_str().unwrap_or_default().into(),
                cpu,
                memory,
                containers: vec![],
            }
        })
        .collect())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Prometheus
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusTarget {
    pub namespace: String,
    pub service: String,
    pub port: u16,
}

impl PrometheusTarget {
    fn proxy(&self, api_path: &str) -> String {
        format!(
            "/api/v1/namespaces/{}/services/{}:{}/proxy{}",
            self.namespace, self.service, self.port, api_path
        )
    }
}

async fn prometheus_ok(client: &Client, t: &PrometheusTarget) -> bool {
    let path = t.proxy("/api/v1/query?query=vector(1)");
    matches!(raw_json(client, &path).await, Ok(v) if v["status"] == "success")
}

/// Find a Prometheus the user can reach through the API server (common install names first).
async fn detect_prometheus(client: &Client) -> Option<PrometheusTarget> {
    let known = [
        ("monitoring", "prometheus-k8s", 9090),
        ("monitoring", "prometheus-operated", 9090),
        ("monitoring", "kube-prometheus-stack-prometheus", 9090),
        ("monitoring", "prometheus-server", 80),
        ("prometheus", "prometheus-server", 80),
        ("prometheus", "prometheus-operated", 9090),
        ("lens-metrics", "prometheus", 80),
        ("kube-system", "prometheus", 9090),
        ("default", "prometheus-server", 80),
    ];
    for (ns, svc, port) in known {
        let t = PrometheusTarget { namespace: ns.into(), service: svc.into(), port };
        if prometheus_ok(client, &t).await {
            return Some(t);
        }
    }
    // Otherwise any service that looks like Prometheus.
    let services = Api::<Service>::all(client.clone()).list(&ListParams::default()).await.ok()?;
    for s in services.items {
        let name = s.metadata.name.clone().unwrap_or_default();
        let labels = s.metadata.labels.clone().unwrap_or_default();
        let looks = name.contains("prometheus")
            || labels.values().any(|v| v == "prometheus")
            || labels.get("app.kubernetes.io/name").is_some_and(|v| v.contains("prometheus"));
        if !looks || name.contains("alertmanager") || name.contains("operator") || name.contains("pushgateway") {
            continue;
        }
        for p in s.spec.and_then(|sp| sp.ports).unwrap_or_default() {
            let t = PrometheusTarget {
                namespace: s.metadata.namespace.clone().unwrap_or_default(),
                service: name.clone(),
                port: p.port as u16,
            };
            if prometheus_ok(client, &t).await {
                return Some(t);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn prometheus_detect(
    state: State<'_, AppState>,
    context: String,
    refresh: Option<bool>,
) -> Result<Option<PrometheusTarget>> {
    if !refresh.unwrap_or(false) {
        if let Some(cached) = state.prometheus(&context) {
            return Ok(cached);
        }
    }
    let client = state.client(&context).await?;
    let found = detect_prometheus(&client).await;
    state.set_prometheus(&context, found.clone());
    Ok(found)
}

/// Range query per expression; each result is the first series' [unix_seconds, value] points.
#[tauri::command]
pub async fn prometheus_range(
    state: State<'_, AppState>,
    context: String,
    queries: Vec<String>,
    start: f64,
    end: f64,
    step: f64,
) -> Result<Vec<Vec<(f64, f64)>>> {
    let target = match state.prometheus(&context) {
        Some(Some(t)) => t,
        _ => return Err("prometheus not available".into()),
    };
    let client = state.client(&context).await?;
    let mut out = Vec::new();
    for q in queries {
        let path = target.proxy(&format!(
            "/api/v1/query_range?query={}&start={start}&end={end}&step={step}",
            urlencode(&q)
        ));
        let v = raw_json(&client, &path).await?;
        if v["status"] != "success" {
            return Err(v["error"].as_str().unwrap_or("prometheus query failed").to_string());
        }
        let points = v["data"]["result"][0]["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                let t = p[0].as_f64()?;
                let val: f64 = p[1].as_str()?.parse().ok()?;
                val.is_finite().then_some((t, val))
            })
            .collect();
        out.push(points);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Cluster overview
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    name: String,
    ready: bool,
    unschedulable: bool,
    roles: Vec<String>,
    cpu_allocatable: f64,
    memory_allocatable: f64,
    pods_allocatable: f64,
    kubelet_version: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadCount {
    kind: String,
    total: usize,
    healthy: usize,
    progressing: usize,
    failed: usize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WarningEvent {
    namespace: String,
    object: String,
    reason: String,
    message: String,
    count: i64,
    last_seen: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    server_version: String,
    nodes: Vec<NodeSummary>,
    pod_phases: BTreeMap<String, usize>,
    pods_total: usize,
    cpu_requests: f64,
    memory_requests: f64,
    cpu_limits: f64,
    memory_limits: f64,
    workloads: Vec<WorkloadCount>,
    warnings: Vec<WarningEvent>,
    namespaces: Option<usize>,
}

fn is_ready(conds: &Option<Vec<k8s_openapi::api::core::v1::NodeCondition>>) -> bool {
    conds.iter().flatten().any(|c| c.type_ == "Ready" && c.status == "True")
}

/// Aggregates for the cluster overview. `namespace` scopes pods/workloads/events; nodes are always cluster-wide.
#[tauri::command]
pub async fn cluster_overview(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
) -> Result<Overview> {
    let client = state.client(&context).await?;
    let ns = namespace.filter(|n| !n.is_empty());
    macro_rules! api {
        ($t:ty) => {
            match &ns {
                Some(n) => Api::<$t>::namespaced(client.clone(), n),
                None => Api::<$t>::all(client.clone()),
            }
        };
    }
    let lp = ListParams::default();
    let warn_lp = ListParams::default().fields("type=Warning");
    let (node_api, pod_api, dep_api, sts_api, ds_api, job_api, ev_api) = (
        Api::<Node>::all(client.clone()),
        api!(Pod),
        api!(Deployment),
        api!(StatefulSet),
        api!(DaemonSet),
        api!(Job),
        api!(Event),
    );
    let (nodes, pods, deps, sts, dss, jobs, events, version) = tokio::join!(
        node_api.list(&lp),
        pod_api.list(&lp),
        dep_api.list(&lp),
        sts_api.list(&lp),
        ds_api.list(&lp),
        job_api.list(&lp),
        ev_api.list(&warn_lp),
        client.apiserver_version(),
    );
    let mut o = Overview {
        server_version: version.map(|v| v.git_version).unwrap_or_default(),
        ..Default::default()
    };
    // Nodes may be forbidden for namespace-scoped users; the rest still works.
    if let Ok(nodes) = nodes {
        for n in nodes.items {
            let status = n.status.unwrap_or_default();
            let labels = n.metadata.labels.unwrap_or_default();
            let mut roles: Vec<String> = labels
                .keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/").map(String::from))
                .collect();
            roles.sort();
            o.nodes.push(NodeSummary {
                name: n.metadata.name.unwrap_or_default(),
                ready: is_ready(&status.conditions),
                unschedulable: n.spec.and_then(|s| s.unschedulable).unwrap_or(false),
                roles,
                cpu_allocatable: qty(&status.allocatable, "cpu"),
                memory_allocatable: qty(&status.allocatable, "memory"),
                pods_allocatable: qty(&status.allocatable, "pods"),
                kubelet_version: status.node_info.map(|i| i.kubelet_version).unwrap_or_default(),
            });
        }
    }
    let pods = pods.map_err(kerr)?;
    o.pods_total = pods.items.len();
    for p in &pods.items {
        let phase = p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
        let running = phase == "Running" || phase == "Pending";
        *o.pod_phases.entry(phase).or_default() += 1;
        // Requests/limits only count pods that hold resources.
        if running {
            for c in p.spec.iter().flat_map(|s| s.containers.iter()) {
                if let Some(r) = &c.resources {
                    o.cpu_requests += qty(&r.requests, "cpu");
                    o.memory_requests += qty(&r.requests, "memory");
                    o.cpu_limits += qty(&r.limits, "cpu");
                    o.memory_limits += qty(&r.limits, "memory");
                }
            }
        }
    }
    if let Ok(d) = deps {
        let mut w = WorkloadCount { kind: "Deployment".into(), ..Default::default() };
        for x in d.items {
            let want = x.spec.and_then(|s| s.replicas).unwrap_or(1);
            let st = x.status.unwrap_or_default();
            let ready = st.ready_replicas.unwrap_or(0);
            w.total += 1;
            if ready >= want {
                w.healthy += 1;
            } else if st.unavailable_replicas.unwrap_or(0) > 0 && ready == 0 && want > 0 {
                w.failed += 1;
            } else {
                w.progressing += 1;
            }
        }
        o.workloads.push(w);
    }
    if let Ok(s) = sts {
        let mut w = WorkloadCount { kind: "StatefulSet".into(), ..Default::default() };
        for x in s.items {
            let want = x.spec.and_then(|s| s.replicas).unwrap_or(1);
            let ready = x.status.and_then(|s| s.ready_replicas).unwrap_or(0);
            w.total += 1;
            if ready >= want { w.healthy += 1 } else { w.progressing += 1 }
        }
        o.workloads.push(w);
    }
    if let Ok(d) = dss {
        let mut w = WorkloadCount { kind: "DaemonSet".into(), ..Default::default() };
        for x in d.items {
            let st = x.status.unwrap_or_default();
            w.total += 1;
            if st.number_ready >= st.desired_number_scheduled { w.healthy += 1 } else { w.progressing += 1 }
        }
        o.workloads.push(w);
    }
    if let Ok(j) = jobs {
        let mut w = WorkloadCount { kind: "Job".into(), ..Default::default() };
        for x in j.items {
            let st = x.status.unwrap_or_default();
            w.total += 1;
            if st.failed.unwrap_or(0) > 0 && st.succeeded.unwrap_or(0) == 0 && st.active.unwrap_or(0) == 0 {
                w.failed += 1;
            } else if st.active.unwrap_or(0) > 0 {
                w.progressing += 1;
            } else {
                w.healthy += 1;
            }
        }
        o.workloads.push(w);
    }
    {
        let mut w = WorkloadCount { kind: "Pod".into(), total: pods.items.len(), ..Default::default() };
        for (phase, n) in &o.pod_phases {
            match phase.as_str() {
                "Running" | "Succeeded" => w.healthy += n,
                "Pending" => w.progressing += n,
                _ => w.failed += n,
            }
        }
        o.workloads.insert(0, w);
    }
    if let Ok(ev) = events {
        let mut items: Vec<WarningEvent> = ev
            .items
            .into_iter()
            .map(|e| {
                let last = e
                    .last_timestamp
                    .map(|t| t.0.to_string())
                    .or_else(|| e.event_time.map(|t| t.0.to_string()))
                    .or_else(|| e.metadata.creation_timestamp.map(|t| t.0.to_string()));
                WarningEvent {
                    namespace: e.metadata.namespace.unwrap_or_default(),
                    object: format!(
                        "{}/{}",
                        e.involved_object.kind.unwrap_or_default().to_lowercase(),
                        e.involved_object.name.unwrap_or_default()
                    ),
                    reason: e.reason.unwrap_or_default(),
                    message: e.message.unwrap_or_default(),
                    count: e.count.unwrap_or(1) as i64,
                    last_seen: last,
                }
            })
            .collect();
        items.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        items.truncate(50);
        o.warnings = items;
    }
    if ns.is_none() {
        o.namespaces = Api::<k8s_openapi::api::core::v1::Namespace>::all(client)
            .list_metadata(&ListParams::default())
            .await
            .ok()
            .map(|l| l.items.len());
    }
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::parse_quantity as q;

    #[test]
    fn quantities() {
        assert_eq!(q("250m"), 0.25);
        assert_eq!(q("2"), 2.0);
        assert_eq!(q("128Mi"), 128.0 * 1024.0 * 1024.0);
        assert_eq!(q("1Gi"), 1024f64.powi(3));
        assert!((q("123456789n") - 0.123456789).abs() < 1e-12);
        assert_eq!(q("1e3"), 1000.0);
        assert_eq!(q("1k"), 1000.0);
        assert_eq!(q("512Ki"), 512.0 * 1024.0);
    }
}
