import { useEffect, useMemo, useRef, useState } from "react";
import type { Point } from "../metrics";

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

const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function LineChart({ title, points, format, refs = [], height = 150, emptyText, bytes, minMax = 0 }: Props & { bytes?: boolean }) {
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

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const innerH = height - M.top - M.bottom;
    const t0 = points.length ? points[0][0] : Date.now() / 1000 - 3600;
    const t1 = points.length ? Math.max(points[points.length - 1][0], t0 + 60) : Date.now() / 1000;
    const vmax = Math.max(minMax, ...points.map((p) => p[1]), ...refs.map((r) => r.value));
    const ticks = bytes ? niceByteTicks(vmax) : niceTicks(vmax);
    const ymax = ticks[ticks.length - 1] || 1;
    const x = (t: number) => M.left + ((t - t0) / (t1 - t0)) * innerW;
    const y = (v: number) => M.top + innerH - (v / ymax) * innerH;
    // Time ticks on round 10/15/30-minute boundaries depending on span.
    const span = t1 - t0;
    const tstep = span > 4 * 3600 ? 3600 : span > 90 * 60 ? 1800 : span > 30 * 60 ? 900 : span > 10 * 60 ? 300 : 60;
    const xticks: number[] = [];
    for (let t = Math.ceil(t0 / tstep) * tstep; t <= t1; t += tstep) xticks.push(t);
    return { innerW, innerH, x, y, ticks, xticks, t0, t1 };
  }, [points, refs, width, height, bytes, minMax]);

  const line = points.map((p, i) => `${i ? "L" : "M"}${geo.x(p[0]).toFixed(1)},${geo.y(p[1]).toFixed(1)}`).join("");
  const area = points.length
    ? `${line}L${geo.x(points[points.length - 1][0]).toFixed(1)},${geo.y(0)}L${geo.x(points[0][0]).toFixed(1)},${geo.y(0)}Z`
    : "";
  const latest = points.length ? points[points.length - 1][1] : null;
  const hp = hover !== null ? points[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // Snap to the nearest sample (points are time-ordered).
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(geo.x(points[i][0]) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const tipLeft = hp ? Math.min(Math.max(geo.x(hp[0]) + 10, M.left), width - 150) : 0;

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
          aria-label={`${title}: ${latest !== null ? `latest ${format(latest)}` : "no data"}`}
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
              {hhmm(t)}
            </text>
          ))}
          {refs.map((r) => (
            <g key={r.label}>
              <line className="chart-ref" x1={M.left} x2={M.left + geo.innerW} y1={geo.y(r.value)} y2={geo.y(r.value)} />
              <text className="chart-ref-label" x={M.left + geo.innerW - 2} y={geo.y(r.value) - 4} textAnchor="end">
                {r.label} {format(r.value)}
              </text>
            </g>
          ))}
          {points.length > 0 && (
            <>
              <path className="chart-area" d={area} />
              <path className="chart-line" d={line} />
            </>
          )}
          {points.length > 0 && !hp && (
            // End marker: the latest value (also makes a single sample visible).
            <circle
              className="chart-dot"
              cx={geo.x(points[points.length - 1][0])}
              cy={geo.y(points[points.length - 1][1])}
              r={4}
            />
          )}
          {hp && (
            <>
              <line className="chart-crosshair" x1={geo.x(hp[0])} x2={geo.x(hp[0])} y1={M.top} y2={M.top + geo.innerH} />
              <circle className="chart-dot" cx={geo.x(hp[0])} cy={geo.y(hp[1])} r={4} />
            </>
          )}
          {/* Full-plot hit target so the crosshair tracks anywhere, not just on the line. */}
          <rect x={M.left} y={M.top} width={geo.innerW} height={geo.innerH} fill="transparent" />
        </svg>
        {!points.length && <div className="chart-empty">{emptyText ?? "No data"}</div>}
        {hp && (
          <div className="chart-tip" style={{ left: tipLeft, top: 6 }}>
            <div className="muted small">{new Date(hp[0] * 1000).toLocaleTimeString()}</div>
            <div>
              <span className="chart-swatch" /> {title} <strong>{format(hp[1])}</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal meter: fill = used / total, severity colouring past thresholds. */
export function Meter({ label, used, total, format, extra }: { label: string; used: number; total: number; format: (v: number) => string; extra?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const level = pct >= 90 ? "critical" : pct >= 75 ? "warning" : "normal";
  return (
    <div className="meter" title={`${label}: ${format(used)} of ${format(total)}`}>
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
