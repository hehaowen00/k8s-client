import { isBackgroundClick } from "../keys";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  canDelete,
  isNode,
  isPod,
  isRestartable,
  isScalable,
  type Column,
  type Usage,
  type ResourceInfo,
  type Row,
} from "../api";
import { deleteMany, restartMany, targetMenu } from "../actions";
import { openContextMenu } from "../components/ContextMenu";
import { formatAge, formatBytes, formatCpu, nsSelection, statusTone, useNow } from "../util";
import { usePref } from "../hooks";
import { useUsageMap } from "../metrics";
import { useSettings } from "../settings";
import { Checkbox } from "../components/Checkbox";
import { loadPerms } from "../permissions";
import { S } from "../strings";

const BACKGROUND_WATCH_MS = 5 * 60_000;

const EMPTY_LIST: string[] = [];

const ROW_HEIGHT = 30;
const OVERSCAN = 12;
const MIN_COL_WIDTH = 48;

interface Props {
  context: string;
  resource: ResourceInfo;
  namespace: string; // "" = all
  filter: string;
  wide: boolean;
  active: boolean;
  selectedUid: string | null;
  /** Select (via onSelect) and scroll to the row with this name once it's loaded. */
  reveal?: { name: string; namespace?: string } | null;
  onSelect: (row: Row | null) => void;
  onOpen: (row: Row, background: boolean) => void;
  /** `loaded`: the total is the server's actual count (listed without errors). */
  onCount: (n: number, total: number, loaded: boolean) => void;
  /** Server-side filters (embedded "related pods" tables). */
  labelSelector?: string;
  fieldSelector?: string;
  /** Embedded mode: no bulk selection. */
  compact?: boolean;
}

interface DisplayColumn {
  key: string;
  label: string;
  index: number; // index into row.cells, or -1 for synthetic columns
  kind: "name" | "namespace" | "age" | "status" | "number" | "text" | "cpu" | "memory";
  description?: string;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.join(", ");
  return JSON.stringify(v);
}

function buildColumns(cols: Column[], showNamespace: boolean, wide: boolean, metrics: boolean): DisplayColumn[] {
  const out: DisplayColumn[] = [];
  cols.forEach((c, i) => {
    if (!wide && c.priority > 0) return;
    const lname = c.name.toLowerCase();
    let kind: DisplayColumn["kind"] = "text";
    if (c.format === "name" || (i === 0 && lname === "name")) kind = "name";
    else if (lname === "age" || c.type === "date") kind = "age";
    else if (lname === "namespace") kind = "namespace";
    else if (lname === "status" || lname === "phase") kind = "status";
    else if (c.type === "integer" || c.type === "number") kind = "number";
    out.push({ key: `c${i}`, label: c.name, index: i, kind, description: c.description });
  });
  if (showNamespace && !out.some((c) => c.kind === "namespace")) {
    const nameIdx = out.findIndex((c) => c.kind === "name");
    out.splice(nameIdx + 1, 0, { key: "ns", label: S.field.namespace, index: -1, kind: "namespace" });
  }
  if (metrics) {
    // Live usage from metrics-server, just before Age like Lens.
    const ageIdx = out.findIndex((c) => c.kind === "age");
    const at = ageIdx >= 0 ? ageIdx : out.length;
    out.splice(
      at,
      0,
      { key: "cpu", label: S.field.cpu, index: -1, kind: "cpu", description: S.table.cpuHint },
      { key: "mem", label: S.field.memory, index: -1, kind: "memory", description: S.table.memoryHint },
    );
  }
  return out;
}

const usageKey = (row: Row) => (row.namespace ? `${row.namespace}/${row.name}` : row.name);

function sortValue(row: Row, col: DisplayColumn, usage?: Map<string, Usage> | null): string | number {
  if (col.kind === "cpu") return usage?.get(usageKey(row))?.cpu ?? -1;
  if (col.kind === "memory") return usage?.get(usageKey(row))?.memory ?? -1;
  if (col.kind === "age") return row.created ? -Date.parse(row.created) : 0;
  if (col.kind === "namespace" && col.index < 0) return row.namespace ?? "";
  const v = row.cells[col.index];
  if (typeof v === "number") return v;
  const s = cellText(v);
  // "3/4" ready counts and "12 (3m ago)" restarts sort numerically on the leading number.
  const m = /^(\d+)(?:\/(\d+))?(\s|$)/.exec(s);
  if (m && col.kind !== "name") return Number(m[1]);
  return s.toLowerCase();
}

// Watch upserts replace row objects, so a row's haystack never goes stale.
const haystacks = new WeakMap<Row, string>();
function matches(row: Row, terms: string[]): boolean {
  let hay = haystacks.get(row);
  if (hay === undefined) {
    hay = [
      row.name,
      row.namespace ?? "",
      ...row.cells.map(cellText),
      ...Object.entries(row.labels ?? {}).map(([k, v]) => `${k}=${v}`),
    ]
      .join("\u0000")
      .toLowerCase();
    haystacks.set(row, hay);
  }
  return terms.every((t) => hay.includes(t));
}

const collator = new Intl.Collator();

export function ResourceTable(props: Props) {
  const { context, resource, namespace, filter, wide, selectedUid, reveal, onSelect, onOpen, onCount } = props;
  const [columns, setColumns] = useState<Column[]>([]);
  const rowsRef = useRef(new Map<string, Row>());
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<{ loading: boolean; error?: string }>({ loading: true });
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const now = useNow(props.active ? 5000 : 60000);

  // Namespaces the user can see when they can't list cluster-wide (Settings → Clusters).
  const accessible = useSettings((st) => st.settings?.clusters[context]?.accessibleNamespaces ?? EMPTY_LIST);
  // `namespace`: "" none, "*" all, or a comma-separated selection. Cluster-scoped kinds ignore it.
  const sel = resource.namespaced ? nsSelection(namespace) : { none: false, all: true, list: [] as string[] };
  const picked = sel.list;
  const nsList: (string | null)[] = sel.none ? [] : sel.all ? (accessible.length ? accessible : [null]) : picked;
  const nsKey = nsList.join(",");

  // Background tabs keep their watches for a while so switching back is instant, then let them go.
  const [live, setLive] = useState(true);
  useEffect(() => {
    if (props.active) return setLive(true);
    const t = setTimeout(() => setLive(false), BACKGROUND_WATCH_MS);
    return () => clearTimeout(t);
  }, [props.active]);

  // Subscribe to the live table stream(s); batch updates per animation frame.
  useEffect(() => {
    if (!live) return;
    rowsRef.current = new Map();
    setColumns([]);
    setVersion((v) => v + 1);
    setStatus({ loading: true });
    let frame = 0;
    const bump = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setVersion((v) => v + 1);
        });
      }
    };
    if (!nsList.length) setStatus({ loading: false });
    // One stream per namespace; each owns its own rows, merged into rowsRef.
    const perStream = nsList.map(() => new Map<string, Row>());
    const stops = nsList.map((ns, i) =>
      api.watchResources(
        context,
        resource,
        ns,
        (e) => {
          const rows = rowsRef.current;
          const mine = perStream[i];
          switch (e.type) {
            case "reset":
              for (const uid of mine.keys()) rows.delete(uid);
              mine.clear();
              for (const r of e.rows) {
                mine.set(r.uid, r);
                rows.set(r.uid, r);
              }
              setColumns((c) => (c.length ? c : e.columns));
              setStatus({ loading: false });
              break;
            case "upsert":
              for (const r of e.rows) {
                mine.set(r.uid, r);
                rows.set(r.uid, r);
              }
              break;
            case "delete":
              for (const u of e.uids) {
                mine.delete(u);
                rows.delete(u);
              }
              break;
            case "error":
              setStatus({ loading: false, error: nsList.length > 1 ? `${ns}: ${e.message}` : e.message });
              break;
          }
          bump();
        },
        { labelSelector: props.labelSelector, fieldSelector: props.fieldSelector },
      ),
    );
    return () => {
      stops.forEach((stop) => stop());
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context,
    resource.group,
    resource.version,
    resource.plural,
    nsKey,
    props.labelSelector,
    props.fieldSelector,
    live,
  ]);

  const showNamespace = resource.namespaced && (sel.all || picked.length > 1);
  const usage = useUsageMap(
    context,
    isPod(resource) ? "pods" : isNode(resource) ? "nodes" : null,
    nsList.includes(null) ? null : (nsList as string[]),
    props.active,
  );
  // Per-kind column layout: hidden columns, order and widths, by label.
  const [layout, setLayout] = usePref<{ hidden: string[]; order: string[]; widths?: Record<string, number> }>(
    `columns.${resource.group}/${resource.kind}`,
    { hidden: [], order: [] },
  );
  const allCols = useMemo(
    () => buildColumns(columns, showNamespace, wide, !!usage),
    [columns, showNamespace, wide, usage],
  );
  const displayCols = useMemo(() => {
    const visible = allCols.filter((c) => c.kind === "name" || !layout.hidden.includes(c.label));
    if (!layout.order.length) return visible;
    const rank = (c: DisplayColumn) => {
      const i = layout.order.indexOf(c.label);
      return i < 0 ? 1000 + allCols.indexOf(c) : i;
    };
    return [...visible].sort((a, b) => rank(a) - rank(b));
  }, [allCols, layout]);
  const [dragCol, setDragCol] = useState<string | null>(null);
  // Widths follow the pointer in state and are saved once, when the drag ends.
  const [resizing, setResizing] = useState<{ label: string; width: number } | null>(null);
  const resizingRef = useRef(false);
  const widthOf = (c: DisplayColumn) => (resizing?.label === c.label ? resizing.width : layout.widths?.[c.label]);
  const startResize = (e: React.PointerEvent<HTMLSpanElement>, label: string) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = handle.parentElement!.getBoundingClientRect().width;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = Math.max(MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX));
      setResizing({ label, width });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      resizingRef.current = false;
      setResizing(null);
      if (width !== startWidth) setLayout({ ...layout, widths: { ...layout.widths, [label]: width } });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const resetWidth = (label: string) => {
    const { [label]: _, ...widths } = layout.widths ?? {};
    setLayout({ ...layout, widths });
  };
  const columnMenu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      ...allCols
        .filter((c) => c.kind !== "name")
        .map((c) => ({
          label: `${layout.hidden.includes(c.label) ? "   " : "✓ "}${c.label}`,
          onClick: () =>
            setLayout({
              ...layout,
              hidden: layout.hidden.includes(c.label)
                ? layout.hidden.filter((h) => h !== c.label)
                : [...layout.hidden, c.label],
            }),
        })),
      { separator: true, label: "" },
      { label: S.table.resetColumns, onClick: () => setLayout({ hidden: [], order: [] }) },
    ]);

  const visibleRows = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...rowsRef.current.values()];
    const filtered = terms.length ? all.filter((r) => matches(r, terms)) : all;
    const col = sort ? displayCols.find((c) => c.key === sort.key) : undefined;
    let rows: Row[];
    if (col && sort) {
      // Compute each row's sort value once rather than in every comparison.
      const keyed = filtered.map((row) => ({ row, v: sortValue(row, col, usage) }));
      keyed.sort((a, b) => {
        const c =
          typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
        return c * sort.dir || collator.compare(a.row.name, b.row.name);
      });
      rows = keyed.map((k) => k.row);
    } else {
      rows = filtered.sort(
        (a, b) => collator.compare(a.namespace ?? "", b.namespace ?? "") || collator.compare(a.name, b.name),
      );
    }
    return { rows, total: all.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filter, sort, displayCols, usage]);

  const loaded = !status.loading && !status.error;
  useEffect(() => onCount(visibleRows.rows.length, visibleRows.total, loaded), [visibleRows, onCount, loaded]);

  // Virtual scrolling
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Filtering can shrink the list below the current scroll offset; re-read the clamped position.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setScroll({ top: el.scrollTop, height: el.clientHeight });
  }, [visibleRows.rows.length]);
  const start = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visibleRows.rows.length, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN);
  const slice = visibleRows.rows.slice(start, end);

  // Keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = visibleRows.rows;
    if (!rows.length) return;
    const idx = rows.findIndex((r) => r.uid === selectedUid);
    let next = idx;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Enter" && idx >= 0) return onOpen(rows[idx], false);
    else if (e.key === "Escape") return onSelect(null);
    else return;
    e.preventDefault();
    onSelect(rows[next]);
    scrollToRow(next);
  };
  const scrollToRow = (idx: number) => {
    const el = scrollRef.current;
    if (el) {
      const y = idx * ROW_HEIGHT;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + ROW_HEIGHT * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_HEIGHT * 2 - el.clientHeight;
    }
  };
  // A selection made from outside (e.g. an owner opened from a pod) may be off screen, not
  // loaded yet, or known only by name: bring it into view once its row exists.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const rows = visibleRows.rows;
    let idx = selectedUid ? rows.findIndex((r) => r.uid === selectedUid) : -1;
    if (idx < 0 && reveal) {
      idx = rows.findIndex(
        (r) => r.name === reveal.name && (r.namespace || undefined) === (reveal.namespace || undefined),
      );
      if (idx >= 0) onSelect(rows[idx]);
    }
    if (idx < 0 || revealed.current === rows[idx].uid) return;
    revealed.current = rows[idx].uid;
    scrollToRow(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, reveal, visibleRows.rows]);

  // Multi-select for bulk actions (restart where supported, delete everywhere it's allowed).
  const restartable = isRestartable(resource);
  const deletable = canDelete(resource);
  const selectable = !props.compact && (restartable || deletable);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const lastChecked = useRef<number | null>(null);
  const checkedRows = useMemo(
    () => [...checked].map((u) => rowsRef.current.get(u)).filter((r): r is Row => !!r),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [checked, version],
  );
  const allVisibleChecked = visibleRows.rows.length > 0 && visibleRows.rows.every((r) => checked.has(r.uid));
  const someVisibleChecked = visibleRows.rows.some((r) => checked.has(r.uid));
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const r of visibleRows.rows) {
        if (allVisibleChecked) next.delete(r.uid);
        else next.add(r.uid);
      }
      return next;
    });
  const toggleRow = (index: number, shift: boolean) => {
    const rows = visibleRows.rows;
    const on = !checked.has(rows[index].uid);
    const [a, b] =
      shift && lastChecked.current !== null
        ? [Math.min(lastChecked.current, index), Math.max(lastChecked.current, index)]
        : [index, index];
    setChecked((prev) => {
      const next = new Set(prev);
      for (let i = a; i <= b && i < rows.length; i++) {
        if (on) next.add(rows[i].uid);
        else next.delete(rows[i].uid);
      }
      return next;
    });
    lastChecked.current = index;
  };
  const [busy, setBusy] = useState(false);
  const bulk = async (fn: typeof restartMany) => {
    setBusy(true);
    try {
      if (await fn(checkedRows.map((r) => target(r)))) setChecked(new Set());
    } finally {
      setBusy(false);
    }
  };

  // [grid track, minimum px]; the minimums set the table's scroll width when space is tight.
  const tracks: [string, number][] = [
    ...(selectable ? [["32px", 32] as [string, number]] : []),
    ...displayCols.map((c): [string, number] => {
      const w = widthOf(c);
      if (w) return [`${w}px`, w];
      return c.kind === "name"
        ? ["minmax(220px, 3fr)", 220]
        : c.kind === "age"
          ? ["80px", 80]
          : c.kind === "number" || c.kind === "cpu" || c.kind === "memory"
            ? ["minmax(76px, 0.6fr)", 76]
            : ["minmax(96px, 1fr)", 96];
    }),
  ];
  const gridTemplate = tracks.map((t) => t[0]).join(" ");
  const minTableWidth = tracks.reduce((a, t) => a + t[1], 0);
  // Checkbox + Name stay pinned while scrolling sideways.
  const nameLeft = selectable ? 32 : 0;

  const target = (row: Row) => ({ context, resource, namespace: row.namespace ?? null, name: row.name });
  const replicasOf = (row: Row) => {
    if (!isScalable(resource)) return undefined;
    const readyIdx = columns.findIndex((c) => c.name.toLowerCase() === "ready");
    const m = /\/(\d+)$/.exec(cellText(row.cells[readyIdx]));
    return m ? Number(m[1]) : undefined;
  };

  return (
    <div className="rtable" tabIndex={0} onKeyDown={onKeyDown}>
      {selectable && checkedRows.length > 0 && (
        <div className="bulkbar">
          <span>
            <strong>{checkedRows.length}</strong> {S.table.selected}
          </span>
          {restartable && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => bulk(restartMany)}>
              {S.actions.restart}
            </button>
          )}
          {deletable && (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => bulk(deleteMany)}>
              {S.actions.delete}
            </button>
          )}
          {busy && <span className="muted small">{S.table.working}</span>}
          <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set())}>
            {S.table.clearSelection}
          </button>
        </div>
      )}
      <div
        className="rtable-body"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Show the pinned-column divider only while scrolled sideways.
          el.classList.toggle("scrolled-x", el.scrollLeft > 0);
          setScroll({ top: el.scrollTop, height: el.clientHeight });
        }}
      >
        <div className="rtable-head" style={{ gridTemplateColumns: gridTemplate, minWidth: minTableWidth }}>
          {selectable && (
            <span className="rtable-check sticky-col" style={{ left: 0 }}>
              <Checkbox
                checked={allVisibleChecked}
                indeterminate={!allVisibleChecked && someVisibleChecked}
                onChange={toggleAll}
                title={S.table.selectAllHint}
                aria-label={S.common.selectAll}
              />
            </span>
          )}
          {displayCols.map((c) => (
            <button
              key={c.key}
              className={`rtable-th ${c.kind === "name" ? "sticky-col" : ""} ${dragCol && dragCol !== c.label ? "droppable" : ""}`}
              style={c.kind === "name" ? { left: nameLeft } : undefined}
              title={S.table.columnHint(c.description)}
              draggable
              onDragStart={(e) => {
                if (resizingRef.current) e.preventDefault();
                else setDragCol(c.label);
              }}
              onDragEnd={() => setDragCol(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragCol || dragCol === c.label) return;
                const order = displayCols.map((d) => d.label).filter((l) => l !== dragCol);
                order.splice(order.indexOf(c.label), 0, dragCol);
                setLayout({ ...layout, order });
                setDragCol(null);
              }}
              onContextMenu={columnMenu}
              onClick={() =>
                setSort((s) =>
                  s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 },
                )
              }
            >
              {c.label}
              {sort?.key === c.key && <span className="sort-ind">{sort.dir === 1 ? "▲" : "▼"}</span>}
              <span
                className={`col-resize ${resizing?.label === c.label ? "active" : ""}`}
                onPointerDown={(e) => startResize(e, c.label)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  resetWidth(c.label);
                }}
              />
            </button>
          ))}
        </div>
        {status.error && (
          <div className="error-box inline">
            {status.error}
            <span className="muted small">{S.table.retrying}</span>
          </div>
        )}
        {status.loading && <div className="empty">{S.table.loading(resource.kind)}</div>}
        {!status.loading && !status.error && visibleRows.rows.length === 0 && (
          <div className="empty">{visibleRows.total ? S.table.noMatches : S.table.none(resource.plural)}</div>
        )}
        <div style={{ height: visibleRows.rows.length * ROW_HEIGHT, position: "relative", minWidth: minTableWidth }}>
          {slice.map((row, i) => (
            <div
              key={row.uid}
              className={`rtable-row ${row.uid === selectedUid ? "selected" : ""} ${checked.has(row.uid) ? "checked" : ""}`}
              style={{ gridTemplateColumns: gridTemplate, top: (start + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={(e) => {
                if (isBackgroundClick(e)) onOpen(row, true);
                else onSelect(row.uid === selectedUid ? null : row);
              }}
              onDoubleClick={() => onOpen(row, false)}
              onAuxClick={(e) => e.button === 1 && onOpen(row, true)}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(row);
                const at = { clientX: e.clientX, clientY: e.clientY, preventDefault() {} };
                // Permissions are per namespace; checks are cached so this is instant after the first time.
                loadPerms(context, resource, row.namespace ?? null).then((perms) =>
                  openContextMenu(
                    at,
                    targetMenu(target(row), {
                      replicas: replicasOf(row),
                      rowText: row.cells.map(cellText).join(" "),
                      perms,
                    }),
                  ),
                );
              }}
            >
              {selectable && (
                <span
                  className="rtable-check sticky-col"
                  style={{ left: 0 }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={checked.has(row.uid)}
                    onClick={(e) => toggleRow(start + i, e.shiftKey)}
                    aria-label={S.table.selectRow(row.name)}
                  />
                </span>
              )}
              {displayCols.map((c) => {
                if (c.kind === "age") {
                  return (
                    <span key={c.key} className="cell muted">
                      {row.created ? formatAge(row.created, now) : cellText(row.cells[c.index])}
                    </span>
                  );
                }
                if (c.kind === "cpu" || c.kind === "memory") {
                  const u = usage?.get(usageKey(row));
                  const v = u ? (c.kind === "cpu" ? formatCpu(u.cpu) : formatBytes(u.memory)) : "";
                  return (
                    <span key={c.key} className="cell num">
                      {v}
                    </span>
                  );
                }
                const text = c.index < 0 ? (row.namespace ?? "") : cellText(row.cells[c.index]);
                const tone = c.kind === "status" ? statusTone(text) : undefined;
                return (
                  <span
                    key={c.key}
                    className={`cell ${c.kind === "name" ? "cell-name sticky-col" : ""} ${tone ? `tone-${tone}` : ""}`}
                    style={c.kind === "name" ? { left: nameLeft } : undefined}
                    title={text}
                  >
                    {text}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
