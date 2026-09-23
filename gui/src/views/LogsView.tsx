import { useEffect, useMemo, useRef, useState } from "react";
import { api, POD_RESOURCE, type LogSource } from "../api";
import { useAsync, usePref } from "../hooks";
import { useTabs, type Tab, contextLabel } from "../store";
import { hasAnsi, parseAnsi, stripAnsi } from "../ansi";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";

const MAX_LINES = 100_000;
const LINE_HEIGHT = 18;
/** Wrapped lines have variable height, so wrap mode renders only the newest lines (unvirtualised). */
const WRAP_LIMIT = 5000;
const SINCE_OPTIONS: [number, string][] = [
  [0, "Any time"],
  [300, "Last 5m"],
  [900, "Last 15m"],
  [3600, "Last 1h"],
  [6 * 3600, "Last 6h"],
  [24 * 3600, "Last 24h"],
];
const ALL = "*";

type LogsTab = Extract<Tab, { kind: "logs" }>;

/** A log line; `src` indexes into the source list (-1 for single-container mode). */
interface Line {
  src: number;
  /** Text with escape codes removed (used for search / save). */
  text: string;
  /** Original text, kept only when it contains ANSI codes. */
  raw?: string;
}

const toLine = (src: number, s: string): Line => (hasAnsi(s) ? { src, text: stripAnsi(s), raw: s } : { src, text: s });
interface Src {
  pod: string;
  container: string;
  color: string;
}

function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 68%)`;
}

export function LogsView({ tab, active, onUpdate }: { tab: LogsTab; active: boolean; onUpdate?: (patch: Partial<LogsTab>) => void }) {
  const { update: updateTab } = useTabs();
  // Dock items persist their choices in the host tab's dock; top-level tabs in the tab itself.
  const update = (_id: string, patch: Partial<LogsTab>) => (onUpdate ? onUpdate(patch) : updateTab(tab.id, patch));
  const workload = tab.workload;
  const pod = useAsync(
    () =>
      tab.pod
        ? api.getObject({ context: tab.context, resource: POD_RESOURCE, namespace: tab.namespace, name: tab.pod })
        : Promise.resolve(null),
    [tab.context, tab.namespace, tab.pod],
  );
  const podContainers = useMemo(() => {
    const spec = pod.data?.spec;
    if (!spec) return [];
    return [
      ...(spec.initContainers ?? []).map((c: { name: string }) => ({ name: c.name, init: true })),
      ...(spec.containers ?? []).map((c: { name: string }) => ({ name: c.name, init: false })),
    ];
  }, [pod.data]);
  const defaultContainer =
    pod.data?.metadata?.annotations?.["kubectl.kubernetes.io/default-container"] ??
    podContainers.find((c) => !c.init)?.name;
  const container = tab.container ?? (workload ? ALL : defaultContainer) ?? null;
  // Multi mode: several streams merged (a workload, or all containers of a pod).
  const multi = !!workload || container === ALL;

  const [tail, setTail] = usePref("logs.tail", 1000);
  const [timestamps, setTimestamps] = usePref("logs.timestamps", false);
  const [since, setSince] = usePref("logs.since", 0);
  const [wrap, setWrap] = usePref("logs.wrap", false);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [podFilter, setPodFilter] = useState("");
  const [status, setStatus] = useState<{ state: "connecting" | "streaming" | "ended" | "error"; message?: string }>({
    state: "connecting",
  });
  const [nonce, setNonce] = useState(0);
  const [sources, setSources] = useState<LogSource[]>([]);

  const linesRef = useRef<Line[]>([]);
  const srcRef = useRef<{ list: Src[]; index: Map<string, number> }>({ list: [], index: new Map() });
  const [version, setVersion] = useState(0);

  // Total lines ever received (unaffected by trimming), for the "N new lines" count.
  const receivedRef = useRef(0);
  const push = (lines: Line[]) => {
    receivedRef.current += lines.length;
    const buf = linesRef.current;
    for (const l of lines) buf.push(l);
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
    setStatus((s) => (s.state === "connecting" ? { state: "streaming" } : s));
    setVersion((v) => v + 1);
  };
  const srcIndex = (podName: string, c: string) => {
    const key = `${podName}/${c}`;
    const reg = srcRef.current;
    let i = reg.index.get(key);
    if (i === undefined) {
      i = reg.list.length;
      reg.list.push({ pod: podName, container: c, color: hue(key) });
      reg.index.set(key, i);
    }
    return i;
  };

  // Wait for the pod spec so single-pod mode streams the right default container.
  const ready = multi || !!container || !pod.loading;
  useEffect(() => {
    if (!ready) return;
    linesRef.current = [];
    srcRef.current = { list: [], index: new Map() };
    setSources([]);
    setVersion((v) => v + 1);
    setStatus({ state: "connecting" });
    const tailLines = tail > 0 ? tail : null;
    const sinceSeconds = since > 0 ? since : null;
    if (multi) {
      return api.streamMultiLogs(
        {
          context: tab.context,
          namespace: tab.namespace,
          selector: workload?.selector ?? null,
          pod: workload ? null : tab.pod,
          container: container === ALL ? null : container,
          tailLines,
          timestamps,
          sinceSeconds,
        },
        (e) => {
          if (e.type === "lines") {
            push(e.lines.map((l) => toLine(srcIndex(l.pod, l.container), l.line)));
          } else if (e.type === "sources") {
            setSources(e.sources);
            setStatus((s) => (s.state === "error" || s.state === "connecting" ? { state: "streaming" } : s));
          } else {
            setStatus({ state: "error", message: e.message });
          }
        },
      );
    }
    return api.streamLogs(
      { context: tab.context, namespace: tab.namespace, pod: tab.pod!, container, tailLines, previous, timestamps, sinceSeconds },
      (e) => {
        if (e.type === "lines") push(e.lines.map((l) => toLine(-1, l)));
        else if (e.type === "end") setStatus({ state: "ended" });
        else setStatus({ state: "error", message: e.message });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.context, tab.namespace, tab.pod, workload?.selector, container, tail, since, previous, timestamps, nonce, ready]);

  const srcList = srcRef.current.list;
  const podNames = useMemo(() => [...new Set(sources.map((s) => s.pod))].sort(), [sources]);
  const containerNames = useMemo(
    () => (workload ? [...new Set(sources.map((s) => s.container))].sort() : podContainers.map((c) => c.name)),
    [workload, sources, podContainers],
  );
  const showContainer = new Set(srcList.map((s) => s.container)).size > 1 || container === ALL && !workload;
  const prefix = (l: Line) => {
    if (l.src < 0) return "";
    const s = srcList[l.src];
    if (!workload) return s.container;
    return showContainer ? `${s.pod}/${s.container}` : s.pod;
  };

  const q = search.toLowerCase();
  const shown = useMemo(() => {
    let all = linesRef.current;
    if (podFilter) all = all.filter((l) => l.src >= 0 && srcList[l.src].pod === podFilter);
    if (q && filterMode) all = all.filter((l) => l.text.toLowerCase().includes(q));
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, q, filterMode, podFilter]);

  // Virtual list
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const atBottom = useRef(true);
  // Set while scrolled away from the bottom: how many lines had arrived at that point.
  const [awayAt, setAwayAt] = useState<number | null>(null);
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setAwayAt(null);
    setFollow(true);
    el.focus();
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Resizing the pane (dock opening, window resize) keeps a following view pinned to the bottom.
    const ro = new ResizeObserver(() => {
      if (followRef.current && atBottom.current) el.scrollTop = el.scrollHeight;
      setScroll({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (follow && atBottom.current) el.scrollTop = el.scrollHeight;
      // The list may have shrunk (filter/clear): re-read the clamped position.
      setScroll({ top: el.scrollTop, height: el.clientHeight });
    };
    pin();
    // Again after layout (virtual-list height / slice changes land a frame later).
    const raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
    // `version` bumps on every batch of lines; `shown` can be the same (mutated) array.
  }, [shown, version, follow, active]);

  const start = Math.max(0, Math.floor(scroll.top / LINE_HEIGHT) - 20);
  const end = Math.min(shown.length, Math.ceil((scroll.top + scroll.height) / LINE_HEIGHT) + 20);

  const renderText = (line: Line) => {
    if (q) return highlight(line.text);
    if (line.raw)
      return parseAnsi(line.raw).map((seg, i) =>
        seg.style ? (
          <span key={i} style={seg.style}>
            {seg.text}
          </span>
        ) : (
          seg.text
        ),
      );
    return line.text;
  };
  const highlight = (line: string) => {
    if (!q) return line;
    const lower = line.toLowerCase();
    const parts: React.ReactNode[] = [];
    let i = 0;
    let idx = lower.indexOf(q);
    while (idx >= 0) {
      parts.push(line.slice(i, idx), <mark key={idx}>{line.slice(idx, idx + q.length)}</mark>);
      i = idx + q.length;
      idx = lower.indexOf(q, i);
    }
    parts.push(line.slice(i));
    return parts;
  };

  const title = workload ? `${workload.kind.toLowerCase()}/${workload.name}` : tab.pod;
  const download = () => {
    const text = linesRef.current.map((l) => (l.src >= 0 ? `[${prefix(l)}] ${l.text}` : l.text)).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${(title ?? "logs").replace("/", "-")}${container && container !== ALL ? "-" + container : ""}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const matchCount = useMemo(
    () => (q ? linesRef.current.reduce((n, l) => (l.text.toLowerCase().includes(q) ? n + 1 : n), 0) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, q],
  );
  const streaming = sources.filter((s) => s.state === "streaming").length;

  return (
    <div className="logs-view">
      <div className="toolbar">
        <h2 className="toolbar-title">
          {title}
          <span className="muted small">
            {tab.namespace} · {contextLabel(tab.context)}
          </span>
        </h2>
        {workload && podNames.length > 1 && (
          <Select className="select" value={podFilter} onChange={(e) => setPodFilter(e.target.value)} title="Pod">
            <option value="">All pods ({podNames.length})</option>
            {podNames.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        )}
        {(containerNames.length > 1 || !workload) && (
          <Select
            className="select"
            value={container ?? ""}
            onChange={(e) => update(tab.id, { container: e.target.value })}
            title="Container"
          >
            {containerNames.length > 1 && <option value={ALL}>All containers</option>}
            {workload
              ? containerNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))
              : podContainers.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.init ? " (init)" : ""}
                  </option>
                ))}
          </Select>
        )}
        <Select className="select" value={tail} onChange={(e) => setTail(Number(e.target.value))} title="Tail lines">
          {[100, 500, 1000, 5000, 20000, 0].map((n) => (
            <option key={n} value={n}>
              {n ? `Last ${n}` : "All lines"}
            </option>
          ))}
        </Select>
        <Select className="select" value={since} onChange={(e) => setSince(Number(e.target.value))} title="Since">
          {SINCE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <input className="input filter" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <span className="muted small">{matchCount} matches</span>}
        <Checkbox checked={filterMode} onChange={(e) => setFilterMode(e.target.checked)}>Only matches</Checkbox>
        <Checkbox checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)}>Timestamps</Checkbox>
        {!multi && (
          <Checkbox checked={previous} onChange={(e) => setPrevious(e.target.checked)}>Previous</Checkbox>
        )}
        <Checkbox checked={wrap} onChange={(e) => setWrap(e.target.checked)}>Wrap</Checkbox>
        <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)}>Follow</Checkbox>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setNonce((n) => n + 1)}>
          Reconnect
        </button>
        <button className="btn btn-sm" onClick={download}>
          Save
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            linesRef.current = [];
            setVersion((v) => v + 1);
          }}
        >
          Clear
        </button>
      </div>
      <div className="logs-scroll">
      <div
        className="logs-body"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "End") {
            e.preventDefault();
            jumpToBottom();
          } else if (e.key === "Home") {
            e.preventDefault();
            e.currentTarget.scrollTop = 0;
          }
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT * 2;
          atBottom.current = bottom;
          if (bottom) setAwayAt(null);
          else setAwayAt((a) => a ?? receivedRef.current);
          setScroll({ top: el.scrollTop, height: el.clientHeight });
        }}
      >
        {wrap ? (
          <div className="log-wrap">
            {shown.length > WRAP_LIMIT && (
              <div className="muted small log-note">
                Wrap mode shows the newest {WRAP_LIMIT.toLocaleString()} of {shown.length.toLocaleString()} lines
              </div>
            )}
            {shown.slice(-WRAP_LIMIT).map((line, i) => (
              <div key={i} className="log-line wrapped">
                {line.src >= 0 && (
                  <span className="log-src" style={{ color: srcList[line.src].color }}>
                    {prefix(line)}
                  </span>
                )}
                {renderText(line)}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ height: shown.length * LINE_HEIGHT, position: "relative", minWidth: "100%" }}>
            {shown.slice(start, end).map((line, i) => (
              <div key={start + i} className="log-line" style={{ top: (start + i) * LINE_HEIGHT, height: LINE_HEIGHT }}>
                {line.src >= 0 && (
                  <span className="log-src" style={{ color: srcList[line.src].color }}>
                    {prefix(line)}
                  </span>
                )}
                {renderText(line)}
              </div>
            ))}
          </div>
        )}
      </div>
      {awayAt !== null && shown.length > 0 && (
        <button className="logs-jump" onClick={jumpToBottom} title="Jump to the latest line (End)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M7 2.5v8M3.5 7.5 7 11l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {receivedRef.current - awayAt > 0
            ? `${(receivedRef.current - awayAt).toLocaleString()} new line${receivedRef.current - awayAt === 1 ? "" : "s"}`
            : "Jump to bottom"}
        </button>
      )}
      </div>
      <div className="statusbar">
        <span className={`dot tone-bg-${status.state === "streaming" ? "ok" : status.state === "error" ? "bad" : "muted"}`} />
        {status.state === "connecting" && "Connecting…"}
        {status.state === "streaming" &&
          (multi
            ? `Streaming ${streaming} of ${sources.length} container${sources.length === 1 ? "" : "s"}${workload ? ` across ${podNames.length} pod${podNames.length === 1 ? "" : "s"}` : ""}`
            : previous
              ? "Previous container logs"
              : "Streaming")}
        {status.state === "ended" && "Stream ended"}
        {status.state === "error" && <span className="tone-bad">{status.message}</span>}
        {pod.error && <span className="tone-bad">{pod.error}</span>}
        {multi && status.state === "streaming" && sources.length === 0 && (
          <span className="muted">— no running pods match</span>
        )}
        <span className="spacer" />
        <span className="muted">{linesRef.current.length.toLocaleString()} lines</span>
      </div>
    </div>
  );
}
