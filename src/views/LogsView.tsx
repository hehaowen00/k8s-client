import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, POD_RESOURCE, type LogSource } from "../api";
import { useAsync, usePref } from "../hooks";
import { useTabs, type Tab } from "../store";
import { hasAnsi, parseAnsi, stripAnsi } from "../ansi";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";
import { S } from "../strings";

const MAX_LINES = 100_000;
const LINE_HEIGHT = 18;
/** Wrapped lines have variable height, so wrap mode renders only the newest lines (unvirtualised). */
const WRAP_LIMIT = 5000;
const SINCE_OPTIONS: [number, string][] = [
  [0, S.logs.anyTime],
  [300, S.logs.last("5m")],
  [900, S.logs.last("15m")],
  [3600, S.logs.last("1h")],
  [6 * 3600, S.logs.last("6h")],
  [24 * 3600, S.logs.last("24h")],
];
const ALL = "*";

type LogsTab = Extract<Tab, { kind: "logs" }>;

/** A log line; `src` indexes into the source list (-1 for single-container mode). */
interface Line {
  /** Arrival number, unique and increasing for the view's lifetime. */
  n: number;
  src: number;
  /** Text with escape codes removed (used for search / save). */
  text: string;
  /** Original text, kept only when it contains ANSI codes. */
  raw?: string;
}

const toLine = (src: number, s: string): Line =>
  hasAnsi(s) ? { n: 0, src, text: stripAnsi(s), raw: s } : { n: 0, src, text: s };

/** First index in `a` whose `n` is >= `n` (`a` is ordered by `n`). */
function lowerBound<T>(a: T[], n: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(a[mid]) < n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Absolutely positioned rows serialise without line breaks, so join the selected rows explicitly. */
function copyLines(e: React.ClipboardEvent<HTMLElement>) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".log-line")].filter((r) => range.intersectsNode(r));
  if (rows.length < 2) return;
  const text = rows
    .map((r) => {
      const part = document.createRange();
      part.selectNodeContents(r);
      if (r.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
      if (r.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      return part.toString();
    })
    .join("\n");
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
}

const lineN = (l: Line) => l.n;
const num = (x: number) => x;

function highlight(text: string, test: RegExp) {
  const parts: React.ReactNode[] = [];
  let i = 0;
  for (const m of text.matchAll(new RegExp(test.source, "gi"))) {
    if (!m[0]) continue; // zero-length match (e.g. `a*`): nothing to mark
    parts.push(text.slice(i, m.index), <mark key={m.index}>{m[0]}</mark>);
    i = m.index + m[0].length;
  }
  parts.push(text.slice(i));
  return parts;
}

function renderText(line: Line, test: RegExp | null) {
  if (test) return highlight(line.text, test);
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
}

const LogRow = memo(function LogRow(props: {
  line: Line;
  prefix: string;
  color?: string;
  current: boolean;
  test: RegExp | null;
  top?: number;
}) {
  const { line, prefix, color, current, test, top } = props;
  return (
    <div
      data-line={line.n}
      className={`log-line${top === undefined ? " wrapped" : ""}${current ? " current" : ""}`}
      style={top === undefined ? undefined : { top, height: LINE_HEIGHT }}
    >
      {prefix && (
        <span className="log-src" style={{ color }}>
          {prefix}
        </span>
      )}
      {renderText(line, test)}
    </div>
  );
});
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

export function LogsView({
  tab,
  active,
  onUpdate,
}: {
  tab: LogsTab;
  active: boolean;
  onUpdate?: (patch: Partial<LogsTab>) => void;
}) {
  const updateTab = useTabs((s) => s.update);
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
  const [showPod, setShowPod] = usePref("logs.showPod", false);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => !moreRef.current?.contains(e.target as Node) && setMoreOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [moreOpen]);
  // Toggles/actions sit inline while they fit on one row, else move into the ⋯ menu.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const needW = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const fitToolbar = () => {
    const bar = toolbarRef.current;
    if (!bar) return;
    // Inline items only have a width while shown; when hidden, reuse the last measurement.
    if ((bar.querySelector(".logs-wide > *") as HTMLElement | null)?.offsetWidth) {
      const cs = getComputedStyle(bar);
      const items = [
        ...bar.querySelectorAll<HTMLElement>(":scope > :not(.spacer, .logs-wide), :scope > .logs-wide > *"),
      ];
      needW.current =
        items.reduce((w, el) => w + el.offsetWidth, 0) +
        parseFloat(cs.columnGap) * (items.length - 1) +
        parseFloat(cs.paddingLeft) +
        parseFloat(cs.paddingRight);
    }
    setNarrow(bar.clientWidth < needW.current);
  };
  const fitRef = useRef(fitToolbar);
  fitRef.current = fitToolbar;
  useEffect(() => {
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(toolbarRef.current!);
    return () => ro.disconnect();
  }, []);
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [regex, setRegex] = usePref("logs.regex", false);
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
  const rafRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const push = (lines: Line[]) => {
    const buf = linesRef.current;
    for (const l of lines) {
      l.n = receivedRef.current++;
      buf.push(l);
    }
    // Trimming shifts the whole array, so let it overshoot a little and trim in bulk.
    if (buf.length > MAX_LINES * 1.1) buf.splice(0, buf.length - MAX_LINES);
    if (!rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setStatus((s) => (s.state === "connecting" ? { state: "streaming" } : s));
        setVersion((v) => v + 1);
      });
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
      {
        context: tab.context,
        namespace: tab.namespace,
        pod: tab.pod!,
        container,
        tailLines,
        previous,
        timestamps,
        sinceSeconds,
      },
      (e) => {
        if (e.type === "lines") push(e.lines.map((l) => toLine(-1, l)));
        else if (e.type === "end") setStatus({ state: "ended" });
        else setStatus({ state: "error", message: e.message });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab.context,
    tab.namespace,
    tab.pod,
    workload?.selector,
    container,
    tail,
    since,
    previous,
    timestamps,
    nonce,
    ready,
  ]);

  const srcList = srcRef.current.list;
  const podNames = useMemo(() => [...new Set(sources.map((s) => s.pod))].sort(), [sources]);
  const containerNames = useMemo(
    () => (workload ? [...new Set(sources.map((s) => s.container))].sort() : podContainers.map((c) => c.name)),
    [workload, sources, podContainers],
  );
  const showContainer = new Set(srcList.map((s) => s.container)).size > 1 || (container === ALL && !workload);
  const prefix = (l: Line) => {
    if (l.src < 0) return "";
    const s = srcList[l.src];
    if (!workload) return s.container;
    if (!showPod) return showContainer ? s.container : "";
    return showContainer ? `${s.pod}/${s.container}` : s.pod;
  };

  // `test` has no g flag (stateless .test); highlight builds its own global copy. Invalid regex → null + error.
  const { test, searchError } = useMemo(() => {
    if (!search) return { test: null, searchError: null };
    try {
      return {
        test: new RegExp(regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        searchError: null,
      };
    } catch (e) {
      return { test: null, searchError: (e as Error).message };
    }
  }, [search, regex]);
  // Filtered lines are kept between batches; only newly arrived lines are tested.
  const filterRef = useRef<{ buf: Line[]; pod: string; test: RegExp | null; lines: Line[]; next: number } | null>(null);
  const shown = useMemo(() => {
    const buf = linesRef.current;
    const t = filterMode ? test : null;
    if (!podFilter && !t) return buf;
    const keep = (l: Line) =>
      (!podFilter || (l.src >= 0 && srcList[l.src].pod === podFilter)) && (!t || t.test(l.text));
    let f = filterRef.current;
    if (!f || f.buf !== buf || f.pod !== podFilter || f.test !== t) {
      f = filterRef.current = { buf, pod: podFilter, test: t, lines: [], next: 0 };
    }
    for (let i = lowerBound(buf, f.next, lineN); i < buf.length; i++) if (keep(buf[i])) f.lines.push(buf[i]);
    if (buf.length) {
      f.next = buf[buf.length - 1].n + 1;
      const drop = lowerBound(f.lines, buf[0].n, lineN);
      if (drop) f.lines.splice(0, drop);
    }
    return f.lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, test, filterMode, podFilter]);

  // Virtual list
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const readScroll = (el: HTMLElement) =>
    setScroll((s) =>
      s.top === el.scrollTop && s.height === el.clientHeight ? s : { top: el.scrollTop, height: el.clientHeight },
    );
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
      readScroll(el);
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
      readScroll(el);
    };
    pin();
    // Again after layout (virtual-list height / slice changes land a frame later).
    const raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
    // `version` bumps on every batch of lines; `shown` can be the same (mutated) array.
  }, [shown, version, follow, active]);

  const start = Math.max(0, Math.floor(scroll.top / LINE_HEIGHT) - 20);
  const end = Math.min(shown.length, Math.ceil((scroll.top + scroll.height) / LINE_HEIGHT) + 20);

  const title = workload ? `${workload.kind.toLowerCase()}/${workload.name}` : tab.pod;
  const download = () => {
    const text = linesRef.current.map((l) => (prefix(l) ? `[${prefix(l)}] ${l.text}` : l.text)).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${(title ?? "logs").replace("/", "-")}${container && container !== ALL ? "-" + container : ""}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Wrap mode only renders the newest WRAP_LIMIT lines, so only those count as matches.
  const wrapOffset = wrap ? Math.max(0, shown.length - WRAP_LIMIT) : 0;
  // Arrival numbers of matching lines in `shown`, extended per batch. In "only matches" mode every shown line matches.
  const matchRef = useRef<{ src: Line[]; test: RegExp; ns: number[]; next: number } | null>(null);
  const matchNs = useMemo(() => {
    if (!test || filterMode) return null;
    let m = matchRef.current;
    if (!m || m.src !== shown || m.test !== test) m = matchRef.current = { src: shown, test, ns: [], next: 0 };
    for (let i = lowerBound(shown, m.next, lineN); i < shown.length; i++)
      if (test.test(shown[i].text)) m.ns.push(shown[i].n);
    if (shown.length) {
      m.next = shown[shown.length - 1].n + 1;
      const drop = lowerBound(m.ns, shown[0].n, num);
      if (drop) m.ns.splice(0, drop);
    }
    return m.ns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, shown, test, filterMode]);
  const matchOffset =
    matchNs && shown.length ? lowerBound(matchNs, shown[Math.min(wrapOffset, shown.length - 1)].n, num) : 0;
  const matchCount = !test ? 0 : matchNs ? matchNs.length - matchOffset : shown.length - wrapOffset;
  /** Index into `shown` of the k-th match. */
  const matchAt = (k: number) => (matchNs ? lowerBound(shown, matchNs[matchOffset + k], lineN) : wrapOffset + k);
  // ponytail: position is by match number, so it drifts when old lines are trimmed past MAX_LINES.
  const [cur, setCur] = useState<number | null>(null);
  useEffect(() => setCur(null), [test]);
  const curLine = cur !== null && cur < matchCount ? matchAt(cur) : -1;
  const goToMatch = (d: 1 | -1) => {
    const n = matchCount;
    const el = scrollRef.current;
    if (!n || !el) return;
    const next = cur === null || cur >= n ? (d > 0 ? 0 : n - 1) : (cur + d + n) % n;
    setCur(next);
    setFollow(false);
    const idx = matchAt(next);
    if (wrap) el.querySelector(`[data-line="${shown[idx].n}"]`)?.scrollIntoView({ block: "center" });
    else el.scrollTop = idx * LINE_HEIGHT - el.clientHeight / 2;
  };
  const streaming = sources.filter((s) => s.state === "streaming").length;
  // Re-measure when toolbar contents change; the ResizeObserver covers the toolbar's own size.
  useLayoutEffect(fitToolbar, [
    podNames.length,
    containerNames.length,
    multi,
    workload,
    container,
    tail,
    since,
    search,
    searchError,
    matchCount,
    curLine,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shown inline when the toolbar is wide, inside the ⋯ menu when narrow.
  const toggles = (
    <>
      {!multi && (
        <Checkbox checked={previous} onChange={(e) => setPrevious(e.target.checked)}>
          {S.logs.previous}
        </Checkbox>
      )}
      <Checkbox checked={wrap} onChange={(e) => setWrap(e.target.checked)}>
        {S.logs.wrap}
      </Checkbox>
      <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)}>
        {S.logs.follow}
      </Checkbox>
    </>
  );
  const actions: [string, () => void, boolean?][] = [
    [S.terminal.reconnect, () => setNonce((n) => n + 1)],
    [S.logs.save, download],
    [
      S.logs.clear,
      () => {
        linesRef.current = [];
        setVersion((v) => v + 1);
      },
      true,
    ],
  ];

  return (
    <div className={`logs-view ${narrow ? "narrow" : ""}`}>
      <div className="toolbar" ref={toolbarRef}>
        {workload && podNames.length > 1 && (
          <Select
            className="select"
            value={podFilter}
            onChange={(e) => setPodFilter(e.target.value)}
            title={S.logs.pod}
          >
            <option value="">{S.logs.allPods(podNames.length)}</option>
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
            title={S.logs.container}
          >
            {containerNames.length > 1 && <option value={ALL}>{S.logs.allContainers}</option>}
            {workload
              ? containerNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))
              : podContainers.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.init ? S.logs.init : ""}
                  </option>
                ))}
          </Select>
        )}
        <Select className="select" value={tail} onChange={(e) => setTail(Number(e.target.value))} title={S.logs.tail}>
          {[100, 500, 1000, 5000, 20000, 0].map((n) => (
            <option key={n} value={n}>
              {n ? S.logs.last(String(n)) : S.logs.allLines}
            </option>
          ))}
        </Select>
        <Select
          className="select"
          value={since}
          onChange={(e) => setSince(Number(e.target.value))}
          title={S.logs.since}
        >
          {SINCE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
        <input
          className="input filter"
          placeholder={S.logs.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goToMatch(e.shiftKey ? -1 : 1);
            }
          }}
        />
        {searchError ? (
          <span className="tone-bad small" title={searchError}>
            {S.logs.invalidRegex}
          </span>
        ) : (
          search && (
            <>
              <span className="muted small">
                {curLine >= 0 ? S.logs.matchPosition(cur! + 1, matchCount) : S.logs.matches(matchCount)}
              </span>
              <button
                className="btn btn-sm btn-icon"
                disabled={!matchCount}
                onClick={() => goToMatch(-1)}
                title={S.logs.prevMatch}
              >
                ↑
              </button>
              <button
                className="btn btn-sm btn-icon"
                disabled={!matchCount}
                onClick={() => goToMatch(1)}
                title={S.logs.nextMatch}
              >
                ↓
              </button>
            </>
          )
        )}
        <div className="ns-picker" ref={moreRef}>
          <button
            className="btn btn-sm btn-icon"
            title={S.logs.moreOptions}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(!moreOpen)}
          >
            ⋯
          </button>
          {moreOpen && (
            <div className="ns-popover logs-more" onKeyDown={(e) => e.key === "Escape" && setMoreOpen(false)}>
              <Checkbox checked={regex} onChange={(e) => setRegex(e.target.checked)}>
                {S.logs.regex}
              </Checkbox>
              <Checkbox checked={filterMode} onChange={(e) => setFilterMode(e.target.checked)}>
                {S.logs.onlyMatches}
              </Checkbox>
              <Checkbox checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)}>
                {S.logs.timestamps}
              </Checkbox>
              {workload && (
                <Checkbox checked={showPod} onChange={(e) => setShowPod(e.target.checked)}>
                  {S.logs.podName}
                </Checkbox>
              )}
              <span className="logs-narrow">
                {toggles}
                <div className="menu-sep" />
                {actions.map(([label, onClick]) => (
                  <button
                    key={label}
                    className="menu-item"
                    onClick={() => {
                      onClick();
                      setMoreOpen(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
        <span className="logs-wide">{toggles}</span>
        <div className="spacer" />
        <span className="logs-wide">
          {actions.map(([label, onClick, ghost]) => (
            <button key={label} className={`btn btn-sm ${ghost ? "btn-ghost" : ""}`} onClick={onClick}>
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="logs-scroll">
        <div
          className="logs-body"
          ref={scrollRef}
          tabIndex={0}
          onCopy={copyLines}
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
            readScroll(el);
          }}
        >
          {wrap ? (
            <div className="log-wrap">
              {shown.length > WRAP_LIMIT && (
                <div className="muted small log-note">{S.logs.wrapNote(WRAP_LIMIT, shown.length)}</div>
              )}
              {shown.slice(wrapOffset).map((line, i) => (
                <LogRow
                  key={line.n}
                  line={line}
                  prefix={prefix(line)}
                  color={srcList[line.src]?.color}
                  current={wrapOffset + i === curLine}
                  test={test}
                />
              ))}
            </div>
          ) : (
            <div style={{ height: shown.length * LINE_HEIGHT, position: "relative", minWidth: "100%" }}>
              {shown.slice(start, end).map((line, i) => (
                <LogRow
                  key={line.n}
                  line={line}
                  prefix={prefix(line)}
                  color={srcList[line.src]?.color}
                  current={start + i === curLine}
                  test={test}
                  top={(start + i) * LINE_HEIGHT}
                />
              ))}
            </div>
          )}
        </div>
        {awayAt !== null && shown.length > 0 && (
          <button className="logs-jump" onClick={jumpToBottom} title={S.logs.jumpHint}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M7 2.5v8M3.5 7.5 7 11l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {receivedRef.current - awayAt > 0 ? S.logs.newLines(receivedRef.current - awayAt) : S.logs.jumpToBottom}
          </button>
        )}
      </div>
      <div className="statusbar">
        <span
          className={`dot tone-bg-${status.state === "streaming" ? "ok" : status.state === "error" ? "bad" : "muted"}`}
        />
        {status.state === "connecting" && S.clusterView.connecting}
        {status.state === "streaming" &&
          (multi
            ? S.logs.streamingMulti(streaming, sources.length, workload ? podNames.length : null)
            : previous
              ? S.logs.previousLogs
              : S.logs.streaming)}
        {status.state === "ended" && S.logs.ended}
        {status.state === "error" && <span className="tone-bad">{status.message}</span>}
        {pod.error && <span className="tone-bad">{pod.error}</span>}
        {multi && status.state === "streaming" && sources.length === 0 && (
          <span className="muted">{S.logs.noPods}</span>
        )}
        <span className="spacer" />
        <span className="muted">{S.logs.lineCount(linesRef.current.length)}</span>
      </div>
    </div>
  );
}
