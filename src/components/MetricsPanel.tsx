import { useState } from "react";
import { DEFAULT_SPAN, SPANS, useMetricSeries, type MetricSpec } from "../metrics";
import { formatBytes, formatCpu } from "../util";
import { BarChart, type RefLine } from "./Chart";

let lastSpan = DEFAULT_SPAN;

export function MetricsPanel({
  context,
  spec,
  active,
  cpuRefs,
  memoryRefs,
}: {
  context: string;
  spec: MetricSpec | null;
  active: boolean;
  cpuRefs?: RefLine[];
  memoryRefs?: RefLine[];
}) {
  const [span, setSpan] = useState(lastSpan);
  const series = useMetricSeries(context, spec, active, span);
  if (!spec) return null;
  if (series.source === null && !series.cpu.length) {
    return (
      <div className="muted small metrics-note">
        Metrics unavailable — install metrics-server (live usage) or Prometheus (history) to see charts.
      </div>
    );
  }
  const collecting = series.source === "metrics-server" && series.cpu.length < 2;
  const empty = collecting ? "Collecting samples (every 10s)…" : "No data";
  return (
    <>
      <div className="segmented chart-spans">
        {SPANS.map((s) => (
          <button
            key={s.seconds}
            className={span === s.seconds ? "active" : ""}
            onClick={() => {
              lastSpan = s.seconds;
              setSpan(s.seconds);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="chart-row">
        <BarChart
          title="CPU"
          points={series.cpu}
          format={formatCpu}
          refs={cpuRefs}
          emptyText={empty}
          minMax={0.01}
          span={span}
          step={series.step}
          end={series.end}
        />
        <BarChart
          title="Memory"
          points={series.memory}
          format={formatBytes}
          refs={memoryRefs}
          emptyText={empty}
          bytes
          minMax={8 * 1024 * 1024}
          span={span}
          step={series.step}
          end={series.end}
        />
      </div>
      <div className="muted small metrics-note">
        {series.source === "prometheus"
          ? "From Prometheus"
          : "Sampled from metrics-server while Kube Portal is open (install Prometheus for history)"}
        {series.error && <span className="tone-warn"> · {series.error}</span>}
      </div>
    </>
  );
}
