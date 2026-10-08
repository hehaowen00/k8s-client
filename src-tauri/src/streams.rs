use std::io::{Read, Write};
use std::time::Duration;

use futures::{AsyncBufReadExt, SinkExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, LogParams, TerminalSize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::state::{err, kerr, AppState, Result, SessionInput};
use crate::strings;

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines { lines: Vec<String> },
    End,
    Error { message: String },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_logs(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: Option<bool>,
    timestamps: Option<bool>,
    since_seconds: Option<i64>,
    channel: Channel<LogEvent>,
) -> Result<String> {
    let client = state.client(&context).await?;
    let (id, token) = state.register_stream();
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let lp = LogParams {
        container,
        follow: !previous.unwrap_or(false),
        previous: previous.unwrap_or(false),
        timestamps: timestamps.unwrap_or(false),
        tail_lines,
        since_seconds,
        ..Default::default()
    };

    tokio::spawn(async move {
        let reader = tokio::select! {
            _ = token.cancelled() => return,
            r = api.log_stream(&pod, &lp) => r,
        };
        let reader = match reader {
            Ok(r) => r,
            Err(e) => {
                let _ = channel.send(LogEvent::Error { message: kerr(e) });
                return;
            }
        };
        let mut lines = reader.lines();
        let mut buf: Vec<String> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(80));
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tick.tick() => {
                    if !buf.is_empty()
                        && channel.send(LogEvent::Lines { lines: std::mem::take(&mut buf) }).is_err()
                    {
                        break;
                    }
                }
                line = lines.next() => match line {
                    Some(Ok(l)) => {
                        buf.push(l);
                        if buf.len() >= 2000
                            && channel.send(LogEvent::Lines { lines: std::mem::take(&mut buf) }).is_err()
                        {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        let _ = channel.send(LogEvent::Lines { lines: std::mem::take(&mut buf) });
                        let _ = channel.send(LogEvent::Error { message: e.to_string() });
                        break;
                    }
                    None => {
                        let _ = channel.send(LogEvent::Lines { lines: std::mem::take(&mut buf) });
                        let _ = channel.send(LogEvent::End);
                        break;
                    }
                }
            }
        }
    });
    Ok(id)
}

// ---------------------------------------------------------------------------
// Interactive sessions (pod exec + local pty) share one event shape.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Data { data: String },
    Exit { message: Option<String> },
}

/// Incremental UTF-8 decoder so multi-byte chars split across reads survive.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    match e.error_len() {
                        // Incomplete sequence at the end: keep for next read.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn exec_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<Vec<String>>,
    attach: Option<bool>,
    cols: u16,
    rows: u16,
    channel: Channel<SessionEvent>,
) -> Result<String> {
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let attach = attach.unwrap_or(false);

    // Attach must match how the container was started (tty / stdin); exec always gets a TTY.
    let (tty, want_stdin) = if attach {
        let p = api.get(&pod).await.map_err(kerr)?;
        let spec = p.spec.unwrap_or_default();
        let c = spec
            .containers
            .iter()
            .find(|c| container.as_deref().is_none_or(|n| n == c.name))
            .ok_or(strings::CONTAINER_NOT_FOUND)?;
        (c.tty.unwrap_or(false), c.stdin.unwrap_or(false))
    } else {
        (true, true)
    };
    let ap = AttachParams {
        container,
        stdin: want_stdin,
        stdout: true,
        stderr: !tty,
        tty,
        ..Default::default()
    };
    let mut proc = if attach {
        api.attach(&pod, &ap).await.map_err(kerr)?
    } else {
        let command = command.unwrap_or_else(|| {
            vec![
                "sh".into(),
                "-c".into(),
                "command -v bash >/dev/null 2>&1 && exec bash || exec sh".into(),
            ]
        });
        api.exec(&pod, command, &ap).await.map_err(kerr)?
    };
    let mut stdin = proc.stdin();
    let stdout = proc.stdout().ok_or(strings::NO_STDOUT)?;
    let stderr = proc.stderr();
    let mut size_tx = if tty { proc.terminal_size() } else { None };
    if let Some(tx) = size_tx.as_mut() {
        let _ = tx
            .send(TerminalSize {
                width: cols,
                height: rows,
            })
            .await;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionInput>();
    state.register_session(&id, tx);

    // The pump ends when session_close drops the sender; that also tears down the connection,
    // which closing stdin alone doesn't do (attach without stdin, or commands ignoring EOF).
    let closed = tokio_util::sync::CancellationToken::new();
    let close_guard = closed.clone().drop_guard();
    tokio::spawn(async move {
        let _close_guard = close_guard;
        while let Some(input) = rx.recv().await {
            match input {
                SessionInput::Data(d) => {
                    if let Some(w) = stdin.as_mut() {
                        if w.write_all(&d).await.is_err() {
                            break;
                        }
                        let _ = w.flush().await;
                    }
                }
                SessionInput::Resize { cols, rows } => {
                    if let Some(tx) = size_tx.as_mut() {
                        let _ = tx
                            .send(TerminalSize {
                                width: cols,
                                height: rows,
                            })
                            .await;
                    }
                }
            }
        }
    });

    // Without a TTY, output needs CRLF for xterm.
    spawn_output_pump(stdout, channel.clone(), !tty);
    if let Some(err_stream) = stderr {
        spawn_output_pump(err_stream, channel.clone(), true);
    }

    let session_id = id.clone();
    let status = proc.take_status();
    tokio::spawn(async move {
        let message = match status {
            Some(s) => tokio::select! {
                st = s => st.and_then(|st| (st.status.as_deref() != Some("Success")).then(|| st.message.unwrap_or_default())),
                _ = closed.cancelled() => {
                    proc.abort();
                    None
                }
            },
            None => None,
        };
        let _ = proc.join().await;
        app.state::<AppState>().remove_session(&session_id);
        let _ = channel.send(SessionEvent::Exit { message });
    });

    Ok(id)
}

fn spawn_output_pump<R>(mut reader: R, channel: Channel<SessionEvent>, crlf: bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        let mut dec = Utf8Stream::default();
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut data = dec.push(&buf[..n]);
                    if crlf {
                        data = data.replace("\r\n", "\n").replace('\n', "\r\n");
                    }
                    if !data.is_empty() && channel.send(SessionEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub fn session_write(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state.session_send(&id, SessionInput::Data(data.into_bytes()))
}

#[tauri::command]
pub fn session_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    state.session_send(&id, SessionInput::Resize { cols, rows })
}

#[tauri::command]
pub fn session_close(state: State<'_, AppState>, id: String) {
    // Dropping the sender ends the input pump, which closes stdin / kills the pty.
    state.remove_session(&id);
}

#[tauri::command]
pub async fn pty_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    cols: u16,
    rows: u16,
    channel: Channel<SessionEvent>,
) -> Result<String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let pty = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    let configured = state
        .settings
        .lock()
        .unwrap()
        .terminal_shell
        .clone()
        .filter(|s| !s.trim().is_empty());
    let shell = configured
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "/bin/sh".into()
            }
        });
    let mut cmd = CommandBuilder::new(shell);
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    // Point kubectl (and anything else reading KUBECONFIG) at this cluster only, through its proxy.
    cmd.env("KUBECONFIG", state.scoped_kubeconfig(&app, &context).await?);
    if let Some(p) = state
        .cluster_settings(&context)
        .proxy_url
        .filter(|p| !p.trim().is_empty())
    {
        cmd.env("HTTPS_PROXY", &p);
        cmd.env("HTTP_PROXY", &p);
    }
    // kubectl first on PATH: an explicit path from Settings, else a downloaded kubectl matching
    // the cluster's version.
    let (kubectl_path, kubectl_auto) = {
        let s = state.settings.lock().unwrap();
        (
            s.kubectl_path
                .clone()
                .filter(|p| !p.trim().is_empty())
                .map(std::path::PathBuf::from),
            s.kubectl_auto,
        )
    };
    let mut kubectl = kubectl_path;
    if kubectl.is_none() && kubectl_auto {
        let note = |m: &str| {
            let _ = channel.send(SessionEvent::Data {
                data: format!("\x1b[2m{m}\x1b[0m\r\n"),
            });
        };
        let version = match state.client(&context).await {
            Ok(c) => c
                .apiserver_version()
                .await
                .ok()
                .and_then(|v| crate::kubectl::normalize_version(&v.git_version)),
            Err(_) => None,
        };
        if let Some(v) = version {
            match crate::kubectl::ensure(&app, &v, note).await {
                Ok(p) => kubectl = Some(p),
                Err(e) => note(&strings::using_kubectl_from_path(e)),
            }
        }
    }
    if let Some(dir) = kubectl.as_deref().and_then(|p| p.parent()) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![dir.to_path_buf()];
        parts.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(parts) {
            cmd.env("PATH", joined);
        }
    }
    let mut child = pty.slave.spawn_command(cmd).map_err(err)?;
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().map_err(err)?;
    let mut writer = pty.master.take_writer().map_err(err)?;
    let master = pty.master;

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionInput>();
    state.register_session(&id, tx);

    let mut killer = child.clone_killer();
    std::thread::spawn(move || {
        while let Some(input) = rx.blocking_recv() {
            match input {
                SessionInput::Data(d) => {
                    if writer.write_all(&d).is_err() {
                        break;
                    }
                }
                SessionInput::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
        }
        let _ = killer.kill();
    });

    let out = channel.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        let mut dec = Utf8Stream::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = dec.push(&buf[..n]);
                    if !data.is_empty() && out.send(SessionEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let session_id = id.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        app.state::<AppState>().remove_session(&session_id);
        let message = match status {
            Ok(s) if s.success() => None,
            Ok(s) => Some(strings::exited_with_code(s.exit_code())),
            Err(e) => Some(e.to_string()),
        };
        let _ = channel.send(SessionEvent::Exit { message });
    });

    Ok(id)
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}
