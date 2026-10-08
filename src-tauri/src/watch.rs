//! List + watch against the API server with as little load as possible: lists are served from
//! the watch cache (`resourceVersion=0`), watches carry bookmarks so a resume rarely needs a
//! relist, and failures back off.

use std::time::{Duration, Instant};

use futures::{AsyncBufReadExt, StreamExt};
use kube::Client;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::state::{err, kerr, Result};

const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Relist interval for APIs that can't be watched.
const POLL_EVERY: Duration = Duration::from_secs(10);

pub(crate) enum Event {
    /// A full list (a Table or a List, depending on what the server rendered).
    Listed(Value),
    Upsert(Value),
    Delete(Value),
    Error(String),
}

enum Outcome {
    Cancelled,
    /// Watch ended normally (server timeout); resume from resourceVersion.
    Resume,
    /// resourceVersion too old or stream error; relist. Carries an error worth showing (e.g. watch forbidden).
    Relist(Option<String>),
}

pub(crate) async fn get_json(client: &Client, uri: &str, accept: &str) -> Result<Value> {
    let req = http::Request::get(uri)
        .header(http::header::ACCEPT, accept)
        .body(vec![])
        .map_err(err)?;
    client.request(req).await.map_err(kerr)
}

/// Table rows carry the resourceVersion in their object's metadata.
fn object_rv(obj: &Value) -> Option<&str> {
    obj["rows"][0]["object"]["metadata"]["resourceVersion"]
        .as_str()
        .or_else(|| obj["metadata"]["resourceVersion"].as_str())
}

async fn sleep(token: &CancellationToken, d: Duration) -> bool {
    tokio::select! {
        _ = token.cancelled() => false,
        _ = tokio::time::sleep(d) => true,
    }
}

/// Runs until cancelled or `emit` returns false. `url` must end in '?' or '&'.
pub(crate) async fn list_watch(
    client: &Client,
    url: &str,
    accept: &str,
    can_watch: bool,
    token: &CancellationToken,
    mut emit: impl FnMut(Event) -> bool,
) {
    let mut list_backoff = Duration::from_secs(1);
    let mut watch_backoff = BACKOFF_MIN;
    let list_url = format!("{url}resourceVersion=0");
    'outer: loop {
        let listed = tokio::select! {
            _ = token.cancelled() => return,
            r = get_json(client, &list_url, accept) => r,
        };
        let list = match listed {
            Ok(v) => v,
            Err(e) => {
                if !emit(Event::Error(e)) || !sleep(token, list_backoff).await {
                    return;
                }
                list_backoff = (list_backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        list_backoff = Duration::from_secs(1);
        let mut rv = list["metadata"]["resourceVersion"].as_str().unwrap_or_default().to_string();
        let watch_accept = if list["kind"] == "Table" { accept } else { "application/json" };
        if !emit(Event::Listed(list)) {
            return;
        }
        if !can_watch {
            if !sleep(token, POLL_EVERY).await {
                return;
            }
            continue;
        }
        loop {
            let (started, start_rv) = (Instant::now(), rv.clone());
            let outcome = watch(client, url, watch_accept, &mut rv, token, &mut emit).await;
            // A watch that delivered events or ran a while is healthy; one that keeps ending at once backs off.
            if rv != start_rv || started.elapsed() > Duration::from_secs(60) {
                watch_backoff = BACKOFF_MIN;
            }
            let relist = match outcome {
                Outcome::Cancelled => return,
                Outcome::Resume => false,
                Outcome::Relist(msg) => {
                    if let Some(message) = msg {
                        if !emit(Event::Error(message)) {
                            return;
                        }
                    }
                    true
                }
            };
            if relist || watch_backoff > BACKOFF_MIN || started.elapsed() < Duration::from_secs(1) {
                if !sleep(token, watch_backoff).await {
                    return;
                }
                watch_backoff = (watch_backoff * 2).min(BACKOFF_MAX);
            }
            if relist {
                continue 'outer;
            }
        }
    }
}

async fn watch(
    client: &Client,
    url: &str,
    accept: &str,
    rv: &mut String,
    token: &CancellationToken,
    emit: &mut impl FnMut(Event) -> bool,
) -> Outcome {
    let uri = format!("{url}watch=1&allowWatchBookmarks=true&resourceVersion={rv}&timeoutSeconds=290");
    let req = match http::Request::get(uri).header(http::header::ACCEPT, accept).body(vec![]) {
        Ok(r) => r,
        Err(e) => return Outcome::Relist(Some(e.to_string())),
    };
    let stream = tokio::select! {
        _ = token.cancelled() => return Outcome::Cancelled,
        s = client.request_stream(req) => match s {
            Ok(s) => s,
            Err(kube::Error::Api(e)) if e.code == 410 => return Outcome::Relist(None),
            Err(e) => return Outcome::Relist(Some(format!("watch failed: {}", kerr(e)))),
        },
    };
    let mut lines = stream.lines();
    loop {
        let line = tokio::select! {
            _ = token.cancelled() => return Outcome::Cancelled,
            l = lines.next() => l,
        };
        let line = match line {
            None => return Outcome::Resume,
            Some(Err(_)) => return Outcome::Relist(None),
            Some(Ok(l)) => l,
        };
        let Ok(mut ev) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let obj = ev["object"].take();
        let ty = ev["type"].as_str().unwrap_or_default();
        if ty == "ERROR" {
            let msg = (obj["code"].as_i64() != Some(410))
                .then(|| format!("watch failed: {}", obj["message"].as_str().unwrap_or("unknown error")));
            return Outcome::Relist(msg);
        }
        if let Some(r) = object_rv(&obj) {
            *rv = r.to_string();
        }
        let event = match ty {
            "ADDED" | "MODIFIED" => Event::Upsert(obj),
            "DELETED" => Event::Delete(obj),
            _ => continue,
        };
        if !emit(event) {
            return Outcome::Cancelled;
        }
    }
}
