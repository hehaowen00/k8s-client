//! Log streaming across many pods/containers: a whole workload (label selector)
//! or every container of one pod. Pods are watched so new pods (rollouts,
//! scale-ups) join the stream and restarted containers reconnect.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::jiff::Timestamp;
use kube::api::{Api, LogParams};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::kube_ops::urlencode;
use crate::state::{AppState, Result};
use crate::watch::{list_watch, Event};

const RECONCILE_EVERY: Duration = Duration::from_secs(3);
const FLUSH_EVERY: Duration = Duration::from_millis(80);
const MAX_BATCH: usize = 2000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaggedLine {
    pod: String,
    container: String,
    line: String,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pod: String,
    container: String,
    /// "streaming" | "waiting" | "done"
    state: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MultiLogEvent {
    Lines { lines: Vec<TaggedLine> },
    Sources { sources: Vec<Source> },
    Error { message: String },
}

type Key = (String, String);

enum Msg {
    Line(TaggedLine),
    Ended(Key),
}

enum ContainerState {
    Running,
    Terminated,
    Waiting,
}

/// (container, state) pairs for the containers we want from this pod.
fn containers_of(pod: &Pod, only: Option<&str>) -> Vec<(String, ContainerState)> {
    let spec_names: Vec<String> = pod
        .spec
        .as_ref()
        .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
        .unwrap_or_default();
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.clone())
        .unwrap_or_default();
    spec_names
        .into_iter()
        .filter(|n| only.is_none_or(|o| o == n))
        .map(|name| {
            let st = statuses.iter().find(|s| s.name == name).and_then(|s| s.state.as_ref());
            let state = match st {
                Some(s) if s.running.is_some() => ContainerState::Running,
                Some(s) if s.terminated.is_some() => ContainerState::Terminated,
                _ => ContainerState::Waiting,
            };
            (name, state)
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_multi_logs(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    selector: Option<String>,
    pod: Option<String>,
    container: Option<String>,
    tail_lines: Option<i64>,
    timestamps: Option<bool>,
    since_seconds: Option<i64>,
    channel: Channel<MultiLogEvent>,
) -> Result<String> {
    if selector.is_none() && pod.is_none() {
        return Err("either a selector or a pod is required".into());
    }
    let client = state.client(&context).await?;
    let (id, token) = state.register_stream();
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let url = match (&selector, &pod) {
        (Some(sel), _) => format!("/api/v1/namespaces/{namespace}/pods?labelSelector={}&", urlencode(sel)),
        (None, Some(name)) => format!("/api/v1/namespaces/{namespace}/pods?fieldSelector={}&", urlencode(&format!("metadata.name={name}"))),
        (None, None) => unreachable!(),
    };
    let timestamps = timestamps.unwrap_or(false);

    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
        let mut active: HashMap<Key, CancellationToken> = HashMap::new();
        // Streams that ended: when, so a reconnect only fetches newer lines.
        let mut ended_at: HashMap<Key, Timestamp> = HashMap::new();
        // Terminated containers we've already shown once.
        let mut finished: HashSet<Key> = HashSet::new();
        let mut last_sources: Vec<Source> = Vec::new();
        let mut last_error: Option<String> = None;
        let mut first = true;
        let mut buf: Vec<TaggedLine> = Vec::new();
        let mut reconcile = tokio::time::interval(RECONCILE_EVERY);
        let mut flush = tokio::time::interval(FLUSH_EVERY);
        let mut pods: BTreeMap<String, Pod> = BTreeMap::new();
        // Reconcile only after the pod set changed or a stream ended.
        let mut dirty = false;
        let (wtx, mut wrx) = mpsc::unbounded_channel::<Event>();
        let wtoken = token.clone();
        tokio::spawn(async move { list_watch(&client, &url, "application/json", true, &wtoken, |e| wtx.send(e).is_ok()).await });

        'main: loop {
            tokio::select! {
                _ = token.cancelled() => break,
                Some(ev) = wrx.recv() => {
                    let parse = |v: Value| serde_json::from_value::<Pod>(v).ok();
                    match ev {
                        Event::Listed(mut v) => {
                            last_error = None;
                            pods.clear();
                            if let Value::Array(items) = v["items"].take() {
                                for p in items.into_iter().filter_map(parse) {
                                    pods.insert(p.metadata.name.clone().unwrap_or_default(), p);
                                }
                            }
                        }
                        Event::Upsert(v) => {
                            if let Some(p) = parse(v) {
                                pods.insert(p.metadata.name.clone().unwrap_or_default(), p);
                            }
                        }
                        Event::Delete(v) => {
                            if let Some(name) = v["metadata"]["name"].as_str() {
                                pods.remove(name);
                            }
                        }
                        Event::Error(msg) => {
                            if last_error.as_ref() != Some(&msg) {
                                if channel.send(MultiLogEvent::Error { message: msg.clone() }).is_err() {
                                    break 'main;
                                }
                                last_error = Some(msg);
                            }
                            continue;
                        }
                    }
                    dirty = true;
                }
                _ = reconcile.tick(), if dirty => {
                    dirty = false;
                    let mut present: HashSet<Key> = HashSet::new();
                    let mut sources = Vec::new();
                    for p in pods.values() {
                        let pod_name = p.metadata.name.clone().unwrap_or_default();
                        for (cname, cstate) in containers_of(p, container.as_deref()) {
                            let key = (pod_name.clone(), cname.clone());
                            present.insert(key.clone());
                            let start = !active.contains_key(&key)
                                && match cstate {
                                    ContainerState::Running => true,
                                    ContainerState::Terminated => !finished.contains(&key),
                                    ContainerState::Waiting => false,
                                };
                            if start {
                                if matches!(cstate, ContainerState::Terminated) {
                                    finished.insert(key.clone());
                                }
                                let lp = LogParams {
                                    container: Some(cname.clone()),
                                    follow: true,
                                    timestamps,
                                    // Initial pods get the tail; later pods (rollouts) start from the top;
                                    // reconnects only fetch what's new.
                                    tail_lines: if first { tail_lines } else { None },
                                    since_time: ended_at.get(&key).copied(),
                                    since_seconds: if first && !ended_at.contains_key(&key) { since_seconds } else { None },
                                    ..Default::default()
                                };
                                let child = token.child_token();
                                active.insert(key.clone(), child.clone());
                                spawn_stream(api.clone(), key.clone(), lp, tx.clone(), child);
                            }
                            let state = if active.contains_key(&key) {
                                "streaming"
                            } else if matches!(cstate, ContainerState::Waiting) {
                                "waiting"
                            } else {
                                "done"
                            };
                            sources.push(Source { pod: pod_name.clone(), container: cname, state });
                        }
                    }
                    // Pods that went away: stop their streams.
                    active.retain(|k, t| {
                        let keep = present.contains(k);
                        if !keep {
                            t.cancel();
                        }
                        keep
                    });
                    first = false;
                    sources.sort_by(|a, b| (&a.pod, &a.container).cmp(&(&b.pod, &b.container)));
                    if sources != last_sources {
                        if channel.send(MultiLogEvent::Sources { sources: sources.clone() }).is_err() {
                            break 'main;
                        }
                        last_sources = sources;
                    }
                }
                Some(msg) = rx.recv() => match msg {
                    Msg::Line(l) => {
                        buf.push(l);
                        if buf.len() >= MAX_BATCH
                            && channel.send(MultiLogEvent::Lines { lines: std::mem::take(&mut buf) }).is_err()
                        {
                            break 'main;
                        }
                    }
                    Msg::Ended(key) => {
                        dirty = true;
                        active.remove(&key);
                        ended_at.insert(key, Timestamp::now());
                    }
                },
                _ = flush.tick() => {
                    if !buf.is_empty()
                        && channel.send(MultiLogEvent::Lines { lines: std::mem::take(&mut buf) }).is_err()
                    {
                        break 'main;
                    }
                }
            }
        }
        for t in active.values() {
            t.cancel();
        }
    });
    Ok(id)
}

fn spawn_stream(api: Api<Pod>, key: Key, lp: LogParams, tx: mpsc::UnboundedSender<Msg>, token: CancellationToken) {
    tokio::spawn(async move {
        let reader = tokio::select! {
            _ = token.cancelled() => return,
            r = api.log_stream(&key.0, &lp) => r,
        };
        if let Ok(reader) = reader {
            let mut lines = reader.lines();
            loop {
                tokio::select! {
                    _ = token.cancelled() => return,
                    l = lines.next() => match l {
                        Some(Ok(line)) => {
                            let msg = TaggedLine { pod: key.0.clone(), container: key.1.clone(), line };
                            if tx.send(Msg::Line(msg)).is_err() {
                                return;
                            }
                        }
                        _ => break,
                    }
                }
            }
        }
        let _ = tx.send(Msg::Ended(key));
    });
}
