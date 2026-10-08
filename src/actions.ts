import {
  api,
  canDelete,
  hasWorkloadLogs,
  isCronJob,
  isNode,
  isPod,
  isRestartable,
  isScalable,
  type KubeObject,
  type ResourceInfo,
} from "./api";
import { selectorString } from "./util";
import { confirmDialog, promptDialog, toast } from "./components/Dialogs";
import { portForwardDialog, type PortChoice } from "./components/PortForwardDialog";
import { restartAcrossDialog } from "./components/RestartAcrossDialog";
import type { MenuItem } from "./components/ContextMenu";
import { openSession, useTabs } from "./store";
import { ALL_ALLOWED, type Perms } from "./permissions";
import { matchesKind, useExtensions } from "./extensions";
import { S } from "./strings";

export interface Target {
  context: string;
  resource: ResourceInfo;
  namespace: string | null;
  name: string;
}

const open = (...args: Parameters<ReturnType<typeof useTabs.getState>["open"]>) => useTabs.getState().open(...args);

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
    if (!selector) return toast(S.actions.noSelector(t.resource.kind, t.name), "bad");
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
      out.push({
        port: p.containerPort,
        label: `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""} · ${c.name}`,
      });
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
      const v = await promptDialog({
        title: S.portForward.title,
        message: S.actions.noPortsPrompt(t.name),
        initial: "8080",
        inputType: "number",
      });
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
    title: S.actions.deleteTitle(t.resource.kind),
    message: S.actions.deleteMessage(t.resource.kind.toLowerCase(), t.name, t.namespace, t.context),
    danger: true,
    confirmLabel: S.actions.delete,
  });
  if (!ok) return false;
  try {
    await api.deleteResource(t);
    toast(S.actions.deleted(`${t.resource.kind.toLowerCase()}/${t.name}`));
    return true;
  } catch (e) {
    toast(String(e), "bad");
    return false;
  }
}

export async function scaleTarget(t: Target, current?: number) {
  const v = await promptDialog({
    title: S.actions.scaleTitle(t.resource.kind),
    message: S.actions.scaleMessage(t.name),
    initial: String(current ?? 1),
    inputType: "range",
    // ponytail: fixed headroom; add a typed-in fallback if people need to jump past 2x
    max: Math.max(10, (current ?? 1) * 2),
  });
  if (v === null) return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return toast(S.actions.badReplicas, "bad");
  try {
    await api.scaleResource(t, n);
    toast(S.actions.scaled(t.name, n));
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function restartTarget(t: Target) {
  const ok = await confirmDialog({
    title: S.actions.restartTitle(t.resource.kind),
    message: S.actions.restartMessage(t.name),
    confirmLabel: S.actions.restart,
  });
  if (!ok) return;
  try {
    await api.restartResource(t);
    toast(S.actions.restarted(t.name));
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
    toast(cordon ? S.actions.cordoned(t.name) : S.actions.uncordoned(t.name));
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function drainTarget(t: Target) {
  const ok = await confirmDialog({
    title: S.actions.drainTitle(t.name),
    message: S.actions.drainMessage(t.name),
    danger: true,
    confirmLabel: S.actions.drain,
  });
  if (!ok) return;
  toast(S.actions.draining(t.name));
  try {
    const r = await api.drainNode(t.context, t.name);
    toast(S.actions.drained(t.name, r.evicted.length, r.skipped.length, r.pending.length));
    if (r.failed.length) toast(S.actions.evictFailed(r.failed), "bad");
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function triggerCronJob(t: Target) {
  try {
    const job = await api.triggerCronjob(t.context, t.namespace ?? "default", t.name);
    toast(S.actions.jobCreated(job));
  } catch (e) {
    toast(String(e), "bad");
  }
}

export async function setSuspend(t: Target, suspend: boolean) {
  try {
    await api.patchResource(t, { spec: { suspend } });
    toast(suspend ? S.actions.suspended(t.name) : S.actions.resumed(t.name));
  } catch (e) {
    toast(String(e), "bad");
  }
}

/** Delete many objects; returns how many succeeded. */
export async function deleteMany(targets: Target[]): Promise<number> {
  if (!targets.length) return 0;
  const kind = targets[0].resource.kind;
  const names = targets.slice(0, 8).map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
  const more = targets.length > names.length ? S.actions.andMore(targets.length - names.length) : "";
  const ok = await confirmDialog({
    title: S.actions.deleteManyTitle(targets.length, kind),
    message: S.actions.deleteManyMessage(`${names.join(", ")}${more}`, targets[0].context),
    danger: true,
    confirmLabel: S.actions.deleteN(targets.length),
  });
  if (!ok) return 0;
  const results = await Promise.allSettled(targets.map((t) => api.deleteResource(t)));
  const failed = results
    .map((r, i) => (r.status === "rejected" ? `${targets[i].name}: ${r.reason}` : null))
    .filter((x): x is string => x !== null);
  const done = targets.length - failed.length;
  if (done) toast(S.actions.deletedMany(done, kind.toLowerCase()));
  if (failed.length) toast(S.actions.deleteFailed(failed), "bad");
  return done;
}

/** Rolling-restart many workloads at once; returns how many succeeded. */
export async function restartMany(targets: Target[]): Promise<number> {
  if (!targets.length) return 0;
  const kind = targets[0].resource.kind;
  const names = targets.slice(0, 8).map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
  const more = targets.length > names.length ? S.actions.andMore(targets.length - names.length) : "";
  const ok = await confirmDialog({
    title: S.actions.restartManyTitle(targets.length, kind),
    message: S.actions.restartManyMessage(`${names.join(", ")}${more}`, targets[0].context),
    confirmLabel: S.restartAcross.restartN(targets.length),
  });
  if (!ok) return 0;
  const results = await Promise.allSettled(targets.map((t) => api.restartResource(t)));
  const failed = results
    .map((r, i) => (r.status === "rejected" ? `${targets[i].name}: ${r.reason}` : null))
    .filter((x): x is string => x !== null);
  const done = targets.length - failed.length;
  if (done) toast(S.actions.restartedMany(done, kind.toLowerCase()));
  if (failed.length) toast(S.actions.restartFailed(failed), "bad");
  return done;
}

export function targetMenu(
  t: Target,
  extra?: { replicas?: number; onDeleted?: () => void; rowText?: string; perms?: Perms },
): MenuItem[] {
  const p = extra?.perms ?? ALL_ALLOWED;
  const items: MenuItem[] = [
    { label: S.common.openInNewTab, onClick: () => openDetail(t) },
    { label: S.actions.editYaml, disabled: !p.update, onClick: () => openDetail(t, { view: "yaml" }) },
  ];
  if (isPod(t.resource)) {
    items.push({ separator: true, label: "" });
    items.push({ label: S.actions.logs, disabled: !p.logs, onClick: () => openLogs(t) });
    items.push({ label: S.actions.shell, disabled: !p.exec, onClick: () => openShell(t) });
    items.push({ label: S.actions.attach, disabled: !p.attach, onClick: () => openAttach(t) });
  }
  if (isNode(t.resource)) {
    const cordoned = /SchedulingDisabled/.test(extra?.rowText ?? "");
    items.push({ separator: true, label: "" });
    items.push({ label: S.actions.shell, onClick: () => openNodeShell(t.context, t.name) });
    items.push(
      cordoned
        ? { label: S.actions.uncordon, disabled: !p.patch, onClick: () => setCordon(t, false) }
        : { label: S.actions.cordon, disabled: !p.patch, onClick: () => setCordon(t, true) },
    );
    items.push({ label: S.actions.drain, disabled: !p.patch || !p.evict, onClick: () => drainTarget(t) });
  }
  if (isCronJob(t.resource)) {
    // The Table's "Suspend" column reads True/False.
    const suspended = /\bTrue\b/.test(extra?.rowText ?? "");
    items.push({ separator: true, label: "" });
    items.push({ label: S.actions.triggerNow, onClick: () => triggerCronJob(t) });
    items.push(
      suspended
        ? { label: S.actions.resume, disabled: !p.patch, onClick: () => setSuspend(t, false) }
        : { label: S.actions.suspend, disabled: !p.patch, onClick: () => setSuspend(t, true) },
    );
  }
  if (canPortForward(t.resource)) {
    if (!isPod(t.resource)) items.push({ separator: true, label: "" });
    items.push({ label: S.portForward.title, disabled: !p.portForward, onClick: () => portForwardTarget(t) });
  }
  if (hasWorkloadLogs(t.resource)) {
    items.push({ separator: true, label: "" });
    items.push({ label: S.actions.workloadLogs, onClick: () => openWorkloadLogs(t) });
  }
  if (isScalable(t.resource) || isRestartable(t.resource)) items.push({ separator: true, label: "" });
  if (isScalable(t.resource))
    items.push({ label: S.actions.scale, disabled: !p.patch, onClick: () => scaleTarget(t, extra?.replicas) });
  if (isRestartable(t.resource)) {
    items.push({ label: S.actions.restart, disabled: !p.patch, onClick: () => restartTarget(t) });
    items.push({ label: S.restartAcross.title, onClick: () => restartAcrossDialog(t) });
  }
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
  items.push({ label: S.actions.copyName, onClick: () => navigator.clipboard.writeText(t.name) });
  items.push({
    label: S.actions.delete,
    danger: true,
    disabled: !canDelete(t.resource) || !p.delete,
    onClick: async () => {
      if (await deleteTarget(t)) extra?.onDeleted?.();
    },
  });
  return items;
}
