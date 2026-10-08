import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type FolderInfo } from "../api";
import { EMPTY_CLUSTER, NO_MCP, bumpContexts, useContexts, useSettings, type ClusterSettings, type McpAccess, type Settings } from "../settings";
import { useDiscovery, useNamespaces } from "../hooks";
import { backToHome, contextColor, contextLabel, type Tab } from "../store";
import { alertDialog, toast } from "../components/Dialogs";
import { openPath } from "@tauri-apps/plugin-opener";
import { useExtensions } from "../extensions";
import { Checkbox } from "../components/Checkbox";
import { Select } from "../components/Select";
import { iconDataUrl } from "../clusterIcon";

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

/** App-wide settings. Per-cluster options live on each cluster's own page (ClusterSettingsView). */
export function SettingsView() {
  const settings = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const [folders, setFolders] = useState<FolderInfo[]>([]);

  useEffect(() => {
    api.listKubeconfigFolders().then(setFolders, () => {});
  }, [settings?.kubeconfigFolders]);

  if (!settings) return <div className="empty">Loading settings…</div>;
  const set = (patch: Partial<Settings>) => save({ ...settings, ...patch }).catch((e) => toast(String(e), "bad"));

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
              + Add folder
            </button>
          </Field>
        </section>

        <McpSection settings={settings} set={set} />

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

/** Settings for one cluster: how it's shown, how it's reached, and what MCP clients may read. */
export function ClusterSettingsView({ tab }: { tab: Extract<Tab, { kind: "cluster-settings" }> }) {
  const settings = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const cluster = tab.context;

  if (!settings) return <div className="empty">Loading settings…</div>;
  const set = (patch: Partial<Settings>) => save({ ...settings, ...patch }).catch((e) => toast(String(e), "bad"));
  const cs: ClusterSettings = settings.clusters[cluster] || EMPTY_CLUSTER;
  const setCluster_ = (patch: Partial<ClusterSettings>) => set({ clusters: { ...settings.clusters, [cluster]: { ...cs, ...patch } } });

  return (
    <div className="settings-view">
      <div className="settings-inner">
        {tab.fromHome && (
          <button className="btn btn-xs btn-ghost settings-back" onClick={() => backToHome(tab.id)}>
            ← New Tab
          </button>
        )}
        <h1>
          {contextLabel(cluster)}
          {contextLabel(cluster) !== cluster && <span className="muted small"> {cluster}</span>}
        </h1>
        <section className="settings-section">
          <h2>General</h2>
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
          <Field label="Icon" hint="Image shown instead of the colour">
            <div className="swatches">
              <label className="btn btn-xs">
                Choose image
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    const input = e.currentTarget;
                    const file = input.files?.[0];
                    if (!file) return;
                    try {
                      setCluster_({ icon: await iconDataUrl(file) });
                    } catch (err) {
                      console.error("icon decode failed", file.type, err);
                      alertDialog("Couldn't read that image", `${file.name} (${file.type || "unknown type"}, ${file.size} bytes)\n\n${err}`);
                    } finally {
                      input.value = "";
                    }
                  }}
                />
              </label>
              {cs.icon && (
                <button className="btn btn-xs btn-ghost" onClick={() => setCluster_({ icon: null })}>
                  Remove
                </button>
              )}
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
        </section>

        <section className="settings-section">
          <h2>MCP access</h2>
          <McpClusterAccess cluster={cluster} value={cs.mcp ?? NO_MCP} onChange={(mcp) => setCluster_({ mcp })} />
        </section>
      </div>
    </div>
  );
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

/** Filterable list of checkboxes. `locked` items can't be unticked; `allowAdd` lets the filter text be added as an item. */
function Checklist({
  items,
  selected,
  onChange,
  loading,
  error,
  locked,
  allowAdd,
}: {
  items: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  loading?: boolean;
  error?: string | null;
  locked?: (id: string) => boolean;
  allowAdd?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = items.filter((id) => id.toLowerCase().includes(q));
  const chosen = new Set(selected);
  return (
    <>
      <input className="input wide-input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="folders mcp-resources">
        {loading && <div className="folder-row muted small">Loading…</div>}
        {error && <div className="folder-row small">{error}</div>}
        {shown.map((id) => (
          <div key={id} className="folder-row">
            <Checkbox
              checked={chosen.has(id)}
              disabled={chosen.has(id) && locked?.(id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, id] : selected.filter((x) => x !== id))}
            >
              <span className="mono small">{id}</span>
            </Checkbox>
          </div>
        ))}
      </div>
      <div className="swatches">
        {allowAdd && q && !items.includes(filter.trim()) && (
          <button className="btn btn-xs" onClick={() => (onChange([...selected, filter.trim()]), setFilter(""))}>
            Add {filter.trim()}
          </button>
        )}
        <button className="btn btn-xs" onClick={() => onChange([...new Set([...selected, ...shown])])}>
          Select {q ? "Shown" : "All"}
        </button>
        {!locked && (
          <button className="btn btn-xs btn-ghost" onClick={() => onChange(q ? selected.filter((x) => !shown.includes(x)) : [])}>
            Clear {q ? "Shown" : "All"}
          </button>
        )}
      </div>
    </>
  );
}

/** Per-cluster MCP sharing: which resource types, namespaces and data. */
function McpClusterAccess({ cluster, value, onChange }: { cluster: string; value: McpAccess; onChange: (v: McpAccess) => void }) {
  const set = (p: Partial<McpAccess>) => onChange({ ...value, ...p });
  const discovery = useDiscovery(value.enabled ? cluster : null);
  const namespaces = useNamespaces(value.enabled ? cluster : null);
  const resourceIds = useMemo(() => {
    const found = (discovery.data ?? []).map((r) => (r.group ? `${r.plural}.${r.group}` : r.plural));
    return [...new Set([...value.resources, ...found])].sort();
  }, [discovery.data, value.resources]);
  const namespaceIds = useMemo(() => [...new Set([...value.namespaces, ...(namespaces.data ?? [])])].sort(), [namespaces.data, value.namespaces]);
  const [restrict, setRestrict] = useState(value.namespaces.length > 0);
  return (
    <>
      <Field label="MCP access" hint="What AI assistants connected to Kube Portal's MCP server can read. Nothing is shared by default">
        <Checkbox checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })}>
          Share this cluster
        </Checkbox>
      </Field>
      {value.enabled && (
        <>
          <Field label="Resource types" hint={`${value.resources.length} shared, as kubectl-style tables`}>
            <Checklist
              items={resourceIds}
              selected={value.resources}
              onChange={(resources) => set({ resources })}
              loading={discovery.loading}
              error={discovery.error}
            />
          </Field>
          <Field
            label="MCP namespaces"
            hint={!restrict ? "All namespaces are shared" : value.namespaces.length ? `${value.namespaces.length} shared` : "Add a namespace; until then all are shared"}
          >
            <Checkbox
              checked={!restrict}
              onChange={(e) => {
                setRestrict(!e.target.checked);
                set({ namespaces: e.target.checked ? [] : namespaceIds });
              }}
            >
              All namespaces
            </Checkbox>
            {restrict && (
              <Checklist
                items={namespaceIds}
                selected={value.namespaces}
                onChange={(ns) => ns.length && set({ namespaces: ns })}
                loading={namespaces.loading}
                error={namespaces.error}
                locked={() => value.namespaces.length === 1}
                allowAdd
              />
            )}
          </Field>
          <Field label="MCP data" hint="Without these, only table rows (what kubectl get shows) are shared">
            <Checkbox checked={value.objects} onChange={(e) => set({ objects: e.target.checked })}>
              Full objects (YAML; Secret values are always redacted)
            </Checkbox>
            <Checkbox checked={value.logs} onChange={(e) => set({ logs: e.target.checked })}>
              Pod and deployment logs
            </Checkbox>
            <Checkbox checked={value.events} onChange={(e) => set({ events: e.target.checked })}>
              Events
            </Checkbox>
          </Field>
        </>
      )}
    </>
  );
}

const MCP_TOOLS = [
  { name: "list_clusters", label: "List Clusters", hint: "Shared clusters and what each allows" },
  { name: "list_resources", label: "List Resources", hint: "kubectl get tables of shared resource types" },
  { name: "get_resource", label: "Get Resource", hint: "Full YAML of one object, where full objects are shared" },
  { name: "get_deployment", label: "Get Deployment", hint: "Deployment status and its pods, where deployments.apps is shared" },
  { name: "get_logs", label: "Get Logs", hint: "Pod or deployment logs, where logs are shared" },
  { name: "list_events", label: "List Events", hint: "Events, where events are shared" },
];

interface McpStatus {
  running: boolean;
  url?: string | null;
  error?: string | null;
}

interface McpAccessEntry {
  timeMs: number;
  tool: string;
  cluster: string;
  target: string;
  outcome: "ok" | "denied" | "error";
  detail: string;
}

function McpSection({ settings, set }: { settings: Settings; set: (p: Partial<Settings>) => void }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [log, setLog] = useState<McpAccessEntry[]>([]);
  const [showToken, setShowToken] = useState(false);
  const contexts = useContexts();
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => invoke<McpStatus>("mcp_status").then(setStatus, () => {});
    refresh();
    invoke<McpAccessEntry[]>("mcp_access_log").then(setLog, () => {});
    const un = [listen("mcp-status", refresh), listen<McpAccessEntry>("mcp-access", (e) => setLog((l) => [...l.slice(-499), e.payload]))];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  const token = settings.mcpToken ?? "";
  const url = status?.url ?? `http://127.0.0.1:${settings.mcpPort}/mcp`;
  const shared = Object.entries(settings.clusters).filter(([, c]) => c.mcp?.enabled);
  const cluster = picked ?? shared[0]?.[0] ?? contexts.data?.[0]?.name ?? null;
  const cs = cluster ? settings.clusters[cluster] || EMPTY_CLUSTER : null;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"));
  const claudeCmd = `claude mcp add --transport http kube-portal ${url} --header "Authorization: Bearer ${token}"`;
  const jsonConfig = JSON.stringify({ mcpServers: { "kube-portal": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

  return (
    <section className="settings-section">
      <h2>MCP server</h2>
      <Field label="Server" hint="Read-only, on this machine only (127.0.0.1), while Kube Portal is open">
        <Checkbox checked={settings.mcpEnabled} onChange={(e) => set({ mcpEnabled: e.target.checked })}>
          Enable MCP server
        </Checkbox>
        {status?.running && <span className="muted small">Listening on <span className="mono">{status.url}</span></span>}
        {status?.error && <span className="small mcp-bad">{status.error}</span>}
      </Field>
      <Field label="Port">
        <CommitInput
          className="narrow-input"
          value={String(settings.mcpPort)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1024 && n <= 65535) set({ mcpPort: n });
            else toast("Port must be 1024–65535", "bad");
          }}
        />
      </Field>
      <Field label="Tools" hint="Turned-off tools are hidden from clients and refused">
        {MCP_TOOLS.map((t) => (
          <Checkbox
            key={t.name}
            checked={!settings.mcpDisabledTools.includes(t.name)}
            title={t.hint}
            onChange={(e) =>
              set({ mcpDisabledTools: e.target.checked ? settings.mcpDisabledTools.filter((n) => n !== t.name) : [...settings.mcpDisabledTools, t.name] })
            }
          >
            {t.label} <span className="mono small muted">{t.name}</span>
          </Checkbox>
        ))}
      </Field>
      <Field label="Shared clusters">
        <span className="small">
          {shared.length ? (
            shared.map(([id]) => (
              <button key={id} className="link" onClick={() => setPicked(id)}>
                {contextLabel(id)}
              </button>
            ))
          ) : (
            <span className="muted">None yet</span>
          )}
        </span>
      </Field>
      <Field label="Cluster" hint="Choose a cluster to set what it shares">
        <Select className="select" value={cluster ?? ""} onChange={(e) => setPicked(e.target.value)}>
          {contexts.data?.map((c) => (
            <option key={c.name} value={c.name} title={c.name}>
              {contextLabel(c.name)}
            </option>
          ))}
        </Select>
      </Field>
      {cluster && cs && (
        <McpClusterAccess key={cluster} cluster={cluster} value={cs.mcp ?? NO_MCP} onChange={(mcp) => set({ clusters: { ...settings.clusters, [cluster]: { ...cs, mcp } } })} />
      )}
      {settings.mcpEnabled && token && (
        <Field label="Connect a client" hint="Anyone with the token can read what you share">
          <div className="swatches">
            <span className="mono small">{showToken ? token : "•".repeat(16)}</span>
            <button className="btn btn-xs btn-ghost" onClick={() => setShowToken((v) => !v)}>
              {showToken ? "Hide" : "Show"}
            </button>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => invoke("mcp_regenerate_token").then(() => useSettings.getState().load(), (e) => toast(String(e), "bad"))}
            >
              Regenerate
            </button>
          </div>
          <div className="swatches">
            <button className="btn btn-xs" onClick={() => copy(claudeCmd)}>
              Copy Claude Code command
            </button>
            <button className="btn btn-xs" onClick={() => copy(jsonConfig)}>
              Copy JSON config
            </button>
          </div>
        </Field>
      )}
      <Field label="Access log" hint="Every MCP request since Kube Portal started (last 500)">
        {log.length ? (
          <>
            <div className="mcp-log">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Cluster</th>
                    <th>Tool</th>
                    <th>Target</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...log].reverse().map((e, i) => (
                    <tr key={log.length - i} className={e.outcome === "ok" ? "" : "mcp-bad"}>
                      <td className="mono">{new Date(e.timeMs).toLocaleTimeString()}</td>
                      <td>{e.cluster ? contextLabel(e.cluster) : ""}</td>
                      <td className="mono">{e.tool}</td>
                      <td className="mono">{e.target}</td>
                      <td>{e.outcome === "ok" ? e.detail : `${e.outcome}: ${e.detail}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-xs btn-ghost" onClick={() => invoke("mcp_clear_log").then(() => setLog([]))}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted small">No requests yet</span>
        )}
      </Field>
    </section>
  );
}
