import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type FolderInfo } from "../api";
import {
  EMPTY_CLUSTER,
  NO_MCP,
  bumpContexts,
  useContexts,
  useSettings,
  type ClusterSettings,
  type McpAccess,
  type Settings,
} from "../settings";
import { useDiscovery, useNamespaces } from "../hooks";
import { backToHome, contextColor, contextLabel, type Tab } from "../store";
import { alertDialog, toast } from "../components/Dialogs";
import { openPath } from "@tauri-apps/plugin-opener";
import { useExtensions } from "../extensions";
import { Checkbox } from "../components/Checkbox";
import { Select } from "../components/Select";
import { iconDataUrl } from "../clusterIcon";
import { S } from "../strings";

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
function CommitInput({
  value,
  onCommit,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
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

  if (!settings) return <div className="empty">{S.settings.loading}</div>;
  const set = (patch: Partial<Settings>) => save({ ...settings, ...patch }).catch((e) => toast(String(e), "bad"));

  return (
    <div className="settings-view">
      <div className="settings-inner">
        <h1>{S.settings.title}</h1>

        <section className="settings-section">
          <h2>{S.settings.appearance}</h2>
          <Field label={S.settings.theme}>
            <div className="segmented">
              {(["system", "dark", "light"] as const).map((t) => (
                <button key={t} className={settings.theme === t ? "active" : ""} onClick={() => set({ theme: t })}>
                  {S.settings.themes[t]}
                </button>
              ))}
            </div>
          </Field>
        </section>

        <section className="settings-section">
          <h2>{S.settings.kubeconfig}</h2>
          <Field label={S.settings.sources} hint={S.settings.sourcesHint}>
            <div className="folders">
              <div className="folder-row">
                <span className="mono small">$KUBECONFIG / ~/.kube/config</span>
                <span className="muted small">{S.home.alwaysLoaded}</span>
              </div>
              {folders.map((f) => (
                <div key={f.path} className="folder-row">
                  <span className="mono small" title={f.path}>
                    {f.managed ? S.home.addedInApp : f.path}
                  </span>
                  <span className="muted small">{S.settings.contextCount(f.contexts)}</span>
                  {!f.managed && (
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() =>
                        api
                          .removeKubeconfigFolder(f.path)
                          .then(setFolders)
                          .then(bumpContexts)
                          .then(() => useSettings.getState().load())
                      }
                    >
                      {S.common.remove}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                const path = await openDialog({ directory: true, title: S.home.chooseFolder });
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
              {S.home.addFolder}
            </button>
          </Field>
        </section>

        <McpSection settings={settings} set={set} />

        <section className="settings-section">
          <h2>{S.home.tools}</h2>
          <Field label={S.settings.helmBinary} hint={S.settings.helmBinaryHint}>
            <CommitInput
              className="wide-input"
              value={settings.helmPath ?? ""}
              placeholder="helm"
              onCommit={(v) => set({ helmPath: v.trim() || null })}
            />
          </Field>
          <Field label={S.settings.kubectlBinary} hint={S.settings.kubectlBinaryHint}>
            <CommitInput
              className="wide-input"
              value={settings.kubectlPath ?? ""}
              placeholder="kubectl"
              onCommit={(v) => set({ kubectlPath: v.trim() || null })}
            />
          </Field>
          <Field label={S.settings.kubectlAuto} hint={S.settings.kubectlAutoHint}>
            <Checkbox checked={settings.kubectlAuto} onChange={(e) => set({ kubectlAuto: e.target.checked })}>
              {S.settings.kubectlAutoLabel}
            </Checkbox>
          </Field>
        </section>

        <ExtensionsSection />

        <UpdatesSection settings={settings} set={set} />

        <section className="settings-section">
          <h2>{S.clusterView.terminal}</h2>
          <Field label={S.settings.shell} hint={S.settings.shellHint}>
            <CommitInput
              className="wide-input"
              value={settings.terminalShell ?? ""}
              placeholder="$SHELL"
              onCommit={(v) => set({ terminalShell: v.trim() || null })}
            />
          </Field>
          <Field label={S.settings.fontSize}>
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

  if (!settings) return <div className="empty">{S.settings.loading}</div>;
  const set = (patch: Partial<Settings>) => save({ ...settings, ...patch }).catch((e) => toast(String(e), "bad"));
  const cs: ClusterSettings = settings.clusters[cluster] || EMPTY_CLUSTER;
  const setCluster_ = (patch: Partial<ClusterSettings>) =>
    set({ clusters: { ...settings.clusters, [cluster]: { ...cs, ...patch } } });

  return (
    <div className="settings-view">
      <div className="settings-inner">
        {tab.fromHome && (
          <button className="btn btn-xs btn-ghost settings-back" onClick={() => backToHome(tab.id)}>
            {S.settings.backToNewTab}
          </button>
        )}
        <h1>
          {contextLabel(cluster)}
          {contextLabel(cluster) !== cluster && <span className="muted small"> {cluster}</span>}
        </h1>
        <section className="settings-section">
          <h2>{S.settings.general}</h2>
          <Field label={S.settings.displayName} hint={S.settings.displayNameHint}>
            <CommitInput
              value={cs.displayName ?? ""}
              placeholder={cluster}
              onCommit={(v) => setCluster_({ displayName: v.trim() || null })}
            />
          </Field>
          <Field label={S.settings.colour}>
            <div className="swatches">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${cs.color === c ? "active" : ""}`}
                  style={{ background: c }}
                  aria-label={S.settings.colourAria(c)}
                  onClick={() => setCluster_({ color: c })}
                />
              ))}
              <button className="btn btn-xs btn-ghost" onClick={() => setCluster_({ color: null })}>
                {S.settings.auto}
              </button>
              <span
                className="swatch preview"
                style={{ background: contextColor(cluster) }}
                title={S.settings.currentColour}
              />
            </div>
          </Field>
          <Field label={S.settings.icon} hint={S.settings.iconHint}>
            <div className="swatches">
              <label className="btn btn-xs">
                {S.settings.chooseImage}
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
                      alertDialog(
                        S.cluster.iconReadFailed,
                        S.cluster.iconReadFailedDetail(file.name, file.type, file.size, String(err)),
                      );
                    } finally {
                      input.value = "";
                    }
                  }}
                />
              </label>
              {cs.icon && (
                <button className="btn btn-xs btn-ghost" onClick={() => setCluster_({ icon: null })}>
                  {S.common.remove}
                </button>
              )}
            </div>
          </Field>
          <Field label={S.settings.pinToHotbar}>
            <Checkbox checked={cs.pinned} onChange={(e) => setCluster_({ pinned: e.target.checked })}>
              {S.home.pinned}
            </Checkbox>
          </Field>
          <Field label={S.settings.defaultNamespace} hint={S.settings.defaultNamespaceHint}>
            <CommitInput
              value={cs.defaultNamespace ?? ""}
              placeholder={S.settings.defaultNamespacePlaceholder}
              onCommit={(v) => setCluster_({ defaultNamespace: v.trim() || null })}
            />
          </Field>
          <Field label={S.settings.accessibleNamespaces} hint={S.settings.accessibleNamespacesHint}>
            <CommitInput
              className="wide-input"
              value={cs.accessibleNamespaces.join(", ")}
              placeholder={S.settings.accessibleNamespacesPlaceholder}
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
          <Field label={S.settings.proxy} hint={S.settings.proxyHint}>
            <CommitInput
              className="wide-input"
              value={cs.proxyUrl ?? ""}
              placeholder={S.settings.none}
              onCommit={(v) => setCluster_({ proxyUrl: v.trim() || null })}
            />
          </Field>
        </section>

        <section className="settings-section">
          <h2>{S.settings.mcpAccess}</h2>
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
      <h2>{S.settings.updates}</h2>
      <Field label={S.settings.currentVersion}>
        <span className="mono">{version}</span>
      </Field>
      <Field label={S.settings.updateFeed} hint={S.settings.updateFeedHint}>
        <CommitInput
          className="wide-input"
          value={settings.updateEndpoint ?? ""}
          placeholder="https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
          onCommit={(v) => set({ updateEndpoint: v.trim() || null })}
        />
      </Field>
      <Field label={S.settings.publicKey} hint={S.settings.publicKeyHint}>
        <CommitInput
          className="wide-input"
          value={settings.updatePubkey ?? ""}
          placeholder="dW50cnVzdGVkIGNvbW1lbnQ6…"
          onCommit={(v) => set({ updatePubkey: v.trim() || null })}
        />
      </Field>
      <Field label="">
        <div className="update-row">
          <button
            className="btn btn-sm"
            disabled={state.kind === "checking" || state.kind === "installing"}
            onClick={check}
          >
            {state.kind === "checking" ? S.restartAcross.checking : S.settings.checkForUpdates}
          </button>
          {state.kind === "none" && <span className="tone-ok small">{S.settings.upToDate}</span>}
          {state.kind === "available" && (
            <>
              <span className="small">{S.settings.updateAvailable(state.version)}</span>
              <button className="btn btn-sm btn-primary" onClick={install}>
                {S.settings.installAndRestart}
              </button>
            </>
          )}
          {state.kind === "installing" && <span className="small">{S.settings.downloading(state.pct)}</span>}
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
      <h2>{S.palette.extensions}</h2>
      <Field label={S.settings.installed} hint={S.settings.installedHint}>
        {extensions.length === 0 ? (
          <span className="muted small">{S.settings.noExtensions}</span>
        ) : (
          <div className="folders">
            {extensions.map((x) => (
              <div key={x.id} className="folder-row">
                <Checkbox
                  checked={enabled(x.id, x.enabled)}
                  aria-label={S.settings.enableExtension(x.name)}
                  onChange={async (e) => {
                    const on = e.target.checked;
                    setState({ ...state, [x.id]: on });
                    await invoke("set_extension_enabled", { id: x.id, enabled: on }).catch((err) =>
                      toast(String(err), "bad"),
                    );
                    setChanged(true);
                  }}
                />
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
            {S.settings.openExtensionsFolder}
          </button>
          <button className="btn btn-sm" onClick={() => location.reload()}>
            {S.settings.reloadExtensions}
          </button>
          {changed && <span className="muted small">{S.settings.reloadToApply}</span>}
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
      <input
        className="input wide-input"
        placeholder={S.common.filter}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="folders mcp-resources">
        {loading && <div className="folder-row muted small">{S.settings.loadingList}</div>}
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
            {S.settings.addItem(filter.trim())}
          </button>
        )}
        <button className="btn btn-xs" onClick={() => onChange([...new Set([...selected, ...shown])])}>
          {q ? S.settings.selectShown : S.common.selectAll}
        </button>
        {!locked && (
          <button
            className="btn btn-xs btn-ghost"
            onClick={() => onChange(q ? selected.filter((x) => !shown.includes(x)) : [])}
          >
            {q ? S.settings.clearShown : S.common.clearAll}
          </button>
        )}
      </div>
    </>
  );
}

/** Per-cluster MCP sharing: which resource types, namespaces and data. */
function McpClusterAccess({
  cluster,
  value,
  onChange,
}: {
  cluster: string;
  value: McpAccess;
  onChange: (v: McpAccess) => void;
}) {
  const set = (p: Partial<McpAccess>) => onChange({ ...value, ...p });
  const discovery = useDiscovery(value.enabled ? cluster : null);
  const namespaces = useNamespaces(value.enabled ? cluster : null);
  const resourceIds = useMemo(() => {
    const found = (discovery.data ?? []).map((r) => (r.group ? `${r.plural}.${r.group}` : r.plural));
    return [...new Set([...value.resources, ...found])].sort();
  }, [discovery.data, value.resources]);
  const namespaceIds = useMemo(
    () => [...new Set([...value.namespaces, ...(namespaces.data ?? [])])].sort(),
    [namespaces.data, value.namespaces],
  );
  const [restrict, setRestrict] = useState(value.namespaces.length > 0);
  return (
    <>
      <Field label={S.settings.mcpAccess} hint={S.settings.mcpAccessHint}>
        <Checkbox checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })}>
          {S.settings.shareCluster}
        </Checkbox>
      </Field>
      {value.enabled && (
        <>
          <Field label={S.settings.resourceTypes} hint={S.settings.resourceTypesHint(value.resources.length)}>
            <Checklist
              items={resourceIds}
              selected={value.resources}
              onChange={(resources) => set({ resources })}
              loading={discovery.loading}
              error={discovery.error}
            />
          </Field>
          <Field
            label={S.settings.mcpNamespaces}
            hint={
              !restrict
                ? S.settings.allNamespacesShared
                : value.namespaces.length
                  ? S.settings.nShared(value.namespaces.length)
                  : S.settings.addNamespaceHint
            }
          >
            <Checkbox
              checked={!restrict}
              onChange={(e) => {
                setRestrict(!e.target.checked);
                set({ namespaces: e.target.checked ? [] : namespaceIds });
              }}
            >
              {S.ns.all}
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
          <Field label={S.settings.mcpData} hint={S.settings.mcpDataHint}>
            <Checkbox checked={value.objects} onChange={(e) => set({ objects: e.target.checked })}>
              {S.settings.mcpObjects}
            </Checkbox>
            <Checkbox checked={value.logs} onChange={(e) => set({ logs: e.target.checked })}>
              {S.settings.mcpLogs}
            </Checkbox>
            <Checkbox checked={value.events} onChange={(e) => set({ events: e.target.checked })}>
              {S.settings.mcpEvents}
            </Checkbox>
          </Field>
        </>
      )}
    </>
  );
}

const MCP_TOOLS = [
  { name: "list_clusters", ...S.settings.mcpTools.listClusters },
  { name: "list_resources", ...S.settings.mcpTools.listResources },
  { name: "get_resource", ...S.settings.mcpTools.getResource },
  { name: "get_deployment", ...S.settings.mcpTools.getDeployment },
  { name: "get_logs", ...S.settings.mcpTools.getLogs },
  { name: "list_events", ...S.settings.mcpTools.listEvents },
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
    const un = [
      listen("mcp-status", refresh),
      listen<McpAccessEntry>("mcp-access", (e) => setLog((l) => [...l.slice(-499), e.payload])),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  const token = settings.mcpToken ?? "";
  const url = status?.url ?? `http://127.0.0.1:${settings.mcpPort}/mcp`;
  const shared = Object.entries(settings.clusters).filter(([, c]) => c.mcp?.enabled);
  const cluster = picked ?? shared[0]?.[0] ?? contexts.data?.[0]?.name ?? null;
  const cs = cluster ? settings.clusters[cluster] || EMPTY_CLUSTER : null;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast(S.common.copied));
  const claudeCmd = `claude mcp add --transport http kube-portal ${url} --header "Authorization: Bearer ${token}"`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { "kube-portal": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  return (
    <section className="settings-section">
      <h2>{S.settings.mcpServer}</h2>
      <Field label={S.settings.server} hint={S.settings.serverHint}>
        <Checkbox checked={settings.mcpEnabled} onChange={(e) => set({ mcpEnabled: e.target.checked })}>
          {S.settings.enableMcp}
        </Checkbox>
        {status?.running && (
          <span className="muted small">
            {S.settings.listeningOn} <span className="mono">{status.url}</span>
          </span>
        )}
        {status?.error && <span className="small mcp-bad">{status.error}</span>}
      </Field>
      <Field label={S.settings.port}>
        <CommitInput
          className="narrow-input"
          value={String(settings.mcpPort)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1024 && n <= 65535) set({ mcpPort: n });
            else toast(S.settings.badPort, "bad");
          }}
        />
      </Field>
      <Field label={S.settings.tools} hint={S.settings.toolsHint}>
        {MCP_TOOLS.map((t) => (
          <Checkbox
            key={t.name}
            checked={!settings.mcpDisabledTools.includes(t.name)}
            title={t.hint}
            onChange={(e) =>
              set({
                mcpDisabledTools: e.target.checked
                  ? settings.mcpDisabledTools.filter((n) => n !== t.name)
                  : [...settings.mcpDisabledTools, t.name],
              })
            }
          >
            {t.label} <span className="mono small muted">{t.name}</span>
          </Checkbox>
        ))}
      </Field>
      <Field label={S.settings.sharedClusters}>
        <span className="small">
          {shared.length ? (
            shared.map(([id]) => (
              <button key={id} className="link" onClick={() => setPicked(id)}>
                {contextLabel(id)}
              </button>
            ))
          ) : (
            <span className="muted">{S.settings.noneYet}</span>
          )}
        </span>
      </Field>
      <Field label={S.settings.cluster} hint={S.settings.clusterHint}>
        <Select className="select" value={cluster ?? ""} onChange={(e) => setPicked(e.target.value)}>
          {contexts.data?.map((c) => (
            <option key={c.name} value={c.name} title={c.name}>
              {contextLabel(c.name)}
            </option>
          ))}
        </Select>
      </Field>
      {cluster && cs && (
        <McpClusterAccess
          key={cluster}
          cluster={cluster}
          value={cs.mcp ?? NO_MCP}
          onChange={(mcp) => set({ clusters: { ...settings.clusters, [cluster]: { ...cs, mcp } } })}
        />
      )}
      {settings.mcpEnabled && token && (
        <Field label={S.settings.connectClient} hint={S.settings.connectClientHint}>
          <div className="swatches">
            <span className="mono small">{showToken ? token : "•".repeat(16)}</span>
            <button className="btn btn-xs btn-ghost" onClick={() => setShowToken((v) => !v)}>
              {showToken ? S.settings.hide : S.settings.show}
            </button>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() =>
                invoke("mcp_regenerate_token").then(
                  () => useSettings.getState().load(),
                  (e) => toast(String(e), "bad"),
                )
              }
            >
              {S.settings.regenerate}
            </button>
          </div>
          <div className="swatches">
            <button className="btn btn-xs" onClick={() => copy(claudeCmd)}>
              {S.settings.copyClaudeCommand}
            </button>
            <button className="btn btn-xs" onClick={() => copy(jsonConfig)}>
              {S.settings.copyJsonConfig}
            </button>
          </div>
        </Field>
      )}
      <Field label={S.settings.accessLog} hint={S.settings.accessLogHint}>
        {log.length ? (
          <>
            <div className="mcp-log">
              <table>
                <thead>
                  <tr>
                    <th>{S.settings.colTime}</th>
                    <th>{S.portForward.colCluster}</th>
                    <th>{S.settings.colTool}</th>
                    <th>{S.portForward.colTarget}</th>
                    <th>{S.settings.colResult}</th>
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
              {S.logs.clear}
            </button>
          </>
        ) : (
          <span className="muted small">{S.settings.noRequests}</span>
        )}
      </Field>
    </section>
  );
}
