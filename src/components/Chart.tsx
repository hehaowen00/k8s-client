import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_BARS, type Point } from "../metrics";
import { S } from "../strings";

export interface RefLine {
  value: number;
  label: string;
}

interface Props {
  title: string;
  points: Point[];
  format: (v: number) => string;
  refs?: RefLine[];
  height?: number;
  /** Shown when there are no points yet. */
  emptyText?: string;
  /** Smallest y-axis top, so an idle series doesn't get a meaningless 0–1 scale. */
  minMax?: number;
}

const M = { top: 10, right: 12, bottom: 22, left: 48 };

/** Clean ticks from 0 to >= max ("nice numbers"). */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** Binary-unit tick steps for byte axes so labels read 256Mi, 512Mi… */
function niceByteTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 1024 ** Math.floor(Math.log(raw) / Math.log(1024));
  const step = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const TIME_STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];

function clock(t: number, seconds: boolean) {
  return new Date(t * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hourCycle: "h23",
  });
}

interface Bin {
  start: number;
  end: number;
  value: number;
}

/** Average samples into fixed-width bins ending at `end`, so each bar covers an equal slice of the span. */
function binPoints(points: Point[], end: number, span: number, step: number): { bins: (Bin | null)[]; width: number } {
  const n = Math.max(1, Math.min(MAX_BARS, Math.round(span / Math.max(step, 1))));
  const width = span / n;
  const t0 = end - span;
  const sums = new Float64Array(n);
  const counts = new Uint32Array(n);
  for (const [t, v] of points) {
    const i = Math.ceil((t - t0) / width) - 1;
    if (i < 0 || i >= n) continue;
    sums[i] += v;
    counts[i]++;
  }
  const bins: (Bin | null)[] = [];
  for (let i = 0; i < n; i++) {
    bins.push(counts[i] ? { start: t0 + i * width, end: t0 + (i + 1) * width, value: sums[i] / counts[i] } : null);
  }
  return { bins, width };
}

export function BarChart({
  title,
  points,
  format,
  refs = [],
  height = 150,
  emptyText,
  bytes,
  minMax = 0,
  span,
  step,
  end,
}: Props & { bytes?: boolean; span: number; step: number; end: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t1 = end || Date.now() / 1000;
  const { bins, width: binW } = useMemo(() => binPoints(points, t1, span, step), [points, t1, span, step]);

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const t0 = t1 - span;
    let vmax = minMax;
    for (const b of bins) if (b && b.value > vmax) vmax = b.value;
    for (const r of refs) if (r.value > vmax) vmax = r.value;
    const ticks = bytes ? niceByteTicks(vmax) : niceTicks(vmax);
    const ymax = ticks[ticks.length - 1] || 1;
    const x = (t: number) => M.left + ((t - t0) / span) * innerW;
    const y = (v: number) => M.top + innerH - (v / ymax) * innerH;
    const maxLabels = Math.max(2, Math.floor(innerW / 64));
    const tstep = TIME_STEPS.find((s) => span / s <= Math.min(6, maxLabels)) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const xticks: number[] = [];
    for (let t = Math.ceil(t0 / tstep) * tstep; t <= t1; t += tstep) xticks.push(t);
    const barW = innerW / bins.length;
    const gap = barW > 4 ? Math.min(2, barW * 0.2) : 0;
    return { innerW, innerH, x, y, ticks, xticks, tstep, barW, gap };
  }, [bins, refs, width, height, bytes, minMax, span, t1]);

  const latest = points.length ? points[points.length - 1][1] : null;
  const hb = hover !== null ? bins[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.left) / geo.barW);
    setHover(i >= 0 && i < bins.length && bins[i] ? i : null);
  };

  const tipLeft = hb ? Math.min(Math.max(geo.x(hb.end) + 6, M.left), width - 170) : 0;
  const showSeconds = geo.tstep < 60 || binW < 60;

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {latest !== null && <span className="chart-value">{format(latest)}</span>}
      </div>
      <div className="chart-plot" style={{ height }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={S.chart.aria(title, latest !== null ? format(latest) : null)}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {geo.ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={M.left} x2={M.left + geo.innerW} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="chart-tick" x={M.left - 6} y={geo.y(v) + 3.5} textAnchor="end">
                {format(v)}
              </text>
            </g>
          ))}
          {geo.xticks.map((t) => (
            <text key={t} className="chart-tick" x={geo.x(t)} y={height - 6} textAnchor="middle">
              {clock(t, geo.tstep < 60)}
            </text>
          ))}
          {bins.map((b, i) => {
            if (!b) return null;
            const top = geo.y(b.value);
            return (
              <rect
                key={i}
                className={i === hover ? "chart-bar active" : "chart-bar"}
                x={M.left + i * geo.barW + geo.gap / 2}
                y={top}
                width={Math.max(1, geo.barW - geo.gap)}
                height={Math.max(0, geo.y(0) - top)}
              />
            );
          })}
          {refs.map((r) => (
            <g key={r.label}>
              <line
                className="chart-ref"
                x1={M.left}
                x2={M.left + geo.innerW}
                y1={geo.y(r.value)}
                y2={geo.y(r.value)}
              />
              <text className="chart-ref-label" x={M.left + geo.innerW - 2} y={geo.y(r.value) - 4} textAnchor="end">
                {r.label} {format(r.value)}
              </text>
            </g>
          ))}
          <rect x={M.left} y={M.top} width={geo.innerW} height={geo.innerH} fill="transparent" />
        </svg>
        {!points.length && <div className="chart-empty">{emptyText ?? S.common.noData}</div>}
        {hb && (
          <div className="chart-tip" style={{ left: tipLeft, top: 6 }}>
            <div className="muted small">
              {clock(hb.start, showSeconds)} – {clock(hb.end, showSeconds)}
            </div>
            <div>
              <span className="chart-swatch" /> {title} <strong>{format(hb.value)}</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal meter: fill = used / total, severity colouring past thresholds. */
export function Meter({
  label,
  used,
  total,
  format,
  extra,
}: {
  label: string;
  used: number;
  total: number;
  format: (v: number) => string;
  extra?: string;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const level = pct >= 90 ? "critical" : pct >= 75 ? "warning" : "normal";
  return (
    <div className="meter" title={S.chart.meterTitle(label, format(used), format(total))}>
      <div className="meter-head">
        <span>{label}</span>
        <span className="muted">
          {format(used)} / {format(total)} · {Math.round(pct)}%{extra ? ` · ${extra}` : ""}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill meter-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
