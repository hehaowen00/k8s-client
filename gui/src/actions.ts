import { api, canDelete, hasWorkloadLogs, isCronJob, isNode, isPod, isRestartable, isScalable, type KubeObject, type ResourceInfo } from "./api";
import { selectorString } from "./util";
import { confirmDialog, promptDialog, toast } from "./components/Dialogs";
import { portForwardDialog, type PortChoice } from "./components/PortForwardDialog";
import type { MenuItem } from "./components/ContextMenu";
import { openSession, useTabs } from "./store";
import { ALL_ALLOWED, type Perms } from "./permissions";
import { matchesKind, useExtensions } from "./extensions";

export interface Target {
  context: string;
  resource: ResourceInfo;
  namespace: string | null;
  name: string;
}

const open = (...args: Parameters<ReturnType<typeof useTabs.getState>["open"]>) =>
  useTabs.getState().open(...args);

export function openDetail(t: Target, opts?: { background?: boolean; view?: "overview" | "yaml" | "events" }) {
  open({ kind: "detail", ...t, view: opts?.view }, { background: opts?.background });
}

export function openLogs(t: Target) {
  openSession({ kind: "logs", context: t.context, namespace: t.namespace ?? "default", pod: t.name });
}

/** Logs for every pod of a workload. Pass the object if already loaded to skip a fetch. */
export async function openWorkloadLogs(t: Target, obj?: KubeObject) {
  try {
    const o = obj ?? (await api.getObject(t));
    const selector = selectorString(o.spec?.selector);
    if (!selector) return toast(`${t.resource.kind} ${t.name} has no pod selector`, "bad");
    openSession({
      kind: "logs",
      context: t.context,
      namespace: t.namespace ?? "default",
      workload: { kind: t.resource.kind, name: t.name, selector },
      container: "*",
    });
  } catch (e) {
    toast(String(e), "bad");
  }
}

export const canPortForward = (r: ResourceInfo) => r.group === "" && (r.kind === "Pod" || r.kind === "Service");

/** Ports a pod or service exposes, for the port-forward dialog. */
export function portsOf(r: ResourceInfo, o: KubeObject): PortChoice[] {
  if (r.kind === "Service") {
    return (o.spec?.ports ?? []).map((p: KubeObject) => ({
      port: p.port,
      label: `${p.port}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`,
    }));
  }
  const seen = new Set<number>();
  const out: PortChoice[] = [];
  for (const c of o.spec?.containers ?? []) {
    for (const p of c.ports ?? []) {
      if (seen.has(p.containerPort)) continue;
      seen.add(p.containerPort);
      out.push({ port: p.containerPort, label: `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""} · ${c.name}` });
    }
  }
  return out;
}

export async function portForwardTarget(t: Target, obj?: KubeObject, port?: number) {
  try {
    const o = obj ?? (await api.getObject(t));
    let ports = portsOf(t.resource, o);
    // Pods don't have to declare ports; let the user type one.
    if (!ports.length && t.resource.kind === "Pod") {
      const v = await promptDialog({ title: "Port Forward", message: `${t.name} declares no ports. Remote port:`, initial: "8080", inputType: "number" });
      if (!v) return;
      ports = [{ port: Number(v), label: v }];
    }
    portForwardDialog({
      context: t.context,
      namespace: t.namespace ?? "default",
      kind: t.resource.kind === "Service" ? "service" : "pod",
      name: t.name,
      ports,
      initial: port,
    });
  } catch (e) {
    toast(String(e), "bad");
  }
}

/** Logs for a pod or workload target. */
export function openAnyLogs(t: Target, obj?: KubeObject) {
  if (isPod(t.resource)) openLogs(t);
  else if (hasWorkloadLogs(t.resource)) openWorkloadLogs(t, obj);
}

export function openShell(t: Target) {
  openSession({ kind: "exec", context: t.context, namespace: t.namespace ?? "default", pod: t.name });
}

export async function deleteTarget(t: Target): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Delete ${t.resource.kind}`,
    message: `Delete ${t.resource.kind.toLowerCase()} "${t.name}"${t.namespace ? ` in namespace "${t.namespace}"` : ""} on ${t.context}?`,
    danger: true,
    confirmLabel: "Delete",
  });
  if (!ok) return false;
  try {
    await api.deleteResource(t);
    toast(`Deleted ${t.resource.kind.toLowerCase()}/${t.name}`);
    return true;
  } catch (e) {
    toast(String(e), "bad");
    return false;
  }
}

export async function scaleTarget(t: Target, current?: number) {
  const v = await promptDialog({
    title: `Scale ${t.resource.kind}`,
    message: `Replicas for ${t.name}:`,
    initial: String(current ?? 1),
    inputType: "range",
    // ponytail: fixed headroom; add a typed-in fallback if people need to jump past 2x
    max: Math.max(10, (current ?? 1) * 2),
  });
  if (v === null) return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return toast("Replicas must be a non-negative integer", "bad");
  try {
    await api.scaleResource(t, n);
    toast(`Scaled ${t.name} to ${n}`);
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function restartTarget(t: Target) {
  const ok = await confirmDialog({
    title: `Restart ${t.resource.kind}`,
    message: `Trigger a rolling restart of ${t.name}?`,
    confirmLabel: "Restart",
  });
  if (!ok) return;
  try {
    await api.restartResource(t);
    toast(`Restarted ${t.name}`);
  } catch (e) {
    toast(String(e), "bad");
  }
}

export function openAttach(t: Target) {
  openSession({ kind: "exec", context: t.context, namespace: t.namespace ?? "default", pod: t.name, attach: true });
}

export function openNodeShell(context: string, node: string) {
  openSession({ kind: "exec", context, namespace: "kube-system", pod: "", nodeShell: node });
}

export async function setCordon(t: Target, cordon: boolean) {
  try {
    await api.patchResource(t, { spec: { unschedulable: cordon ? true : null } });
    toast(`${cordon ? "Cordoned" : "Uncordoned"} ${t.name}`);
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function drainTarget(t: Target) {
  const ok = await confirmDialog({
    title: `Drain ${t.name}`,
    message: `Cordon ${t.name} and evict all pods except DaemonSet and static pods (emptyDir data is lost). Pod disruption budgets are respected.`,
    danger: true,
    confirmLabel: "Drain",
  });
  if (!ok) return;
  toast(`Draining ${t.name}…`);
  try {
    const r = await api.drainNode(t.context, t.name);
    toast(`Drained ${t.name}: ${r.evicted.length} evicted, ${r.skipped.length} skipped${r.pending.length ? `, ${r.pending.length} still terminating` : ""}`);
    if (r.failed.length) toast(`Could not evict:\n${r.failed.join("\n")}`, "bad");
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function triggerCronJob(t: Target) {
  try {
    const job = await api.triggerCronjob(t.context, t.namespace ?? "default", t.name);
    toast(`Created job ${job}`);
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function setSuspend(t: Target, suspend: boolean) {
  try {
    await api.patchResource(t, { spec: { suspend } });
    toast(`${suspend ? "Suspended" : "Resumed"} ${t.name}`);
  } catch (e) {
    toast(String(e), "bad");
  }
}

/** Delete many objects; returns how many succeeded. */
export async function deleteMany(targets: Target[]): Promise<number> {
  if (!targets.length) return 0;
  const kind = targets[0].resource.kind;
  const names = targets.slice(0, 8).map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
  const more = targets.length > names.length ? `, and ${targets.length - names.length} more` : "";
  const ok = await confirmDialog({
    title: `Delete ${targets.length} ${kind}${targets.length === 1 ? "" : "s"}`,
    message: `Delete ${names.join(", ")}${more} on ${targets[0].context}?`,
    danger: true,
    confirmLabel: `Delete ${targets.length}`,
  });
  if (!ok) return 0;
  const results = await Promise.allSettled(targets.map((t) => api.deleteResource(t)));
  const failed = results
    .map((r, i) => (r.status === "rejected" ? `${targets[i].name}: ${r.reason}` : null))
    .filter((x): x is string => x !== null);
  const done = targets.length - failed.length;
  if (done) toast(`Deleted ${done} ${kind.toLowerCase()}${done === 1 ? "" : "s"}`);
  if (failed.length) toast(`Failed to delete ${failed.length}:\n${failed.join("\n")}`, "bad");
  return done;
}

/** Rolling-restart many workloads at once; returns how many succeeded. */
export async function restartMany(targets: Target[]): Promise<number> {
  if (!targets.length) return 0;
  const kind = targets[0].resource.kind;
  const names = targets.slice(0, 8).map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
  const more = targets.length > names.length ? `, and ${targets.length - names.length} more` : "";
  const ok = await confirmDialog({
    title: `Restart ${targets.length} ${kind}${targets.length === 1 ? "" : "s"}`,
    message: `Trigger a rolling restart of ${names.join(", ")}${more} on ${targets[0].context}?`,
    confirmLabel: `Restart ${targets.length}`,
  });
  if (!ok) return 0;
  const results = await Promise.allSettled(targets.map((t) => api.restartResource(t)));
  const failed = results
    .map((r, i) => (r.status === "rejected" ? `${targets[i].name}: ${r.reason}` : null))
    .filter((x): x is string => x !== null);
  const done = targets.length - failed.length;
  if (done) toast(`Restarted ${done} ${kind.toLowerCase()}${done === 1 ? "" : "s"}`);
  if (failed.length) toast(`Failed to restart ${failed.length}:\n${failed.join("\n")}`, "bad");
  return done;
}

export function targetMenu(
  t: Target,
  extra?: { replicas?: number; onDeleted?: () => void; rowText?: string; perms?: Perms },
): MenuItem[] {
  const p = extra?.perms ?? ALL_ALLOWED;
  const items: MenuItem[] = [
    { label: "Open in New Tab", onClick: () => openDetail(t) },
    { label: "Edit YAML", disabled: !p.update, onClick: () => openDetail(t, { view: "yaml" }) },
  ];
  if (isPod(t.resource)) {
    items.push({ separator: true, label: "" });
    items.push({ label: "Logs", disabled: !p.logs, onClick: () => openLogs(t) });
    items.push({ label: "Shell", disabled: !p.exec, onClick: () => openShell(t) });
    items.push({ label: "Attach", disabled: !p.attach, onClick: () => openAttach(t) });
  }
  if (isNode(t.resource)) {
    const cordoned = /SchedulingDisabled/.test(extra?.rowText ?? "");
    items.push({ separator: true, label: "" });
    items.push({ label: "Shell", onClick: () => openNodeShell(t.context, t.name) });
    items.push(
      cordoned
        ? { label: "Uncordon", disabled: !p.patch, onClick: () => setCordon(t, false) }
        : { label: "Cordon", disabled: !p.patch, onClick: () => setCordon(t, true) },
    );
    items.push({ label: "Drain", disabled: !p.patch || !p.evict, onClick: () => drainTarget(t) });
  }
  if (isCronJob(t.resource)) {
    // The Table's "Suspend" column reads True/False.
    const suspended = /\bTrue\b/.test(extra?.rowText ?? "");
    items.push({ separator: true, label: "" });
    items.push({ label: "Trigger Now", onClick: () => triggerCronJob(t) });
    items.push(
      suspended
        ? { label: "Resume", disabled: !p.patch, onClick: () => setSuspend(t, false) }
        : { label: "Suspend", disabled: !p.patch, onClick: () => setSuspend(t, true) },
    );
  }
  if (canPortForward(t.resource)) {
    if (!isPod(t.resource)) items.push({ separator: true, label: "" });
    items.push({ label: "Port Forward", disabled: !p.portForward, onClick: () => portForwardTarget(t) });
  }
  if (hasWorkloadLogs(t.resource)) {
    items.push({ separator: true, label: "" });
    items.push({ label: "Logs (all pods)", onClick: () => openWorkloadLogs(t) });
  }
  if (isScalable(t.resource) || isRestartable(t.resource)) items.push({ separator: true, label: "" });
  if (isScalable(t.resource)) items.push({ label: "Scale", disabled: !p.patch, onClick: () => scaleTarget(t, extra?.replicas) });
  if (isRestartable(t.resource)) items.push({ label: "Restart", disabled: !p.patch, onClick: () => restartTarget(t) });
  const extActions = useExtensions.getState().actions.filter((a) => matchesKind(a.kinds, t.resource));
  if (extActions.length) {
    items.push({ separator: true, label: "" });
    for (const a of extActions) {
      items.push({
        label: a.label,
        hint: a.ext,
        onClick: () => {
          try {
            a.run(t);
          } catch (e) {
            toast(`${a.ext}: ${e}`, "bad");
          }
        },
      });
    }
  }
  items.push({ separator: true, label: "" });
  items.push({ label: "Copy Name", onClick: () => navigator.clipboard.writeText(t.name) });
  items.push({
    label: "Delete",
    danger: true,
    disabled: !canDelete(t.resource) || !p.delete,
    onClick: async () => {
      if (await deleteTarget(t)) extra?.onDeleted?.();
    },
  });
  return items;
}
