//! The cluster overview, computed from watches instead of listing every pod and workload on each
//! refresh. Each object is reduced to the few numbers the overview needs as it arrives. Watches
//! start on the first request for a (cluster, namespace) and stop once the overview goes unused.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Event as KubeEvent, Node, Pod};
use kube::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::kube_ops::urlencode;
use crate::metrics::qty;
use crate::state::{AppState, Result};
use crate::strings;
use crate::watch::{list_watch, Event};

const IDLE_STOP: Duration = Duration::from_secs(90);
const FIRST_SYNC_WAIT: Duration = Duration::from_secs(15);

#[derive(Serialize, Default, Clone)]
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

#[derive(Serialize, Default, Clone)]
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

#[derive(Clone, Copy)]
enum Health {
    Healthy,
    Progressing,
    Failed,
}

#[derive(Default)]
struct PodSummary {
    phase: String,
    /// cpu requests, memory requests, cpu limits, memory limits
    resources: [f64; 4],
}

/// Objects of one kind by uid, reduced to what the overview needs.
struct Kind<T> {
    items: HashMap<String, T>,
    synced: bool,
    error: Option<String>,
}

impl<T> Default for Kind<T> {
    fn default() -> Self {
        Kind {
            items: HashMap::new(),
            synced: false,
            error: None,
        }
    }
}

impl<T> Kind<T> {
    fn settled(&self) -> bool {
        self.synced || self.error.is_some()
    }
}

#[derive(Default)]
struct Stores {
    server_version: String,
    nodes: Kind<NodeSummary>,
    pods: Kind<PodSummary>,
    deployments: Kind<Health>,
    statefulsets: Kind<Health>,
    daemonsets: Kind<Health>,
    jobs: Kind<Health>,
    warnings: Kind<WarningEvent>,
    namespaces: Kind<()>,
}

pub struct OverviewWatch {
    stores: Arc<Mutex<Stores>>,
    token: CancellationToken,
    last_used: Mutex<Instant>,
    cluster_wide: bool,
}

impl OverviewWatch {
    pub fn stop(&self) {
        self.token.cancel();
    }
}

fn node_summary(n: Node) -> NodeSummary {
    let status = n.status.unwrap_or_default();
    let mut roles: Vec<String> = n
        .metadata
        .labels
        .unwrap_or_default()
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/").map(String::from))
        .collect();
    roles.sort();
    NodeSummary {
        name: n.metadata.name.unwrap_or_default(),
        ready: status
            .conditions
            .iter()
            .flatten()
            .any(|c| c.type_ == "Ready" && c.status == "True"),
        unschedulable: n.spec.and_then(|s| s.unschedulable).unwrap_or(false),
        roles,
        cpu_allocatable: qty(&status.allocatable, "cpu"),
        memory_allocatable: qty(&status.allocatable, "memory"),
        pods_allocatable: qty(&status.allocatable, "pods"),
        kubelet_version: status
            .node_info
            .map(|i| i.kubelet_version)
            .unwrap_or_default(),
    }
}

fn pod_summary(p: Pod) -> PodSummary {
    let phase = p
        .status
        .and_then(|s| s.phase)
        .unwrap_or_else(|| "Unknown".into());
    let mut resources = [0.0; 4];
    // Requests/limits only count pods that hold resources.
    if phase == "Running" || phase == "Pending" {
        for r in p
            .spec
            .iter()
            .flat_map(|s| s.containers.iter())
            .filter_map(|c| c.resources.as_ref())
        {
            resources[0] += qty(&r.requests, "cpu");
            resources[1] += qty(&r.requests, "memory");
            resources[2] += qty(&r.limits, "cpu");
            resources[3] += qty(&r.limits, "memory");
        }
    }
    PodSummary { phase, resources }
}

fn deployment_health(d: Deployment) -> Health {
    let want = d.spec.and_then(|s| s.replicas).unwrap_or(1);
    let st = d.status.unwrap_or_default();
    let ready = st.ready_replicas.unwrap_or(0);
    if ready >= want {
        Health::Healthy
    } else if st.unavailable_replicas.unwrap_or(0) > 0 && ready == 0 && want > 0 {
        Health::Failed
    } else {
        Health::Progressing
    }
}

fn statefulset_health(s: StatefulSet) -> Health {
    let want = s.spec.and_then(|s| s.replicas).unwrap_or(1);
    let ready = s.status.and_then(|s| s.ready_replicas).unwrap_or(0);
    if ready >= want {
        Health::Healthy
    } else {
        Health::Progressing
    }
}

fn daemonset_health(d: DaemonSet) -> Health {
    let st = d.status.unwrap_or_default();
    if st.number_ready >= st.desired_number_scheduled {
        Health::Healthy
    } else {
        Health::Progressing
    }
}

fn job_health(j: Job) -> Health {
    let st = j.status.unwrap_or_default();
    if st.failed.unwrap_or(0) > 0 && st.succeeded.unwrap_or(0) == 0 && st.active.unwrap_or(0) == 0 {
        Health::Failed
    } else if st.active.unwrap_or(0) > 0 {
        Health::Progressing
    } else {
        Health::Healthy
    }
}

fn warning_event(e: KubeEvent) -> WarningEvent {
    let last_seen = e
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
        last_seen,
    }
}

fn spawn_kind<K: DeserializeOwned + 'static, T: Send + 'static>(
    client: &Client,
    url: String,
    stores: &Arc<Mutex<Stores>>,
    token: &CancellationToken,
    pick: fn(&mut Stores) -> &mut Kind<T>,
    summarize: fn(K) -> T,
) {
    let (client, stores, token) = (client.clone(), stores.clone(), token.clone());
    let parse = move |v: Value| -> Option<(String, T)> {
        let uid = v["metadata"]["uid"].as_str()?.to_string();
        Some((uid, summarize(serde_json::from_value(v).ok()?)))
    };
    tokio::spawn(async move {
        list_watch(&client, &url, "application/json", true, &token, |ev| {
            let mut s = stores.lock().unwrap();
            let kind = pick(&mut s);
            match ev {
                Event::Listed(mut v) => {
                    kind.items.clear();
                    if let Value::Array(items) = v["items"].take() {
                        kind.items.extend(items.into_iter().filter_map(parse));
                    }
                    kind.synced = true;
                    kind.error = None;
                }
                Event::Upsert(v) => {
                    if let Some((uid, t)) = parse(v) {
                        kind.items.insert(uid, t);
                    }
                }
                Event::Delete(v) => {
                    if let Some(uid) = v["metadata"]["uid"].as_str() {
                        kind.items.remove(uid);
                    }
                }
                Event::Error(e) => kind.error = Some(e),
            }
            true
        })
        .await;
    });
}

fn start(client: &Client, namespace: Option<&str>) -> OverviewWatch {
    let stores = Arc::new(Mutex::new(Stores::default()));
    let token = CancellationToken::new();
    let scoped = |prefix: &str, plural: &str| match namespace {
        Some(ns) => format!("{prefix}/namespaces/{ns}/{plural}?"),
        None => format!("{prefix}/{plural}?"),
    };
    spawn_kind(
        client,
        "/api/v1/nodes?".into(),
        &stores,
        &token,
        |s| &mut s.nodes,
        node_summary,
    );
    spawn_kind(
        client,
        scoped("/api/v1", "pods"),
        &stores,
        &token,
        |s| &mut s.pods,
        pod_summary,
    );
    spawn_kind(
        client,
        scoped("/apis/apps/v1", "deployments"),
        &stores,
        &token,
        |s| &mut s.deployments,
        deployment_health,
    );
    spawn_kind(
        client,
        scoped("/apis/apps/v1", "statefulsets"),
        &stores,
        &token,
        |s| &mut s.statefulsets,
        statefulset_health,
    );
    spawn_kind(
        client,
        scoped("/apis/apps/v1", "daemonsets"),
        &stores,
        &token,
        |s| &mut s.daemonsets,
        daemonset_health,
    );
    spawn_kind(
        client,
        scoped("/apis/batch/v1", "jobs"),
        &stores,
        &token,
        |s| &mut s.jobs,
        job_health,
    );
    let events = format!(
        "{}fieldSelector={}&",
        scoped("/api/v1", "events"),
        urlencode("type=Warning")
    );
    spawn_kind(
        client,
        events,
        &stores,
        &token,
        |s| &mut s.warnings,
        warning_event,
    );
    if namespace.is_none() {
        let ns_url = "/api/v1/namespaces?".to_string();
        spawn_kind(
            client,
            ns_url,
            &stores,
            &token,
            |s| &mut s.namespaces,
            |_: Value| (),
        );
    }
    {
        let (client, stores) = (client.clone(), stores.clone());
        tokio::spawn(async move {
            if let Ok(v) = client.apiserver_version().await {
                stores.lock().unwrap().server_version = v.git_version;
            }
        });
    }
    OverviewWatch {
        stores,
        token,
        last_used: Mutex::new(Instant::now()),
        cluster_wide: namespace.is_none(),
    }
}

fn counts(kind: &str, k: &Kind<Health>) -> Option<WorkloadCount> {
    if !k.synced {
        return None;
    }
    let mut w = WorkloadCount {
        kind: kind.into(),
        total: k.items.len(),
        ..Default::default()
    };
    for h in k.items.values() {
        match h {
            Health::Healthy => w.healthy += 1,
            Health::Progressing => w.progressing += 1,
            Health::Failed => w.failed += 1,
        }
    }
    Some(w)
}

fn compute(s: &Stores, cluster_wide: bool) -> Result<Overview> {
    if !s.pods.synced {
        return Err(s
            .pods
            .error
            .clone()
            .unwrap_or_else(|| strings::PODS_STILL_LOADING.into()));
    }
    let mut o = Overview {
        server_version: s.server_version.clone(),
        ..Default::default()
    };
    // Nodes may be forbidden for namespace-scoped users; the rest still works.
    if s.nodes.synced {
        o.nodes = s.nodes.items.values().cloned().collect();
        o.nodes.sort_by(|a, b| a.name.cmp(&b.name));
    }
    o.pods_total = s.pods.items.len();
    for p in s.pods.items.values() {
        *o.pod_phases.entry(p.phase.clone()).or_default() += 1;
        o.cpu_requests += p.resources[0];
        o.memory_requests += p.resources[1];
        o.cpu_limits += p.resources[2];
        o.memory_limits += p.resources[3];
    }
    let mut pods = WorkloadCount {
        kind: "Pod".into(),
        total: o.pods_total,
        ..Default::default()
    };
    for (phase, n) in &o.pod_phases {
        match phase.as_str() {
            "Running" | "Succeeded" => pods.healthy += n,
            "Pending" => pods.progressing += n,
            _ => pods.failed += n,
        }
    }
    o.workloads.push(pods);
    o.workloads.extend(
        [
            counts("Deployment", &s.deployments),
            counts("StatefulSet", &s.statefulsets),
            counts("DaemonSet", &s.daemonsets),
            counts("Job", &s.jobs),
        ]
        .into_iter()
        .flatten(),
    );
    if s.warnings.synced {
        let mut items: Vec<&WarningEvent> = s.warnings.items.values().collect();
        items.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
        o.warnings = items.into_iter().take(50).cloned().collect();
    }
    if cluster_wide && s.namespaces.synced {
        o.namespaces = Some(s.namespaces.items.len());
    }
    Ok(o)
}

fn settled(s: &Stores, cluster_wide: bool) -> bool {
    s.nodes.settled()
        && s.pods.settled()
        && s.deployments.settled()
        && s.statefulsets.settled()
        && s.daemonsets.settled()
        && s.jobs.settled()
        && s.warnings.settled()
        && (!cluster_wide || s.namespaces.settled())
}

/// Stop the watches once nobody has asked for this overview in a while.
fn reap_when_idle(app: AppHandle, key: (String, String), watch: Arc<OverviewWatch>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = watch.token.cancelled() => return,
                _ = tokio::time::sleep(IDLE_STOP / 3) => {}
            }
            if watch.last_used.lock().unwrap().elapsed() > IDLE_STOP {
                app.state::<AppState>().remove_overview(&key, &watch);
                watch.stop();
                return;
            }
        }
    });
}

/// Aggregates for the cluster overview. `namespace` scopes pods/workloads/events; nodes are always cluster-wide.
#[tauri::command]
pub async fn cluster_overview(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
) -> Result<Overview> {
    let ns = namespace.filter(|n| !n.is_empty());
    let key = (context.clone(), ns.clone().unwrap_or_default());
    let watch = match state.overview(&key) {
        Some(w) => w,
        None => {
            let client = state.client(&context).await?;
            let (watch, created) = state.overview_or_insert(&key, || start(&client, ns.as_deref()));
            if created {
                reap_when_idle(app, key, watch.clone());
            }
            watch
        }
    };
    *watch.last_used.lock().unwrap() = Instant::now();
    let deadline = Instant::now() + FIRST_SYNC_WAIT;
    while !settled(&watch.stores.lock().unwrap(), watch.cluster_wide) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let stores = watch.stores.lock().unwrap();
    compute(&stores, watch.cluster_wide)
}
