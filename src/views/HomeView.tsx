import { backgroundClickLabel, isBackgroundClick, nextTabLabel, shortcut } from "../keys";
import { useState } from "react";
import logo from "../assets/logo.svg";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { api, type FolderInfo } from "../api";
import { useAsync } from "../hooks";
import { confirmDialog, toast } from "../components/Dialogs";
import { openContextMenu } from "../components/ContextMenu";
import { addClusterDialog } from "../components/AddClusterDialog";
import { pickClusterIcon } from "../clusterIcon";
import { bumpContexts, useContexts, useSettings, NO_CLUSTERS } from "../settings";
import {
  contextColor,
  contextIcon,
  contextDetail,
  contextLabel,
  openCluster,
  openClusterSettings,
  openSingleton,
  useTabs,
  type Tab,
} from "../store";
import { S } from "../strings";

export function HomeView({ tab }: { tab: Extract<Tab, { kind: "home" }> }) {
  const { data, error, loading, reload } = useContexts();
  const clusters = useSettings((s) => s.settings?.clusters ?? NO_CLUSTERS);
  const updateCluster = useSettings((s) => s.updateCluster);
  const update = useTabs((s) => s.update);
  const folders = useAsync(() => api.listKubeconfigFolders(), [], [useSettings((s) => s.contextsVersion)]);
  const [query, setQuery] = useState("");

  const afterFolderChange = (next: FolderInfo[]) => {
    folders.reload();
    reload();
    return next;
  };
  const addFolder = async () => {
    const path = await openDialog({ directory: true, title: S.home.chooseFolder });
    if (typeof path !== "string") return;
    try {
      const next = afterFolderChange(await api.addKubeconfigFolder(path));
      const info = next.find((f) => f.path === path);
      toast(info ? S.home.folderLoaded(info.contexts, info.files) : S.home.folderAdded);
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
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      contextLabel(c.name).toLowerCase().includes(q) ||
      c.cluster.toLowerCase().includes(q) ||
      c.source?.toLowerCase().includes(q),
  );
  const fileName = (p: string) => p.split(/[\\/]/).pop();

  const openContext = (context: string, newTab: boolean) =>
    openCluster(context, newTab ? { background: true } : { replace: tab.id });

  return (
    <div className="home">
      <div className="home-inner">
        <h1>
          <img className="logo" src={logo} alt="" width={34} height={34} /> {S.app.name}
        </h1>
        <p className="muted">{S.home.intro(backgroundClickLabel)}</p>

        <div className="home-section-title">
          <span>{S.home.clusters(data?.length)}</span>
          <span className="home-actions">
            {(data?.length ?? 0) > 8 && (
              <input
                className="input"
                placeholder={S.home.filterClusters}
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
              {S.common.reload}
            </button>
            <button className="btn btn-sm" onClick={() => addClusterDialog()}>
              {S.home.addCluster}
            </button>
          </span>
        </div>
        {loading && <div className="muted">{S.home.loading}</div>}
        {error && <div className="error-box">{error}</div>}
        <div className="context-grid">
          {contexts.map((c) => (
            <button
              key={c.name}
              className="context-card"
              title={`${c.name}\n${c.source ?? S.home.defaultKubeconfig}`}
              onClick={(e) => openContext(c.name, isBackgroundClick(e))}
              onAuxClick={(e) => e.button === 1 && openContext(c.name, true)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: S.common.openInNewTab, onClick: () => openContext(c.name, true) },
                  clusters[c.name]?.pinned
                    ? { label: S.home.unpin, onClick: () => updateCluster(c.name, { pinned: false }) }
                    : { label: S.home.pin, onClick: () => updateCluster(c.name, { pinned: true }) },
                  { label: S.home.changeIcon, onClick: () => pickClusterIcon(c.name) },
                  ...(clusters[c.name]?.icon
                    ? [{ label: S.home.removeIcon, onClick: () => updateCluster(c.name, { icon: null }) }]
                    : []),
                  { label: S.cluster.settings, onClick: () => openClusterSettings(c.name, { replace: tab.id }) },
                  ...(c.source && folders.data?.some((f) => f.managed && c.source!.startsWith(f.path))
                    ? [
                        { separator: true, label: "" },
                        {
                          label: S.home.removeCluster,
                          danger: true,
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: S.home.removeClusterTitle,
                              message: S.home.removeClusterMessage(contextLabel(c.name)),
                              danger: true,
                              confirmLabel: S.common.remove,
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
                {!contextIcon(c.name) && contextLabel(c.name).slice(0, 2).toUpperCase()}
              </span>
              <span className="context-meta">
                <span className="context-name">
                  {contextLabel(c.name)}
                  {c.current && <span className="badge">{S.home.current}</span>}
                  {clusters[c.name]?.pinned && <span className="badge">{S.home.pinned}</span>}
                </span>
                <span className="muted small">
                  {contextDetail(c.name) ?? S.home.contextDetail(c.cluster, c.user)}
                  {c.namespace ? S.home.contextNamespace(c.namespace) : ""}
                  {c.source ? ` · ${fileName(c.source)}` : ""}
                </span>
              </span>
            </button>
          ))}
          {data && data.length === 0 && <div className="muted">{S.home.noContexts}</div>}
          {data && data.length > 0 && contexts.length === 0 && <div className="muted">{S.home.noMatches}</div>}
        </div>

        <div className="home-section-title">
          <span>{S.home.folders}</span>
          <button className="btn btn-sm" onClick={addFolder}>
            {S.home.addFolder}
          </button>
        </div>
        <div className="folders">
          <div className="folder-row">
            <span className="mono small">$KUBECONFIG / ~/.kube/config</span>
            <span className="muted small">{S.home.alwaysLoaded}</span>
          </div>
          {folders.data?.map((f) => (
            <div key={f.path} className="folder-row">
              <span className="mono small" title={f.path}>
                {f.managed ? S.home.addedInApp : f.path}
              </span>
              <span className="muted small">{S.home.folderCounts(f.contexts, f.files)}</span>
              {!f.managed && (
                <button
                  className="btn btn-xs btn-ghost"
                  title={S.home.removeFolder}
                  onClick={() => removeFolder(f.path)}
                >
                  {S.common.remove}
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
          <span>{S.home.tools}</span>
        </div>
        <div className="context-grid">
          <button className="context-card" onClick={() => openSingleton("settings")}>
            <span className="context-avatar tool">⚙</span>
            <span className="context-meta">
              <span className="context-name">{S.settings.title}</span>
              <span className="muted small">{S.home.settingsHint(shortcut(","))}</span>
            </span>
          </button>
          <button className="context-card" onClick={() => openSingleton("portforwards")}>
            <span className="context-avatar tool">⇄</span>
            <span className="context-meta">
              <span className="context-name">{S.portForward.listTitle}</span>
              <span className="muted small">{S.home.portForwardsHint}</span>
            </span>
          </button>
          <button
            className="context-card"
            onClick={() => update(tab.id, { kind: "apply", context: null, namespace: null })}
          >
            <span className="context-avatar tool">⇪</span>
            <span className="context-meta">
              <span className="context-name">{S.apply.title}</span>
              <span className="muted small">{S.home.applyHint}</span>
            </span>
          </button>
        </div>

        <div className="home-section-title">
          <span>{S.home.shortcuts}</span>
        </div>
        <div className="shortcuts">
          <kbd>{shortcut("T")}</kbd> {S.home.keyNewTab} <kbd>{shortcut("W")}</kbd> {S.home.keyCloseTab}{" "}
          <kbd>{nextTabLabel}</kbd> {S.home.keyNextTab} <kbd>{shortcut("1…9")}</kbd> {S.home.keyJump}{" "}
          <kbd>{S.home.middleClick}</kbd> {S.home.keyMiddleClick}
        </div>
      </div>
    </div>
  );
}
