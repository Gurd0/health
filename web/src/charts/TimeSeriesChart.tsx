// One metric over the course of a run (heart rate, pace, elevation, cadence…), with optional
// zone bands and average line. All charts on the run page share the hovered sample index.
import { useMemo, type CSSProperties } from "react";
import { clamp, fdur, fx, niceTicks, quantile } from "../lib/format";
import type { Series } from "../types";
import { GridLine, HoverLine, scrub } from "./svg";

export interface TsSpec {
  title: string;
  vals: Series; // one value per sample
  h: number; // plot height
  lo?: number; // fixed axis range; otherwise from the 1st-99th percentile
  hi?: number;
  nt?: number; // about how many gridlines
  color: string;
  fmt: (v: number) => string;
  tick?: (q: number) => string;
  invert?: boolean; // smaller is better (pace): draw it higher
  area?: boolean;
  bands?: { from: number; to: number; color: string; label: string }[];
  avg?: number | null;
  avgLabel?: boolean;
  thin?: boolean;
  xlabels?: boolean; // elapsed-time labels under the chart
}

function layout(spec: TsSpec, n: number, step: number, W: number, phone: boolean) {
  const L = phone ? 34 : 44, R = W - (phone ? 6 : 10), top = 4, H = spec.h;
  const X = (i: number) => L + (i / (n - 1)) * (R - L);
  const vals = spec.vals;
  let lo = spec.lo, hi = spec.hi;
  if (lo == null || hi == null) {
    const q1 = quantile(vals, 0.01), q9 = quantile(vals, 0.99), pad = (q9 - q1) * 0.15 || 1;
    lo ??= q1 - pad;
    hi ??= q9 + pad;
  }
  const tk = niceTicks(lo, hi, spec.nt || 2);
  if (spec.lo == null) lo = tk.lo;
  if (spec.hi == null) hi = tk.hi;
  const yLo = lo, yHi = hi;
  const Y = (v: number) => {
    const f = (clamp(v, yLo, yHi) - yLo) / (yHi - yLo || 1);
    return spec.invert ? top + f * H : top + H - f * H;
  };

  let line = "", pen = false, firstX: number | null = null, lastX = 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null) { pen = false; continue; }
    line += (pen ? "L" : "M") + fx(X(i)) + " " + fx(Y(v));
    pen = true;
    firstX ??= X(i);
    lastX = X(i);
  }
  const area = spec.area && firstX != null ? `${line}L${fx(lastX)} ${top + H}L${fx(firstX)} ${top + H}Z` : "";
  const bands = (spec.bands || [])
    .map(b => { const y1 = Y(Math.min(b.to, yHi)), y2 = Y(Math.max(b.from, yLo)); return { ...b, y: Math.min(y1, y2), h: Math.abs(y2 - y1) }; })
    .filter(b => b.h > 0.5);
  const grid = tk.ticks.filter(q => q >= yLo - 1e-9 && q <= yHi + 1e-9);

  const xl: { x: number; label: string; anchor: "start" | "middle" }[] = [];
  if (spec.xlabels) {
    const dur = (n - 1) * step, every = (phone ? 15 : 10) * 60;
    for (let s = 0; s <= dur; s += every) xl.push({ x: X(Math.round(s / step)), label: fdur(s), anchor: s === 0 ? "start" : "middle" });
  }
  return { L, R, top, H, X, Y, line, area, bands, grid, xl, vbH: top + H + (spec.xlabels ? 22 : 6) };
}

interface Props {
  spec: TsSpec;
  n: number;
  step: number; // seconds between samples
  W: number;
  phone: boolean;
  hi: number; // hovered sample
  onHi: (i: number) => void;
  style?: CSSProperties;
}

export function TimeSeriesChart({ spec, n, step, W, phone, hi, onHi, style }: Props) {
  const g = useMemo(() => layout(spec, n, step, W, phone), [spec, n, step, W, phone]);
  const v = spec.vals[hi], cx = g.X(hi);
  let tip = null;
  if (v != null) {
    const dy = g.Y(v), text = spec.fmt(v), w = Math.round(text.length * 7 + 16);
    const bx = cx + 8 + w <= W ? cx + 8 : cx - 8 - w, by = clamp(dy - 30, 0, g.top + g.H - 22);
    tip = (
      <>
        <circle cx={fx(cx)} cy={fx(dy)} r={spec.thin ? 3.5 : 4} style={{ fill: spec.color, stroke: "var(--surface)", strokeWidth: 2 }} />
        <rect x={fx(bx)} y={fx(by)} width={w} height={22} rx={5} style={{ fill: "var(--tipbg)", stroke: "var(--border)", strokeWidth: 1 }} />
        <text x={fx(bx + 8)} y={fx(by + 15)} style={{ fontSize: 12, fontWeight: 600, fill: "var(--text)" }}>{text}</text>
      </>
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${fx(g.vbH)}`} role="img"
      aria-label={spec.title + " over the run. Use the arrow keys to move through time; hold Shift to jump a minute."}
      style={style || { display: "block", width: "100%", height: "auto", marginTop: 10, overflow: "visible" }}
      {...scrub({ W, n, index: hi, toIndex: x => clamp(Math.round(((x - g.L) / (g.R - g.L)) * (n - 1)), 0, n - 1), onIndex: onHi, bigStep: 12 })}>
      {g.bands.map(b => (
        <g key={b.label}>
          <rect x={g.L} y={fx(b.y)} width={fx(g.R - g.L)} height={fx(b.h)} className="zone-band" style={{ fill: b.color }} />
          <text x={fx(g.R - 4)} y={fx(b.y + 11)} style={{ fontSize: 10, fill: "var(--text2)", textAnchor: "end" }}>{b.label}</text>
        </g>
      ))}
      {g.grid.map(q => <GridLine key={q} x1={g.L} x2={g.R} y={g.Y(q)} label={spec.tick ? spec.tick(q) : String(q)} />)}
      {g.area && <path d={g.area} style={{ fill: spec.color, opacity: 0.16 }} />}
      <path d={g.line} style={{ fill: "none", stroke: spec.color, strokeWidth: spec.thin ? 1.5 : 2, strokeLinejoin: "round" }} />
      {spec.avg != null && (
        <>
          <line x1={g.L} x2={g.R} y1={fx(g.Y(spec.avg))} y2={fx(g.Y(spec.avg))} style={{ stroke: "var(--text2)", strokeWidth: 1, strokeDasharray: "5 4" }} />
          {spec.avgLabel !== false && (
            <text x={g.R} y={fx(g.Y(spec.avg) - 5)} style={{ fontSize: 11, fill: "var(--text2)", textAnchor: "end" }}>avg {spec.fmt(spec.avg)}</text>
          )}
        </>
      )}
      {g.xl.map(x => <text key={x.label} x={fx(x.x)} y={g.top + g.H + 16} style={{ fontSize: 11, fill: "var(--muted)", textAnchor: x.anchor }}>{x.label}</text>)}
      <HoverLine x={cx} y1={g.top} y2={g.top + g.H} />
      {tip}
    </svg>
  );
}
