import { useEffect, useState } from "react";
import { api, type PrometheusTarget, type Usage } from "./api";

// ---------------------------------------------------------------------------
// Live usage tables (metrics-server)
// ---------------------------------------------------------------------------

/** Poll metrics-server usage keyed by "namespace/name" (or "name" for nodes). null = unavailable. */
export function useUsageMap(
  context: string,
  kind: "pods" | "nodes" | null,
  namespace: string | null,
  active: boolean,
): Map<string, Usage> | null {
  const [map, setMap] = useState<Map<string, Usage> | null>(null);
  useEffect(() => {
    if (!kind || !active) return;
    let cancelled = false;
    const load = () =>
      (kind === "pods" ? api.podMetrics(context, namespace) : api.nodeMetrics(context)).then(
        (list) => {
          if (cancelled) return;
          setMap(new Map(list.map((u) => [u.namespace ? `${u.namespace}/${u.name}` : u.name, u])));
        },
        () => !cancelled && setMap(null),
      );
    load();
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [context, kind, namespace, active]);
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
  error?: string;
}

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
const SAMPLE_EVERY = 10_000;
const KEEP_SECONDS = 3600;

export interface MetricSpec {
  /** Stable id for the sample buffer, e.g. "ctx|pod|ns/name". */
  key: string;
  /** PromQL for [cpu cores, memory bytes]. */
  prometheus: [string, string];
  /** Current usage from metrics-server (summed), used when there's no Prometheus. */
  sample: () => Promise<{ cpu: number; memory: number } | null>;
}

export const WINDOW_SECONDS = 3600;

export function useMetricSeries(context: string, spec: MetricSpec | null, active: boolean): Series {
  const [series, setSeries] = useState<Series>({ cpu: [], memory: [], source: null });
  const key = spec?.key;
  useEffect(() => {
    if (!spec || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const prom = await detectPrometheus(context);
      if (cancelled) return;
      if (prom) {
        const load = async () => {
          const end = Date.now() / 1000;
          const start = end - WINDOW_SECONDS;
          try {
            const [cpu, memory] = await api.prometheusRange(context, spec.prometheus, start, end, 60);
            if (!cancelled) setSeries({ cpu, memory, source: "prometheus" });
          } catch (e) {
            if (!cancelled) setSeries((s) => ({ ...s, source: "prometheus", error: String(e) }));
          }
        };
        load();
        timer = setInterval(load, 30_000);
        return;
      }
      const buf = samples.get(spec.key) ?? { cpu: [], memory: [] };
      samples.set(spec.key, buf);
      const sample = async () => {
        const u = await spec.sample().catch(() => null);
        if (cancelled) return;
        if (!u) {
          setSeries({ cpu: buf.cpu, memory: buf.memory, source: buf.cpu.length ? "metrics-server" : null });
          return;
        }
        const t = Date.now() / 1000;
        buf.cpu.push([t, u.cpu]);
        buf.memory.push([t, u.memory]);
        while (buf.cpu.length && buf.cpu[0][0] < t - KEEP_SECONDS) {
          buf.cpu.shift();
          buf.memory.shift();
        }
        setSeries({ cpu: [...buf.cpu], memory: [...buf.memory], source: "metrics-server" });
      };
      sample();
      timer = setInterval(sample, SAMPLE_EVERY);
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, key, active]);
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
      const list = await api.podMetrics(context, namespace);
      const u = list.find((x) => x.name === pod);
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
export function workloadSpec(context: string, namespace: string, kind: string, name: string, selector: string): MetricSpec {
  const re = podNamePattern(kind, name);
  const f = podFilter(namespace, re);
  return {
    key: `${context}|${kind}|${namespace}/${name}`,
    prometheus: [
      `sum(rate(container_cpu_usage_seconds_total{${f}}[2m]))`,
      `sum(container_memory_working_set_bytes{${f}})`,
    ],
    sample: async () => {
      const list = await api.podMetrics(context, namespace, selector);
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
      const list = await api.nodeMetrics(context);
      const u = list.find((x) => x.name === node);
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
      const list = await api.nodeMetrics(context);
      if (!list.length) return null;
      return { cpu: list.reduce((a, u) => a + u.cpu, 0), memory: list.reduce((a, u) => a + u.memory, 0) };
    },
  };
}
