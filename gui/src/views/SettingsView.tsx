import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type FolderInfo } from "../api";
import { EMPTY_CLUSTER, bumpContexts, useContexts, useSettings, type ClusterSettings, type Settings } from "../settings";
import { contextColor, contextLabel, useTabs, type Tab } from "../store";
import { toast } from "../components/Dialogs";
import { openPath } from "@tauri-apps/plugin-opener";
import { useExtensions } from "../extensions";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";

const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Text input that commits on blur / Enter instead of every keystroke. */
function CommitInput({ value, onCommit, placeholder, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`input ${className ?? ""}`}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function SettingsView({ tab }: { tab: Extract<Tab, { kind: "settings" }> }) {
  const settings = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const contexts = useContexts();
  const [cluster, setCluster] = useState<string | null>(tab.context ?? null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);

  useEffect(() => {
    api.listKubeconfigFolders().then(setFolders, () => {});
  }, [settings?.kubeconfigFolders]);
  useEffect(() => {
    if (tab.context) setCluster(tab.context);
  }, [tab.context]);
  useEffect(() => {
    if (!cluster && contexts.data?.length) setCluster(contexts.data[0].name);
  }, [cluster, contexts.data]);

  if (!settings) return <div className="empty">Loading settings…</div>;
  const set = (patch: Partial<Settings>) => save({ ...settings, ...patch }).catch((e) => toast(String(e), "bad"));
  const cs: ClusterSettings = (cluster && settings.clusters[cluster]) || EMPTY_CLUSTER;
  const setCluster_ = (patch: Partial<ClusterSettings>) =>
    cluster && set({ clusters: { ...settings.clusters, [cluster]: { ...cs, ...patch } } });

  return (
    <div className="settings-view">
      <div className="settings-inner">
        <h1>Settings</h1>

        <section className="settings-section">
          <h2>Appearance</h2>
          <Field label="Theme">
            <div className="segmented">
              {(["system", "dark", "light"] as const).map((t) => (
                <button key={t} className={settings.theme === t ? "active" : ""} onClick={() => set({ theme: t })}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </Field>
        </section>

        <section className="settings-section">
          <h2>Kubeconfig</h2>
          <Field label="Sources" hint="Changes to these files are picked up automatically">
            <div className="folders">
              <div className="folder-row">
                <span className="mono small">$KUBECONFIG / ~/.kube/config</span>
                <span className="muted small">always loaded</span>
              </div>
              {folders.map((f) => (
                <div key={f.path} className="folder-row">
                  <span className="mono small" title={f.path}>
                    {f.managed ? "Added in Kube Portal" : f.path}
                  </span>
                  <span className="muted small">
                    {f.contexts} context{f.contexts === 1 ? "" : "s"}
                  </span>
                  {!f.managed && (
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() => api.removeKubeconfigFolder(f.path).then(setFolders).then(bumpContexts).then(() => useSettings.getState().load())}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                const path = await openDialog({ directory: true, title: "Choose a folder of kubeconfig files" });
                if (typeof path !== "string") return;
                try {
                  setFolders(await api.addKubeconfigFolder(path));
                  bumpContexts();
                  useSettings.getState().load();
                } catch (e) {
                  toast(String(e), "bad");
                }
              }}
            >
              + Add folder…
            </button>
          </Field>
        </section>

        <section className="settings-section">
          <h2>Clusters</h2>
          <Field label="Cluster">
            <Select className="select wide-select" value={cluster ?? ""} onChange={(e) => setCluster(e.target.value)}>
              {contexts.data?.map((c) => (
                <option key={c.name} value={c.name}>
                  {contextLabel(c.name)}
                  {contextLabel(c.name) !== c.name ? ` — ${c.name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {cluster && (
            <>
              <Field label="Display name" hint="Shown on tabs, cards and the hotbar">
                <CommitInput value={cs.displayName ?? ""} placeholder={cluster} onCommit={(v) => setCluster_({ displayName: v.trim() || null })} />
              </Field>
              <Field label="Colour">
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      className={`swatch ${cs.color === c ? "active" : ""}`}
                      style={{ background: c }}
                      aria-label={`Colour ${c}`}
                      onClick={() => setCluster_({ color: c })}
                    />
                  ))}
                  <button className="btn btn-xs btn-ghost" onClick={() => setCluster_({ color: null })}>
                    Auto
                  </button>
                  <span className="swatch preview" style={{ background: contextColor(cluster) }} title="Current" />
                </div>
              </Field>
              <Field label="Pin to hotbar">
                <Checkbox checked={cs.pinned} onChange={(e) => setCluster_({ pinned: e.target.checked })}>Pinned</Checkbox>
              </Field>
              <Field label="Default namespace" hint="Selected when opening this cluster; * = all namespaces">
                <CommitInput value={cs.defaultNamespace ?? ""} placeholder="none (pick when opening)" onCommit={(v) => setCluster_({ defaultNamespace: v.trim() || null })} />
              </Field>
              <Field label="Accessible namespaces" hint="Comma-separated; for users who can't list namespaces">
                <CommitInput
                  className="wide-input"
                  value={cs.accessibleNamespaces.join(", ")}
                  placeholder="e.g. team-a, team-a-staging"
                  onCommit={(v) =>
                    setCluster_({
                      accessibleNamespaces: v
                        .split(/[,\s]+/)
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Field label="Proxy" hint="http://, https:// or socks5:// — used for the API server, Helm and terminals">
                <CommitInput className="wide-input" value={cs.proxyUrl ?? ""} placeholder="none" onCommit={(v) => setCluster_({ proxyUrl: v.trim() || null })} />
              </Field>
            </>
          )}
        </section>

        <section className="settings-section">
          <h2>Tools</h2>
          <Field label="Helm binary" hint="Leave empty to use helm from PATH">
            <CommitInput className="wide-input" value={settings.helmPath ?? ""} placeholder="helm" onCommit={(v) => set({ helmPath: v.trim() || null })} />
          </Field>
          <Field label="kubectl binary" hint="Put first on PATH in terminals; overrides the automatic download">
            <CommitInput className="wide-input" value={settings.kubectlPath ?? ""} placeholder="kubectl" onCommit={(v) => set({ kubectlPath: v.trim() || null })} />
          </Field>
          <Field label="Per-cluster kubectl" hint="Download (and verify) the kubectl release matching each cluster's version for its terminals">
            <Checkbox checked={settings.kubectlAuto} onChange={(e) => set({ kubectlAuto: e.target.checked })}>Match cluster version</Checkbox>
          </Field>
        </section>

        <ExtensionsSection />

        <UpdatesSection settings={settings} set={set} />

        <section className="settings-section">
          <h2>Terminal</h2>
          <Field label="Shell" hint="Empty = $SHELL">
            <CommitInput className="wide-input" value={settings.terminalShell ?? ""} placeholder="$SHELL" onCommit={(v) => set({ terminalShell: v.trim() || null })} />
          </Field>
          <Field label="Font size">
            <input
              className="input narrow-input"
              type="number"
              min={9}
              max={24}
              value={settings.terminalFontSize}
              onChange={(e) => set({ terminalFontSize: Math.min(24, Math.max(9, Number(e.target.value) || 13)) })}
            />
          </Field>
        </section>
      </div>
    </div>
  );
}

export function openClusterSettings(context: string) {
  useTabs.getState().open({ kind: "settings", context });
}

function UpdatesSection({ settings, set }: { settings: Settings; set: (p: Partial<Settings>) => void }) {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "none" }
    | { kind: "available"; version: string; notes?: string | null }
    | { kind: "installing"; pct: number | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  useEffect(() => {
    getVersion().then(setVersion, () => {});
    const un = listen<[number, number | null]>("update-progress", (e) => {
      const [done, total] = e.payload;
      setState({ kind: "installing", pct: total ? Math.round((done / total) * 100) : null });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  const check = async () => {
    setState({ kind: "checking" });
    try {
      const u = await invoke<{ version: string; notes?: string | null } | null>("update_check");
      setState(u ? { kind: "available", version: u.version, notes: u.notes } : { kind: "none" });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  };
  const install = async () => {
    setState({ kind: "installing", pct: null });
    try {
      await invoke("update_install");
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  };
  return (
    <section className="settings-section">
      <h2>Updates</h2>
      <Field label="Current version">
        <span className="mono">{version}</span>
      </Field>
      <Field label="Update feed" hint="URL of latest.json from your signed releases (e.g. a GitHub release asset)">
        <CommitInput
          className="wide-input"
          value={settings.updateEndpoint ?? ""}
          placeholder="https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
          onCommit={(v) => set({ updateEndpoint: v.trim() || null })}
        />
      </Field>
      <Field label="Public key" hint="Contents of the .pub file from `tauri signer generate`">
        <CommitInput className="wide-input" value={settings.updatePubkey ?? ""} placeholder="dW50cnVzdGVkIGNvbW1lbnQ6…" onCommit={(v) => set({ updatePubkey: v.trim() || null })} />
      </Field>
      <Field label="">
        <div className="update-row">
          <button className="btn btn-sm" disabled={state.kind === "checking" || state.kind === "installing"} onClick={check}>
            {state.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
          {state.kind === "none" && <span className="tone-ok small">You're up to date</span>}
          {state.kind === "available" && (
            <>
              <span className="small">Version {state.version} is available</span>
              <button className="btn btn-sm btn-primary" onClick={install}>
                Install and restart
              </button>
            </>
          )}
          {state.kind === "installing" && <span className="small">Downloading{state.pct !== null ? ` ${state.pct}%` : "…"}</span>}
          {state.kind === "error" && <span className="tone-bad small">{state.message}</span>}
        </div>
        {state.kind === "available" && state.notes && <pre className="data-val">{state.notes}</pre>}
      </Field>
    </section>
  );
}

function ExtensionsSection() {
  const { extensions, errors } = useExtensions();
  const [changed, setChanged] = useState(false);
  const [state, setState] = useState<Record<string, boolean>>({});
  const enabled = (id: string, dflt: boolean) => state[id] ?? dflt;
  return (
    <section className="settings-section">
      <h2>Extensions</h2>
      <Field label="Installed" hint="Extensions run with full access to Kube Portal and your clusters — only install ones you trust">
        {extensions.length === 0 ? (
          <span className="muted small">No extensions installed. Put an extension folder (with index.js) in the extensions folder.</span>
        ) : (
          <div className="folders">
            {extensions.map((x) => (
              <div key={x.id} className="folder-row">
                <Checkbox
                  checked={enabled(x.id, x.enabled)}
                  aria-label={`Enable ${x.name}`}
                  onChange={async (e) => {
                      const on = e.target.checked;
                      setState({ ...state, [x.id]: on });
                      await invoke("set_extension_enabled", { id: x.id, enabled: on }).catch((err) => toast(String(err), "bad"));
                      setChanged(true);
                    }} />
                <span className="ext-meta">
                  <strong>{x.name}</strong> <span className="muted small">{x.version}</span>
                  {x.description && <div className="muted small">{x.description}</div>}
                </span>
                {(x.error || errors[x.id]) && <div className="folder-errors">{x.error || errors[x.id]}</div>}
              </div>
            ))}
          </div>
        )}
        <div className="update-row">
          <button
            className="btn btn-sm"
            onClick={async () => {
              try {
                await openPath(await invoke<string>("extensions_folder"));
              } catch (e) {
                toast(String(e), "bad");
              }
            }}
          >
            Open extensions folder
          </button>
          <button className="btn btn-sm" onClick={() => location.reload()}>
            Reload extensions
          </button>
          {changed && <span className="muted small">Reload to apply changes</span>}
        </div>
      </Field>
    </section>
  );
}
