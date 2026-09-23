import { useEffect, useState } from "react";
import type { ResourceInfo } from "./api";

export function formatAge(ts?: string | null, now = Date.now()): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  let s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 && m < 10 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  m %= 60;
  if (h < 24) return `${h}h${m && h < 10 ? `${m}m` : ""}`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d${h % 24 && d < 10 ? `${h % 24}h` : ""}`;
  return `${Math.floor(d / 365)}y${Math.floor((d % 365))}d`;
}

/** Re-render periodically so relative ages stay fresh. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type Tone = "ok" | "warn" | "bad" | "muted" | undefined;

export function statusTone(value: string): Tone {
  const v = value.toLowerCase();
  if (/^(running|active|bound|ready|true|available|healthy|complete|established)$/.test(v)) return "ok";
  if (/^(succeeded|completed|terminated|released)$/.test(v)) return "muted";
  if (/(error|fail|crash|backoff|evicted|oomkilled|lost|notready|false|invalid|unknown)/.test(v)) return "bad";
  if (/(pending|creating|init|terminating|waiting|progressing|containercreating)/.test(v)) return "warn";
  return undefined;
}

// ---------------------------------------------------------------------------
// Sidebar categories
// ---------------------------------------------------------------------------

const CATEGORIES: [string, [string, string][]][] = [
  [
    "Workloads",
    [
      ["", "Pod"],
      ["apps", "Deployment"],
      ["apps", "DaemonSet"],
      ["apps", "StatefulSet"],
      ["apps", "ReplicaSet"],
      ["batch", "Job"],
      ["batch", "CronJob"],
    ],
  ],
  [
    "Config",
    [
      ["", "ConfigMap"],
      ["", "Secret"],
      ["", "ResourceQuota"],
      ["", "LimitRange"],
      ["autoscaling", "HorizontalPodAutoscaler"],
      ["policy", "PodDisruptionBudget"],
      ["scheduling.k8s.io", "PriorityClass"],
      ["node.k8s.io", "RuntimeClass"],
      ["coordination.k8s.io", "Lease"],
      ["admissionregistration.k8s.io", "MutatingWebhookConfiguration"],
      ["admissionregistration.k8s.io", "ValidatingWebhookConfiguration"],
    ],
  ],
  [
    "Network",
    [
      ["", "Service"],
      ["", "Endpoints"],
      ["discovery.k8s.io", "EndpointSlice"],
      ["networking.k8s.io", "Ingress"],
      ["networking.k8s.io", "IngressClass"],
      ["networking.k8s.io", "NetworkPolicy"],
    ],
  ],
  [
    "Storage",
    [
      ["", "PersistentVolumeClaim"],
      ["", "PersistentVolume"],
      ["storage.k8s.io", "StorageClass"],
      ["storage.k8s.io", "VolumeAttachment"],
      ["storage.k8s.io", "CSIDriver"],
      ["storage.k8s.io", "CSINode"],
    ],
  ],
  [
    "Access Control",
    [
      ["", "ServiceAccount"],
      ["rbac.authorization.k8s.io", "Role"],
      ["rbac.authorization.k8s.io", "RoleBinding"],
      ["rbac.authorization.k8s.io", "ClusterRole"],
      ["rbac.authorization.k8s.io", "ClusterRoleBinding"],
    ],
  ],
  [
    "Cluster",
    [
      ["", "Node"],
      ["", "Namespace"],
      ["", "Event"],
      ["apiextensions.k8s.io", "CustomResourceDefinition"],
      ["apiregistration.k8s.io", "APIService"],
    ],
  ],
];

const BUILTIN_GROUPS = new Set([
  "",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "networking.k8s.io",
  "rbac.authorization.k8s.io",
  "storage.k8s.io",
  "scheduling.k8s.io",
  "node.k8s.io",
  "coordination.k8s.io",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "certificates.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "resource.k8s.io",
  "internal.apiserver.k8s.io",
  "storagemigration.k8s.io",
  "metrics.k8s.io",
]);

export interface Section {
  title: string;
  items: ResourceInfo[];
  /** Custom resources are grouped by API group. */
  groups?: { group: string; items: ResourceInfo[] }[];
}

export function buildSections(resources: ResourceInfo[]): Section[] {
  const byKey = new Map(resources.map((r) => [`${r.group}/${r.kind}`, r]));
  const used = new Set<string>();
  const sections: Section[] = [];
  for (const [title, entries] of CATEGORIES) {
    const items: ResourceInfo[] = [];
    for (const [g, k] of entries) {
      const r = byKey.get(`${g}/${k}`);
      if (r) {
        items.push(r);
        used.add(`${g}/${k}`);
      }
    }
    if (items.length) sections.push({ title, items });
  }
  const rest = resources.filter((r) => !used.has(`${r.group}/${r.kind}`));
  const other = rest.filter((r) => BUILTIN_GROUPS.has(r.group));
  const custom = rest.filter((r) => !BUILTIN_GROUPS.has(r.group));

  if (custom.length) {
    const groups = new Map<string, ResourceInfo[]>();
    for (const r of custom) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group)!.push(r);
    }
    sections.push({
      title: "Custom Resources",
      items: custom,
      groups: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, items]) => ({ group, items: items.sort((a, b) => a.kind.localeCompare(b.kind)) })),
    });
  }
  if (other.length) {
    sections.push({ title: "Other", items: other.sort((a, b) => a.kind.localeCompare(b.kind)) });
  }
  return sections;
}

export function sameResource(a?: ResourceInfo | null, b?: ResourceInfo | null) {
  return !!a && !!b && a.group === b.group && a.kind === b.kind;
}

export function decodeBase64(s: string): string {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return s;
  }
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/** metav1.LabelSelector -> label selector string ("app=web,tier in (a,b)"). */
export function selectorString(sel?: LabelSelector | null): string {
  if (!sel) return "";
  const parts = Object.entries(sel.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    const vals = (e.values ?? []).join(",");
    if (e.operator === "In") parts.push(`${e.key} in (${vals})`);
    else if (e.operator === "NotIn") parts.push(`${e.key} notin (${vals})`);
    else if (e.operator === "Exists") parts.push(e.key);
    else if (e.operator === "DoesNotExist") parts.push(`!${e.key}`);
  }
  return parts.join(",");
}

/** Cores -> "250m" / "1.25". */
export function formatCpu(cores: number): string {
  if (!Number.isFinite(cores)) return "";
  if (cores === 0) return "0";
  if (cores < 1) return `${Math.max(1, Math.round(cores * 1000))}m`;
  return cores < 10 ? cores.toFixed(2).replace(/\.?0+$/, "") : cores.toFixed(1).replace(/\.0$/, "");
}

/** Bytes -> "128Mi" / "1.5Gi" (binary units, like kubectl). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  const units = ["", "Ki", "Mi", "Gi", "Ti", "Pi"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
  return `${s}${units[i]}`;
}

export function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "";
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}%`;
}

/** Kubernetes quantity ("250m", "128Mi", "1e3") -> number (cores / bytes). */
export function parseQuantity(q: string | number | undefined | null): number {
  if (q === undefined || q === null) return 0;
  if (typeof q === "number") return q;
  const m = /^([+-]?[0-9.]+)(?:[eE]([+-]?[0-9]+))?([a-zA-Z]*)$/.exec(q.trim());
  if (!m) return 0;
  let n = Number(m[1]);
  if (m[2]) n *= 10 ** Number(m[2]);
  const mult: Record<string, number> = {
    "": 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  };
  return n * (mult[m[3]] ?? 1);
}

/** A tab's namespace selection: "" = none (nothing shown), "*" = all, otherwise a comma-separated list. */
export const ALL_NAMESPACES = "*";

export function nsSelection(v: string | null | undefined): { none: boolean; all: boolean; list: string[] } {
  if (v === ALL_NAMESPACES) return { none: false, all: true, list: [] };
  const list = (v ?? "").split(",").filter((x) => x && x !== ALL_NAMESPACES);
  return { none: list.length === 0, all: false, list };
}

/** For APIs that take one namespace or "everything": the single namespace, else null (all). */
export function nsForApi(v: string | null | undefined): string | null {
  const s = nsSelection(v);
  return s.list.length === 1 ? s.list[0] : null;
}
