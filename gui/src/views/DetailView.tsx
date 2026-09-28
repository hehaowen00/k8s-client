import { useEffect, useState } from "react";
import { api, hasWorkloadLogs, isCronJob, isNode, isPod, isRestartable, isScalable, type KubeObject, type ResourceInfo } from "../api";
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
  triggerCronJob, restartTarget, scaleTarget, type Target } from "../actions";
import { useAsync, useDiscovery } from "../hooks";
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
  const { update, close } = useTabs();
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
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  // Poll the object while visible so the overview stays live.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () =>
      api.getObject(target).then(
        (o) => {
          if (cancelled) return;
          setObj(o);
          setError(null);
          setGone(false);
        },
        (e) => {
          if (cancelled) return;
          const msg = String(e);
          if (/not ?found/i.test(msg)) setGone(true);
          setError(msg);
        },
      );
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, resource.plural, resource.group, namespace, name, active]);

  const changeView = (v: View) => {
    setView(v);
    props.onViewChange?.(v);
  };

  const replicas = obj?.spec?.replicas as number | undefined;
  const perms = usePerms(context, resource, namespace);
  const deny = (allowed: boolean) => (allowed ? {} : { disabled: true, title: "You don't have permission for this" });

  return (
    <div className={`detail ${compact ? "compact" : ""}`}>
      <div className="detail-head">
        <div className="detail-title">
          <span className="detail-name" title={`${resource.kind} ${namespace ? `${namespace}/` : ""}${name}`}>
            {name}
          </span>
          {gone && <span className="badge bad">deleted</span>}
        </div>
        <div className="detail-actions">
          {isPod(resource) && (
            <>
              <button className="btn btn-sm" {...deny(perms.logs)} onClick={() => openLogs(target)}>
                Logs
              </button>
              <button className="btn btn-sm" {...deny(perms.exec)} onClick={() => openShell(target)}>
                Shell
              </button>
              <button className="btn btn-sm" title="Attach to the main process" {...deny(perms.attach)} onClick={() => openAttach(target)}>
                Attach
              </button>
            </>
          )}
          {isNode(resource) && (
            <>
              <button className="btn btn-sm" onClick={() => openNodeShell(context, name)}>
                Shell
              </button>
              {obj?.spec?.unschedulable ? (
                <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => setCordon(target, false)}>
                  Uncordon
                </button>
              ) : (
                <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => setCordon(target, true)}>
                  Cordon
                </button>
              )}
              <button className="btn btn-sm" {...deny(perms.patch && perms.evict)} onClick={() => drainTarget(target)}>
                Drain
              </button>
            </>
          )}
          {isCronJob(resource) && (
            <>
              <button className="btn btn-sm" onClick={() => triggerCronJob(target)}>
                Trigger
              </button>
              <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => setSuspend(target, !obj?.spec?.suspend)}>
                {obj?.spec?.suspend ? "Resume" : "Suspend"}
              </button>
            </>
          )}
          {hasWorkloadLogs(resource) && (
            <button className="btn btn-sm" title="Logs from all pods" onClick={() => openWorkloadLogs(target, obj ?? undefined)}>
              Logs
            </button>
          )}
          {isScalable(resource) && (
            <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => scaleTarget(target, replicas)}>
              Scale
            </button>
          )}
          {isRestartable(resource) && (
            <button className="btn btn-sm" {...deny(perms.patch)} onClick={() => restartTarget(target)}>
              Restart
            </button>
          )}
          {compact && (
            <button className="btn btn-icon btn-sm" title="Open in new tab" onClick={() => openDetail(target, { view })}>
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
            Delete
          </button>
          {compact && props.onClose && (
            <button className="btn btn-sm btn-ghost btn-icon" onClick={props.onClose} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="subtabs">
        {(["overview", "yaml", "events"] as View[]).map((v) => (
          <button key={v} className={`subtab ${view === v ? "active" : ""}`} onClick={() => changeView(v)}>
            {v === "yaml" ? "YAML" : v[0].toUpperCase() + v.slice(1)}
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
            <div className="empty">Loading…</div>
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

function Annotations({ map }: { map?: Record<string, string> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!map || !Object.keys(map).length) return null;
  return (
    <div className="annotations">
      {Object.entries(map).map(([k, v]) => {
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
  if (t.limits) refs.push({ value: t.limits, label: "limit" });
  if (t.requests) refs.push({ value: t.requests, label: "request" });
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
        cpuRefs={[{ value: parseQuantity(alloc.cpu), label: "allocatable" }]}
        memoryRefs={[{ value: parseQuantity(alloc.memory), label: "allocatable" }]}
      />
    );
  }
  if (hasWorkloadLogs(resource)) {
    const selector = selectorString(obj.spec?.selector);
    if (!selector) return null;
    return <MetricsPanel context={context} spec={workloadSpec(context, ns, resource.kind, name, selector)} active={active} />;
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
    if (res) openObject({ context: target.context, resource: res, namespace: res.namespaced ? target.namespace : null, name: o.name }, background);
    else toast(`Unknown resource ${o.apiVersion}/${o.kind}`, "bad");
  };

  const showMetrics = isPod(target.resource) || isNode(target.resource) || hasWorkloadLogs(target.resource);
  return (
    <div className="overview">
      {showMetrics && (
        <Section title="Metrics">
          <Metrics obj={obj} target={target} active={active} />
        </Section>
      )}
      <Section title="Metadata">
        <dl className="kv">
          <KV label="Name">{md.name}</KV>
          <KV label="Namespace">{md.namespace}</KV>
          <KV label="Created">
            {md.creationTimestamp && (
              <span title={md.creationTimestamp}>{formatAge(md.creationTimestamp, now)} ago</span>
            )}
          </KV>
          <KV label="UID">
            <span className="mono small">{md.uid}</span>
          </KV>
          <KV label="Labels">
            {md.labels && Object.keys(md.labels).length ? <Chips map={md.labels} /> : undefined}
          </KV>
          <KV label="Annotations">
            {md.annotations && Object.keys(md.annotations).length ? <Annotations map={md.annotations} /> : undefined}
          </KV>
          <KV label="Controlled By">
            {md.ownerReferences?.length
              ? md.ownerReferences.map((o: KubeObject) => (
                  <button key={o.uid} className="link" onClick={(e) => openOwner(o, inBackground(e))}>
                    {o.kind}/{o.name}
                  </button>
                ))
              : undefined}
          </KV>
          <KV label="Finalizers">{md.finalizers?.length ? md.finalizers.join(", ") : undefined}</KV>
        </dl>
      </Section>

      <KindSpecific obj={obj} target={target} />
      <KindExtras obj={obj} target={target} />

      {conditions?.length ? (
        <Section title="Conditions">
          <table className="dtable">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Message</th>
                <th>Age</th>
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

function KindSpecific({ obj, target }: { obj: KubeObject; target: Target }) {
  const { resource } = target;
  const spec = obj.spec ?? {};
  const status = obj.status ?? {};
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  if (isPod(resource)) {
    const statuses = new Map<string, KubeObject>(
      [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])].map((s: KubeObject) => [s.name, s]),
    );
    const containers: [KubeObject, boolean][] = [
      ...(spec.initContainers ?? []).map((c: KubeObject) => [c, true]),
      ...(spec.containers ?? []).map((c: KubeObject) => [c, false]),
    ];
    return (
      <>
        <Section title="Status">
          <dl className="kv">
            <KV label="Phase">
              <Tone value={status.phase} />
            </KV>
            <KV label="Node">{spec.nodeName}</KV>
            <KV label="Pod IP">{status.podIPs?.map((p: KubeObject) => p.ip).join(", ") || status.podIP}</KV>
            <KV label="Host IP">{status.hostIP}</KV>
            <KV label="QoS Class">{status.qosClass}</KV>
            <KV label="Service Account">{spec.serviceAccountName}</KV>
            <KV label="Priority Class">{spec.priorityClassName}</KV>
            <KV label="Message">{status.message}</KV>
          </dl>
        </Section>
        <Section title="Containers">
          <div className="containers">
            {containers.map(([c, init]) => {
              const s = statuses.get(c.name);
              const state = containerState(s?.state);
              return (
                <div key={c.name} className="container-card">
                  <div className="container-head">
                    <span className={`dot tone-bg-${statusTone(state) ?? "muted"}`} />
                    <strong>{c.name}</strong>
                    {init && <span className="badge">init</span>}
                    <span className="spacer" />
                    <button className="btn btn-xs" onClick={() => openLogsFor(target, c.name)}>
                      Logs
                    </button>
                    {!init && (
                      <button className="btn btn-xs" onClick={() => openShellFor(target, c.name)}>
                        Shell
                      </button>
                    )}
                  </div>
                  <dl className="kv small">
                    <KV label="Image">
                      <span className="mono">{c.image}</span>
                    </KV>
                    <KV label="State">
                      <Tone value={state} />
                      {s?.state?.waiting?.message && <div className="muted wrap">{s.state.waiting.message}</div>}
                    </KV>
                    <KV label="Ready">{s ? String(s.ready) : undefined}</KV>
                    <KV label="Restarts">{s?.restartCount ? String(s.restartCount) : undefined}</KV>
                    <KV label="Last State">{containerState(s?.lastState) || undefined}</KV>
                    <KV label="Ports">
                      {c.ports?.length ? (
                        <div className="port-list">
                          {c.ports.map((p: KubeObject) => (
                            <span key={p.containerPort} className="port-item">
                              {p.name ? `${p.name}: ` : ""}
                              {p.containerPort}/{p.protocol ?? "TCP"}
                              {!init && (
                                <button className="btn btn-xs" onClick={() => portForwardTarget(target, obj, p.containerPort)}>
                                  Forward
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : undefined}
                    </KV>
                    <KV label="Requests">
                      {c.resources?.requests
                        ? Object.entries(c.resources.requests).map(([k, v]) => `${k}: ${v}`).join(", ")
                        : undefined}
                    </KV>
                    <KV label="Limits">
                      {c.resources?.limits
                        ? Object.entries(c.resources.limits).map(([k, v]) => `${k}: ${v}`).join(", ")
                        : undefined}
                    </KV>
                    <KV label="Command">
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
      <Section title="Spec">
        <dl className="kv">
          <KV label="Replicas">
            {spec.replicas !== undefined
              ? `${status.readyReplicas ?? 0} ready / ${status.updatedReplicas ?? 0} updated / ${status.availableReplicas ?? 0} available / ${spec.replicas} desired`
              : undefined}
          </KV>
          <KV label="Scheduled">
            {resource.kind === "DaemonSet"
              ? `${status.numberReady ?? 0} ready / ${status.desiredNumberScheduled ?? 0} desired`
              : undefined}
          </KV>
          <KV label="Completions">
            {resource.kind === "Job" ? `${status.succeeded ?? 0} / ${spec.completions ?? 1}` : undefined}
          </KV>
          <KV label="Strategy">{spec.strategy?.type ?? spec.updateStrategy?.type}</KV>
          <KV label="Selector">
            {spec.selector?.matchLabels ? <Chips map={spec.selector.matchLabels} /> : undefined}
          </KV>
          <KV label="Images">
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
      <Section title="Spec">
        <dl className="kv">
          <KV label="Type">{spec.type}</KV>
          <KV label="Cluster IP">{spec.clusterIPs?.join(", ") ?? spec.clusterIP}</KV>
          <KV label="External">
            {status.loadBalancer?.ingress?.map((i: KubeObject) => i.ip ?? i.hostname).join(", ") ||
              spec.externalIPs?.join(", ") ||
              spec.externalName}
          </KV>
          <KV label="Ports">
            {spec.ports?.map((p: KubeObject) => (
              <div key={`${p.port}/${p.protocol}`} className="mono small port-item">
                {p.name ? `${p.name}: ` : ""}
                {p.port}
                {p.nodePort ? `:${p.nodePort}` : ""} → {p.targetPort}/{p.protocol ?? "TCP"}
                <button className="btn btn-xs" onClick={() => portForwardTarget(target, obj, p.port)}>
                  Forward
                </button>
              </div>
            ))}
          </KV>
          <KV label="Selector">{spec.selector ? <Chips map={spec.selector} /> : undefined}</KV>
          <KV label="Session Affinity">{spec.sessionAffinity}</KV>
        </dl>
      </Section>
    );
  }

  if (resource.group === "" && (resource.kind === "ConfigMap" || resource.kind === "Secret")) {
    const secret = resource.kind === "Secret";
    const data: Record<string, string> = { ...(obj.data ?? {}), ...(secret ? {} : obj.binaryData ?? {}) };
    return (
      <Section title={`Data${secret && obj.type ? ` (${obj.type})` : ""}`}>
        {Object.keys(data).length === 0 && <div className="muted">No data</div>}
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="data-entry">
            <div className="data-key">
              <strong>{k}</strong>
              {secret && (
                <button className="btn btn-xs" onClick={() => setReveal({ ...reveal, [k]: !reveal[k] })}>
                  {reveal[k] ? "Hide" : "Reveal"}
                </button>
              )}
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => navigator.clipboard.writeText(secret ? decodeBase64(v) : v).then(() => toast("Copied"))}
              >
                Copy
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
        <Section title="System">
          <dl className="kv">
            <KV label="Addresses">
              {status.addresses?.map((a: KubeObject) => `${a.type}: ${a.address}`).join(", ")}
            </KV>
            <KV label="OS">{info.osImage && `${info.osImage} (${info.operatingSystem}/${info.architecture})`}</KV>
            <KV label="Kernel">{info.kernelVersion}</KV>
            <KV label="Kubelet">{info.kubeletVersion}</KV>
            <KV label="Runtime">{info.containerRuntimeVersion}</KV>
            <KV label="Pod CIDR">{spec.podCIDR}</KV>
            <KV label="Unschedulable">{spec.unschedulable ? "true" : undefined}</KV>
            <KV label="Taints">
              {spec.taints?.map((t: KubeObject) => `${t.key}${t.value ? "=" + t.value : ""}:${t.effect}`).join(", ")}
            </KV>
          </dl>
        </Section>
        <Section title="Capacity">
          <table className="dtable">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Capacity</th>
                <th>Allocatable</th>
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
      toast(`Saved ${target.resource.kind.toLowerCase()}/${target.name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="yaml-view">
      <div className="yaml-toolbar">
        {!perms.update && <span className="tone-warn small">Read-only: you can't update this object</span>}
        <button className="btn btn-sm btn-primary" disabled={!dirty || saving || !perms.update} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-sm" disabled={!dirty} onClick={() => original !== null && setText(original)}>
          Revert
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            if (
              !dirty ||
              (await confirmDialog({ title: "Reload YAML", message: "Discard your changes and reload?", danger: true, confirmLabel: "Discard" }))
            )
              load();
          }}
        >
          Reload
        </button>
        {dirty && <span className="muted small">Unsaved changes · Ctrl+S to save</span>}
      </div>
      {error && <div className="error-box">{error}</div>}
      {original === null && !error ? (
        <div className="empty">Loading…</div>
      ) : (
        <YamlEditor value={text} onChange={setText} onSave={() => dirty && save()} />
      )}
    </div>
  );
}

function EventsView({ context, namespace, uid }: { context: string; namespace: string | null; uid?: string }) {
  const now = useNow(5000);
  const { data, error, loading, reload } = useAsync(
    () => (uid ? api.listEvents(context, namespace, uid) : Promise.resolve([])),
    [context, namespace, uid],
  );
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <div className="error-box">{error}</div>;
  if (loading && !data) return <div className="empty">Loading…</div>;
  if (!data?.length) return <div className="empty">No events</div>;
  return (
    <table className="dtable events">
      <thead>
        <tr>
          <th>Type</th>
          <th>Reason</th>
          <th>Message</th>
          <th>Count</th>
          <th>Source</th>
          <th>Last Seen</th>
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
