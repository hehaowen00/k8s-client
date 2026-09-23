import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ResourceInfo, type Row } from "../api";
import { openDetail } from "../actions";
import { forgetContext, loadDiscovery, refreshNamespaces, useDiscovery, useNamespaces, usePref } from "../hooks";
import { useContexts } from "../settings";
import { contextColor, openSession, openSingleton, pluralLabel, useTabs, type Tab, contextLabel } from "../store";
import { ALL_NAMESPACES, buildSections, nsForApi, nsSelection, sameResource } from "../util";
import { ResourceTable } from "./ResourceTable";
import { DetailView } from "./DetailView";
import { OverviewView } from "./OverviewView";
import { Dock } from "../components/Dock";
import { HelmCharts, HelmReleases } from "./HelmViews";
import { NamespacePicker } from "../components/NamespacePicker";
import { useExtensions, type ExtPage } from "../extensions";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";

type ClusterTab = Extract<Tab, { kind: "cluster" }>;

export function ClusterView({ tab, active }: { tab: ClusterTab; active: boolean }) {
  const { update, open } = useTabs();
  const discovery = useDiscovery(tab.context);
  const namespaces = useNamespaces(tab.context);
  const contexts = useContexts();

  const [filter, setFilter] = useState("");
  const [wide, setWide] = usePref("table.wide", false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [counts, setCounts] = useState<{ shown: number; total: number }>({ shown: 0, total: 0 });
  const [kindFilter, setKindFilter] = useState("");
  const [collapsed, setCollapsed] = usePref<Record<string, boolean>>("sidebar.collapsed", { Other: true });

  useEffect(() => setSelected(null), [tab.context, tab.resource?.kind, tab.resource?.group, tab.namespace]);

  const sections = useMemo(() => {
    const all = discovery.data ?? [];
    const q = kindFilter.toLowerCase();
    const filtered = q
      ? all.filter((r) => r.kind.toLowerCase().includes(q) || r.plural.includes(q) || r.group.includes(q))
      : all;
    return buildSections(filtered);
  }, [discovery.data, kindFilter]);

  const pick = (r: ResourceInfo, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.button === 1) {
      open({ kind: "cluster", context: tab.context, resource: r, namespace: tab.namespace }, { background: true });
    } else {
      update(tab.id, { resource: r, page: undefined });
    }
  };
  const extPages = useExtensions((s) => s.pages);
  const goPage = (page: "releases" | "charts" | `ext:${string}` | undefined, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) open({ kind: "cluster", context: tab.context, resource: null, namespace: tab.namespace, page }, { background: true });
    else update(tab.id, { resource: null, page });
  };

  const onCount = useCallback((shown: number, total: number) => setCounts({ shown, total }), []);

  // Object counts for the expanded sidebar sections (cheap limit=1 lists), refreshed every 30s.
  const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
  const expanded = useMemo(
    () => sections.filter((s) => !(!kindFilter && collapsed[s.title])).flatMap((s) => s.items),
    [sections, collapsed, kindFilter],
  );
  const countNs = nsForApi(tab.namespace) ?? "";
  useEffect(() => {
    if (!active || !expanded.length) return;
    let cancelled = false;
    const load = () =>
      api.countResources(tab.context, expanded, countNs || null).then(
        (counts) => {
          if (cancelled) return;
          const next: Record<string, number> = {};
          expanded.forEach((r, i) => {
            const n = counts[i];
            if (n !== null && n !== undefined) next[`${r.group}/${r.kind}`] = n;
          });
          setKindCounts(next);
        },
        () => {},
      );
    load();
    const t = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tab.context, expanded, countNs, active]);

  const reconnect = async () => {
    await api.reconnect(tab.context);
    forgetContext(tab.context);
    await loadDiscovery(tab.context, true).catch(() => {});
    discovery.reload();
    namespaces.reload();
  };

  const resourceItem = (r: ResourceInfo) => (
    <button
      key={`${r.group}/${r.kind}`}
      className={`nav-item ${sameResource(r, tab.resource) ? "active" : ""}`}
      title={`${r.plural}${r.group ? `.${r.group}` : ""} (${r.version})`}
      onClick={(e) => pick(r, e)}
      onAuxClick={(e) => e.button === 1 && pick(r, e)}
    >
      <span className="nav-label">{pluralLabel(r)}</span>
      {kindCounts[`${r.group}/${r.kind}`] !== undefined && (
        <span className="nav-count">{kindCounts[`${r.group}/${r.kind}`]}</span>
      )}
    </button>
  );

  return (
    <div className="cluster-view">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="context-swatch" style={{ background: contextColor(tab.context) }} />
          <Select
            className="select context-select"
            value={tab.context}
            onChange={(e) => update(tab.id, { context: e.target.value, resource: null, namespace: "" })}
          >
            {!contexts.data?.some((c) => c.name === tab.context) && <option value={tab.context}>{contextLabel(tab.context)}</option>}
            {contexts.data?.map((c) => (
              <option key={c.name} value={c.name} title={c.name}>
                {contextLabel(c.name)}
              </option>
            ))}
          </Select>
        </div>
        <input
          className="input sidebar-search"
          placeholder="Find resource type…"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        />
        <nav className="nav">
          <button className={`nav-item nav-top ${!tab.resource && !tab.page ? "active" : ""}`} onClick={(e) => goPage(undefined, e)}>
            Overview
          </button>
          {discovery.loading && <div className="muted small pad">Discovering APIs…</div>}
          {discovery.error && (
            <div className="error-box small">
              {discovery.error}
              <button className="btn btn-sm" onClick={reconnect}>
                Retry
              </button>
            </div>
          )}
          {sections.map((s) => {
            const isCollapsed = !kindFilter && collapsed[s.title];
            return (
              <div key={s.title} className="nav-section">
                <button
                  className="nav-section-title"
                  onClick={() => setCollapsed({ ...collapsed, [s.title]: !collapsed[s.title] })}
                >
                  <span className={`chev ${isCollapsed ? "" : "open"}`}>▸</span>
                  {s.title}
                  <span className="nav-count">{s.items.length}</span>
                </button>
                {!isCollapsed &&
                  (s.groups
                    ? s.groups.map((g) => (
                        <div key={g.group} className="nav-group">
                          <div className="nav-group-title" title={g.group}>
                            {g.group}
                          </div>
                          {g.items.map(resourceItem)}
                        </div>
                      ))
                    : s.items.map(resourceItem))}
                {!isCollapsed && s.title === "Network" && (
                  <button className="nav-item" onClick={() => openSingleton("portforwards")}>
                    Port Forwarding
                  </button>
                )}
              </div>
            );
          })}
          {discovery.data && (
            <div className="nav-section">
              <button className="nav-section-title" onClick={() => setCollapsed({ ...collapsed, Helm: !collapsed.Helm })}>
                <span className={`chev ${collapsed.Helm ? "" : "open"}`}>▸</span>
                Helm
              </button>
              {!collapsed.Helm && (
                <>
                  <button className={`nav-item ${tab.page === "releases" && !tab.resource ? "active" : ""}`} onClick={(e) => goPage("releases", e)}>
                    Releases
                  </button>
                  <button className={`nav-item ${tab.page === "charts" && !tab.resource ? "active" : ""}`} onClick={(e) => goPage("charts", e)}>
                    Charts
                  </button>
                </>
              )}
            </div>
          )}
          {discovery.data && extPages.length > 0 && (
            <div className="nav-section">
              <button className="nav-section-title" onClick={() => setCollapsed({ ...collapsed, Extensions: !collapsed.Extensions })}>
                <span className={`chev ${collapsed.Extensions ? "" : "open"}`}>▸</span>
                Extensions
              </button>
              {!collapsed.Extensions &&
                extPages.map((p) => {
                  const key = `ext:${p.ext}:${p.title}` as const;
                  return (
                    <button
                      key={key}
                      className={`nav-item ${tab.page === key && !tab.resource ? "active" : ""}`}
                      title={`From ${p.ext}`}
                      onClick={(e) => goPage(key, e)}
                    >
                      {p.title}
                    </button>
                  );
                })}
            </div>
          )}
        </nav>
      </aside>

      <main className="main">
        <div className="main-content">
        {tab.resource ? (
          <>
            <div className="toolbar">
              <h2 className="toolbar-title">
                {pluralLabel(tab.resource)}
                <span className="muted small">
                  {counts.shown === counts.total ? counts.total : `${counts.shown} / ${counts.total}`}
                </span>
              </h2>
              {tab.resource.namespaced && (
                <NamespacePicker
                  value={tab.namespace}
                  options={namespaces.data ?? []}
                  onChange={(ns) => update(tab.id, { namespace: ns })}
                  onOpen={() => {
                    refreshNamespaces(tab.context);
                    namespaces.reload();
                  }}
                />
              )}
              <input
                className="input filter"
                placeholder="Filter (name, label=value, status…)"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Checkbox checked={wide} onChange={(e) => setWide(e.target.checked)} title="Show extra columns (like kubectl -o wide)">Wide</Checkbox>
              <div className="spacer" />
              <button
                className="btn btn-sm"
                title="Local terminal with kubectl pointed at this cluster"
                onClick={() => openSession({ kind: "terminal", context: tab.context })}
              >
                Terminal
              </button>
              <button
                className="btn btn-sm"
                title="Create from YAML"
                onClick={() => open({ kind: "apply", context: tab.context, namespace: nsForApi(tab.namespace) })}
              >
                + Create
              </button>
              <button className="btn btn-sm btn-ghost btn-icon" title="Reconnect & rediscover" onClick={reconnect}>
                ⟳
              </button>
            </div>
            <div className="content-split">
              {tab.resource.namespaced && nsSelection(tab.namespace).none ? (
                <NoNamespace
                  namespaces={namespaces.data ?? []}
                  loading={namespaces.loading}
                  plural={pluralLabel(tab.resource)}
                  onPick={(ns) => update(tab.id, { namespace: ns })}
                />
              ) : (
              <ResourceTable
                key={`${tab.context}|${tab.resource.group}/${tab.resource.kind}|${tab.namespace}`}
                context={tab.context}
                resource={tab.resource}
                namespace={tab.resource.namespaced ? tab.namespace : ""}
                filter={filter}
                wide={wide}
                active={active}
                selectedUid={selected?.uid ?? null}
                onSelect={setSelected}
                onOpen={(row, background) =>
                  openDetail(
                    { context: tab.context, resource: tab.resource!, namespace: row.namespace ?? null, name: row.name },
                    { background },
                  )
                }
                onCount={onCount}
              />
              )}
              {selected && (
                <div className="drawer">
                  <DetailView
                    key={selected.uid}
                    context={tab.context}
                    resource={tab.resource}
                    namespace={selected.namespace ?? null}
                    name={selected.name}
                    active={active}
                    compact
                    onClose={() => setSelected(null)}
                  />
                </div>
              )}
            </div>
          </>
        ) : tab.page === "releases" ? (
          <HelmReleases context={tab.context} namespace={tab.namespace} active={active} onNamespace={(ns) => update(tab.id, { namespace: ns })} />
        ) : tab.page === "charts" ? (
          <HelmCharts context={tab.context} active={active} />
        ) : tab.page?.startsWith("ext:") ? (
          <ExtPageView
            page={extPages.find((p) => `ext:${p.ext}:${p.title}` === tab.page)}
            context={tab.context}
            // Extensions get "" for all namespaces, else the comma-separated selection.
            namespace={nsSelection(tab.namespace).list.join(",")}
          />
        ) : discovery.error ? (
          <div className="empty">Couldn't connect to {tab.context}</div>
        ) : discovery.loading ? (
          <div className="empty">Connecting…</div>
        ) : (
          <>
            <div className="toolbar">
              <h2 className="toolbar-title">Overview</h2>
              <Select
                className="select"
                value={nsForApi(tab.namespace) ?? ALL_NAMESPACES}
                onChange={(e) => update(tab.id, { namespace: e.target.value })}
                title="Scope pods, workloads and events"
              >
                <option value={ALL_NAMESPACES}>All namespaces</option>
                {namespaces.data?.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <div className="spacer" />
              <button
                className="btn btn-sm"
                title="Local terminal with kubectl pointed at this cluster"
                onClick={() => openSession({ kind: "terminal", context: tab.context })}
              >
                Terminal
              </button>
            </div>
            <div className="dash-scroll">
              <OverviewView
                context={tab.context}
                // The overview is cluster-wide unless exactly one namespace is chosen.
                namespace={nsForApi(tab.namespace) ?? ""}
                active={active}
                onPick={(r) => update(tab.id, { resource: r })}
              />
            </div>
          </>
        )}
        </div>
        <Dock host={tab} active={active} />
      </main>
    </div>
  );
}

function ExtPageView({ page, context, namespace }: { page?: ExtPage; context: string; namespace: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !page) return;
    el.replaceChildren();
    let cleanup: void | (() => void);
    try {
      cleanup = page.render(el, { context, namespace });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch {
        /* ignore */
      }
    };
  }, [page, context, namespace]);
  if (!page) return <div className="empty">This extension page is no longer available</div>;
  return (
    <>
      <div className="toolbar">
        <h2 className="toolbar-title">
          {page.title}
          <span className="muted small">{page.ext}</span>
        </h2>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="ext-page" ref={ref} />
    </>
  );
}

/** Shown for namespaced kinds until a namespace is picked. */
function NoNamespace({
  namespaces,
  loading,
  plural,
  onPick,
}: {
  namespaces: string[];
  loading: boolean;
  plural: string;
  onPick: (ns: string) => void;
}) {
  const [q, setQ] = useState("");
  const shown = namespaces.filter((n) => !q || n.includes(q.toLowerCase()));
  return (
    <div className="no-ns">
      <div className="no-ns-inner">
        <h3>Choose a namespace</h3>
        <p className="muted">Pick a namespace to list {plural}, or show every namespace.</p>
        <div className="no-ns-actions">
          <button className="btn btn-sm btn-primary" onClick={() => onPick(ALL_NAMESPACES)}>
            All namespaces
          </button>
          {namespaces.length > 8 && <input className="input" placeholder="Filter namespaces…" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        {loading && <div className="muted small">Loading namespaces…</div>}
        <div className="no-ns-list">
          {shown.map((n) => (
            <button key={n} className="chip-btn" onClick={() => onPick(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
