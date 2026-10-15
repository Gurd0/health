// Training page charts: km per week planned vs done, and daily load with the acute:chronic ratio.
import { useMemo, useState } from "react";
import { useData } from "../data";
import { clamp, fx, niceTicks } from "../lib/format";
import type { Week } from "../types";
import { GridLine, HoverLine, polyline, roundedBar, scrub, TipBox } from "./svg";

const W = 780, L = 36, R = W - 8;

/** Planned km as an outline, done km as a filled bar, per week. */
export function PlanWeeksChart({ weeks }: { weeks: Week[] }) {
  const { cal } = useData();
  const n = weeks.length, TOP = 46, PH = 130;
  const cur = Math.max(0, weeks.findIndex(w => w.state === "current"));
  const [hover, setHover] = useState(cur);
  const g = useMemo(() => {
    const step = (R - L) / n, bw = Math.min(26, step * 0.6);
    const ticks = niceTicks(0, Math.max(5, ...weeks.map(w => Math.max(w.plannedKm, w.doneKm))), 3);
    const Y = (v: number) => TOP + PH - (v / ticks.hi) * PH;
    return { step, bw, ticks, Y, x: (j: number) => L + (j + 0.5) * step };
  }, [weeks, n]);
  const j = clamp(hover, 0, n - 1), w = weeks[j];
  const k = Math.min(n, 6), labels = Array.from({ length: k }, (_, q) => Math.round((q * (n - 1)) / Math.max(1, k - 1)));

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${TOP + PH + 22}`} role="img"
      aria-label="Kilometres per week, planned and done. Use the arrow keys to step through weeks."
      {...scrub({ W, n, index: j, toIndex: x => clamp(Math.floor((x - L) / g.step), 0, n - 1), onIndex: setHover })}>
      {g.ticks.ticks.map(q => <GridLine key={q} x1={L} x2={R} y={g.Y(q)} label={String(q)} />)}
      {weeks.map((wk, i) => (
        <g key={wk.monday}>
          {wk.plannedKm > 0 && (
            <path d={roundedBar(g.x(i) - g.bw / 2, g.bw, g.Y(wk.plannedKm), TOP + PH, 3)}
              style={{ fill: "none", stroke: "var(--text2)", strokeWidth: 1, strokeDasharray: wk.state === "future" ? "3 2" : undefined, opacity: 0.6 }} />
          )}
          {wk.doneKm > 0 && (
            <path d={roundedBar(g.x(i) - g.bw / 2 + 3, g.bw - 6, g.Y(wk.doneKm), TOP + PH, 3)}
              style={{ fill: wk.hit ? "var(--aqua)" : "var(--blue)" }} />
          )}
        </g>
      ))}
      {labels.map((i, q) => (
        <text key={i} x={fx(g.x(i))} y={TOP + PH + 16}
          style={{ fontSize: 11, fill: "var(--muted)", textAnchor: q === 0 ? "start" : q === labels.length - 1 ? "end" : "middle" }}>
          {cal.fd(cal.day(weeks[i].monday))}
        </text>
      ))}
      <rect x={fx(g.x(j) - g.step / 2)} y={TOP} width={fx(g.step)} height={PH} style={{ fill: "var(--text)", opacity: 0.06 }} />
      <TipBox x={g.x(j)} y={2} gap={g.bw / 2 + 8} W={W}
        value={`${w.doneKm.toFixed(1)} of ${w.plannedKm.toFixed(1)} km`}
        label={"Week of " + cal.fd(cal.day(w.monday), true) + (w.hit ? " · target hit" : "")} />
    </svg>
  );
}

/** ACWR line (with the 0.8–1.3 band) above daily load bars, sharing one time axis. */
export function LoadChart({ start, load, acwr }: { start: string; load: number[]; acwr: (number | null)[] }) {
  const { cal } = useData();
  const n = load.length, d0 = cal.day(start);
  const [hover, setHover] = useState(n - 1);
  const T1 = 46, H1 = 90, T2 = T1 + H1 + 18, H2 = 60;
  const g = useMemo(() => {
    const step = (R - L) / n;
    const aHi = Math.max(2, ...acwr.map(v => v ?? 0));
    const A = (v: number) => T1 + H1 - (Math.min(v, aHi) / aHi) * H1;
    const lt = niceTicks(0, Math.max(10, ...load), 2);
    const B = (v: number) => T2 + H2 - (v / lt.hi) * H2;
    const pts: [number, number][][] = [];
    let seg: [number, number][] = [];
    acwr.forEach((v, i) => {
      if (v == null) { if (seg.length) pts.push(seg); seg = []; } else seg.push([L + (i + 0.5) * step, A(v)]);
    });
    if (seg.length) pts.push(seg);
    return { step, aHi, A, lt, B, pts, x: (i: number) => L + (i + 0.5) * step };
  }, [load, acwr, n]);
  const j = clamp(hover, 0, n - 1);
  const months: number[] = [];
  for (let i = 0; i < n; i++) if (cal.date(d0 + i).getUTCDate() === 1) months.push(i);
  const a = acwr[j];

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${T2 + H2 + 22}`} role="img"
      aria-label="Acute to chronic workload ratio and daily training load for the last 90 days. Use the arrow keys to step through days."
      {...scrub({ W, n, index: j, toIndex: x => clamp(Math.floor((x - L) / g.step), 0, n - 1), onIndex: setHover, bigStep: 7 })}>
      <rect x={L} width={R - L} y={fx(g.A(1.3))} height={fx(g.A(0.8) - g.A(1.3))} style={{ fill: "var(--aqua)", opacity: 0.14 }} />
      {[0, 1, 2].filter(v => v <= g.aHi).map(v => <GridLine key={v} x1={L} x2={R} y={g.A(v)} label={v.toFixed(1)} />)}
      <line x1={L} x2={R} y1={fx(g.A(1.5))} y2={fx(g.A(1.5))} style={{ stroke: "var(--orange)", strokeWidth: 1, strokeDasharray: "4 3" }} />
      {g.pts.map((p, i) => <path key={i} d={polyline(p)} style={{ fill: "none", stroke: "var(--text)", strokeWidth: 2, strokeLinejoin: "round" }} />)}
      {g.lt.ticks.map(q => <GridLine key={"b" + q} x1={L} x2={R} y={g.B(q)} label={String(q)} />)}
      {load.map((v, i) => v > 0 && (
        <rect key={i} x={fx(g.x(i) - Math.max(1, g.step * 0.35))} width={fx(Math.max(2, g.step * 0.7))} y={fx(g.B(v))} height={fx(T2 + H2 - g.B(v))}
          style={{ fill: "var(--blue)" }} />
      ))}
      {months.map(i => (
        <text key={i} x={fx(g.x(i))} y={T2 + H2 + 16} style={{ fontSize: 11, fill: "var(--muted)", textAnchor: "middle" }}>{cal.fd(d0 + i).replace(/^1\. /, "")}</text>
      ))}
      <HoverLine x={g.x(j)} y1={T1} y2={T2 + H2} />
      {a != null && <circle cx={fx(g.x(j))} cy={fx(g.A(a))} r={3.5} style={{ fill: "var(--text)" }} />}
      <TipBox x={g.x(j)} y={2} gap={8} W={W}
        value={(a != null ? "ratio " + a.toFixed(2) : "no ratio") + " · load " + Math.round(load[j])}
        label={cal.fdw(d0 + j, true)} />
    </svg>
  );
}
