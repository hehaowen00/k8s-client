//! Port forwarding to pods and services. Each accepted local connection opens its
//! own forwarding stream; service targets are re-resolved to a ready pod per
//! connection so forwards survive pod restarts and rollouts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::state::{err, kerr, AppState, Result};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: String,
    context: String,
    namespace: String,
    /// "pod" | "service"
    kind: String,
    name: String,
    remote_port: u16,
    local_port: u16,
    connections: u64,
    active_connections: u64,
    last_error: Option<String>,
    /// Pod serving the most recent connection.
    last_pod: Option<String>,
}

struct Forward {
    info: Arc<Mutex<ForwardInfo>>,
    token: CancellationToken,
}

#[derive(Default)]
pub struct Forwards(Mutex<HashMap<String, Forward>>);

impl Forwards {
    fn list(&self) -> Vec<ForwardInfo> {
        let mut v: Vec<ForwardInfo> = self.0.lock().unwrap().values().map(|f| f.info.lock().unwrap().clone()).collect();
        v.sort_by(|a, b| (&a.context, &a.namespace, &a.name, a.remote_port).cmp(&(&b.context, &b.namespace, &b.name, b.remote_port)));
        v
    }
}

fn pod_ready(p: &Pod) -> bool {
    let status = p.status.as_ref();
    status.and_then(|s| s.phase.as_deref()) == Some("Running")
        && status
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        && p.metadata.deletion_timestamp.is_none()
}

/// Resolve a service port to (pod, container port).
async fn resolve_service(client: &Client, ns: &str, svc: &str, port: u16) -> Result<(String, u16)> {
    let svc_obj = Api::<Service>::namespaced(client.clone(), ns).get(svc).await.map_err(kerr)?;
    let spec = svc_obj.spec.ok_or("service has no spec")?;
    let selector = spec.selector.unwrap_or_default();
    if selector.is_empty() {
        return Err(format!("service {svc} has no selector; cannot pick a pod"));
    }
    let sp = spec
        .ports
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.port as u16 == port)
        .ok_or_else(|| format!("service {svc} has no port {port}"))?;
    let labels = selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
    let pods = Api::<Pod>::namespaced(client.clone(), ns)
        .list(&ListParams::default().labels(&labels))
        .await
        .map_err(kerr)?;
    let pod = pods
        .items
        .into_iter()
        .find(pod_ready)
        .ok_or_else(|| format!("no ready pods behind service {svc}"))?;
    let target = match sp.target_port {
        Some(IntOrString::Int(n)) => n as u16,
        Some(IntOrString::String(name)) => pod
            .spec
            .as_ref()
            .into_iter()
            .flat_map(|s| s.containers.iter())
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(name.as_str()))
            .map(|p| p.container_port as u16)
            .ok_or_else(|| format!("no container port named {name}"))?,
        None => port,
    };
    Ok((pod.metadata.name.unwrap_or_default(), target))
}

async fn bind(preferred: Option<u16>, remote: u16) -> Result<TcpListener> {
    if let Some(p) = preferred.filter(|p| *p != 0) {
        return TcpListener::bind(("127.0.0.1", p))
            .await
            .map_err(|e| format!("cannot listen on 127.0.0.1:{p}: {e}"));
    }
    // Like Lens: reuse the remote port number locally when it's free and unprivileged.
    if remote >= 1024 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", remote)).await {
            return Ok(l);
        }
    }
    TcpListener::bind(("127.0.0.1", 0)).await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_port_forward(
    state: State<'_, AppState>,
    forwards: State<'_, Forwards>,
    context: String,
    namespace: String,
    kind: String,
    name: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<ForwardInfo> {
    let client = state.client(&context).await?;
    // Validate the target up front so the user gets an immediate error.
    if kind == "service" {
        resolve_service(&client, &namespace, &name, remote_port).await?;
    } else {
        Api::<Pod>::namespaced(client.clone(), &namespace).get(&name).await.map_err(kerr)?;
    }
    let listener = bind(local_port, remote_port).await?;
    let local = listener.local_addr().map_err(err)?.port();
    let id = uuid::Uuid::new_v4().to_string();
    let info = Arc::new(Mutex::new(ForwardInfo {
        id: id.clone(),
        context,
        namespace: namespace.clone(),
        kind: kind.clone(),
        name: name.clone(),
        remote_port,
        local_port: local,
        connections: 0,
        active_connections: 0,
        last_error: None,
        last_pod: None,
    }));
    let token = CancellationToken::new();
    let result = info.lock().unwrap().clone();
    forwards.0.lock().unwrap().insert(id, Forward { info: info.clone(), token: token.clone() });

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = tokio::select! {
                _ = token.cancelled() => break,
                a = listener.accept() => match a {
                    Ok(a) => a,
                    Err(_) => continue,
                },
            };
            let client = client.clone();
            let info = info.clone();
            let (ns, kind, name) = (namespace.clone(), kind.clone(), name.clone());
            let token = token.clone();
            {
                let mut i = info.lock().unwrap();
                i.connections += 1;
                i.active_connections += 1;
            }
            tokio::spawn(async move {
                let result: Result<()> = async {
                    let (pod, port) = if kind == "service" {
                        resolve_service(&client, &ns, &name, remote_port).await?
                    } else {
                        (name.clone(), remote_port)
                    };
                    info.lock().unwrap().last_pod = Some(pod.clone());
                    let mut pf = Api::<Pod>::namespaced(client, &ns).portforward(&pod, &[port]).await.map_err(kerr)?;
                    let mut upstream = pf.take_stream(port).ok_or("port-forward stream unavailable")?;
                    let error = pf.take_error(port);
                    let copied = tokio::select! {
                        _ = token.cancelled() => Ok(()),
                        r = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => r.map(|_| ()),
                    };
                    drop(upstream);
                    // The API server reports failures (e.g. nothing listening on the port) out of band.
                    let reported = match error {
                        Some(f) => tokio::time::timeout(std::time::Duration::from_secs(2), f).await.ok().flatten(),
                        None => None,
                    };
                    pf.abort();
                    if let Some(msg) = reported {
                        return Err(msg);
                    }
                    copied.map_err(err)?;
                    Ok(())
                }
                .await;
                let mut i = info.lock().unwrap();
                i.active_connections -= 1;
                match result {
                    Ok(()) => {}
                    Err(e) => i.last_error = Some(e),
                }
            });
        }
    });
    Ok(result)
}

#[tauri::command]
pub fn stop_port_forward(forwards: State<'_, Forwards>, id: String) -> Vec<ForwardInfo> {
    if let Some(f) = forwards.0.lock().unwrap().remove(&id) {
        f.token.cancel();
    }
    forwards.list()
}

#[tauri::command]
pub fn list_port_forwards(forwards: State<'_, Forwards>) -> Vec<ForwardInfo> {
    forwards.list()
}
