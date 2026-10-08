import { useEffect, useMemo, useState } from "react";
import { api, POD_RESOURCE, type Overview, type ResourceInfo } from "../api";
import { inBackground, useOpenObject } from "../clusterNav";
import { useDiscovery } from "../hooks";
import { clusterSpec, useUsageMap } from "../metrics";
import { contextLabel } from "../store";
import { formatAge, formatBytes, formatCpu, formatPercent, pollWhileVisible, useNow } from "../util";
import { Meter } from "../components/Chart";
import { MetricsPanel } from "../components/MetricsPanel";
import { S } from "../strings";

interface Props {
  context: string;
  namespace: string;
  active: boolean;
  onPick: (r: ResourceInfo) => void;
}

const STATUS_LABEL = S.overview.status;

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "warn" }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ""}`}>{value}</div>
      {sub && <div className="stat-sub muted">{sub}</div>}
    </div>
  );
}

/** One stacked bar: healthy / pending / failed, 2px surface gaps, labelled counts. */
function StatusBar({ w, onClick }: { w: Overview["workloads"][number]; onClick?: () => void }) {
  const parts = (["healthy", "progressing", "failed"] as const).filter((k) => w[k] > 0);
  return (
    <button className="status-row" onClick={onClick} disabled={!onClick} title={S.overview.openKind(w.kind)}>
      <span className="status-kind">{w.kind}s</span>
      <span className="status-total">{w.total}</span>
      <span className="status-bar" aria-hidden>
        {w.total === 0 ? (
          <span className="status-seg status-seg-none" style={{ flex: 1 }} />
        ) : (
          parts.map((k) => <span key={k} className={`status-seg seg-${k}`} style={{ flex: w[k] }} />)
        )}
      </span>
      <span className="status-legend">
        {parts.map((k) => (
          <span key={k} className="status-legend-item">
            <span className={`status-dot seg-${k}`} />
            {w[k]} {STATUS_LABEL[k]}
          </span>
        ))}
        {w.total === 0 && <span className="muted">{S.overview.none}</span>}
      </span>
    </button>
  );
}

export function OverviewView({ context, namespace, active, onPick }: Props) {
  const now = useNow(10000);
  // Results are tagged with what they were loaded for, so a switch never shows the previous cluster/namespace.
  const key = `${context}\u0000${namespace}`;
  const [loaded, setLoaded] = useState<{ key: string; overview?: Overview; error?: string } | null>(null);
  const data = loaded?.key === key ? (loaded.overview ?? null) : null;
  const error = loaded?.key === key ? (loaded.error ?? null) : null;
  const discovery = useDiscovery(context);
  const nodeUsage = useUsageMap(context, "nodes", null, active);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () =>
      api.clusterOverview(context, namespace || null).then(
        (o) => !cancelled && setLoaded({ key, overview: o }),
        (e) =>
          !cancelled &&
          setLoaded((l) => ({ key, overview: l?.key === key ? l.overview : undefined, error: String(e) })),
      );
    load();
    const stop = pollWhileVisible(load, 10000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [context, namespace, active, key]);

  const find = (group: string, kind: string) => discovery.data?.find((r) => r.group === group && r.kind === kind);
  const kindGroup: Record<string, string> = {
    Pod: "",
    Deployment: "apps",
    StatefulSet: "apps",
    DaemonSet: "apps",
    Job: "batch",
  };

  const totals = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const cpuAlloc = nodes.reduce((a, n) => a + n.cpuAllocatable, 0);
    const memAlloc = nodes.reduce((a, n) => a + n.memoryAllocatable, 0);
    const podsAlloc = nodes.reduce((a, n) => a + n.podsAllocatable, 0);
    let cpuUsed = 0;
    let memUsed = 0;
    for (const u of nodeUsage?.values() ?? []) {
      cpuUsed += u.cpu;
      memUsed += u.memory;
    }
    return { cpuAlloc, memAlloc, podsAlloc, cpuUsed, memUsed };
  }, [data, nodeUsage]);

  const spec = useMemo(() => clusterSpec(context), [context]);
  const openObject = useOpenObject();

  if (error && !data) return <div className="error-box">{error}</div>;
  if (!data) return <div className="empty">{S.overview.loading}</div>;

  const readyNodes = data.nodes.filter((n) => n.ready).length;
  const running = data.podPhases.Running ?? 0;
  const failedPods = (data.podPhases.Failed ?? 0) + (data.podPhases.Unknown ?? 0);
  const activePods = running + (data.podPhases.Pending ?? 0);
  const nodeRes = find("", "Node");

  return (
    <div className="overview-dash">
      <div className="dash-head">
        <h2>{contextLabel(context)}</h2>
        <span className="muted small">
          {S.overview.version(data.serverVersion)}
          {namespace ? S.overview.namespace(namespace) : ""}
        </span>
      </div>

      <div className="stat-grid">
        <StatTile
          label={S.overview.nodes}
          value={data.nodes.length ? `${readyNodes}/${data.nodes.length}` : "—"}
          sub={
            data.nodes.length
              ? readyNodes === data.nodes.length
                ? S.overview.allReady
                : S.overview.notReady(data.nodes.length - readyNodes)
              : S.overview.notVisible
          }
          tone={readyNodes < data.nodes.length ? "bad" : undefined}
        />
        <StatTile
          label={S.overview.pods}
          value={String(data.podsTotal)}
          sub={S.overview.podSummary(running, data.podPhases.Pending ?? 0, failedPods)}
          tone={failedPods ? "warn" : undefined}
        />
        {data.namespaces != null && <StatTile label={S.overview.namespaces} value={String(data.namespaces)} />}
        <StatTile
          label={S.overview.warnings}
          value={String(data.warnings.length)}
          sub={S.overview.recentWarnings}
          tone={data.warnings.length ? "warn" : undefined}
        />
      </div>

      {data.nodes.length > 0 && (
        <section className="dsection">
          <h4>{S.overview.capacity}</h4>
          <div className="meter-grid">
            {nodeUsage && (
              <Meter label={S.overview.cpuUsage} used={totals.cpuUsed} total={totals.cpuAlloc} format={formatCpu} />
            )}
            <Meter
              label={S.overview.cpuRequests}
              used={data.cpuRequests}
              total={totals.cpuAlloc}
              format={formatCpu}
              extra={data.cpuLimits ? S.overview.limits(formatCpu(data.cpuLimits)) : undefined}
            />
            {nodeUsage && (
              <Meter
                label={S.overview.memoryUsage}
                used={totals.memUsed}
                total={totals.memAlloc}
                format={formatBytes}
              />
            )}
            <Meter
              label={S.overview.memoryRequests}
              used={data.memoryRequests}
              total={totals.memAlloc}
              format={formatBytes}
              extra={data.memoryLimits ? S.overview.limits(formatBytes(data.memoryLimits)) : undefined}
            />
            <Meter
              label={S.overview.pods}
              used={activePods}
              total={totals.podsAlloc}
              format={(v) => String(Math.round(v))}
            />
          </div>
          {!nodeUsage && <div className="muted small metrics-note">{S.overview.installMetrics}</div>}
        </section>
      )}

      {data.nodes.length > 0 && (
        <section className="dsection">
          <h4>{S.overview.usage}</h4>
          <MetricsPanel
            context={context}
            spec={spec}
            active={active}
            cpuRefs={[{ value: totals.cpuAlloc, label: S.overview.allocatable }]}
            memoryRefs={[{ value: totals.memAlloc, label: S.overview.allocatable }]}
          />
        </section>
      )}

      <section className="dsection">
        <h4>{S.overview.workloads}</h4>
        <div className="status-list">
          {data.workloads.map((w) => {
            const r = find(kindGroup[w.kind] ?? "", w.kind) ?? (w.kind === "Pod" ? POD_RESOURCE : undefined);
            return <StatusBar key={w.kind} w={w} onClick={r ? () => onPick(r) : undefined} />;
          })}
        </div>
      </section>

      {data.nodes.length > 0 && (
        <section className="dsection">
          <h4>{S.overview.nodes}</h4>
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.name}</th>
                <th>{S.field.roles}</th>
                <th>{S.field.status}</th>
                <th className="num">{S.field.cpu}</th>
                <th className="num">{S.field.memory}</th>
                <th>{S.field.version}</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => {
                const u = nodeUsage?.get(n.name);
                return (
                  <tr
                    key={n.name}
                    className={nodeRes ? "clickable" : ""}
                    onClick={(e) =>
                      nodeRes &&
                      openObject({ context, resource: nodeRes, namespace: null, name: n.name }, inBackground(e))
                    }
                  >
                    <td>{n.name}</td>
                    <td className="muted">{n.roles.join(", ") || "—"}</td>
                    <td>
                      <span className={n.ready ? "tone-ok" : "tone-bad"}>
                        {n.ready ? S.overview.nodeReady : S.overview.nodeNotReady}
                      </span>
                      {n.unschedulable && <span className="tone-warn"> · {S.overview.schedulingDisabled}</span>}
                    </td>
                    <td className="num">
                      {u
                        ? `${formatCpu(u.cpu)} (${formatPercent((u.cpu / n.cpuAllocatable) * 100)})`
                        : formatCpu(n.cpuAllocatable)}
                    </td>
                    <td className="num">
                      {u
                        ? `${formatBytes(u.memory)} (${formatPercent((u.memory / n.memoryAllocatable) * 100)})`
                        : formatBytes(n.memoryAllocatable)}
                    </td>
                    <td className="muted">{n.kubeletVersion}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="dsection">
        <h4>{S.overview.warnings}</h4>
        {data.warnings.length === 0 ? (
          <div className="muted">{S.overview.noWarnings}</div>
        ) : (
          <table className="dtable events">
            <thead>
              <tr>
                <th>{S.field.object}</th>
                <th>{S.field.namespace}</th>
                <th>{S.field.reason}</th>
                <th>{S.field.message}</th>
                <th>{S.field.count}</th>
                <th>{S.field.lastSeen}</th>
              </tr>
            </thead>
            <tbody>
              {data.warnings.map((w, i) => (
                <tr key={i}>
                  <td>{w.object}</td>
                  <td className="muted">{w.namespace}</td>
                  <td className="tone-warn">{w.reason}</td>
                  <td className="wrap">{w.message}</td>
                  <td>{w.count}</td>
                  <td className="muted">{formatAge(w.lastSeen, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
