import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { api, POD_RESOURCE, type SessionEvent } from "../api";
import { useAsync } from "../hooks";
import { useTabs, type Tab, contextLabel } from "../store";
import { useResolvedTheme, useSettings } from "../settings";
import { Select } from "../components/Select";

type TermTab = Extract<Tab, { kind: "exec" | "terminal" }>;

const THEME = {
  background: "#14161b",
  foreground: "#d6dae3",
  cursor: "#7aa2ff",
  selectionBackground: "#2c3a5c",
  black: "#1c1f26",
  brightBlack: "#5c6370",
  red: "#ef6b73",
  brightRed: "#ff8a91",
  green: "#8fd18b",
  brightGreen: "#a9e5a5",
  yellow: "#e5c07b",
  brightYellow: "#f0d399",
  blue: "#7aa2ff",
  brightBlue: "#9bbaff",
  magenta: "#c678dd",
  brightMagenta: "#d99cf0",
  cyan: "#56b6c2",
  brightCyan: "#7fd0db",
  white: "#d6dae3",
  brightWhite: "#ffffff",
};

const THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#2a78d6",
  selectionBackground: "#cde2fb",
  black: "#24292f",
  brightBlack: "#57606a",
  red: "#cf222e",
  brightRed: "#a40e26",
  green: "#116329",
  brightGreen: "#1a7f37",
  yellow: "#7d4e00",
  brightYellow: "#955800",
  blue: "#0969da",
  brightBlue: "#218bff",
  magenta: "#8250df",
  brightMagenta: "#a475f9",
  cyan: "#1b7c83",
  brightCyan: "#3192aa",
  white: "#6e7781",
  brightWhite: "#8c959f",
};

export function TerminalView({ tab, active, onUpdate }: { tab: TermTab; active: boolean; onUpdate?: (patch: Partial<TermTab>) => void }) {
  const theme = useResolvedTheme();
  const fontSize = useSettings((s) => s.settings?.terminalFontSize ?? 13);
  const { update: updateTab } = useTabs();
  const update = (_id: string, patch: Partial<TermTab>) => (onUpdate ? onUpdate(patch) : updateTab(tab.id, patch));
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [session, setSession] = useState<{ state: "connecting" | "open" | "closed"; message?: string }>({
    state: "connecting",
  });
  const [nonce, setNonce] = useState(0);

  const isExec = tab.kind === "exec";
  const nodeShell = tab.kind === "exec" ? tab.nodeShell : undefined;
  const pod = useAsync(
    () =>
      isExec && !nodeShell
        ? api.getObject({ context: tab.context, resource: POD_RESOURCE, namespace: tab.namespace, name: tab.pod })
        : Promise.resolve(null),
    isExec ? [tab.context, tab.namespace, tab.pod] : [],
  );
  const containers: string[] = useMemo(
    () => (pod.data?.spec?.containers ?? []).map((c: { name: string }) => c.name),
    [pod.data],
  );
  const container = isExec
    ? tab.container ??
      pod.data?.metadata?.annotations?.["kubectl.kubernetes.io/default-container"] ??
      containers[0] ??
      null
    : null;
  const ready = !isExec || !!nodeShell || !!container || !pod.loading;

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, monospace",
      fontSize,
      cursorBlink: true,
      scrollback: 10000,
      theme: theme === "dark" ? THEME : THEME_LIGHT,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    // Let app-level tab shortcuts through instead of sending them to the shell.
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown" || /^[1-9]$/.test(e.key))) return false;
      if (mod && e.shiftKey && (e.key === "C" || e.key === "V")) {
        if (e.type === "keydown") {
          if (e.key === "C") navigator.clipboard.writeText(term.getSelection());
          else navigator.clipboard.readText().then((t) => term.paste(t));
        }
        return false;
      }
      return true;
    });
    requestAnimationFrame(() => fit.fit());
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Follow theme / font-size changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = theme === "dark" ? THEME : THEME_LIGHT;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [theme, fontSize]);

  // Connect a session.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !ready) return;
    let id: string | null = null;
    let disposed = false;
    setSession({ state: "connecting" });
    term.reset();
    fitRef.current?.fit();

    const channel = new Channel<SessionEvent>();
    channel.onmessage = (e) => {
      if (disposed) return;
      if (e.type === "data") term.write(e.data);
      else {
        term.write(`\r\n\x1b[2m[session closed${e.message ? `: ${e.message}` : ""}]\x1b[0m\r\n`);
        setSession({ state: "closed", message: e.message ?? undefined });
        deleteShellPod();
      }
    };
    const size = { cols: term.cols, rows: term.rows };
    // Node shell: a privileged helper pod we create now and delete when the session ends.
    let shellPod: { namespace: string; pod: string } | null = null;
    const deleteShellPod = () => {
      if (!shellPod || tab.kind !== "exec") return;
      const ref = { context: tab.context, resource: POD_RESOURCE, namespace: shellPod.namespace, name: shellPod.pod };
      shellPod = null;
      api.deleteResource(ref).catch(() => {});
    };
    const start = (async () => {
      if (tab.kind !== "exec") return api.ptyStart({ ...size, context: tab.context ?? null }, channel);
      if (nodeShell) {
        term.write(`\x1b[2mStarting node shell pod on ${nodeShell}…\x1b[0m\r\n`);
        const created = await api.nodeShellCreate(tab.context, nodeShell);
        shellPod = created;
        if (disposed) {
          deleteShellPod();
          throw new Error("cancelled");
        }
        return api.execStart(
          {
            context: tab.context,
            namespace: created.namespace,
            pod: created.pod,
            // Enter the host's namespaces via PID 1.
            command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l"],
            ...size,
          },
          channel,
        );
      }
      return api.execStart(
        { context: tab.context, namespace: tab.namespace, pod: tab.pod, container, attach: !!tab.attach, ...size },
        channel,
      );
    })();
    start.then(
      (sid) => {
        if (disposed) {
          api.sessionClose(sid);
          return;
        }
        id = sid;
        setSession({ state: "open" });
        if (active) term.focus();
      },
      (err) => {
        deleteShellPod();
        if (disposed) return;
        term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
        setSession({ state: "closed", message: String(err) });
      },
    );
    const dataSub = term.onData((d) => id && api.sessionWrite(id, d).catch(() => {}));
    const resizeSub = term.onResize(({ cols, rows }) => id && api.sessionResize(id, cols, rows).catch(() => {}));
    return () => {
      disposed = true;
      dataSub.dispose();
      resizeSub.dispose();
      if (id) api.sessionClose(id);
      deleteShellPod();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, container, nonce]);

  // Fit on container resize and when the tab becomes visible.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fitRef.current?.fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [active]);

  return (
    <div className="terminal-view">
      <div className="toolbar">
        <h2 className="toolbar-title">
          {tab.kind === "exec" ? (tab.nodeShell ? `Node shell: ${tab.nodeShell}` : tab.pod) : "Local Terminal"}
          {tab.kind === "exec" && tab.attach && <span className="badge">attached</span>}
          {tab.kind === "terminal" && tab.context && (
            <span className="muted small">kubectl → {contextLabel(tab.context)}</span>
          )}
          {tab.kind === "exec" && (
            <span className="muted small">
              {tab.namespace} · {contextLabel(tab.context)}
            </span>
          )}
        </h2>
        {tab.kind === "exec" && containers.length > 1 && (
          <Select
            className="select"
            value={container ?? ""}
            onChange={(e) => update(tab.id, { container: e.target.value })}
          >
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
        <span className={`dot tone-bg-${session.state === "open" ? "ok" : session.state === "closed" ? "bad" : "warn"}`} />
        <span className="muted small">{session.state}</span>
        <div className="spacer" />
        <span className="muted small">Ctrl+Shift+C / V to copy / paste</span>
        <button className="btn btn-sm" onClick={() => setNonce((n) => n + 1)}>
          {session.state === "closed" ? "Reconnect" : "Restart"}
        </button>
      </div>
      {pod.error && <div className="error-box">{pod.error}</div>}
      <div className="terminal-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
