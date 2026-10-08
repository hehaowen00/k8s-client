import { isBackgroundClick } from "../keys";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ResourceInfo, type Row } from "../api";
import type { Target } from "../actions";
import { openDetail } from "../actions";
import { forgetContext, loadDiscovery, refreshNamespaces, useDiscovery, useNamespaces, usePref } from "../hooks";
import { useContexts } from "../settings";
import {
  contextColor,
  openSession,
  openSingleton,
  pluralLabel,
  useTabs,
  type Tab,
  contextLabel,
  initialNamespace,
} from "../store";
import {
  ALL_NAMESPACES,
  buildSections,
  isPlaceholder,
  nsForApi,
  nsSelection,
  pollWhileVisible,
  sameResource,
} from "../util";
import { ResourceTable } from "./ResourceTable";
import { DetailView } from "./DetailView";
import { OverviewView } from "./OverviewView";
import { Dock } from "../components/Dock";
import { Drawer } from "../components/Drawer";
import { HelmCharts, HelmReleases } from "./HelmViews";
import { NamespacePicker } from "../components/NamespacePicker";
import { useExtensions, type ExtPage } from "../extensions";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";
import { ClusterNavContext } from "../clusterNav";
import { S } from "../strings";

type ClusterTab = Extract<Tab, { kind: "cluster" }>;

/** uid prefix of a selection known only by name, until the table has its row. */
const PENDING = "pending:";

export function ClusterView({ tab, active }: { tab: ClusterTab; active: boolean }) {
  const update = useTabs((s) => s.update);
  const open = useTabs((s) => s.open);
  const discovery = useDiscovery(tab.context);
  const namespaces = useNamespaces(tab.context);
  const contexts = useContexts();

  const [filter, setFilter] = useState("");
  const [wide, setWide] = usePref("table.wide", false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [counts, setCounts] = useState<{ shown: number; total: number }>({ shown: 0, total: 0 });
  const [kindFilter, setKindFilter] = useState("");
  const [collapsed, setCollapsed] = usePref<Record<string, boolean>>("sidebar.collapsed", { Other: true });

  // Switching resource / namespace clears the selection, unless the switch was to show an object.
  const pendingSelect = useRef<Row | null>(null);
  useEffect(() => {
    setSelected(pendingSelect.current);
    pendingSelect.current = null;
  }, [tab.context, tab.resource?.kind, tab.resource?.group, tab.namespace]);

  /**
   * Show an object in this view's own list: its resource type, a namespace that has it, selected.
   * Only its name is known here, so the drawer opens on a placeholder row until the table finds
   * the real one (see `reveal` on ResourceTable).
   */
  const showInList = useCallback(
    (t: Target) => {
      const resource = discovery.data?.find((d) => sameResource(d, t.resource)) ?? t.resource;
      const objNs = resource.namespaced ? (t.namespace ?? undefined) : undefined;
      const row: Row = {
        uid: `${PENDING}${objNs ?? ""}/${t.name}`,
        name: t.name,
        namespace: objNs,
        labels: null,
        cells: [],
      };
      const ns = nsSelection(tab.namespace);
      const namespace = objNs && !ns.all && !ns.list.includes(objNs) ? objNs : tab.namespace;
      if (sameResource(resource, tab.resource) && namespace === tab.namespace) {
        setSelected(row);
        return;
      }
      pendingSelect.current = row;
      // A filter typed for the previous list would likely hide the object.
      if (!sameResource(resource, tab.resource)) setFilter("");
      update(tab.id, { resource, page: undefined, namespace });
    },
    [discovery.data, tab.id, tab.namespace, tab.resource, update],
  );
  const nav = useMemo(() => ({ context: tab.context, show: showInList }), [tab.context, showInList]);

  const sections = useMemo(
    () => buildSections(discovery.data ?? [], kindFilter.toLowerCase()),
    [discovery.data, kindFilter],
  );

  const pick = (r: ResourceInfo, e: React.MouseEvent) => {
    if (isBackgroundClick(e)) {
      open({ kind: "cluster", context: tab.context, resource: r, namespace: tab.namespace }, { background: true });
    } else {
      update(tab.id, { resource: r, page: undefined });
    }
  };
  const extPages = useExtensions((s) => s.pages);
  const goPage = (page: "releases" | "charts" | `ext:${string}` | undefined, e: React.MouseEvent) => {
    if (isBackgroundClick(e))
      open(
        { kind: "cluster", context: tab.context, resource: null, namespace: tab.namespace, page },
        { background: true },
      );
    else update(tab.id, { resource: null, page });
  };

  // The open table's own count is live, so the sidebar shows it instead of the periodic count.
  const openKey = tab.resource ? `${tab.resource.group}/${tab.resource.kind}` : null;
  const [liveCount, setLiveCount] = useState<{ key: string; total: number } | null>(null);
  const onCount = useCallback(
    (shown: number, total: number, loaded: boolean) => {
      setCounts({ shown, total });
      setLiveCount(loaded && openKey ? { key: openKey, total } : null);
    },
    [openKey],
  );

  // Object counts for the expanded sidebar sections (cheap limit=1 lists), refreshed every 10 minutes
  // and whenever a section is expanded.
  const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
  const countNs = nsForApi(tab.namespace) ?? "";
  useEffect(() => setKindCounts({}), [tab.context, countNs]);
  const expanded = useMemo(
    () =>
      sections
        .filter((s) => !(!kindFilter && collapsed[s.title]))
        .flatMap((s) => s.items.filter((r) => !isPlaceholder(r))),
    [sections, collapsed, kindFilter],
  );
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
          setKindCounts((prev) => ({ ...prev, ...next }));
        },
        () => {},
      );
    load();
    const stop = pollWhileVisible(load, 10 * 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [tab.context, expanded, countNs, active]);

  const reconnect = async () => {
    await api.reconnect(tab.context);
    forgetContext(tab.context);
    await loadDiscovery(tab.context, true).catch(() => {});
    discovery.reload();
    namespaces.reload();
  };

  const countOf = (r: ResourceInfo) => {
    const key = `${r.group}/${r.kind}`;
    return liveCount?.key === key ? liveCount.total : kindCounts[key];
  };
  const resourceItem = (r: ResourceInfo) => (
    <button
      key={`${r.group}/${r.kind}`}
      className={`nav-item ${sameResource(r, tab.resource) ? "active" : ""}`}
      disabled={isPlaceholder(r)}
      title={
        isPlaceholder(r)
          ? discovery.loading
            ? S.clusterView.discovering
            : S.clusterView.notServed
          : `${r.plural}${r.group ? `.${r.group}` : ""} (${r.version})`
      }
      onClick={(e) => pick(r, e)}
      onAuxClick={(e) => e.button === 1 && pick(r, e)}
    >
      <span className="nav-label">{pluralLabel(r)}</span>
      {countOf(r) !== undefined && <span className="nav-count">{countOf(r)}</span>}
    </button>
  );

  return (
    <ClusterNavContext.Provider value={nav}>
      <div className="cluster-view">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span className="context-swatch" style={{ background: contextColor(tab.context) }} />
            <Select
              className="select context-select"
              value={tab.context}
              onChange={(e) =>
                update(tab.id, { context: e.target.value, resource: null, namespace: initialNamespace(e.target.value) })
              }
            >
              {!contexts.data?.some((c) => c.name === tab.context) && (
                <option value={tab.context}>{contextLabel(tab.context)}</option>
              )}
              {contexts.data?.map((c) => (
                <option key={c.name} value={c.name} title={c.name}>
                  {contextLabel(c.name)}
                </option>
              ))}
            </Select>
          </div>
          <input
            className="input sidebar-search"
            placeholder={S.clusterView.findType}
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
          />
          <nav className="nav">
            <button
              className={`nav-item nav-top ${!tab.resource && !tab.page ? "active" : ""}`}
              onClick={(e) => goPage(undefined, e)}
            >
              {S.cluster.overview}
            </button>
            {discovery.loading && <div className="muted small pad">{S.clusterView.discovering}</div>}
            {discovery.error && (
              <div className="error-box small">
                {discovery.error}
                <button className="btn btn-sm" onClick={reconnect}>
                  {S.common.retry}
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
                  {!isCollapsed && s.title === S.nav.network && (
                    <button className="nav-item" onClick={() => openSingleton("portforwards")}>
                      {S.clusterView.portForwarding}
                    </button>
                  )}
                </div>
              );
            })}
            {discovery.data && (
              <div className="nav-section">
                <button
                  className="nav-section-title"
                  onClick={() => setCollapsed({ ...collapsed, Helm: !collapsed.Helm })}
                >
                  <span className={`chev ${collapsed.Helm ? "" : "open"}`}>▸</span>
                  {S.helm.section}
                </button>
                {!collapsed.Helm && (
                  <>
                    <button
                      className={`nav-item ${tab.page === "releases" && !tab.resource ? "active" : ""}`}
                      onClick={(e) => goPage("releases", e)}
                    >
                      {S.helm.releasesShort}
                    </button>
                    <button
                      className={`nav-item ${tab.page === "charts" && !tab.resource ? "active" : ""}`}
                      onClick={(e) => goPage("charts", e)}
                    >
                      {S.helm.chartsShort}
                    </button>
                  </>
                )}
              </div>
            )}
            {discovery.data && extPages.length > 0 && (
              <div className="nav-section">
                <button
                  className="nav-section-title"
                  onClick={() => setCollapsed({ ...collapsed, Extensions: !collapsed.Extensions })}
                >
                  <span className={`chev ${collapsed.Extensions ? "" : "open"}`}>▸</span>
                  {S.palette.extensions}
                </button>
                {!collapsed.Extensions &&
                  extPages.map((p) => {
                    const key = `ext:${p.ext}:${p.title}` as const;
                    return (
                      <button
                        key={key}
                        className={`nav-item ${tab.page === key && !tab.resource ? "active" : ""}`}
                        title={S.clusterView.fromExt(p.ext)}
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
                    placeholder={S.clusterView.filter}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <Checkbox checked={wide} onChange={(e) => setWide(e.target.checked)} title={S.clusterView.wideHint}>
                    {S.clusterView.wide}
                  </Checkbox>
                  <div className="spacer" />
                  <button
                    className="btn btn-sm"
                    title={S.clusterView.terminalHint}
                    onClick={() => openSession({ kind: "terminal", context: tab.context })}
                  >
                    {S.clusterView.terminal}
                  </button>
                  <button
                    className="btn btn-sm"
                    title={S.clusterView.createHint}
                    onClick={() => open({ kind: "apply", context: tab.context, namespace: nsForApi(tab.namespace) })}
                  >
                    {S.clusterView.create}
                  </button>
                  <button className="btn btn-sm btn-ghost btn-icon" title={S.clusterView.reconnect} onClick={reconnect}>
                    ⟳
                  </button>
                </div>
                <div className="content-split">
                  {tab.resource.namespaced && nsSelection(tab.namespace).none ? (
                    <div className="no-ns" />
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
                      reveal={selected?.uid.startsWith(PENDING) ? selected : null}
                      onSelect={setSelected}
                      onOpen={(row, background) =>
                        openDetail(
                          {
                            context: tab.context,
                            resource: tab.resource!,
                            namespace: row.namespace ?? null,
                            name: row.name,
                          },
                          { background },
                        )
                      }
                      onCount={onCount}
                    />
                  )}
                  {selected && (
                    <Drawer>
                      <DetailView
                        key={`${selected.namespace ?? ""}/${selected.name}`}
                        context={tab.context}
                        resource={tab.resource}
                        namespace={selected.namespace ?? null}
                        name={selected.name}
                        active={active}
                        compact
                        onClose={() => setSelected(null)}
                      />
                    </Drawer>
                  )}
                </div>
              </>
            ) : tab.page === "releases" ? (
              <HelmReleases
                key={tab.context}
                context={tab.context}
                namespace={tab.namespace}
                active={active}
                onNamespace={(ns) => update(tab.id, { namespace: ns })}
              />
            ) : tab.page === "charts" ? (
              <HelmCharts key={tab.context} context={tab.context} active={active} />
            ) : tab.page?.startsWith("ext:") ? (
              <ExtPageView
                page={extPages.find((p) => `ext:${p.ext}:${p.title}` === tab.page)}
                context={tab.context}
                // Extensions get "" for all namespaces, else the comma-separated selection.
                namespace={nsSelection(tab.namespace).list.join(",")}
              />
            ) : discovery.error ? (
              <div className="empty">{S.clusterView.connectFailed(tab.context)}</div>
            ) : discovery.loading ? (
              <div className="empty">{S.clusterView.connecting}</div>
            ) : (
              <>
                <div className="toolbar">
                  <h2 className="toolbar-title">{S.cluster.overview}</h2>
                  <Select
                    className="select"
                    value={nsForApi(tab.namespace) ?? ALL_NAMESPACES}
                    onChange={(e) => update(tab.id, { namespace: e.target.value })}
                    title={S.clusterView.overviewScope}
                  >
                    <option value={ALL_NAMESPACES}>{S.ns.all}</option>
                    {namespaces.data?.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                  <div className="spacer" />
                  <button
                    className="btn btn-sm"
                    title={S.clusterView.terminalHint}
                    onClick={() => openSession({ kind: "terminal", context: tab.context })}
                  >
                    {S.clusterView.terminal}
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
    </ClusterNavContext.Provider>
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
  if (!page) return <div className="empty">{S.clusterView.extPageGone}</div>;
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
