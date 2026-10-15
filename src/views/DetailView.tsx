import { shortcut } from "../keys";
import { useEffect, useMemo, useState } from "react";
import { restartAcrossDialog } from "../components/RestartAcrossDialog";
import {
  api,
  EVENT_RESOURCE,
  hasWorkloadLogs,
  isCronJob,
  isNode,
  isPod,
  isRestartable,
  isScalable,
  type KubeObject,
  type ResourceInfo,
} from "../api";
import {
  deleteTarget,
  drainTarget,
  openAttach,
  openDetail,
  openLogs,
  openNodeShell,
  openShell,
  openWorkloadLogs,
  portForwardTarget,
  setCordon,
  setSuspend,
  triggerCronJob,
  restartTarget,
  scaleTarget,
  type Target,
} from "../actions";
import { stopPortForward, useDiscovery, usePortForwards, useWatchObjects } from "../hooks";
import { inBackground, useOpenObject } from "../clusterNav";
import { openSession, useTabs, type Tab } from "../store";
import { decodeBase64, formatAge, parseQuantity, selectorString, statusTone, useNow } from "../util";
import { MetricsPanel } from "../components/MetricsPanel";
import { KindExtras } from "./DetailExtras";
import { Dock } from "../components/Dock";
import { usePerms, type Perms } from "../permissions";
import { nodeSpec, podSpec, workloadSpec } from "../metrics";
import { YamlEditor } from "../components/YamlEditor";
import { confirmDialog, toast } from "../components/Dialogs";
import { S } from "../strings";

type View = "overview" | "yaml" | "events";

interface Props {
  context: string;
  resource: ResourceInfo;
  namespace: string | null;
  name: string;
  active: boolean;
  compact?: boolean;
  initialView?: View;
  onClose?: () => void;
  onViewChange?: (v: View) => void;
}

export function DetailTab({ tab, active }: { tab: Extract<Tab, { kind: "detail" }>; active: boolean }) {
  const update = useTabs((s) => s.update);
  const close = useTabs((s) => s.close);
  return (
    <div className="detail-tab">
      <DetailView
        context={tab.context}
        resource={tab.resource}
        namespace={tab.namespace}
        name={tab.name}
        active={active}
        initialView={tab.view}
        onViewChange={(view) => update(tab.id, { view })}
        onClose={() => close(tab.id)}
      />
      <Dock host={tab} active={active} />
    </div>
  );
}

export function DetailView(props: Props) {
  const { context, resource, namespace, name, active, compact } = props;
  const [view, setView] = useState<View>(props.initialView ?? "overview");
  const target: Target = { context, resource, namespace, name };
  const [obj, setObj] = useState<KubeObject | null>(null);
  const [gone, setGone] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Watch the object while visible so the overview stays live.
  const watched = useWatchObjects(context, resource, namespace, { fieldSelector: `metadata.name=${name}` }, active);
  useEffect(() => {
    setObj(null);
    setGone(false);
    setFetchError(null);
    // Show the object straight away rather than waiting on the watch's first list.
    let cancelled = false;
    api.getObject({ context, resource, namespace, name }).then(
      (o) => !cancelled && setObj((prev) => prev ?? o),
      (e) => !cancelled && setFetchError(String(e)),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, resource.plural, resource.group, namespace, name]);
  useEffect(() => {
    if (!watched.items) return;
    const o = watched.items[0];
    if (o) setObj(o);
    setGone(!o);
  }, [watched.items]);
  const error = watched.error ?? (gone && !obj ? S.detail.notFound(resource.kind, name) : fetchError);

  const changeView = (v: View) => {
    setView(v);
    props.onViewChange?.(v);
  };

  const replicas = obj?.spec?.replicas as number | undefined;
  const perms = usePerms(context, resource, namespace);
  const deny = (allowed: boolean) => (allowed ? {} : { disabled: true, title: S.detail.noPermission });

  return (
    <div className={`detail ${compact ? "compact" : ""}`}>
      <div className="detail-head">
        <div className="detail-title">
          <span className="detail-name" title={`${resource.kind} ${namespace ? `${namespace}/` : ""}${name}`}>
            {name}
          </span>
          {gone && <span className="badge bad">{S.detail.deleted}</span>}
        </div>
        <div className="detail-actions">
          {isPod(resource) && (
            <>
              <button className="btn btn-sm" {...deny(perms.logs)} onClick={() => openLogs(target)}>
                {S.actions.logs}
              </button>
              <button className="btn btn-sm" {...deny(perms.exec)} onClick={() => openShell(target)}>
                {S.actions.shell}
              </button>
              <button
                className="btn btn-sm"
                title={S.detail.attachHint}
                {...deny(perms.attach)}
                onClick={() => openAttach(target)}
              >
                {S.actions.attach}
              </button>
            </>
          )}
          {isNode(resource) && (
            <>
              <button className="btn btn-sm" onClick={() => openNodeShell(context, name)}>
                {S.actions.shell}
              </button>
              {obj?.spec?.unschedulable ? (
                <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => setCordon(target, false)}>
                  {S.actions.uncordon}
                </button>
              ) : (
                <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => setCordon(target, true)}>
                  {S.actions.cordon}
                </button>
              )}
              <button className="btn btn-sm" {...deny(perms.patch && perms.evict)} onClick={() => drainTarget(target)}>
                {S.actions.drain}
              </button>
            </>
          )}
          {isCronJob(resource) && (
            <>
              <button className="btn btn-sm" onClick={() => triggerCronJob(target)}>
                {S.detail.trigger}
              </button>
              <button
                className="btn btn-sm"
                {...deny(perms.patch)}
                onClick={() => setSuspend(target, !obj?.spec?.suspend)}
              >
                {obj?.spec?.suspend ? S.actions.resume : S.actions.suspend}
              </button>
            </>
          )}
          {hasWorkloadLogs(resource) && (
            <button
              className="btn btn-sm"
              title={S.detail.workloadLogsHint}
              onClick={() => openWorkloadLogs(target, obj ?? undefined)}
            >
              {S.actions.logs}
            </button>
          )}
          {isScalable(resource) && (
            <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => scaleTarget(target, replicas)}>
              {S.actions.scale}
            </button>
          )}
          {isRestartable(resource) && (
            <>
              <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => restartTarget(target)}>
                {S.actions.restart}
              </button>
              <button
                className="btn btn-sm"
                title={S.detail.restartAcrossHint}
                onClick={() => restartAcrossDialog(target)}
              >
                {S.restartAcross.title}
              </button>
            </>
          )}
          {compact && (
            <button
              className="btn btn-icon btn-sm"
              title={S.common.openInNewTab}
              onClick={() => openDetail(target, { view })}
            >
              ⧉
            </button>
          )}
          <button
            className="btn btn-sm btn-danger-ghost"
            {...deny(perms.delete)}
            onClick={async () => {
              if ((await deleteTarget(target)) && compact) props.onClose?.();
            }}
          >
            {S.actions.delete}
          </button>
          {compact && props.onClose && (
            <button className="btn btn-sm btn-ghost btn-icon" onClick={props.onClose} title={S.common.close}>
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="subtabs">
        {(["overview", "yaml", "events"] as View[]).map((v) => (
          <button key={v} className={`subtab ${view === v ? "active" : ""}`} onClick={() => changeView(v)}>
            {S.detail.views[v]}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {view === "overview" &&
          (obj ? (
            <Overview obj={obj} target={target} active={active} />
          ) : error ? (
            <div className="error-box">{error}</div>
          ) : (
            <div className="empty">{S.detail.loading}</div>
          ))}
        {view === "yaml" && <YamlView target={target} perms={perms} />}
        {view === "events" && obj && <EventsView context={context} namespace={namespace} uid={obj.metadata?.uid} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Chips({ map }: { map?: Record<string, string> }) {
  if (!map || !Object.keys(map).length) return null;
  return (
    <div className="chips">
      {Object.entries(map).map(([k, v]) => (
        <span key={k} className="chip" title={`${k}=${v}`}>
          {k}
          {v ? `=${v}` : ""}
        </span>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="dsection">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Tone({ value }: { value?: string }) {
  if (!value) return null;
  const t = statusTone(value);
  return <span className={t ? `tone-${t}` : ""}>{value}</span>;
}

// kubectl apply stores the whole manifest here, so on a Secret it holds the secret values.
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

function Annotations({ map, secret }: { map?: Record<string, string>; secret?: boolean }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState(false);
  if (!map || !Object.keys(map).length) return null;
  return (
    <div className="annotations">
      {Object.entries(map).map(([k, v]) => {
        if (secret && k === LAST_APPLIED && !revealed) {
          return (
            <div key={k} className="annotation">
              <span className="ann-key">{k}</span>
              <span className="ann-val">
                ••••••••{" "}
                <button className="btn btn-xs" onClick={() => setRevealed(true)}>
                  {S.detail.reveal}
                </button>
              </span>
            </div>
          );
        }
        const long = v.length > 120;
        return (
          <div key={k} className="annotation">
            <span className="ann-key">{k}</span>
            <span
              className={`ann-val ${long && !expanded[k] ? "clamped" : ""}`}
              onClick={() => long && setExpanded({ ...expanded, [k]: !expanded[k] })}
            >
              {v}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Sum of container requests/limits for one resource ("cpu" | "memory"). */
function containerTotals(spec: KubeObject | undefined, res: "cpu" | "memory") {
  let requests = 0;
  let limits = 0;
  for (const c of spec?.containers ?? []) {
    requests += parseQuantity(c.resources?.requests?.[res]);
    limits += parseQuantity(c.resources?.limits?.[res]);
  }
  return { requests, limits };
}

function refLines(t: { requests: number; limits: number }) {
  const refs = [];
  if (t.limits) refs.push({ value: t.limits, label: S.detail.limit });
  if (t.requests) refs.push({ value: t.requests, label: S.detail.request });
  return refs;
}

function Metrics({ obj, target, active }: { obj: KubeObject; target: Target; active: boolean }) {
  const { resource, context, namespace, name } = target;
  const ns = namespace ?? "default";
  if (isPod(resource)) {
    return (
      <MetricsPanel
        context={context}
        spec={podSpec(context, ns, name)}
        active={active}
        cpuRefs={refLines(containerTotals(obj.spec, "cpu"))}
        memoryRefs={refLines(containerTotals(obj.spec, "memory"))}
      />
    );
  }
  if (isNode(resource)) {
    const alloc = obj.status?.allocatable ?? {};
    return (
      <MetricsPanel
        context={context}
        spec={nodeSpec(context, name)}
        active={active}
        cpuRefs={[{ value: parseQuantity(alloc.cpu), label: S.overview.allocatable }]}
        memoryRefs={[{ value: parseQuantity(alloc.memory), label: S.overview.allocatable }]}
      />
    );
  }
  if (hasWorkloadLogs(resource)) {
    const selector = selectorString(obj.spec?.selector);
    if (!selector) return null;
    return (
      <MetricsPanel context={context} spec={workloadSpec(context, ns, resource.kind, name, selector)} active={active} />
    );
  }
  return null;
}

function Overview({ obj, target, active }: { obj: KubeObject; target: Target; active: boolean }) {
  const now = useNow(5000);
  const md = obj.metadata ?? {};
  const discovery = useDiscovery(target.context);
  const conditions: KubeObject[] | undefined = obj.status?.conditions;

  const openObject = useOpenObject();
  const openOwner = (o: KubeObject, background: boolean) => {
    const group = String(o.apiVersion).includes("/") ? o.apiVersion.split("/")[0] : "";
    const res = discovery.data?.find((r) => r.group === group && r.kind === o.kind);
    // Owners are in the same namespace, or cluster-scoped (e.g. a Node owning a mirror pod).
    if (res)
      openObject(
        { context: target.context, resource: res, namespace: res.namespaced ? target.namespace : null, name: o.name },
        background,
      );
    else toast(S.detail.unknownResource(`${o.apiVersion}/${o.kind}`), "bad");
  };

  const showMetrics = isPod(target.resource) || isNode(target.resource) || hasWorkloadLogs(target.resource);
  return (
    <div className="overview">
      {showMetrics && (
        <Section title={S.field.metrics}>
          <Metrics obj={obj} target={target} active={active} />
        </Section>
      )}
      <Section title={S.field.metadata}>
        <dl className="kv">
          <KV label={S.field.name}>{md.name}</KV>
          <KV label={S.field.namespace}>{md.namespace}</KV>
          <KV label={S.field.created}>
            {md.creationTimestamp && (
              <span title={md.creationTimestamp}>{formatAge(md.creationTimestamp, now)} ago</span>
            )}
          </KV>
          <KV label={S.field.uid}>
            <span className="mono small">{md.uid}</span>
          </KV>
          <KV label={S.field.labels}>
            {md.labels && Object.keys(md.labels).length ? <Chips map={md.labels} /> : undefined}
          </KV>
          <KV label={S.field.annotations}>
            {md.annotations && Object.keys(md.annotations).length ? (
              <Annotations map={md.annotations} secret={target.resource.kind === "Secret"} />
            ) : undefined}
          </KV>
          <KV label={S.field.controlledBy}>
            {md.ownerReferences?.length
              ? md.ownerReferences.map((o: KubeObject) => (
                  <button key={o.uid} className="link" onClick={(e) => openOwner(o, inBackground(e))}>
                    {o.kind}/{o.name}
                  </button>
                ))
              : undefined}
          </KV>
          <KV label={S.field.finalizers}>{md.finalizers?.length ? md.finalizers.join(", ") : undefined}</KV>
        </dl>
      </Section>

      <KindSpecific obj={obj} target={target} active={active} />
      <KindExtras obj={obj} target={target} active={active} />

      {conditions?.length ? (
        <Section title={S.field.conditions}>
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.type}</th>
                <th>{S.field.status}</th>
                <th>{S.field.reason}</th>
                <th>{S.field.message}</th>
                <th>{S.field.age}</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((c) => (
                <tr key={c.type}>
                  <td>{c.type}</td>
                  <td>
                    <Tone value={c.status} />
                  </td>
                  <td>{c.reason}</td>
                  <td className="wrap">{c.message}</td>
                  <td className="muted">{formatAge(c.lastTransitionTime ?? c.lastUpdateTime, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </div>
  );
}

function containerState(s?: KubeObject): string {
  if (!s) return "";
  if (s.running) return "Running";
  if (s.waiting) return s.waiting.reason ?? "Waiting";
  if (s.terminated) return s.terminated.reason ?? `Exited (${s.terminated.exitCode})`;
  return "";
}

function ActiveForwards({ target, port, active }: { target: Target; port: number; active: boolean }) {
  const kind = target.resource.kind === "Service" ? "service" : "pod";
  const forwards = usePortForwards(active).filter(
    (f) =>
      f.context === target.context &&
      f.namespace === (target.namespace ?? "default") &&
      f.kind === kind &&
      f.name === target.name &&
      f.remotePort === port,
  );
  return forwards.map((f) => (
    <span key={f.id} className="port-item">
      <span className="mono muted">localhost:{f.localPort}</span>
      <button
        className="btn btn-xs btn-danger-ghost"
        onClick={() => stopPortForward(f.id).catch((e) => toast(String(e), "bad"))}
      >
        {S.common.stop}
      </button>
    </span>
  ));
}

function KindSpecific({ obj, target, active }: { obj: KubeObject; target: Target; active: boolean }) {
  const { resource } = target;
  const spec = obj.spec ?? {};
  const status = obj.status ?? {};
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  if (isPod(resource)) {
    const statuses = new Map<string, KubeObject>(
      [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])].map((s: KubeObject) => [
        s.name,
        s,
      ]),
    );
    const containers: [KubeObject, boolean][] = [
      ...(spec.initContainers ?? []).map((c: KubeObject) => [c, true]),
      ...(spec.containers ?? []).map((c: KubeObject) => [c, false]),
    ];
    return (
      <>
        <Section title={S.field.status}>
          <dl className="kv">
            <KV label={S.field.phase}>
              <Tone value={status.phase} />
            </KV>
            <KV label={S.field.node}>{spec.nodeName}</KV>
            <KV label={S.field.podIp}>{status.podIPs?.map((p: KubeObject) => p.ip).join(", ") || status.podIP}</KV>
            <KV label={S.field.hostIp}>{status.hostIP}</KV>
            <KV label={S.field.qosClass}>{status.qosClass}</KV>
            <KV label={S.field.serviceAccount}>{spec.serviceAccountName}</KV>
            <KV label={S.field.priorityClass}>{spec.priorityClassName}</KV>
            <KV label={S.field.message}>{status.message}</KV>
          </dl>
        </Section>
        <Section title={S.field.containers}>
          <div className="containers">
            {containers.map(([c, init]) => {
              const s = statuses.get(c.name);
              const state = containerState(s?.state);
              return (
                <div key={c.name} className="container-card">
                  <div className="container-head">
                    <span className={`dot tone-bg-${statusTone(state) ?? "muted"}`} />
                    <strong>{c.name}</strong>
                    {init && <span className="badge">{S.detail.init}</span>}
                    <span className="spacer" />
                    <button className="btn btn-xs" onClick={() => openLogsFor(target, c.name)}>
                      {S.actions.logs}
                    </button>
                    {!init && (
                      <button className="btn btn-xs" onClick={() => openShellFor(target, c.name)}>
                        {S.actions.shell}
                      </button>
                    )}
                  </div>
                  <dl className="kv small">
                    <KV label={S.field.image}>
                      <span className="mono">{c.image}</span>
                    </KV>
                    <KV label={S.field.state}>
                      <Tone value={state} />
                      {s?.state?.waiting?.message && <div className="muted wrap">{s.state.waiting.message}</div>}
                    </KV>
                    <KV label={S.field.ready}>{s ? String(s.ready) : undefined}</KV>
                    <KV label={S.field.restarts}>{s?.restartCount ? String(s.restartCount) : undefined}</KV>
                    <KV label={S.field.lastState}>{containerState(s?.lastState) || undefined}</KV>
                    <KV label={S.field.ports}>
                      {c.ports?.length ? (
                        <div className="port-list">
                          {c.ports.map((p: KubeObject) => (
                            <span key={p.containerPort} className="port-item">
                              {p.name ? `${p.name}: ` : ""}
                              {p.containerPort}/{p.protocol ?? "TCP"}
                              {!init && (
                                <>
                                  <button
                                    className="btn btn-xs"
                                    onClick={() => portForwardTarget(target, obj, p.containerPort)}
                                  >
                                    {S.detail.forward}
                                  </button>
                                  <ActiveForwards target={target} port={p.containerPort} active={active} />
                                </>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : undefined}
                    </KV>
                    <KV label={S.field.requests}>
                      {c.resources?.requests
                        ? Object.entries(c.resources.requests)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ")
                        : undefined}
                    </KV>
                    <KV label={S.field.limits}>
                      {c.resources?.limits
                        ? Object.entries(c.resources.limits)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ")
                        : undefined}
                    </KV>
                    <KV label={S.field.command}>
                      {c.command || c.args ? (
                        <span className="mono">{[...(c.command ?? []), ...(c.args ?? [])].join(" ")}</span>
                      ) : undefined}
                    </KV>
                  </dl>
                </div>
              );
            })}
          </div>
        </Section>
      </>
    );
  }

  if (resource.group === "apps" || (resource.group === "batch" && resource.kind === "Job")) {
    const tmpl = spec.template?.spec ?? spec.jobTemplate?.spec?.template?.spec;
    return (
      <Section title={S.field.spec}>
        <dl className="kv">
          <KV label={S.field.replicas}>
            {spec.replicas !== undefined
              ? S.detail.replicaSummary(
                  status.readyReplicas ?? 0,
                  status.updatedReplicas ?? 0,
                  status.availableReplicas ?? 0,
                  spec.replicas,
                )
              : undefined}
          </KV>
          <KV label={S.field.scheduled}>
            {resource.kind === "DaemonSet"
              ? S.detail.scheduledSummary(status.numberReady ?? 0, status.desiredNumberScheduled ?? 0)
              : undefined}
          </KV>
          <KV label={S.field.completions}>
            {resource.kind === "Job" ? `${status.succeeded ?? 0} / ${spec.completions ?? 1}` : undefined}
          </KV>
          <KV label={S.field.strategy}>{spec.strategy?.type ?? spec.updateStrategy?.type}</KV>
          <KV label={S.field.selector}>
            {spec.selector?.matchLabels ? <Chips map={spec.selector.matchLabels} /> : undefined}
          </KV>
          <KV label={S.field.images}>
            {tmpl?.containers?.map((c: KubeObject) => (
              <div key={c.name} className="mono small">
                {c.name}: {c.image}
              </div>
            ))}
          </KV>
        </dl>
      </Section>
    );
  }

  if (resource.group === "" && resource.kind === "Service") {
    return (
      <Section title={S.field.spec}>
        <dl className="kv">
          <KV label={S.field.type}>{spec.type}</KV>
          <KV label={S.field.clusterIp}>{spec.clusterIPs?.join(", ") ?? spec.clusterIP}</KV>
          <KV label={S.field.external}>
            {status.loadBalancer?.ingress?.map((i: KubeObject) => i.ip ?? i.hostname).join(", ") ||
              spec.externalIPs?.join(", ") ||
              spec.externalName}
          </KV>
          <KV label={S.field.ports}>
            {spec.ports?.map((p: KubeObject) => (
              <div key={`${p.port}/${p.protocol}`} className="mono small port-item">
                {p.name ? `${p.name}: ` : ""}
                {p.port}
                {p.nodePort ? `:${p.nodePort}` : ""} → {p.targetPort}/{p.protocol ?? "TCP"}
                <button className="btn btn-xs" onClick={() => portForwardTarget(target, obj, p.port)}>
                  {S.detail.forward}
                </button>
                <ActiveForwards target={target} port={p.port} active={active} />
              </div>
            ))}
          </KV>
          <KV label={S.field.selector}>{spec.selector ? <Chips map={spec.selector} /> : undefined}</KV>
          <KV label={S.field.sessionAffinity}>{spec.sessionAffinity}</KV>
        </dl>
      </Section>
    );
  }

  if (resource.group === "" && (resource.kind === "ConfigMap" || resource.kind === "Secret")) {
    const secret = resource.kind === "Secret";
    const data: Record<string, string> = { ...(obj.data ?? {}), ...(secret ? {} : (obj.binaryData ?? {})) };
    return (
      <Section title={S.detail.data(secret ? obj.type : null)}>
        {Object.keys(data).length === 0 && <div className="muted">{S.common.noData}</div>}
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="data-entry">
            <div className="data-key">
              <strong>{k}</strong>
              {secret && (
                <button className="btn btn-xs" onClick={() => setReveal({ ...reveal, [k]: !reveal[k] })}>
                  {reveal[k] ? S.settings.hide : S.detail.reveal}
                </button>
              )}
              <button
                className="btn btn-xs btn-ghost"
                onClick={() =>
                  navigator.clipboard.writeText(secret ? decodeBase64(v) : v).then(() => toast(S.common.copied))
                }
              >
                {S.common.copy}
              </button>
            </div>
            <pre className="data-val">{secret ? (reveal[k] ? decodeBase64(v) : "••••••••") : v}</pre>
          </div>
        ))}
      </Section>
    );
  }

  if (resource.group === "" && resource.kind === "Node") {
    const info = status.nodeInfo ?? {};
    return (
      <>
        <Section title={S.field.system}>
          <dl className="kv">
            <KV label={S.field.addresses}>
              {status.addresses?.map((a: KubeObject) => `${a.type}: ${a.address}`).join(", ")}
            </KV>
            <KV label={S.field.os}>
              {info.osImage && `${info.osImage} (${info.operatingSystem}/${info.architecture})`}
            </KV>
            <KV label={S.field.kernel}>{info.kernelVersion}</KV>
            <KV label={S.field.kubelet}>{info.kubeletVersion}</KV>
            <KV label={S.field.runtime}>{info.containerRuntimeVersion}</KV>
            <KV label={S.field.podCidr}>{spec.podCIDR}</KV>
            <KV label={S.field.unschedulable}>{spec.unschedulable ? "true" : undefined}</KV>
            <KV label={S.field.taints}>
              {spec.taints?.map((t: KubeObject) => `${t.key}${t.value ? "=" + t.value : ""}:${t.effect}`).join(", ")}
            </KV>
          </dl>
        </Section>
        <Section title={S.field.capacity}>
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.resource}</th>
                <th>{S.field.capacity}</th>
                <th>{S.field.allocatable}</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(status.capacity ?? {}).map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{status.capacity[k]}</td>
                  <td>{status.allocatable?.[k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </>
    );
  }

  return null;
}

function openLogsFor(t: Target, container: string) {
  openSession({ kind: "logs", context: t.context, namespace: t.namespace ?? "default", pod: t.name, container });
}
function openShellFor(t: Target, container: string) {
  openSession({ kind: "exec", context: t.context, namespace: t.namespace ?? "default", pod: t.name, container });
}

// ---------------------------------------------------------------------------

function YamlView({ target, perms }: { target: Target; perms: Perms }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    api.getYaml(target).then(
      (y) => {
        setOriginal(y);
        setText(y);
      },
      (e) => setError(String(e)),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [target.context, target.resource.plural, target.namespace, target.name]);

  const dirty = original !== null && text !== original;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const y = await api.replaceYaml(target, text, original);
      setOriginal(y);
      setText(y);
      toast(S.detail.saved(`${target.resource.kind.toLowerCase()}/${target.name}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="yaml-view">
      <div className="yaml-toolbar">
        {!perms.update && <span className="tone-warn small">{S.detail.readOnly}</span>}
        <button className="btn btn-sm btn-primary" disabled={!dirty || saving || !perms.update} onClick={save}>
          {saving ? S.detail.saving : S.logs.save}
        </button>
        <button className="btn btn-sm" disabled={!dirty} onClick={() => original !== null && setText(original)}>
          {S.detail.revert}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            if (
              !dirty ||
              (await confirmDialog({
                title: S.detail.reloadTitle,
                message: S.detail.reloadMessage,
                danger: true,
                confirmLabel: S.detail.discard,
              }))
            )
              load();
          }}
        >
          {S.common.reload}
        </button>
        {dirty && <span className="muted small">{S.detail.unsaved(shortcut("S"))}</span>}
      </div>
      {error && <div className="error-box">{error}</div>}
      {original === null && !error ? (
        <div className="empty">{S.detail.loading}</div>
      ) : (
        <YamlEditor value={text} onChange={setText} onSave={() => dirty && save()} />
      )}
    </div>
  );
}

const eventTime = (e: KubeObject): string | undefined =>
  e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp;

function EventsView({ context, namespace, uid }: { context: string; namespace: string | null; uid?: string }) {
  const now = useNow(5000);
  const { items, error } = useWatchObjects(context, uid ? EVENT_RESOURCE : null, namespace, {
    fieldSelector: `involvedObject.uid=${uid}`,
  });
  const loading = items === null;
  const data = useMemo(
    () =>
      items
        ?.map((e) => ({
          kind: e.type ?? "",
          reason: e.reason ?? "",
          message: e.message ?? "",
          count: e.count ?? 1,
          lastSeen: eventTime(e),
          source: e.source?.component ?? e.reportingComponent ?? "",
        }))
        .sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? ""))),
    [items],
  );

  if (error && !data) return <div className="error-box">{error}</div>;
  if (loading && !data) return <div className="empty">{S.detail.loading}</div>;
  if (!data?.length) return <div className="empty">{S.detail.noEvents}</div>;
  return (
    <table className="dtable events">
      <thead>
        <tr>
          <th>{S.field.type}</th>
          <th>{S.field.reason}</th>
          <th>{S.field.message}</th>
          <th>{S.field.count}</th>
          <th>{S.field.source}</th>
          <th>{S.field.lastSeen}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((e, i) => (
          <tr key={i}>
            <td className={e.kind === "Warning" ? "tone-warn" : "muted"}>{e.kind}</td>
            <td>{e.reason}</td>
            <td className="wrap">{e.message}</td>
            <td>{e.count}</td>
            <td className="muted">{e.source}</td>
            <td className="muted">{formatAge(e.lastSeen, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
