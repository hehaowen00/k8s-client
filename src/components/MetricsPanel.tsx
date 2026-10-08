import { useState } from "react";
import { DEFAULT_SPAN, SPANS, useMetricSeries, type MetricSpec } from "../metrics";
import { formatBytes, formatCpu } from "../util";
import { BarChart, type RefLine } from "./Chart";
import { S } from "../strings";

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
    return <div className="muted small metrics-note">{S.metrics.unavailable}</div>;
  }
  const collecting = series.source === "metrics-server" && series.cpu.length < 2;
  const empty = collecting ? S.metrics.collecting : S.common.noData;
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
          title={S.metrics.cpu}
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
          title={S.metrics.memory}
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
        {series.source === "prometheus" ? S.metrics.fromPrometheus : S.metrics.fromMetricsServer}
        {series.error && <span className="tone-warn"> · {series.error}</span>}
      </div>
    </>
  );
}
