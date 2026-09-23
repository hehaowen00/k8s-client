import { useState } from "react";
import logo from "../assets/logo.png";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { api, type FolderInfo } from "../api";
import { useAsync } from "../hooks";
import { confirmDialog, toast } from "../components/Dialogs";
import { openContextMenu } from "../components/ContextMenu";
import { addClusterDialog } from "../components/AddClusterDialog";
import { bumpContexts, useContexts, useSettings, NO_CLUSTERS } from "../settings";
import { contextColor, contextDetail, contextLabel, openCluster, openSingleton, useTabs, type Tab } from "../store";

export function HomeView({ tab }: { tab: Extract<Tab, { kind: "home" }> }) {
  const { data, error, loading, reload } = useContexts();
  const clusters = useSettings((s) => s.settings?.clusters ?? NO_CLUSTERS);
  const updateCluster = useSettings((s) => s.updateCluster);
  const { update, open } = useTabs();
  const folders = useAsync(() => api.listKubeconfigFolders(), [useSettings((s) => s.contextsVersion)]);
  const [query, setQuery] = useState("");

  const afterFolderChange = (next: FolderInfo[]) => {
    folders.reload();
    reload();
    return next;
  };
  const addFolder = async () => {
    const path = await openDialog({ directory: true, title: "Choose a folder of kubeconfig files" });
    if (typeof path !== "string") return;
    try {
      const next = afterFolderChange(await api.addKubeconfigFolder(path));
      const info = next.find((f) => f.path === path);
      toast(info ? `Loaded ${info.contexts} context${info.contexts === 1 ? "" : "s"} from ${info.files} file${info.files === 1 ? "" : "s"}` : "Folder added");
    } catch (e) {
      toast(String(e), "bad");
    }
  };
  const removeFolder = async (path: string) => {
    try {
      afterFolderChange(await api.removeKubeconfigFolder(path));
    } catch (e) {
      toast(String(e), "bad");
    }
  };

  const q = query.toLowerCase();
  const contexts = (data ?? []).filter(
    (c) => !q || c.name.toLowerCase().includes(q) || contextLabel(c.name).toLowerCase().includes(q) || c.cluster.toLowerCase().includes(q) || c.source?.toLowerCase().includes(q),
  );
  const fileName = (p: string) => p.split(/[\\/]/).pop();

  const openContext = (context: string, newTab: boolean) =>
    openCluster(context, newTab ? { background: true } : { replace: tab.id });

  return (
    <div className="home">
      <div className="home-inner">
        <h1>
          <img className="logo" src={logo} alt="" width={34} height={34} /> Kube Portal
        </h1>
        <p className="muted">Pick a cluster. Ctrl/middle-click opens it in a background tab.</p>

        <div className="home-section-title">
          <span>Clusters{data ? ` (${data.length})` : ""}</span>
          <span className="home-actions">
            {(data?.length ?? 0) > 8 && (
              <input
                className="input"
                placeholder="Filter clusters…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                reload();
                folders.reload();
              }}
            >
              Reload
            </button>
            <button className="btn btn-sm" onClick={() => addClusterDialog()}>
              + Add cluster
            </button>
          </span>
        </div>
        {loading && <div className="muted">Loading kubeconfig…</div>}
        {error && <div className="error-box">{error}</div>}
        <div className="context-grid">
          {contexts.map((c) => (
            <button
              key={c.name}
              className="context-card"
              title={`${c.name}\n${c.source ?? "Default kubeconfig"}`}
              onClick={(e) => openContext(c.name, e.ctrlKey || e.metaKey)}
              onAuxClick={(e) => e.button === 1 && openContext(c.name, true)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Open in New Tab", onClick: () => openContext(c.name, true) },
                  clusters[c.name]?.pinned
                    ? { label: "Unpin from Hotbar", onClick: () => updateCluster(c.name, { pinned: false }) }
                    : { label: "Pin to Hotbar", onClick: () => updateCluster(c.name, { pinned: true }) },
                  { label: "Cluster Settings…", onClick: () => open({ kind: "settings", context: c.name }) },
                  ...(c.source && folders.data?.some((f) => f.managed && c.source!.startsWith(f.path))
                    ? [
                        { separator: true, label: "" },
                        {
                          label: "Remove from Kube Portal",
                          danger: true,
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: "Remove cluster",
                              message: `Delete the kubeconfig you added for ${contextLabel(c.name)}? (Other contexts in the same file are removed too.)`,
                              danger: true,
                              confirmLabel: "Remove",
                            });
                            if (!ok) return;
                            try {
                              await invoke("remove_added_kubeconfig", { path: c.source });
                              bumpContexts();
                            } catch (err) {
                              toast(String(err), "bad");
                            }
                          },
                        },
                      ]
                    : []),
                ])
              }
            >
              <span className="context-avatar" style={{ background: contextColor(c.name) }}>
                {contextLabel(c.name).slice(0, 2).toUpperCase()}
              </span>
              <span className="context-meta">
                <span className="context-name">
                  {contextLabel(c.name)}
                  {c.current && <span className="badge">current</span>}
                  {clusters[c.name]?.pinned && <span className="badge">pinned</span>}
                </span>
                <span className="muted small">
                  {contextDetail(c.name) ?? `cluster ${c.cluster}${c.user ? ` · user ${c.user}` : ""}`}
                  {c.namespace ? ` · ns ${c.namespace}` : ""}
                  {c.source ? ` · ${fileName(c.source)}` : ""}
                </span>
              </span>
            </button>
          ))}
          {data && data.length === 0 && (
            <div className="muted">No contexts found. Add a folder of kubeconfig files below.</div>
          )}
          {data && data.length > 0 && contexts.length === 0 && <div className="muted">No clusters match.</div>}
        </div>

        <div className="home-section-title">
          <span>Kubeconfig folders</span>
          <button className="btn btn-sm" onClick={addFolder}>
            + Add folder…
          </button>
        </div>
        <div className="folders">
          <div className="folder-row">
            <span className="mono small">$KUBECONFIG / ~/.kube/config</span>
            <span className="muted small">always loaded</span>
          </div>
          {folders.data?.map((f) => (
            <div key={f.path} className="folder-row">
              <span className="mono small" title={f.path}>
                {f.managed ? "Added in Kube Portal" : f.path}
              </span>
              <span className="muted small">
                {f.contexts} context{f.contexts === 1 ? "" : "s"} · {f.files} file{f.files === 1 ? "" : "s"}
              </span>
              {!f.managed && (
                <button className="btn btn-xs btn-ghost" title="Remove folder" onClick={() => removeFolder(f.path)}>
                  Remove
                </button>
              )}
              {f.errors.length > 0 && (
                <div className="folder-errors">
                  {f.errors.map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="home-section-title">
          <span>Tools</span>
        </div>
        <div className="context-grid">
          <button className="context-card" onClick={() => update(tab.id, { kind: "terminal" })}>
            <span className="context-avatar tool">$</span>
            <span className="context-meta">
              <span className="context-name">Local Terminal</span>
              <span className="muted small">Shell on this machine (Ctrl+`)</span>
            </span>
          </button>
          <button className="context-card" onClick={() => openSingleton("settings")}>
            <span className="context-avatar tool">⚙</span>
            <span className="context-meta">
              <span className="context-name">Settings</span>
              <span className="muted small">Theme, clusters, tools (Ctrl+,)</span>
            </span>
          </button>
          <button className="context-card" onClick={() => openSingleton("portforwards")}>
            <span className="context-avatar tool">⇄</span>
            <span className="context-meta">
              <span className="context-name">Port Forwards</span>
              <span className="muted small">Active forwards across all clusters</span>
            </span>
          </button>
          <button
            className="context-card"
            onClick={() => update(tab.id, { kind: "apply", context: null, namespace: null })}
          >
            <span className="context-avatar tool">⇪</span>
            <span className="context-meta">
              <span className="context-name">Apply Manifest</span>
              <span className="muted small">Server-side apply YAML to a cluster</span>
            </span>
          </button>
        </div>

        <div className="home-section-title">
          <span>Shortcuts</span>
        </div>
        <div className="shortcuts">
          <kbd>Ctrl+T</kbd> new tab <kbd>Ctrl+W</kbd> close tab <kbd>Ctrl+Tab</kbd> next tab <kbd>Ctrl+1…9</kbd> jump
          to tab <kbd>Middle-click</kbd> open in / close tab
        </div>
      </div>
    </div>
  );
}
