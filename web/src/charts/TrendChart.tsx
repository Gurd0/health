// Overview trend chart: one or more stacked panels (bars or lines) over the same date buckets.
// All trend charts share one hovered bucket, so hovering one moves the marker in all of them.
import { useMemo, type CSSProperties } from "react";
import { clamp, fint, fx, niceTicks } from "../lib/format";
import type { Series } from "../types";
import { GridLine, HoverLine, roundedBar, scrub, TipBox } from "./svg";

/** A date bucket: one day, week or month (days a..b). k identifies it across charts. */
export interface Bucket {
  k: number;
  a: number;
  b: number;
  label: string; // tooltip / table
  tick: string; // x axis
  month?: number;
}

export type BucketMode = "daily" | "weekly" | "monthly";

export interface Panel {
  v: Series; // one value per bucket
  kind: "bar" | "line";
  color: string;
  h: number; // panel height
  min?: number; // fixed axis range; otherwise padded around the data
  max?: number;
  fmt: (q: number) => string;
  unit?: string;
  label: string; // table column
  short?: string; // prefix in the tooltip
  tick?: (q: number) => string;
  connect?: boolean; // draw lines across gaps
  markers?: boolean; // dot on every value
}

export interface TrendSpec {
  id: string;
  title: string;
  sub: string;
  legend?: { label: string; color: string; swatch: CSSProperties }[];
  wide?: boolean;
  clip: boolean; // start at the first bucket with data
  mode: BucketMode;
  panels: Panel[];
}

/** Everything that doesn't depend on the hovered bucket. */
function layout(spec: TrendSpec, buckets: Bucket[], W: number, phone: boolean) {
  const L = phone ? 32 : 40, R = W - (phone ? 36 : 44), top = 8, gap = 16;
  let i0 = 0;
  if (spec.clip) i0 = Math.max(0, buckets.findIndex((_, bi) => spec.panels.some(p => p.v[bi] != null)));
  const bs = buckets.slice(i0), n = bs.length, step = (R - L) / Math.max(1, n);
  const X = (j: number) => L + (j + 0.5) * step;

  let y = top;
  const panels = spec.panels.map(pn => {
    const v = pn.v.slice(i0);
    const nn = v.filter((q): q is number => q != null);
    let lo = nn.length ? Math.min(...nn) : 0, hi = nn.length ? Math.max(...nn) : 1;
    if (pn.min != null) lo = pn.min; else lo -= (hi - lo) * 0.15 || 1;
    if (pn.max != null) hi = pn.max; else hi += (hi - lo) * 0.12 || 1;
    const tk = niceTicks(lo, hi, pn.h < 100 ? 2 : 3);
    if (pn.min == null) lo = tk.lo;
    if (pn.max == null) hi = tk.hi;
    const y0 = y;
    const Y = (q: number) => y0 + pn.h - ((q - lo) / (hi - lo || 1)) * pn.h;
    const frac = tk.ticks.some(q => !Number.isInteger(q));
    const grid = tk.ticks
      .filter(q => q >= lo - 1e-9 && q <= hi + 1e-9)
      .map(q => ({ y: Y(q), label: pn.tick ? pn.tick(q) : frac ? q.toFixed(1) : fint(q) }));

    let path = "";
    const dots: { x: number; y: number; r: number }[] = [];
    let end: { x: number; y: number; text: string } | null = null;
    if (pn.kind === "bar") {
      const bw = Math.min(24, step * 0.7), base = Y(lo);
      v.forEach((q, j) => { if (q != null) path += roundedBar(X(j) - bw / 2, bw, Y(q), base, Math.min(4, bw / 2)); });
    } else {
      let pen = false, last: { px: number; py: number; q: number } | null = null;
      v.forEach((q, j) => {
        if (q == null) { if (!pn.connect) pen = false; return; }
        const px = X(j), py = Y(q);
        path += (pen ? "L" : "M") + fx(px) + " " + fx(py);
        const isolated = !pn.connect && (j === 0 || v[j - 1] == null) && (j === n - 1 || v[j + 1] == null);
        if (isolated || pn.markers) dots.push({ x: px, y: py, r: pn.markers ? 2.5 : 2 });
        pen = true;
        last = { px, py, q };
      });
      if (last) { const l: { px: number; py: number; q: number } = last; end = { x: l.px + 7, y: l.py + 4, text: pn.fmt(l.q) }; }
    }
    y += pn.h + gap;
    return { pn, v, Y, grid, path, dots, end };
  });
  const bottom = y - gap, H = bottom + 22;

  // x labels: January of each year for long monthly ranges, otherwise 3-5 evenly spaced buckets
  const yearly = spec.mode === "monthly" && n > 14;
  let idx: number[] = [];
  if (yearly) {
    bs.forEach((b, j) => { if (b.month === 0) idx.push(j); });
    if (phone) idx = idx.filter((_, q) => q % 2 === 0);
  } else {
    const k = Math.min(n, phone ? 3 : 5);
    for (let t = 0; t < k; t++) idx.push(k > 1 ? Math.round((t * (n - 1)) / (k - 1)) : 0);
  }
  const xLabels = idx.map((j, q) => ({
    x: X(j), label: bs[j].tick,
    anchor: yearly || idx.length < 2 ? "middle" : q === 0 ? "start" : q === idx.length - 1 ? "end" : "middle",
  }));
  return { L, R, top, bottom, H, n, step, X, bs, panels, xLabels };
}

interface Props {
  spec: TrendSpec;
  buckets: Bucket[];
  W: number;
  phone: boolean;
  hoverKey: number;
  onHover: (k: number) => void;
  showTable: boolean;
  onToggleTable: () => void;
}

export function TrendChart({ spec, buckets, W, phone, hoverKey, onHover, showTable, onToggleTable }: Props) {
  const g = useMemo(() => layout(spec, buckets, W, phone), [spec, buckets, W, phone]);
  const hj = g.bs.findIndex(b => b.k === hoverKey);
  const current = hj < 0 ? g.n - 1 : hj;
  const valueText = (pn: Panel, q: number | null) => q == null ? "—" : pn.fmt(q) + (pn.unit ? " " + pn.unit : "");
  const aria = `${spec.title}, ${g.bs[0].label} to ${g.bs[g.n - 1].label}. Use the arrow keys to step through values.`;
  const cols = "minmax(0,1.4fr) " + spec.panels.map(() => "minmax(0,1fr)").join(" ");

  return (
    <div className={"card" + (spec.wide ? " wide" : "")} style={{ padding: "16px 16px 12px" }}>
      <div className="chart-head">
        <div style={{ minWidth: 0 }}><h2>{spec.title}</h2><div className="sub">{spec.sub}</div></div>
        <div className="row">
          {spec.legend?.map(l => (
            <span key={l.label} className="legend">
              <span aria-hidden="true" style={{ display: "inline-block", ...l.swatch, background: l.color }} />{l.label}
            </span>
          ))}
          <button type="button" className="btn sm" aria-pressed={showTable} onClick={onToggleTable}>
            {showTable ? "Hide table" : "Show table"}
          </button>
        </div>
      </div>

      <svg className="chart" viewBox={`0 0 ${W} ${fx(g.H)}`} role="img" aria-label={aria}
        {...scrub({ W, n: g.n, index: current, toIndex: x => clamp(Math.floor((x - g.L) / g.step), 0, g.n - 1), onIndex: j => onHover(g.bs[j].k) })}>
        {g.panels.map((p, pi) => (
          <g key={pi}>
            {p.grid.map(t => <GridLine key={t.label} x1={g.L} x2={g.R} y={t.y} label={t.label} />)}
            {p.pn.kind === "bar"
              ? <path d={p.path} style={{ fill: p.pn.color }} />
              : <path d={p.path} style={{ fill: "none", stroke: p.pn.color, strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }} />}
            {p.dots.map((d, i) => <circle key={i} cx={fx(d.x)} cy={fx(d.y)} r={d.r} style={{ fill: p.pn.color }} />)}
            {p.end && <text x={fx(p.end.x)} y={fx(p.end.y)} style={{ fontSize: 11, fontWeight: 600, fill: "var(--text)" }}>{p.end.text}</text>}
          </g>
        ))}
        {g.xLabels.map(l => (
          <text key={l.x} x={fx(l.x)} y={fx(g.bottom + 16)} style={{ fontSize: 11, fill: "var(--muted)", textAnchor: l.anchor as "start" | "middle" | "end" }}>{l.label}</text>
        ))}
        {hj >= 0 && (
          <g>
            <HoverLine x={g.X(hj)} y1={g.top} y2={g.bottom} />
            {g.panels.map((p, pi) => {
              const q = p.v[hj];
              return q != null && p.pn.kind !== "bar"
                ? <circle key={pi} cx={fx(g.X(hj))} cy={fx(p.Y(q))} r={4} style={{ fill: p.pn.color, stroke: "var(--surface)", strokeWidth: 2 }} />
                : null;
            })}
            <TipBox x={g.X(hj)} y={g.top} gap={10} W={W} label={g.bs[hj].label}
              value={g.panels.map(p => (p.pn.short ? p.pn.short + " " : "") + (p.v[hj] == null ? "no data" : valueText(p.pn, p.v[hj]))).join(" · ")} />
          </g>
        )}
      </svg>

      {showTable && (
        <div className="vtable" role="table" aria-label={spec.title + " values"}>
          <div className="trow thead" role="row" style={{ gridTemplateColumns: cols }}>
            <span role="columnheader">Date</span>
            {spec.panels.map(p => <span key={p.label} role="columnheader" className="num">{p.label}</span>)}
          </div>
          {g.bs.map((b, j) => ({ b, j })).reverse().map(({ b, j }) => (
            <div key={b.k} className="trow" role="row" style={{ gridTemplateColumns: cols }}>
              <span role="cell" className="text2">{b.label}</span>
              {g.panels.map((p, pi) => <span key={pi} role="cell" className="num">{valueText(p.pn, p.v[j])}</span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
