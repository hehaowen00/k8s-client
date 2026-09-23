import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type HelmChart, type HelmRelease, type HelmReleaseDetails } from "../api";
import { openDetail } from "../actions";
import { useDiscovery, useNamespaces } from "../hooks";
import { useTabs } from "../store";
import { formatAge, nsForApi, nsSelection, statusTone, useNow } from "../util";
import { NamespacePicker } from "../components/NamespacePicker";
import { YamlEditor } from "../components/YamlEditor";
import { confirmDialog, toast } from "../components/Dialogs";
import { openContextMenu } from "../components/ContextMenu";
import { Select } from "../components/Select";
import { Checkbox } from "../components/Checkbox";

/** "podinfo-6.14.1" -> ["podinfo", "6.14.1"] */
export function splitChart(chart: string): [string, string] {
  const m = /^(.*)-(v?\d[\w.+-]*)$/.exec(chart);
  return m ? [m[1], m[2]] : [chart, ""];
}

const helmTime = (s: string) => {
  // `helm list` prints "2026-09-23 15:50:31.06 +1000 AEST"; history prints RFC3339.
  const iso = s.replace(/^(\S+) (\S+?)(\.\d+)? ([+-]\d{2})(\d{2}).*$/, "$1T$2$4:$5");
  return Number.isNaN(Date.parse(iso)) ? s : iso;
};

function Tone({ value }: { value: string }) {
  const t = statusTone(value === "deployed" ? "running" : value === "superseded" ? "completed" : value);
  return <span className={t ? `tone-${t}` : ""}>{value}</span>;
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export function HelmReleases({ context, namespace, active, onNamespace }: { context: string; namespace: string; active: boolean; onNamespace: (ns: string) => void }) {
  const now = useNow(10000);
  const namespaces = useNamespaces(context);
  const [list, setList] = useState<HelmRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Track the selection by key so the panel always sees the latest revision/status.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const keyOf = (r: HelmRelease) => `${r.namespace}/${r.name}`;
  const selected = list?.find((r) => keyOf(r) === selectedKey) ?? null;
  const setSelected = (r: HelmRelease | null) => setSelectedKey(r ? keyOf(r) : null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active || nsSelection(namespace).none) return;
    let cancelled = false;
    const load = () =>
      api.helmList(context, nsForApi(namespace)).then(
        (l) => {
          if (cancelled) return;
          setList(l);
          setError(null);
        },
        (e) => !cancelled && setError(String(e)),
      );
    load();
    const t = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [context, namespace, active, nonce]);

  const q = filter.toLowerCase();
  const nsSel = nsSelection(namespace);
  const shown = (list ?? []).filter(
    (r) =>
      (nsSel.all || nsSel.list.length <= 1 || nsSel.list.includes(r.namespace)) &&
      (!q || `${r.name} ${r.namespace} ${r.chart} ${r.status}`.toLowerCase().includes(q)),
  );

  const uninstall = async (r: HelmRelease) => {
    const ok = await confirmDialog({
      title: "Uninstall release",
      message: `Uninstall ${r.name} from ${r.namespace}? All resources it created will be deleted.`,
      danger: true,
      confirmLabel: "Uninstall",
    });
    if (!ok) return;
    try {
      await api.helmUninstall(context, r.namespace, r.name);
      toast(`Uninstalled ${r.name}`);
      if (selected?.name === r.name && selected.namespace === r.namespace) setSelected(null);
      reload();
    } catch (e) {
      toast(String(e), "bad");
    }
  };

  return (
    <>
      <div className="toolbar">
        <h2 className="toolbar-title">
          Releases <span className="muted small">{list ? shown.length : ""}</span>
        </h2>
        <NamespacePicker value={namespace} options={namespaces.data ?? []} onChange={onNamespace} />
        <input className="input filter" placeholder="Filter releases…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="spacer" />
        <button className="btn btn-sm btn-ghost btn-icon" onClick={reload} title="Refresh">
          ⟳
        </button>
      </div>
      <div className="content-split">
        <div className="helm-list">
          {error && <div className="error-box">{error}</div>}
          {nsSel.none && <div className="empty">Choose a namespace (or All namespaces) to list Helm releases</div>}
          {!nsSel.none && !list && !error && <div className="empty">Loading releases…</div>}
          {!nsSel.none && list && shown.length === 0 && <div className="empty">{list.length ? "No releases match" : "No Helm releases"}</div>}
          {!nsSel.none && shown.length > 0 && (
            <table className="dtable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Namespace</th>
                  <th>Chart</th>
                  <th>Version</th>
                  <th>App version</th>
                  <th>Revision</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const [chart, version] = splitChart(r.chart);
                  const isSel = selected?.name === r.name && selected.namespace === r.namespace;
                  return (
                    <tr
                      key={`${r.namespace}/${r.name}`}
                      className={`clickable ${isSel ? "selected" : ""}`}
                      onClick={() => setSelected(isSel ? null : r)}
                      onContextMenu={(e) =>
                        openContextMenu(e, [
                          { label: "Details", onClick: () => setSelected(r) },
                          { separator: true, label: "" },
                          { label: "Uninstall", danger: true, onClick: () => uninstall(r) },
                        ])
                      }
                    >
                      <td className="cell-name">{r.name}</td>
                      <td className="muted">{r.namespace}</td>
                      <td>{chart}</td>
                      <td>{version}</td>
                      <td className="muted">{r.app_version}</td>
                      <td>{r.revision}</td>
                      <td>
                        <Tone value={r.status} />
                      </td>
                      <td className="muted">{formatAge(helmTime(r.updated), now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {selected && (
          <div className="drawer">
            <ReleaseDetail
              key={`${selected.namespace}/${selected.name}`}
              context={context}
              release={selected}
              onClose={() => setSelected(null)}
              onChanged={reload}
              onUninstall={() => uninstall(selected)}
            />
          </div>
        )}
      </div>
    </>
  );
}

type ReleaseView = "overview" | "values" | "manifest" | "history";

function ReleaseDetail({
  context,
  release,
  onClose,
  onChanged,
  onUninstall,
}: {
  context: string;
  release: HelmRelease;
  onClose: () => void;
  onChanged: () => void;
  onUninstall: () => void;
}) {
  const now = useNow(10000);
  const [view, setView] = useState<ReleaseView>("overview");
  const [details, setDetails] = useState<HelmReleaseDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [chartName] = splitChart(release.chart);

  useEffect(() => {
    let cancelled = false;
    api.helmRelease(context, release.namespace, release.name).then(
      (d) => !cancelled && setDetails(d),
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [context, release.namespace, release.name, release.revision, nonce]);

  const refresh = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const rollback = async (revision: number) => {
    const ok = await confirmDialog({
      title: "Roll back release",
      message: `Roll ${release.name} back to revision ${revision}?`,
      confirmLabel: "Roll back",
    });
    if (!ok) return;
    try {
      await api.helmRollback(context, release.namespace, release.name, revision);
      toast(`Rolled back ${release.name} to revision ${revision}`);
      refresh();
    } catch (e) {
      toast(String(e), "bad");
    }
  };

  return (
    <div className="detail compact">
      <div className="detail-head">
        <div className="detail-title">
          <span className="kind-chip">Release</span>
          <span className="detail-name">{release.name}</span>
          <span className="muted small">in {release.namespace}</span>
        </div>
        <div className="detail-actions">
          <button className="btn btn-sm btn-danger-ghost" onClick={onUninstall}>
            Uninstall
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </div>
      <div className="subtabs">
        {(["overview", "values", "manifest", "history"] as ReleaseView[]).map((v) => (
          <button key={v} className={`subtab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {error && <div className="error-box">{error}</div>}
        {!details && !error && <div className="empty">Loading…</div>}
        {details && view === "overview" && <ReleaseOverview context={context} release={release} details={details} now={now} />}
        {details && view === "values" && (
          <UpgradeEditor context={context} release={release} chartName={chartName} initialValues={details.values} onUpgraded={refresh} />
        )}
        {details && view === "manifest" && <YamlEditor value={details.manifest} readOnly />}
        {details && view === "history" && (
          <table className="dtable">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Status</th>
                <th>Chart</th>
                <th>App version</th>
                <th>Updated</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...details.history].reverse().map((h) => (
                <tr key={h.revision}>
                  <td>{h.revision}</td>
                  <td>
                    <Tone value={h.status} />
                  </td>
                  <td>{h.chart}</td>
                  <td className="muted">{h.app_version}</td>
                  <td className="muted">{formatAge(h.updated, now)}</td>
                  <td className="wrap">{h.description}</td>
                  <td>
                    {String(h.revision) !== release.revision && (
                      <button className="btn btn-xs" onClick={() => rollback(h.revision)}>
                        Roll back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Resources declared in a rendered manifest ("kind/name"), for linking. */
function manifestObjects(manifest: string): { apiVersion: string; kind: string; name: string; namespace?: string }[] {
  const out = [];
  for (const doc of manifest.split(/^---\s*$/m)) {
    const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1];
    const apiVersion = /^apiVersion:\s*(\S+)/m.exec(doc)?.[1];
    const meta = /^metadata:\s*\n((?:[ \t]+.*\n?)*)/m.exec(doc)?.[1] ?? "";
    const name = /^\s{2}name:\s*["']?([^"'\s]+)/m.exec(meta)?.[1];
    const namespace = /^\s{2}namespace:\s*["']?([^"'\s]+)/m.exec(meta)?.[1];
    if (kind && apiVersion && name) out.push({ apiVersion, kind, name, namespace });
  }
  return out;
}

function ReleaseOverview({ context, release, details, now }: { context: string; release: HelmRelease; details: HelmReleaseDetails; now: number }) {
  const discovery = useDiscovery(context);
  const [chart, version] = splitChart(release.chart);
  const objects = useMemo(() => manifestObjects(details.manifest), [details.manifest]);
  return (
    <div className="overview">
      <section className="dsection">
        <h4>Release</h4>
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <Tone value={release.status} />
          </dd>
          <dt>Chart</dt>
          <dd>
            {chart} {version}
          </dd>
          <dt>App version</dt>
          <dd>{release.app_version}</dd>
          <dt>Revision</dt>
          <dd>{release.revision}</dd>
          <dt>Updated</dt>
          <dd>{formatAge(helmTime(release.updated), now)} ago</dd>
          {details.status?.info?.description && (
            <>
              <dt>Description</dt>
              <dd>{details.status.info.description}</dd>
            </>
          )}
        </dl>
      </section>
      {objects.length > 0 && (
        <section className="dsection">
          <h4>Resources ({objects.length})</h4>
          <table className="dtable">
            <tbody>
              {objects.map((o, i) => {
                const group = o.apiVersion.includes("/") ? o.apiVersion.split("/")[0] : "";
                const res = discovery.data?.find((r) => r.group === group && r.kind === o.kind);
                return (
                  <tr key={i}>
                    <td className="muted">{o.kind}</td>
                    <td>
                      {res ? (
                        <button
                          className="link"
                          onClick={() =>
                            openDetail({ context, resource: res, namespace: res.namespaced ? o.namespace ?? release.namespace : null, name: o.name })
                          }
                        >
                          {o.name}
                        </button>
                      ) : (
                        o.name
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {details.notes.trim() && (
        <section className="dsection">
          <h4>Notes</h4>
          <pre className="data-val">{details.notes}</pre>
        </section>
      )}
    </div>
  );
}

/** Edit the release's values and upgrade, choosing the chart source/version from local repos. */
function UpgradeEditor({
  context,
  release,
  chartName,
  initialValues,
  onUpgraded,
}: {
  context: string;
  release: HelmRelease;
  chartName: string;
  initialValues: string;
  onUpgraded: () => void;
}) {
  const [values, setValues] = useState(initialValues);
  const [candidates, setCandidates] = useState<HelmChart[] | null>(null);
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [, currentVersion] = splitChart(release.chart);

  useEffect(() => {
    api.helmSearch(chartName, true).then(
      (all) => {
        const matches = all.filter((c) => c.name.split("/")[1] === chartName);
        setCandidates(matches);
        if (matches.length) {
          setSource(matches[0].name.split("/")[0] + "/" + chartName);
          setVersion(matches.find((c) => c.version === currentVersion)?.version ?? matches[0].version);
        }
      },
      () => setCandidates([]),
    );
  }, [chartName, currentVersion]);

  const repos = [...new Set((candidates ?? []).map((c) => c.name))];
  const versions = (candidates ?? []).filter((c) => c.name === source);

  const upgrade = async () => {
    const ok = await confirmDialog({
      title: "Upgrade release",
      message: `Upgrade ${release.name} to ${source} ${version} with these values?`,
      confirmLabel: "Upgrade",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.helmInstall({ context, namespace: release.namespace, name: release.name, chart: source, version, values, upgrade: true });
      toast(`Upgraded ${release.name}`);
      onUpgraded();
    } catch (e) {
      toast(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="yaml-view">
      <div className="yaml-toolbar">
        {candidates === null ? (
          <span className="muted small">Looking up chart in your repositories…</span>
        ) : candidates.length === 0 ? (
          <span className="tone-warn small">Chart "{chartName}" isn't in your Helm repositories — add its repo under Helm → Charts to upgrade.</span>
        ) : (
          <>
            <Select className="select" value={source} onChange={(e) => setSource(e.target.value)} title="Chart source">
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <Select className="select" value={version} onChange={(e) => setVersion(e.target.value)} title="Chart version">
              {versions.map((c) => (
                <option key={c.version} value={c.version}>
                  {c.version}
                  {c.version === currentVersion ? " (current)" : ""}
                </option>
              ))}
            </Select>
            <button className="btn btn-sm btn-primary" disabled={busy || !source} onClick={upgrade}>
              {busy ? "Upgrading…" : "Upgrade"}
            </button>
          </>
        )}
        <span className="muted small">User-supplied values</span>
      </div>
      <YamlEditor value={values} onChange={setValues} onSave={upgrade} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export function HelmCharts({ context, active }: { context: string; active: boolean }) {
  const [charts, setCharts] = useState<HelmChart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [selected, setSelected] = useState<HelmChart | null>(null);
  const [showRepos, setShowRepos] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!active) return;
    setError(null);
    api.helmSearch(null).then(setCharts, (e) => setError(String(e)));
  }, [active, nonce]);

  const repoNames = [...new Set((charts ?? []).map((c) => c.name.split("/")[0]))].sort();
  const q = query.toLowerCase();
  const shown = (charts ?? []).filter(
    (c) => (!repo || c.name.startsWith(repo + "/")) && (!q || `${c.name} ${c.description}`.toLowerCase().includes(q)),
  );

  return (
    <>
      <div className="toolbar">
        <h2 className="toolbar-title">
          Charts <span className="muted small">{charts ? shown.length : ""}</span>
        </h2>
        <Select className="select" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">All repositories</option>
          {repoNames.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <input className="input filter" placeholder="Search charts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="spacer" />
        <button
          className="btn btn-sm"
          disabled={updating}
          onClick={async () => {
            setUpdating(true);
            try {
              await api.helmRepoUpdate();
              toast("Repositories updated");
              setNonce((n) => n + 1);
            } catch (e) {
              toast(String(e), "bad");
            } finally {
              setUpdating(false);
            }
          }}
        >
          {updating ? "Updating…" : "Update repos"}
        </button>
        <button className={`btn btn-sm ${showRepos ? "btn-primary" : ""}`} onClick={() => setShowRepos(!showRepos)}>
          Repositories
        </button>
      </div>
      {showRepos && <RepoManager onChanged={() => setNonce((n) => n + 1)} />}
      <div className="content-split">
        <div className="helm-list">
          {error && <div className="error-box">{error}</div>}
          {!charts && !error && <div className="empty">Loading charts…</div>}
          {charts && charts.length === 0 && (
            <div className="empty">
              No charts. Add a repository (e.g. <span className="mono">https://charts.bitnami.com/bitnami</span>) under Repositories.
            </div>
          )}
          {shown.length > 0 && (
            <table className="dtable">
              <thead>
                <tr>
                  <th>Chart</th>
                  <th>Version</th>
                  <th>App version</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr
                    key={c.name}
                    className={`clickable ${selected?.name === c.name ? "selected" : ""}`}
                    onClick={() => setSelected(selected?.name === c.name ? null : c)}
                  >
                    <td className="cell-name">{c.name}</td>
                    <td>{c.version}</td>
                    <td className="muted">{c.app_version}</td>
                    <td className="wrap muted">{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected && (
          <div className="drawer">
            <ChartDetail key={selected.name} context={context} chart={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
    </>
  );
}

function RepoManager({ onChanged }: { onChanged: () => void }) {
  const [repos, setRepos] = useState<{ name: string; url: string }[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.helmRepos().then(setRepos, (e) => toast(String(e), "bad")), []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await api.helmRepoAdd(name.trim(), url.trim());
      toast(`Added repository ${name.trim()}`);
      setName("");
      setUrl("");
      load();
      onChanged();
    } catch (e) {
      toast(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="repo-panel">
      <table className="dtable">
        <tbody>
          {repos?.map((r) => (
            <tr key={r.name}>
              <td className="cell-name">{r.name}</td>
              <td className="mono small">{r.url}</td>
              <td className="pf-actions">
                <button
                  className="btn btn-xs btn-danger-ghost"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: "Remove repository", message: `Remove Helm repository ${r.name}?`, danger: true, confirmLabel: "Remove" })))
                      return;
                    try {
                      await api.helmRepoRemove(r.name);
                      load();
                      onChanged();
                    } catch (e) {
                      toast(String(e), "bad");
                    }
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {repos?.length === 0 && (
            <tr>
              <td className="muted">No repositories</td>
            </tr>
          )}
        </tbody>
      </table>
      <form
        className="repo-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input repo-url" placeholder="https://charts.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !name.trim() || !url.trim()}>
          {busy ? "Adding…" : "Add repository"}
        </button>
      </form>
    </div>
  );
}

type ChartView = "readme" | "values" | "install";

function ChartDetail({ context, chart, onClose }: { context: string; chart: HelmChart; onClose: () => void }) {
  const { open } = useTabs();
  const namespaces = useNamespaces(context);
  const [view, setView] = useState<ChartView>("readme");
  const [versions, setVersions] = useState<HelmChart[]>([]);
  const [version, setVersion] = useState(chart.version);
  const [info, setInfo] = useState<{ values: string; readme: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const short = chart.name.split("/")[1] ?? chart.name;
  const [release, setRelease] = useState(short);
  const [ns, setNs] = useState("default");
  const [createNs, setCreateNs] = useState(false);
  const [values, setValues] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);

  useEffect(() => {
    api.helmSearch(chart.name, true).then(
      (all) => setVersions(all.filter((c) => c.name === chart.name)),
      () => {},
    );
  }, [chart.name]);
  useEffect(() => {
    setInfo(null);
    setError(null);
    api.helmChartInfo(chart.name, version).then(
      (i) => {
        setInfo(i);
        setValues(i.values);
      },
      (e) => setError(String(e)),
    );
  }, [chart.name, version]);

  const readmeHtml = useMemo(
    () => (info?.readme ? DOMPurify.sanitize(marked.parse(info.readme, { async: false }) as string) : ""),
    [info?.readme],
  );

  const install = async () => {
    setBusy(true);
    setNotes(null);
    try {
      const n = await api.helmInstall({ context, namespace: ns, name: release, chart: chart.name, version, values, createNamespace: createNs });
      toast(`Installed ${release} in ${ns}`);
      setNotes(n || "Installed.");
    } catch (e) {
      toast(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail compact">
      <div className="detail-head">
        <div className="detail-title">
          <span className="kind-chip">Chart</span>
          <span className="detail-name">{chart.name}</span>
        </div>
        <div className="detail-actions">
          <Select className="select" value={version} onChange={(e) => setVersion(e.target.value)} title="Version">
            {(versions.length ? versions : [chart]).map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
              </option>
            ))}
          </Select>
          <button className="btn btn-sm btn-primary" onClick={() => setView("install")}>
            Install
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </div>
      <div className="subtabs">
        {(["readme", "values", "install"] as ChartView[]).map((v) => (
          <button key={v} className={`subtab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
            {v === "readme" ? "README" : v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {error && <div className="error-box">{error}</div>}
        {!info && !error && <div className="empty">Loading…</div>}
        {info && view === "readme" &&
          (readmeHtml ? (
            <div
              className="markdown"
              // Sanitised with DOMPurify above; chart READMEs are untrusted.
              dangerouslySetInnerHTML={{ __html: readmeHtml }}
              onClick={(e) => {
                const a = (e.target as HTMLElement).closest("a");
                if (a?.href) {
                  e.preventDefault();
                  if (/^https?:/.test(a.href)) openUrl(a.href).catch(() => {});
                }
              }}
            />
          ) : (
            <div className="empty">No README</div>
          ))}
        {info && view === "values" && <YamlEditor value={info.values} readOnly />}
        {info && view === "install" && (
          <div className="yaml-view">
            <div className="install-form">
              <label className="field">
                <span>Release name</span>
                <input className="input" value={release} onChange={(e) => setRelease(e.target.value)} />
              </label>
              <label className="field">
                <span>Namespace</span>
                <input className="input" list={`ns-${chart.name}`} value={ns} onChange={(e) => setNs(e.target.value)} />
                <datalist id={`ns-${chart.name}`}>
                  {namespaces.data?.map((n) => <option key={n} value={n} />)}
                </datalist>
              </label>
              <Checkbox checked={createNs} onChange={(e) => setCreateNs(e.target.checked)}>Create namespace</Checkbox>
              <button className="btn btn-sm btn-primary" disabled={busy || !release.trim() || !ns.trim()} onClick={install}>
                {busy ? "Installing…" : `Install ${version}`}
              </button>
            </div>
            {notes !== null && (
              <div className="ok-box">
                <div>
                  Installed {release} in {ns}.{" "}
                  <button className="link" onClick={() => open({ kind: "cluster", context, resource: null, namespace: ns, page: "releases" })}>
                    View releases
                  </button>
                </div>
                {notes && notes !== "Installed." && <pre className="install-notes">{notes}</pre>}
              </div>
            )}
            <YamlEditor value={values} onChange={setValues} onSave={install} />
          </div>
        )}
      </div>
    </div>
  );
}
