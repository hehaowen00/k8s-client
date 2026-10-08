// Kind-specific detail panels beyond the basics (Ingress, storage, jobs, HPA, RBAC, CRDs)
// and "related resources" (pods, endpoints, child jobs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchesKind, useExtensions, type ExtPanel } from "../extensions";
import { hasWorkloadLogs, isNode, POD_RESOURCE, type KubeObject, type ResourceInfo } from "../api";
import type { Target } from "../actions";
import { useDiscovery, useWatchObjects } from "../hooks";
import { useTabs } from "../store";
import { ALL_NAMESPACES, formatAge, selectorString, statusTone, useNow } from "../util";
import { ResourceTable } from "./ResourceTable";
import { inBackground, useOpenObject } from "../clusterNav";
import { toast } from "../components/Dialogs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { S } from "../strings";

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="dsection">
      <h4 className="dsection-head">
        <span>{title}</span>
        {right}
      </h4>
      {children}
    </section>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === "" || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const Tone = ({ value }: { value?: string }) => {
  if (!value) return null;
  const t = statusTone(value);
  return <span className={t ? `tone-${t}` : ""}>{value}</span>;
};

/** A link to another object, resolved through discovery. */
function ObjLink({
  target,
  group,
  kind,
  name,
  namespace,
}: {
  target: Target;
  group: string;
  kind: string;
  name?: string;
  namespace?: string | null;
}) {
  const discovery = useDiscovery(target.context);
  const openObject = useOpenObject();
  if (!name) return null;
  const res = discovery.data?.find((r) => r.group === group && r.kind === kind);
  if (!res) return <span>{name}</span>;
  return (
    <button
      className="link"
      onClick={(e) =>
        openObject(
          {
            context: target.context,
            resource: res,
            namespace: res.namespaced ? (namespace ?? target.namespace) : null,
            name,
          },
          inBackground(e),
        )
      }
    >
      {name}
    </button>
  );
}

const apiGroupOf = (apiVersion?: string) => (apiVersion?.includes("/") ? apiVersion.split("/")[0] : "");

// ---------------------------------------------------------------------------

function IngressDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const spec = obj.spec ?? {};
  const lb = obj.status?.loadBalancer?.ingress ?? [];
  const backend = (b: KubeObject) =>
    b?.service ? (
      <>
        <ObjLink target={target} group="" kind="Service" name={b.service.name} />:
        {b.service.port?.number ?? b.service.port?.name}
      </>
    ) : b?.resource ? (
      `${b.resource.kind}/${b.resource.name}`
    ) : (
      "—"
    );
  const tlsHosts = new Set<string>((spec.tls ?? []).flatMap((t: KubeObject) => t.hosts ?? []));
  return (
    <>
      <Section title={S.field.ingress}>
        <dl className="kv">
          <KV label={S.field.class}>
            {spec.ingressClassName ?? obj.metadata?.annotations?.["kubernetes.io/ingress.class"]}
          </KV>
          <KV label={S.field.address}>{lb.map((i: KubeObject) => i.ip ?? i.hostname).join(", ")}</KV>
          <KV label={S.field.defaultBackend}>{spec.defaultBackend ? backend(spec.defaultBackend) : undefined}</KV>
        </dl>
      </Section>
      <Section title={S.field.rules}>
        <table className="dtable">
          <thead>
            <tr>
              <th>{S.field.host}</th>
              <th>{S.field.path}</th>
              <th>{S.field.type}</th>
              <th>{S.field.backend}</th>
            </tr>
          </thead>
          <tbody>
            {(spec.rules ?? []).flatMap((r: KubeObject, i: number) =>
              (r.http?.paths ?? [{}]).map((p: KubeObject, j: number) => {
                const host = r.host ?? "*";
                const url = r.host ? `${tlsHosts.has(r.host) ? "https" : "http"}://${r.host}${p.path ?? "/"}` : null;
                return (
                  <tr key={`${i}-${j}`}>
                    <td>
                      {url ? (
                        <button
                          className="link"
                          title={url}
                          onClick={() => openUrl(url).catch((e) => toast(String(e), "bad"))}
                        >
                          {host}
                        </button>
                      ) : (
                        host
                      )}
                    </td>
                    <td className="mono">{p.path ?? "/"}</td>
                    <td className="muted">{p.pathType}</td>
                    <td>{p.backend ? backend(p.backend) : "—"}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </Section>
      {spec.tls?.length ? (
        <Section title={S.field.tls}>
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.hosts}</th>
                <th>{S.field.secret}</th>
              </tr>
            </thead>
            <tbody>
              {spec.tls.map((t: KubeObject, i: number) => (
                <tr key={i}>
                  <td>{(t.hosts ?? []).join(", ")}</td>
                  <td>
                    <ObjLink target={target} group="" kind="Secret" name={t.secretName} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

function PvcDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const spec = obj.spec ?? {};
  const st = obj.status ?? {};
  return (
    <Section title={S.field.claim}>
      <dl className="kv">
        <KV label={S.field.status}>
          <Tone value={st.phase} />
        </KV>
        <KV label={S.field.capacity}>{st.capacity?.storage}</KV>
        <KV label={S.field.requested}>{spec.resources?.requests?.storage}</KV>
        <KV label={S.field.accessModes}>{(st.accessModes ?? spec.accessModes ?? []).join(", ")}</KV>
        <KV label={S.field.volumeMode}>{spec.volumeMode}</KV>
        <KV label={S.field.storageClass}>
          <ObjLink target={target} group="storage.k8s.io" kind="StorageClass" name={spec.storageClassName} />
        </KV>
        <KV label={S.field.volume}>
          <ObjLink target={target} group="" kind="PersistentVolume" name={spec.volumeName} />
        </KV>
      </dl>
    </Section>
  );
}

function PvDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const spec = obj.spec ?? {};
  const known = [
    "capacity",
    "accessModes",
    "persistentVolumeReclaimPolicy",
    "storageClassName",
    "claimRef",
    "volumeMode",
    "nodeAffinity",
    "mountOptions",
  ];
  const source = Object.keys(spec).find((k) => !known.includes(k));
  return (
    <Section title={S.field.volume}>
      <dl className="kv">
        <KV label={S.field.status}>
          <Tone value={obj.status?.phase} />
        </KV>
        <KV label={S.field.capacity}>{spec.capacity?.storage}</KV>
        <KV label={S.field.accessModes}>{(spec.accessModes ?? []).join(", ")}</KV>
        <KV label={S.field.reclaimPolicy}>{spec.persistentVolumeReclaimPolicy}</KV>
        <KV label={S.field.storageClass}>
          <ObjLink target={target} group="storage.k8s.io" kind="StorageClass" name={spec.storageClassName} />
        </KV>
        <KV label={S.field.claim}>
          {spec.claimRef ? (
            <>
              {spec.claimRef.namespace}/
              <ObjLink
                target={target}
                group=""
                kind="PersistentVolumeClaim"
                name={spec.claimRef.name}
                namespace={spec.claimRef.namespace}
              />
            </>
          ) : undefined}
        </KV>
        <KV label={S.field.source}>
          {source ? (
            <span className="mono small">
              {source}
              {spec[source]?.path ? `: ${spec[source].path}` : spec[source]?.driver ? `: ${spec[source].driver}` : ""}
            </span>
          ) : undefined}
        </KV>
      </dl>
    </Section>
  );
}

function StorageClassDetails({ obj }: { obj: KubeObject }) {
  const isDefault = obj.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
  return (
    <Section title={S.field.storageClass}>
      <dl className="kv">
        <KV label={S.field.provisioner}>{obj.provisioner}</KV>
        <KV label={S.field.default}>{isDefault ? S.detail.yes : S.detail.no}</KV>
        <KV label={S.field.reclaimPolicy}>{obj.reclaimPolicy ?? "Delete"}</KV>
        <KV label={S.field.bindingMode}>{obj.volumeBindingMode ?? "Immediate"}</KV>
        <KV label={S.field.expansion}>{obj.allowVolumeExpansion ? S.detail.allowed : S.detail.notAllowed}</KV>
        <KV label={S.field.parameters}>
          {obj.parameters && Object.keys(obj.parameters).length ? (
            <div className="chips">
              {Object.entries(obj.parameters).map(([k, v]) => (
                <span key={k} className="chip">
                  {k}={String(v)}
                </span>
              ))}
            </div>
          ) : undefined}
        </KV>
      </dl>
    </Section>
  );
}

function jobStatus(j: KubeObject): string {
  const c = (j.status?.conditions ?? []).find(
    (x: KubeObject) => (x.type === "Complete" || x.type === "Failed") && x.status === "True",
  );
  if (c) return c.type === "Complete" ? "Complete" : "Failed";
  if (j.status?.active) return "Running";
  if (j.spec?.suspend) return "Suspended";
  return "Pending";
}

function duration(j: KubeObject, now: number): string {
  const start = j.status?.startTime ? Date.parse(j.status.startTime) : null;
  if (!start) return "";
  const end = j.status?.completionTime ? Date.parse(j.status.completionTime) : now;
  return formatAge(new Date(start).toISOString(), end);
}

function JobDetails({ obj }: { obj: KubeObject }) {
  const now = useNow(5000);
  const spec = obj.spec ?? {};
  const st = obj.status ?? {};
  return (
    <Section title={S.field.job}>
      <dl className="kv">
        <KV label={S.field.status}>
          <Tone value={jobStatus(obj)} />
        </KV>
        <KV label={S.field.completions}>{`${st.succeeded ?? 0} / ${spec.completions ?? 1}`}</KV>
        <KV label={S.field.parallelism}>{String(spec.parallelism ?? 1)}</KV>
        <KV label={S.field.activeFailed}>{`${st.active ?? 0} / ${st.failed ?? 0}`}</KV>
        <KV label={S.field.backoffLimit}>{String(spec.backoffLimit ?? 6)}</KV>
        <KV label={S.field.started}>
          {st.startTime && <span title={st.startTime}>{S.detail.ago(formatAge(st.startTime, now))}</span>}
        </KV>
        <KV label={S.field.duration}>{duration(obj, now)}</KV>
        <KV label={S.field.ttlAfterFinish}>
          {spec.ttlSecondsAfterFinished != null ? `${spec.ttlSecondsAfterFinished}s` : undefined}
        </KV>
      </dl>
    </Section>
  );
}

function CronJobDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const now = useNow(5000);
  const spec = obj.spec ?? {};
  const st = obj.status ?? {};
  const discovery = useDiscovery(target.context);
  const jobRes = discovery.data?.find((r) => r.group === "batch" && r.kind === "Job");
  const openObject = useOpenObject();
  const uid = obj.metadata?.uid;
  const owned = useWatchObjects(target.context, uid ? jobRes : null, target.namespace, {}).items;
  const jobs = useMemo(
    () =>
      owned
        ?.filter((j) => j.metadata?.ownerReferences?.some((r: KubeObject) => r.uid === uid))
        .sort((a, b) => String(b.metadata?.creationTimestamp).localeCompare(String(a.metadata?.creationTimestamp))) ??
      null,
    [owned, uid],
  );
  return (
    <>
      <Section title={S.field.schedule}>
        <dl className="kv">
          <KV label={S.field.schedule}>
            <span className="mono">{spec.schedule}</span>
            {spec.timeZone ? <span className="muted"> ({spec.timeZone})</span> : null}
          </KV>
          <KV label={S.field.suspended}>
            {spec.suspend ? <span className="tone-warn">{S.detail.yes}</span> : S.detail.no}
          </KV>
          <KV label={S.field.concurrency}>{spec.concurrencyPolicy ?? "Allow"}</KV>
          <KV label={S.field.lastScheduled}>
            {st.lastScheduleTime && S.detail.ago(formatAge(st.lastScheduleTime, now))}
          </KV>
          <KV label={S.field.lastSuccess}>
            {st.lastSuccessfulTime && S.detail.ago(formatAge(st.lastSuccessfulTime, now))}
          </KV>
          <KV label={S.field.historyLimits}>
            {S.detail.historyLimits(spec.successfulJobsHistoryLimit ?? 3, spec.failedJobsHistoryLimit ?? 1)}
          </KV>
        </dl>
      </Section>
      <Section title={S.field.jobs}>
        {!jobs ? (
          <div className="muted">{S.detail.loading}</div>
        ) : jobs.length === 0 ? (
          <div className="muted">{S.detail.noJobs}</div>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.name}</th>
                <th>{S.field.status}</th>
                <th>{S.field.completions}</th>
                <th>{S.field.duration}</th>
                <th>{S.field.age}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.metadata?.uid}
                  className="clickable"
                  onClick={(e) =>
                    jobRes &&
                    openObject(
                      { context: target.context, resource: jobRes, namespace: target.namespace, name: j.metadata.name },
                      inBackground(e),
                    )
                  }
                >
                  <td>{j.metadata?.name}</td>
                  <td>
                    <Tone value={jobStatus(j)} />
                  </td>
                  <td>{`${j.status?.succeeded ?? 0}/${j.spec?.completions ?? 1}`}</td>
                  <td className="muted">{duration(j, now)}</td>
                  <td className="muted">{formatAge(j.metadata?.creationTimestamp, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function metricTarget(m: KubeObject): string {
  const t =
    m.resource?.target ?? m.containerResource?.target ?? m.pods?.target ?? m.object?.target ?? m.external?.target;
  if (!t) return "";
  if (t.averageUtilization != null) return `${t.averageUtilization}%`;
  return String(t.averageValue ?? t.value ?? "");
}

function metricCurrent(m: KubeObject): string {
  const c =
    m.resource?.current ?? m.containerResource?.current ?? m.pods?.current ?? m.object?.current ?? m.external?.current;
  if (!c) return "—";
  if (c.averageUtilization != null) return `${c.averageUtilization}%`;
  return String(c.averageValue ?? c.value ?? "—");
}

function metricName(m: KubeObject): string {
  switch (m.type) {
    case "Resource":
      return `${m.resource?.name} (resource)`;
    case "ContainerResource":
      return `${m.containerResource?.name} (${m.containerResource?.container})`;
    case "Pods":
      return `${m.pods?.metric?.name} (pods)`;
    case "Object":
      return `${m.object?.metric?.name} (${m.object?.describedObject?.kind}/${m.object?.describedObject?.name})`;
    case "External":
      return `${m.external?.metric?.name} (external)`;
    default:
      return m.type;
  }
}

function HpaDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const spec = obj.spec ?? {};
  const st = obj.status ?? {};
  const ref = spec.scaleTargetRef ?? {};
  // autoscaling/v1 has a single CPU target; v2 has a metrics list.
  const metrics: KubeObject[] =
    spec.metrics ??
    (spec.targetCPUUtilizationPercentage != null
      ? [
          {
            type: "Resource",
            resource: { name: "cpu", target: { averageUtilization: spec.targetCPUUtilizationPercentage } },
          },
        ]
      : []);
  const current: KubeObject[] =
    st.currentMetrics ??
    (st.currentCPUUtilizationPercentage != null
      ? [
          {
            type: "Resource",
            resource: { name: "cpu", current: { averageUtilization: st.currentCPUUtilizationPercentage } },
          },
        ]
      : []);
  return (
    <>
      <Section title={S.field.autoscaling}>
        <dl className="kv">
          <KV label={S.field.target}>
            {ref.kind}/
            <ObjLink target={target} group={apiGroupOf(ref.apiVersion)} kind={ref.kind} name={ref.name} />
          </KV>
          <KV label={S.field.replicas}>
            {S.detail.hpaReplicas(
              st.currentReplicas ?? 0,
              st.desiredReplicas ?? 0,
              spec.minReplicas ?? 1,
              spec.maxReplicas,
            )}
          </KV>
          <KV label={S.field.lastScaled}>{st.lastScaleTime && S.detail.ago(formatAge(st.lastScaleTime))}</KV>
        </dl>
      </Section>
      <Section title={S.field.metrics}>
        {metrics.length === 0 ? (
          <div className="muted">{S.detail.noMetrics}</div>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.metric}</th>
                <th>{S.field.current}</th>
                <th>{S.field.target}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => (
                <tr key={i}>
                  <td>{metricName(m)}</td>
                  <td>{current[i] ? metricCurrent(current[i]) : "—"}</td>
                  <td>{metricTarget(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function RoleDetails({ obj }: { obj: KubeObject }) {
  const rules: KubeObject[] = obj.rules ?? [];
  return (
    <Section title={S.field.rules}>
      {obj.aggregationRule && (
        <div className="muted small">
          {S.detail.aggregated(JSON.stringify(obj.aggregationRule.clusterRoleSelectors))}
        </div>
      )}
      {rules.length === 0 ? (
        <div className="muted">{S.detail.noRules}</div>
      ) : (
        <table className="dtable">
          <thead>
            <tr>
              <th>{S.field.apiGroups}</th>
              <th>{S.field.resources}</th>
              <th>{S.field.resourceNames}</th>
              <th>{S.field.verbs}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td className="wrap">
                  {(r.apiGroups ?? []).map((g: string) => g || S.palette.coreGroup).join(", ") ||
                    (r.nonResourceURLs ? "—" : "")}
                </td>
                <td className="wrap">{(r.resources ?? r.nonResourceURLs ?? []).join(", ")}</td>
                <td className="wrap muted">{(r.resourceNames ?? []).join(", ")}</td>
                <td className="wrap">{(r.verbs ?? []).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function BindingDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const ref = obj.roleRef ?? {};
  return (
    <>
      <Section title={S.field.role}>
        <dl className="kv">
          <KV label={ref.kind ?? "Role"}>
            <ObjLink
              target={target}
              group="rbac.authorization.k8s.io"
              kind={ref.kind}
              name={ref.name}
              namespace={ref.kind === "ClusterRole" ? null : target.namespace}
            />
          </KV>
        </dl>
      </Section>
      <Section title={S.field.subjects}>
        <table className="dtable">
          <thead>
            <tr>
              <th>{S.field.kind}</th>
              <th>{S.field.name}</th>
              <th>{S.field.namespace}</th>
            </tr>
          </thead>
          <tbody>
            {(obj.subjects ?? []).map((s: KubeObject, i: number) => (
              <tr key={i}>
                <td>{s.kind}</td>
                <td>
                  {s.kind === "ServiceAccount" ? (
                    <ObjLink target={target} group="" kind="ServiceAccount" name={s.name} namespace={s.namespace} />
                  ) : (
                    s.name
                  )}
                </td>
                <td className="muted">{s.namespace}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

/** Top-level schema properties with types, two levels deep. */
function SchemaTree({ schema, depth = 0 }: { schema?: KubeObject; depth?: number }) {
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  if (!keys.length) return null;
  const required = new Set<string>(schema?.required ?? []);
  return (
    <ul className="schema-tree">
      {keys.map((k) => {
        const p = props[k];
        const type =
          p.type === "array"
            ? `${p.items?.type ?? "object"}[]`
            : (p.type ?? (p["x-kubernetes-int-or-string"] ? "int|string" : "object"));
        return (
          <li key={k}>
            <span className="mono">{k}</span>
            {required.has(k) && <span className="tone-warn">*</span>} <span className="muted small">{type}</span>
            {p.description && <div className="muted small schema-desc">{p.description}</div>}
            {depth < 1 && <SchemaTree schema={p.type === "array" ? p.items : p} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

function CrdDetails({ obj, target }: { obj: KubeObject; target: Target }) {
  const spec = obj.spec ?? {};
  const names = spec.names ?? {};
  const open = useTabs((s) => s.open);
  const discovery = useDiscovery(target.context);
  const versions: KubeObject[] = spec.versions ?? [];
  const storage = versions.find((v) => v.storage) ?? versions[0];
  const res = discovery.data?.find((r) => r.group === spec.group && r.kind === names.kind);
  return (
    <>
      <Section
        title={S.detail.definition}
        right={
          res && (
            <button
              className="btn btn-xs"
              onClick={() => open({ kind: "cluster", context: target.context, resource: res, namespace: "" })}
            >
              {S.detail.browse(names.plural)}
            </button>
          )
        }
      >
        <dl className="kv">
          <KV label={S.field.group}>{spec.group}</KV>
          <KV label={S.field.kind}>{names.kind}</KV>
          <KV label={S.field.plural}>{names.plural}</KV>
          <KV label={S.field.singular}>{names.singular}</KV>
          <KV label={S.field.shortNames}>{(names.shortNames ?? []).join(", ")}</KV>
          <KV label={S.field.categories}>{(names.categories ?? []).join(", ")}</KV>
          <KV label={S.field.scope}>{spec.scope}</KV>
          <KV label={S.field.conversion}>{spec.conversion?.strategy}</KV>
        </dl>
      </Section>
      <Section title={S.field.versions}>
        <table className="dtable">
          <thead>
            <tr>
              <th>{S.field.name}</th>
              <th>{S.field.served}</th>
              <th>{S.field.storage}</th>
              <th>{S.field.deprecated}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.name}>
                <td>{v.name}</td>
                <td>{String(!!v.served)}</td>
                <td>{String(!!v.storage)}</td>
                <td className="wrap">{v.deprecated ? (v.deprecationWarning ?? S.detail.yes) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {storage?.additionalPrinterColumns?.length ? (
        <Section title={S.field.printerColumns}>
          <table className="dtable">
            <thead>
              <tr>
                <th>{S.field.name}</th>
                <th>{S.field.type}</th>
                <th>{S.field.jsonPath}</th>
              </tr>
            </thead>
            <tbody>
              {storage.additionalPrinterColumns.map((c: KubeObject) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="muted">{c.type}</td>
                  <td className="mono small">{c.jsonPath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
      {storage?.schema?.openAPIV3Schema && (
        <Section title={S.detail.schema(storage.name)}>
          <SchemaTree schema={storage.schema.openAPIV3Schema} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Related resources
// ---------------------------------------------------------------------------

export function RelatedPods({
  target,
  labelSelector,
  fieldSelector,
  namespace,
  active,
}: {
  target: Target;
  labelSelector?: string;
  fieldSelector?: string;
  namespace: string | null;
  active: boolean;
}) {
  const [count, setCount] = useState<number | null>(null);
  const onCount = useCallback((n: number) => setCount(n), []);
  const openObject = useOpenObject();
  return (
    <Section title={S.detail.pods(count)}>
      <div className="related-table" style={{ height: Math.min(360, 32 + Math.max(1, count ?? 3) * 30 + 12) }}>
        <ResourceTable
          context={target.context}
          resource={POD_RESOURCE}
          namespace={namespace ?? ALL_NAMESPACES}
          filter=""
          wide={false}
          active={active}
          compact
          selectedUid={null}
          labelSelector={labelSelector}
          fieldSelector={fieldSelector}
          onSelect={() => {}}
          onOpen={(row, background) =>
            openObject(
              { context: target.context, resource: POD_RESOURCE, namespace: row.namespace ?? null, name: row.name },
              background,
            )
          }
          onCount={onCount}
        />
      </div>
    </Section>
  );
}

function Endpoints({ target }: { target: Target }) {
  const discovery = useDiscovery(target.context);
  const epRes: ResourceInfo | undefined = discovery.data?.find((r) => r.group === "" && r.kind === "Endpoints");
  const watched = useWatchObjects(target.context, epRes, target.namespace, {
    fieldSelector: `metadata.name=${target.name}`,
  });
  const ep = watched.items && (watched.items[0] ?? {});
  if (!ep) return null;
  const rows = (ep.subsets ?? []).flatMap((s: KubeObject) => [
    ...(s.addresses ?? []).map((a: KubeObject) => ({ a, ready: true, ports: s.ports ?? [] })),
    ...(s.notReadyAddresses ?? []).map((a: KubeObject) => ({ a, ready: false, ports: s.ports ?? [] })),
  ]);
  return (
    <Section title={S.detail.endpoints(rows.length)}>
      {rows.length === 0 ? (
        <div className="muted">{S.detail.noEndpoints}</div>
      ) : (
        <table className="dtable">
          <thead>
            <tr>
              <th>{S.field.address}</th>
              <th>{S.field.target}</th>
              <th>{S.field.ports}</th>
              <th>{S.field.ready}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, ready, ports }: KubeObject, i: number) => (
              <tr key={i}>
                <td className="mono">{a.ip ?? a.hostname}</td>
                <td>
                  {a.targetRef?.kind === "Pod" ? (
                    <ObjLink
                      target={target}
                      group=""
                      kind="Pod"
                      name={a.targetRef.name}
                      namespace={a.targetRef.namespace}
                    />
                  ) : (
                    (a.targetRef?.name ?? "")
                  )}
                </td>
                <td className="mono small">
                  {ports
                    .map((p: KubeObject) => `${p.name ? p.name + ":" : ""}${p.port}/${p.protocol ?? "TCP"}`)
                    .join(", ")}
                </td>
                <td className={ready ? "tone-ok" : "tone-warn"}>{ready ? S.detail.yes : S.detail.no}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** A detail panel contributed by an extension, rendered into its own element. */
function ExtPanelView({ panel, obj, target }: { panel: ExtPanel; obj: KubeObject; target: Target }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const version = obj.metadata?.resourceVersion;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    let cleanup: void | (() => void);
    try {
      cleanup = panel.render(el, obj, target);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch {
        /* ignore */
      }
    };
    // Re-render when the object changes, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, version, target.name]);
  return (
    <Section title={panel.title} right={<span className="muted small">{panel.ext}</span>}>
      {error && <div className="error-box">{error}</div>}
      <div ref={ref} className="ext-panel" />
    </Section>
  );
}

/** Extra sections for kinds not covered by the basic overview, plus related resources. */
export function KindExtras({ obj, target, active }: { obj: KubeObject; target: Target; active: boolean }) {
  const { resource: r } = target;
  const g = r.group;
  const k = r.kind;
  const extra =
    g === "networking.k8s.io" && k === "Ingress" ? (
      <IngressDetails obj={obj} target={target} />
    ) : g === "" && k === "PersistentVolumeClaim" ? (
      <PvcDetails obj={obj} target={target} />
    ) : g === "" && k === "PersistentVolume" ? (
      <PvDetails obj={obj} target={target} />
    ) : g === "storage.k8s.io" && k === "StorageClass" ? (
      <StorageClassDetails obj={obj} />
    ) : g === "batch" && k === "Job" ? (
      <JobDetails obj={obj} />
    ) : g === "batch" && k === "CronJob" ? (
      <CronJobDetails obj={obj} target={target} />
    ) : g === "autoscaling" && k === "HorizontalPodAutoscaler" ? (
      <HpaDetails obj={obj} target={target} />
    ) : g === "rbac.authorization.k8s.io" && (k === "Role" || k === "ClusterRole") ? (
      <RoleDetails obj={obj} />
    ) : g === "rbac.authorization.k8s.io" && (k === "RoleBinding" || k === "ClusterRoleBinding") ? (
      <BindingDetails obj={obj} target={target} />
    ) : g === "apiextensions.k8s.io" && k === "CustomResourceDefinition" ? (
      <CrdDetails obj={obj} target={target} />
    ) : null;

  // Related pods: workloads & jobs by selector, services by selector, nodes by field selector.
  let related: React.ReactNode = null;
  if (hasWorkloadLogs(r)) {
    const sel = selectorString(obj.spec?.selector);
    if (sel) related = <RelatedPods target={target} active={active} labelSelector={sel} namespace={target.namespace} />;
  } else if (g === "" && k === "Service" && obj.spec?.selector && Object.keys(obj.spec.selector).length) {
    const sel = Object.entries(obj.spec.selector)
      .map(([a, b]) => `${a}=${b}`)
      .join(",");
    related = (
      <>
        <Endpoints target={target} />
        <RelatedPods target={target} active={active} labelSelector={sel} namespace={target.namespace} />
      </>
    );
  } else if (isNode(r)) {
    related = (
      <RelatedPods target={target} active={active} fieldSelector={`spec.nodeName=${target.name}`} namespace={null} />
    );
  }
  const panels = useExtensions((s) => s.panels).filter((p) => matchesKind(p.kinds, r));
  if (!extra && !related && !panels.length) return null;
  return (
    <>
      {extra}
      {related}
      {panels.map((p, i) => (
        <ExtPanelView key={`${p.ext}:${p.title}:${i}`} panel={p} obj={obj} target={target} />
      ))}
    </>
  );
}
