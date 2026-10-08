//! Resource metrics: live usage from metrics-server, history from Prometheus
//! (auto-detected, queried through the API server's service proxy).

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::Service;
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

pub(crate) fn qty(map: &Option<BTreeMap<String, Quantity>>, key: &str) -> f64 {
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

fn pod_usage(item: &Value) -> Usage {
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
}

fn node_usage(item: &Value) -> Usage {
    let (cpu, memory) = usage_of(&item["usage"]);
    Usage {
        namespace: None,
        name: item["metadata"]["name"].as_str().unwrap_or_default().into(),
        cpu,
        memory,
        containers: vec![],
    }
}

/// A list, or one object when `name` is set (empty if metrics-server has nothing for it yet).
async fn usage_list(client: &Client, path: &str, name: bool, parse: fn(&Value) -> Usage) -> Result<Vec<Usage>> {
    let req = http::Request::get(path).body(vec![]).map_err(err)?;
    match client.request::<Value>(req).await {
        Ok(v) if name => Ok(vec![parse(&v)]),
        Ok(v) => Ok(v["items"].as_array().into_iter().flatten().map(parse).collect()),
        Err(kube::Error::Api(e)) if name && e.code == 404 => Ok(vec![]),
        Err(e) => Err(kerr(e)),
    }
}

/// Current pod usage from metrics-server. `namespace` None = all; `selector` narrows to a workload;
/// `name` fetches just that pod.
#[tauri::command]
pub async fn pod_metrics(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
    selector: Option<String>,
    name: Option<String>,
) -> Result<Vec<Usage>> {
    let client = state.client(&context).await?;
    let ns = namespace.filter(|n| !n.is_empty());
    let name = name.filter(|n| !n.is_empty());
    let mut path = match (&ns, &name) {
        (Some(ns), Some(name)) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods/{name}"),
        (Some(ns), None) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"),
        (None, _) => "/apis/metrics.k8s.io/v1beta1/pods".into(),
    };
    let single = ns.is_some() && name.is_some();
    if let Some(sel) = selector.filter(|s| !s.is_empty() && !single) {
        path.push_str("?labelSelector=");
        path.push_str(&urlencode(&sel));
    }
    usage_list(&client, &path, single, pod_usage).await
}

#[tauri::command]
pub async fn node_metrics(state: State<'_, AppState>, context: String, name: Option<String>) -> Result<Vec<Usage>> {
    let client = state.client(&context).await?;
    match name.filter(|n| !n.is_empty()) {
        Some(n) => usage_list(&client, &format!("/apis/metrics.k8s.io/v1beta1/nodes/{n}"), true, node_usage).await,
        None => usage_list(&client, "/apis/metrics.k8s.io/v1beta1/nodes", false, node_usage).await,
    }
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
    let services = Api::<Service>::all(client.clone()).list(&ListParams::default().match_any()).await.ok()?;
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
