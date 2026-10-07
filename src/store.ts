import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ResourceInfo } from "./api";
import { useSettings } from "./settings";

interface TabBase {
  id: string;
}

export type Tab = TabBase &
  (
    | { kind: "home" }
    | {
        kind: "cluster";
        context: string;
        resource: ResourceInfo | null;
        namespace: string; // "" = all namespaces
        /** Non-resource pages; only used when `resource` is null (null + no page = overview). */
        page?: "releases" | "charts" | `ext:${string}`;
        dock?: DockState;
      }
    | {
        kind: "detail";
        context: string;
        resource: ResourceInfo;
        namespace: string | null;
        name: string;
        view?: "overview" | "yaml" | "events";
        dock?: DockState;
      }
    | {
        kind: "logs";
        context: string;
        namespace: string;
        /** Single pod; omitted for workload logs. */
        pod?: string;
        /** Whole workload: every pod matching the selector. */
        workload?: { kind: string; name: string; selector: string };
        /** Container name, "*" for all containers, or null for the pod's default. */
        container?: string | null;
      }
    | {
        kind: "exec";
        context: string;
        namespace: string;
        pod: string;
        container?: string | null;
        /** Attach to the container's main process instead of starting a shell. */
        attach?: boolean;
        /** Node shell: a privileged pod is created on this node on connect and deleted afterwards. */
        nodeShell?: string;
      }
    | { kind: "terminal"; context: string }
    | { kind: "apply"; context: string | null; namespace: string | null }
    | { kind: "portforwards" }
    | { kind: "settings" }
    | {
        kind: "cluster-settings";
        context: string;
        /** Opened in place of a New Tab page, which it can go back to. */
        fromHome?: boolean;
      }
  );

export type NewTab = Tab extends infer T ? (T extends Tab ? Omit<T, "id"> : never) : never;

/** Logs / shells / terminals can live in a tab's bottom dock instead of their own tab. */
export type DockItem = Extract<Tab, { kind: "logs" | "exec" | "terminal" }>;
export type NewDockItem = DockItem extends infer T ? (T extends DockItem ? Omit<T, "id"> : never) : never;
/** Tabs that host a dock ("workspaces"). Each tab has its own, even for the same cluster. */
export type DockHost = Extract<Tab, { kind: "cluster" | "detail" }>;

export interface DockState {
  items: DockItem[];
  activeId: string | null;
  open: boolean;
  height: number;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** Tab shown in the right-hand split pane, if any. */
  splitId: string | null;
  setSplit: (id: string | null) => void;
  toggleSplit: () => void;
  open: (tab: NewTab, opts?: { background?: boolean; after?: string }) => string;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeRight: (id: string) => void;
  activate: (id: string) => void;
  update: (id: string, patch: Partial<Tab>) => void;
  move: (from: number, to: number) => void;
  cycle: (dir: 1 | -1) => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Last namespace picked per context, so new cluster tabs reopen where you left off (survives restarts). */
const LAST_NS_KEY = "kubetab.lastNamespace";
function lastNamespaces(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_NS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function rememberNamespace(context: string, ns: string) {
  try {
    localStorage.setItem(LAST_NS_KEY, JSON.stringify({ ...lastNamespaces(), [context]: ns }));
  } catch {
    /* ignore */
  }
}
/** Record cluster tabs' namespaces (all of them at startup, then only tabs whose namespace changed). */
function syncNamespaces(tabs: Tab[], prev: Tab[] = []) {
  for (const t of tabs) {
    if (t.kind !== "cluster") continue;
    const p = prev.find((x) => x.id === t.id);
    if (p?.kind === "cluster" && p.context === t.context && p.namespace === t.namespace) continue;
    if (lastNamespaces()[t.context] !== t.namespace) rememberNamespace(t.context, t.namespace);
  }
}
/** Namespace for a freshly opened cluster view: last used, else the cluster's configured default. */
export function initialNamespace(context: string): string {
  return lastNamespaces()[context] ?? useSettings.getState().settings?.clusters[context]?.defaultNamespace ?? "";
}

/** localStorage that skips unchanged values and writes at most once per second (flushed when the window closes). */
const coalescedStorage: StateStorage = (() => {
  const pending = new Map<string, string>();
  const written = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const [k, v] of pending) {
      try {
        localStorage.setItem(k, v);
        written.set(k, v);
      } catch {
        /* ignore */
      }
    }
    pending.clear();
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  return {
    getItem: (k) => pending.get(k) ?? localStorage.getItem(k),
    setItem: (k, v) => {
      if ((written.get(k) ?? localStorage.getItem(k)) === v) {
        pending.delete(k);
        return;
      }
      pending.set(k, v);
      timer ??= setTimeout(flush, 1000);
    },
    removeItem: (k) => {
      pending.delete(k);
      written.delete(k);
      localStorage.removeItem(k);
    },
  };
})();

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      splitId: null,
      setSplit: (id) => set((s) => ({ splitId: id && id !== s.activeId ? id : null })),
      toggleSplit: () =>
        set((s) => {
          if (s.splitId) return { splitId: null };
          const idx = s.tabs.findIndex((t) => t.id === s.activeId);
          const other = s.tabs[idx + 1] ?? s.tabs[idx - 1];
          return { splitId: other?.id ?? null };
        }),
      open: (tab, opts) => {
        // The "New Tab" page is hidden from the tab strip, so keep at most one and just focus it.
        const home = tab.kind === "home" && get().tabs.find((t) => t.kind === "home");
        if (home) {
          set({ activeId: home.id });
          return home.id;
        }
        const id = newId();
        set((s) => {
          const tabs = [...s.tabs];
          // Blank tabs go at the end (like a browser's new tab); others open next to their source.
          const anchor = tab.kind === "home" ? null : opts?.after ?? s.activeId;
          const idx = anchor ? tabs.findIndex((t) => t.id === anchor) : -1;
          const newTab = { ...tab, id } as Tab;
          // Opening something in the foreground takes over a blank "New Tab" instead of leaving it behind.
          if (tab.kind !== "home" && !opts?.background && tabs[idx]?.kind === "home") tabs[idx] = newTab;
          else if (idx >= 0) tabs.splice(idx + 1, 0, newTab);
          else tabs.push(newTab);
          return { tabs, activeId: opts?.background ? s.activeId ?? id : id };
        });
        return id;
      },
      close: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return s;
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeId = s.activeId;
          let splitId = s.splitId === id ? null : s.splitId;
          if (activeId === id) {
            // Closing the left pane: the split tab takes over.
            activeId = splitId ?? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
            if (activeId === splitId) splitId = null;
          }
          return { tabs, activeId, splitId };
        }),
      closeOthers: (id) => set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeId: id, splitId: null })),
      closeRight: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.slice(0, idx + 1);
          const activeId = tabs.some((t) => t.id === s.activeId) ? s.activeId : id;
          const splitId = tabs.some((t) => t.id === s.splitId) ? s.splitId : null;
          return { tabs, activeId, splitId };
        }),
      // Activating the split tab swaps the panes.
      activate: (id) => set((s) => (id === s.splitId ? { activeId: id, splitId: s.activeId } : { activeId: id })),
      update: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)),
        })),
      move: (from, to) =>
        set((s) => {
          const tabs = [...s.tabs];
          const [t] = tabs.splice(from, 1);
          tabs.splice(to, 0, t);
          return { tabs };
        }),
      cycle: (dir) => {
        const { activeId } = get();
        const tabs = get().tabs.filter((t) => t.kind !== "home" || t.id === activeId);
        if (!tabs.length) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        const next = (idx + dir + tabs.length) % tabs.length;
        set({ activeId: tabs[next].id });
      },
    }),
    {
      name: "kubetab.tabs",
      version: 1,
      storage: createJSONStorage(() => coalescedStorage),
      partialize: (s) => ({
        tabs: s.tabs.flatMap((t) => (t.kind === "cluster" ? [{ ...t, dock: undefined }] : [])),
        activeId: s.activeId,
        splitId: s.splitId,
      }),
    },
  ),
);

syncNamespaces(useTabs.getState().tabs);
// On startup, restore only cluster tabs (category + namespace); logs, shells, details and docks start fresh.
{
  const { tabs, activeId, splitId } = useTabs.getState();
  const restored = tabs.flatMap((t) => (t.kind === "cluster" ? [{ ...t, dock: undefined }] : []));
  const has = (id: string | null) => restored.some((t) => t.id === id);
  useTabs.setState({
    tabs: restored,
    activeId: has(activeId) ? activeId : restored[0]?.id ?? null,
    splitId: has(splitId) && splitId !== activeId ? splitId : null,
  });
}
useTabs.subscribe((s, prev) => s.tabs !== prev.tabs && syncNamespaces(s.tabs, prev.tabs));

export function tabTitle(tab: Tab): string {
  switch (tab.kind) {
    case "home":
      return "New Tab";
    case "cluster":
      return contextLabel(tab.context);
    case "detail":
      return `${tab.resource.kind}: ${tab.name}`;
    case "logs":
      return tab.workload ? `Logs: ${tab.workload.kind.toLowerCase()}/${tab.workload.name}` : `Logs: ${tab.pod}`;
    case "exec":
      return tab.nodeShell ? `Node: ${tab.nodeShell}` : `${tab.attach ? "Attach" : "Shell"}: ${tab.pod}`;
    case "terminal":
      return `Terminal: ${contextLabel(tab.context)}`;
    case "apply":
      return "Apply Manifest";
    case "portforwards":
      return "Port Forwards";
    case "settings":
      return "Settings";
    case "cluster-settings":
      return `Settings: ${contextLabel(tab.context)}`;
  }
}

/** Open (or focus) a cluster tab for `context`, honouring its default namespace. */
export function openCluster(context: string, opts?: { background?: boolean; replace?: string; focusExisting?: boolean }) {
  const { tabs, activate, open, update } = useTabs.getState();
  if (opts?.focusExisting) {
    const existing = tabs.find((t) => t.kind === "cluster" && t.context === context);
    if (existing) return activate(existing.id);
  }
  const t = { kind: "cluster" as const, context, resource: null, namespace: initialNamespace(context) };
  if (opts?.replace) update(opts.replace, t);
  else open(t, { background: opts?.background });
}

/** Focus the existing tab of a singleton kind, or open one. */
export function openSingleton(kind: "portforwards" | "settings") {
  const { tabs, activate, open } = useTabs.getState();
  const existing = tabs.find((t) => t.kind === kind);
  if (existing) activate(existing.id);
  else open({ kind });
}

/** Open (or focus) the settings page of one cluster. `replace` turns that New Tab page into it instead. */
export function openClusterSettings(context: string, opts?: { replace?: string }) {
  const { tabs, activate, open, update } = useTabs.getState();
  if (opts?.replace) return update(opts.replace, { kind: "cluster-settings", context, fromHome: true });
  const existing = tabs.find((t) => t.kind === "cluster-settings" && t.context === context);
  if (existing) activate(existing.id);
  else open({ kind: "cluster-settings", context });
}

/** Turn a tab back into a New Tab page (a fresh object so no fields of the old kind linger). */
export function backToHome(id: string) {
  useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { id, kind: "home" } : t)) }));
}

export function tabContext(tab: Tab): string | null {
  return "context" in tab ? tab.context ?? null : null;
}

export function pluralLabel(r: ResourceInfo): string {
  // Reuse the API's plural but keep the kind's CamelCase ("endpointslices" -> "EndpointSlices").
  const k = r.kind;
  if (r.plural.startsWith(k.toLowerCase())) return k + r.plural.slice(k.length);
  if (k.endsWith("y") && r.plural.endsWith("ies")) return k.slice(0, -1) + "ies";
  return k + "s";
}

const EKS_ARN = /^arn:aws[\w-]*:eks:([\w-]+):(\d+):cluster\/(.+)$/;

/** Short display name for a context: EKS ARNs become their cluster name (unique ids are kept elsewhere). */
export function contextLabel(ctx: string): string {
  const custom = useSettings.getState().settings?.clusters[ctx]?.displayName;
  if (custom?.trim()) return custom.trim();
  const m = EKS_ARN.exec(ctx);
  if (!m) return ctx;
  // Keep any "(file)" disambiguation suffix the backend added.
  return m[3];
}

/** Extra detail for contexts whose label hides information (e.g. EKS region/account). */
export function contextDetail(ctx: string): string | null {
  const m = EKS_ARN.exec(ctx);
  return m ? `EKS · ${m[1]} · ${m[2]}` : null;
}

export const contextIcon = (ctx: string) => useSettings.getState().settings?.clusters[ctx]?.icon || null;

/** Stable per-cluster CSS `background` (icon image, else colour) so clusters are distinguishable. */
export function contextColor(ctx: string): string {
  const icon = contextIcon(ctx);
  if (icon) return `center / cover no-repeat url("${icon}")`;
  const custom = useSettings.getState().settings?.clusters[ctx]?.color;
  if (custom) return custom;
  let h = 0;
  for (let i = 0; i < ctx.length; i++) h = (h * 31 + ctx.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 60%)`;
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

const EMPTY_DOCK: DockState = { items: [], activeId: null, open: true, height: 300 };
export const isDockHost = (t: Tab | undefined): t is DockHost => !!t && (t.kind === "cluster" || t.kind === "detail");

function setDock(tabId: string, fn: (d: DockState) => DockState) {
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId && isDockHost(t) ? ({ ...t, dock: fn(t.dock ?? EMPTY_DOCK) } as Tab) : t)),
  }));
}

export const dock = {
  add(tabId: string, item: NewDockItem) {
    const id = newId();
    setDock(tabId, (d) => ({ ...d, items: [...d.items, { ...item, id } as DockItem], activeId: id, open: true }));
    return id;
  },
  close(tabId: string, itemId: string) {
    setDock(tabId, (d) => {
      const idx = d.items.findIndex((i) => i.id === itemId);
      const items = d.items.filter((i) => i.id !== itemId);
      const activeId = d.activeId === itemId ? items[Math.min(idx, items.length - 1)]?.id ?? null : d.activeId;
      return { ...d, items, activeId };
    });
  },
  closeOthers: (tabId: string, itemId: string) => setDock(tabId, (d) => ({ ...d, items: d.items.filter((i) => i.id === itemId), activeId: itemId })),
  closeAll: (tabId: string) => setDock(tabId, (d) => ({ ...d, items: [], activeId: null })),
  activate: (tabId: string, itemId: string) => setDock(tabId, (d) => ({ ...d, activeId: itemId, open: true })),
  update: (tabId: string, itemId: string, patch: Partial<DockItem>) =>
    setDock(tabId, (d) => ({ ...d, items: d.items.map((i) => (i.id === itemId ? ({ ...i, ...patch } as DockItem) : i)) })),
  setOpen: (tabId: string, open: boolean) => setDock(tabId, (d) => ({ ...d, open })),
  setHeight: (tabId: string, height: number) => setDock(tabId, (d) => ({ ...d, height })),
  /** Move a dock item out into its own top-level tab. */
  popOut(tabId: string, itemId: string) {
    const host = useTabs.getState().tabs.find((t) => t.id === tabId);
    const item = isDockHost(host) ? host.dock?.items.find((i) => i.id === itemId) : undefined;
    if (!item) return;
    dock.close(tabId, itemId);
    const { id: _id, ...rest } = item;
    useTabs.getState().open(rest as NewTab);
  },
};

/**
 * Open logs / a shell / a terminal in the active tab's dock when that tab belongs to the same
 * cluster (or the session isn't cluster-specific); otherwise in a new top-level tab.
 */
export function openSession(item: NewDockItem, opts?: { newTab?: boolean }) {
  const { tabs, activeId, open } = useTabs.getState();
  const host = tabs.find((t) => t.id === activeId);
  const ctx = "context" in item ? item.context ?? null : null;
  if (!opts?.newTab && isDockHost(host) && (!ctx || host.context === ctx)) {
    dock.add(host.id, item);
  } else {
    open(item as NewTab);
  }
}
