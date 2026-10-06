//! Node and job operations: drain, node shell pods, triggering CronJobs.

use std::collections::BTreeMap;
use std::time::Duration;

use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Node, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use kube::api::{Api, DeleteParams, EvictParams, ListParams, Patch, PatchParams, PostParams};
use kube::Resource;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::state::{kerr, AppState, Result};

pub const NODE_SHELL_NAMESPACE: &str = "kube-system";
const NODE_SHELL_LABEL: &str = "kubetab.dev/node-shell";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResult {
    evicted: Vec<String>,
    skipped: Vec<String>,
    failed: Vec<String>,
    /// Evicted pods still terminating when we stopped waiting.
    pending: Vec<String>,
}

fn pod_key(p: &Pod) -> String {
    format!(
        "{}/{}",
        p.metadata.namespace.as_deref().unwrap_or_default(),
        p.metadata.name.as_deref().unwrap_or_default()
    )
}

/// Cordon the node, then evict everything except DaemonSet and mirror (static) pods,
/// like `kubectl drain --ignore-daemonsets --delete-emptydir-data`.
#[tauri::command]
pub async fn drain_node(state: State<'_, AppState>, context: String, node: String) -> Result<DrainResult> {
    let client = state.client(&context).await?;
    Api::<Node>::all(client.clone())
        .patch(&node, &PatchParams::default(), &Patch::Merge(json!({ "spec": { "unschedulable": true } })))
        .await
        .map_err(kerr)?;

    let pods = Api::<Pod>::all(client.clone())
        .list(&ListParams::default().fields(&format!("spec.nodeName={node}")))
        .await
        .map_err(kerr)?;
    let mut result = DrainResult { evicted: vec![], skipped: vec![], failed: vec![], pending: vec![] };
    let mut evicted_pods = Vec::new();
    for p in pods.items {
        let key = pod_key(&p);
        let phase = p.status.as_ref().and_then(|s| s.phase.as_deref()).unwrap_or_default();
        let is_ds = p.metadata.owner_references.iter().flatten().any(|o| o.kind == "DaemonSet");
        let is_mirror = p.metadata.annotations.as_ref().is_some_and(|a| a.contains_key("kubernetes.io/config.mirror"));
        if is_ds || is_mirror || phase == "Succeeded" || phase == "Failed" {
            result.skipped.push(key);
            continue;
        }
        let ns = p.metadata.namespace.clone().unwrap_or_default();
        let name = p.metadata.name.clone().unwrap_or_default();
        match Api::<Pod>::namespaced(client.clone(), &ns).evict(&name, &EvictParams::default()).await {
            Ok(_) => {
                result.evicted.push(key);
                evicted_pods.push((ns, name));
            }
            Err(e) => result.failed.push(format!("{key}: {}", kerr(e))),
        }
    }

    // Wait (bounded) for evicted pods to go away.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        let mut remaining = Vec::new();
        for (ns, name) in &evicted_pods {
            if let Ok(Some(_)) = Api::<Pod>::namespaced(client.clone(), ns).get_opt(name).await {
                remaining.push(format!("{ns}/{name}"));
            }
        }
        if remaining.is_empty() || tokio::time::Instant::now() >= deadline {
            result.pending = remaining;
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeShellPod {
    namespace: String,
    pod: String,
}

/// Start a privileged pod on `node` that can `nsenter` into the host (like Lens' node shell).
/// The pod self-destructs after a few hours in case the app never cleans it up.
#[tauri::command]
pub async fn node_shell_create(state: State<'_, AppState>, context: String, node: String) -> Result<NodeShellPod> {
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, NODE_SHELL_NAMESPACE);
    let name = format!("node-shell-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let pod: Pod = serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "name": name, "labels": { NODE_SHELL_LABEL: node } },
        "spec": {
            "nodeName": node,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            "activeDeadlineSeconds": 4 * 3600,
            "hostPID": true,
            "hostIPC": true,
            "hostNetwork": true,
            "tolerations": [{ "operator": "Exists" }],
            "priorityClassName": "system-node-critical",
            "containers": [{
                "name": "shell",
                "image": "docker.io/library/busybox:stable",
                "command": ["sleep", "14400"],
                "securityContext": { "privileged": true },
                "stdin": true,
                "tty": true
            }]
        }
    }))
    .map_err(|e| e.to_string())?;
    api.create(&PostParams::default(), &pod).await.map_err(kerr)?;

    // Wait for it to run.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let p = api.get(&name).await.map_err(kerr)?;
        let status = p.status.unwrap_or_default();
        match status.phase.as_deref() {
            Some("Running") => break,
            Some("Failed") | Some("Succeeded") => {
                let _ = api.delete(&name, &DeleteParams::default()).await;
                return Err(format!("node shell pod ended: {}", status.message.unwrap_or_default()));
            }
            _ => {}
        }
        let waiting = status
            .container_statuses
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.state.and_then(|s| s.waiting))
            .find(|w| matches!(w.reason.as_deref(), Some("ErrImagePull" | "ImagePullBackOff" | "CreateContainerError")));
        if let Some(w) = waiting {
            let _ = api.delete(&name, &DeleteParams::default()).await;
            return Err(format!("node shell pod failed: {} {}", w.reason.unwrap_or_default(), w.message.unwrap_or_default()));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = api.delete(&name, &DeleteParams::default()).await;
            return Err("timed out waiting for node shell pod to start".into());
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    Ok(NodeShellPod { namespace: NODE_SHELL_NAMESPACE.into(), pod: name })
}

/// Create a Job from a CronJob's template now (`kubectl create job --from=cronjob/...`).
#[tauri::command]
pub async fn trigger_cronjob(state: State<'_, AppState>, context: String, namespace: String, name: String) -> Result<String> {
    let client = state.client(&context).await?;
    let cj = Api::<CronJob>::namespaced(client.clone(), &namespace).get(&name).await.map_err(kerr)?;
    let template = cj.spec.job_template.clone();
    let suffix = k8s_openapi::jiff::Timestamp::now().as_second() % 100_000;
    let base: String = name.chars().take(52).collect();
    let job_name = format!("{base}-manual-{suffix}");
    let tmeta = template.metadata.unwrap_or_default();
    let mut annotations: BTreeMap<String, String> = tmeta.annotations.unwrap_or_default();
    annotations.insert("cronjob.kubernetes.io/instantiate".into(), "manual".into());
    let owner = OwnerReference {
        api_version: CronJob::api_version(&()).into(),
        kind: CronJob::kind(&()).into(),
        name: name.clone(),
        uid: cj.metadata.uid.clone().unwrap_or_default(),
        controller: Some(true),
        block_owner_deletion: Some(true),
    };
    let job = Job {
        metadata: ObjectMeta {
            name: Some(job_name.clone()),
            namespace: Some(namespace.clone()),
            labels: tmeta.labels,
            annotations: Some(annotations),
            owner_references: Some(vec![owner]),
            ..Default::default()
        },
        spec: template.spec,
        ..Default::default()
    };
    Api::<Job>::namespaced(client, &namespace).create(&PostParams::default(), &job).await.map_err(kerr)?;
    Ok(job_name)
}
