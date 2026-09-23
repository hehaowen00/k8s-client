import { useMetricSeries, type MetricSpec } from "../metrics";
import { formatBytes, formatCpu } from "../util";
import { LineChart, type RefLine } from "./Chart";

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
  const series = useMetricSeries(context, spec, active);
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
      <div className="chart-row">
        <LineChart title="CPU" points={series.cpu} format={formatCpu} refs={cpuRefs} emptyText={empty} minMax={0.01} />
        <LineChart title="Memory" points={series.memory} format={formatBytes} refs={memoryRefs} emptyText={empty} bytes minMax={8 * 1024 * 1024} />
      </div>
      <div className="muted small metrics-note">
        {series.source === "prometheus"
          ? "Last hour from Prometheus"
          : "Sampled from metrics-server while Kube Portal is open (install Prometheus for history)"}
        {series.error && <span className="tone-warn"> · {series.error}</span>}
      </div>
    </>
  );
}
