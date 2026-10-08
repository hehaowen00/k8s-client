import { useEffect, useState } from "react";
import { api, type PrometheusTarget, type Usage } from "./api";
import { pollWhileVisible } from "./util";

// ---------------------------------------------------------------------------
// Live usage tables (metrics-server)
// ---------------------------------------------------------------------------

/** metrics-server refreshes every 15–60s; polling faster only re-fetches the same numbers. */
const METRICS_EVERY = 60_000;
/** Views polling the same scope share one request within this window. */
const USAGE_TTL = 30_000;
const usageCache = new Map<string, { at: number; p: Promise<Usage[]> }>();

function freshUsage(key: string): Promise<Usage[]> | undefined {
  const hit = usageCache.get(key);
  return hit && Date.now() - hit.at < USAGE_TTL ? hit.p : undefined;
}

function cachedUsage(key: string, fetch: () => Promise<Usage[]>): Promise<Usage[]> {
  const hit = freshUsage(key);
  if (hit) return hit;
  const p = fetch();
  p.catch(() => usageCache.delete(key));
  usageCache.set(key, { at: Date.now(), p });
  return p;
}

const podKey = (context: string, namespace: string | null, selector = "", name = "") =>
  `${context}|pods|${namespace ?? ""}|${selector}|${name}`;

export function podUsage(context: string, namespace: string | null, selector?: string | null): Promise<Usage[]> {
  return cachedUsage(podKey(context, namespace, selector ?? ""), () => api.podMetrics(context, namespace, selector));
}

/** One pod's usage, reusing a fresh namespace-wide fetch when there is one. */
function onePodUsage(context: string, namespace: string, pod: string): Promise<Usage | undefined> {
  const wide = freshUsage(podKey(context, namespace)) ?? freshUsage(podKey(context, null));
  if (wide) return wide.then((l) => l.find((u) => u.name === pod && (!u.namespace || u.namespace === namespace)));
  return cachedUsage(podKey(context, namespace, "", pod), () => api.podMetrics(context, namespace, null, pod)).then(
    (l) => l[0],
  );
}

export function nodeUsage(context: string): Promise<Usage[]> {
  return cachedUsage(`${context}|nodes|`, () => api.nodeMetrics(context));
}

function oneNodeUsage(context: string, node: string): Promise<Usage | undefined> {
  const wide = freshUsage(`${context}|nodes|`);
  if (wide) return wide.then((l) => l.find((u) => u.name === node));
  return cachedUsage(`${context}|nodes|${node}`, () => api.nodeMetrics(context, node)).then((l) => l[0]);
}

/**
 * Poll metrics-server usage keyed by "namespace/name" (or "name" for nodes). null = unavailable.
 * `namespaces` null = all namespaces; otherwise only those are fetched.
 */
export function useUsageMap(
  context: string,
  kind: "pods" | "nodes" | null,
  namespaces: string[] | null,
  active: boolean,
): Map<string, Usage> | null {
  const [map, setMap] = useState<Map<string, Usage> | null>(null);
  const nsKey = namespaces?.join(",") ?? null;
  useEffect(() => {
    if (!kind || !active) return;
    let cancelled = false;
    const scopes = nsKey === null ? [null] : nsKey ? nsKey.split(",") : [];
    const load = () =>
      (kind === "pods"
        ? Promise.all(scopes.map((ns) => podUsage(context, ns))).then((l) => l.flat())
        : nodeUsage(context)
      ).then(
        (list) => {
          if (cancelled) return;
          setMap(new Map(list.map((u) => [u.namespace ? `${u.namespace}/${u.name}` : u.name, u])));
        },
        () => !cancelled && setMap(null),
      );
    load();
    const stop = pollWhileVisible(load, METRICS_EVERY);
    return () => {
      cancelled = true;
      stop();
    };
  }, [context, kind, nsKey, active]);
  return map;
}

// ---------------------------------------------------------------------------
// History: Prometheus when present, otherwise sampled from metrics-server
// ---------------------------------------------------------------------------

export type Point = [number, number]; // [unix seconds, value]
export interface Series {
  cpu: Point[];
  memory: Point[];
  source: "prometheus" | "metrics-server" | null;
  /** Seconds between samples. */
  step: number;
  /** Unix seconds the window ends at. */
  end: number;
  error?: string;
}

export const SPANS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
  { label: "15m", seconds: 900 },
  { label: "1hr", seconds: 3600 },
  { label: "3hr", seconds: 3 * 3600 },
  { label: "6hr", seconds: 6 * 3600 },
  { label: "12hr", seconds: 12 * 3600 },
];
export const DEFAULT_SPAN = 3600;
export const MAX_BARS = 60;

const promCache = new Map<string, Promise<PrometheusTarget | null>>();
export function detectPrometheus(context: string, refresh = false) {
  if (refresh || !promCache.has(context)) {
    const p = api.prometheusDetect(context, refresh).catch(() => null);
    promCache.set(context, p);
  }
  return promCache.get(context)!;
}

/** Samples collected while the app is open, so fallback charts survive tab switches. */
const samples = new Map<string, { cpu: Point[]; memory: Point[] }>();
const SAMPLE_EVERY = METRICS_EVERY;
const KEEP_SECONDS = SPANS[SPANS.length - 1].seconds;

export interface MetricSpec {
  /** Stable id for the sample buffer, e.g. "ctx|pod|ns/name". */
  key: string;
  /** PromQL for [cpu cores, memory bytes]. */
  prometheus: [string, string];
  /** Current usage from metrics-server (summed), used when there's no Prometheus. */
  sample: () => Promise<{ cpu: number; memory: number } | null>;
}

function since(points: Point[], t: number): Point[] {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return points.slice(lo);
}

export function useMetricSeries(context: string, spec: MetricSpec | null, active: boolean, span: number): Series {
  const [series, setSeries] = useState<Series>({ cpu: [], memory: [], source: null, step: 0, end: 0 });
  const key = spec?.key;
  useEffect(() => {
    if (!spec || !active) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    (async () => {
      const prom = await detectPrometheus(context);
      if (cancelled) return;
      if (prom) {
        const step = Math.max(5, span / MAX_BARS);
        // After the first load only points since the last one are fetched (the last is re-fetched
        // since it may have been incomplete), then the window is trimmed.
        let have: { cpu: Point[]; memory: Point[]; end: number } | null = null;
        const load = async () => {
          const end = Math.floor(Date.now() / 1000 / step) * step;
          const start = end - span + step;
          const from = have && have.end >= start ? have.end : start;
          const merge = (old: Point[] | undefined, add: Point[]) => [
            ...(old ?? []).filter((p) => p[0] >= start && p[0] < from),
            ...add,
          ];
          try {
            const [cpu, memory] = await api.prometheusRange(context, spec.prometheus, from, end, step);
            if (cancelled) return;
            have = { cpu: merge(have?.cpu, cpu), memory: merge(have?.memory, memory), end };
            setSeries({ cpu: have.cpu, memory: have.memory, source: "prometheus", step, end });
          } catch (e) {
            if (!cancelled) setSeries((s) => ({ ...s, source: "prometheus", step, end, error: String(e) }));
          }
        };
        load();
        stop = pollWhileVisible(load, METRICS_EVERY);
        return;
      }
      const buf = samples.get(spec.key) ?? { cpu: [], memory: [] };
      samples.set(spec.key, buf);
      const step = SAMPLE_EVERY / 1000;
      const emit = (end: number) => {
        const start = end - span;
        setSeries({
          cpu: since(buf.cpu, start),
          memory: since(buf.memory, start),
          source: buf.cpu.length ? "metrics-server" : null,
          step,
          end,
        });
      };
      const sample = async () => {
        const u = await spec.sample().catch(() => null);
        if (cancelled) return;
        const t = Date.now() / 1000;
        if (u) {
          buf.cpu.push([t, u.cpu]);
          buf.memory.push([t, u.memory]);
          const drop = buf.cpu.findIndex((p) => p[0] >= t - KEEP_SECONDS);
          if (drop > 0) {
            buf.cpu.splice(0, drop);
            buf.memory.splice(0, drop);
          }
        }
        emit(t);
      };
      const last = buf.cpu[buf.cpu.length - 1];
      if (last && Date.now() / 1000 - last[0] < step) emit(Date.now() / 1000);
      else sample();
      stop = pollWhileVisible(sample, SAMPLE_EVERY);
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, key, active, span]);
  return series;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const podFilter = (ns: string, pods: string) => `namespace="${esc(ns)}",pod=~"${pods}",container!="",container!="POD"`;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&");

export function podSpec(context: string, namespace: string, pod: string): MetricSpec {
  const f = podFilter(namespace, reEsc(pod));
  return {
    key: `${context}|pod|${namespace}/${pod}`,
    prometheus: [
      `sum(rate(container_cpu_usage_seconds_total{${f}}[2m]))`,
      `sum(container_memory_working_set_bytes{${f}})`,
    ],
    sample: async () => {
      const u = await onePodUsage(context, namespace, pod);
      return u ? { cpu: u.cpu, memory: u.memory } : null;
    },
  };
}

/** Pod-name pattern each controller generates, so "web" doesn't also match "web-api" pods. */
function podNamePattern(kind: string, name: string): string {
  const n = reEsc(name);
  switch (kind) {
    case "Deployment":
      return `${n}-[a-z0-9]{6,10}-[a-z0-9]{5}`;
    case "StatefulSet":
      return `${n}-[0-9]+`;
    case "ReplicaSet":
    case "DaemonSet":
    case "Job":
      return `${n}-[a-z0-9]{5}`;
    default:
      return `${n}-.*`;
  }
}

/** All pods of a workload summed (metrics-server via selector; Prometheus via pod-name pattern). */
export function workloadSpec(
  context: string,
  namespace: string,
  kind: string,
  name: string,
  selector: string,
): MetricSpec {
  const re = podNamePattern(kind, name);
  const f = podFilter(namespace, re);
  return {
    key: `${context}|${kind}|${namespace}/${name}`,
    prometheus: [
      `sum(rate(container_cpu_usage_seconds_total{${f}}[2m]))`,
      `sum(container_memory_working_set_bytes{${f}})`,
    ],
    sample: async () => {
      const list = await podUsage(context, namespace, selector);
      if (!list.length) return null;
      return { cpu: list.reduce((a, u) => a + u.cpu, 0), memory: list.reduce((a, u) => a + u.memory, 0) };
    },
  };
}

export function nodeSpec(context: string, node: string): MetricSpec {
  const n = esc(node);
  const inst = `instance=~"${reEsc(node)}(:[0-9]+)?"`;
  return {
    key: `${context}|node|${node}`,
    prometheus: [
      `sum(rate(container_cpu_usage_seconds_total{id="/",node="${n}"}[2m])) or sum(rate(container_cpu_usage_seconds_total{id="/",${inst}}[2m]))`,
      `sum(container_memory_working_set_bytes{id="/",node="${n}"}) or sum(container_memory_working_set_bytes{id="/",${inst}})`,
    ],
    sample: async () => {
      const u = await oneNodeUsage(context, node);
      return u ? { cpu: u.cpu, memory: u.memory } : null;
    },
  };
}

export function clusterSpec(context: string): MetricSpec {
  return {
    key: `${context}|cluster`,
    prometheus: [
      `sum(rate(container_cpu_usage_seconds_total{id="/"}[2m]))`,
      `sum(container_memory_working_set_bytes{id="/"})`,
    ],
    sample: async () => {
      const list = await nodeUsage(context);
      if (!list.length) return null;
      return { cpu: list.reduce((a, u) => a + u.cpu, 0), memory: list.reduce((a, u) => a + u.memory, 0) };
    },
  };
}
