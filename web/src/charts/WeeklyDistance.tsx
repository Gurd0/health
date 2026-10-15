// Bar chart of km run per week, with a hover tooltip.
import { useMemo } from "react";
import { useData } from "../data";
import { clamp, fx, niceTicks } from "../lib/format";
import { GridLine, roundedBar, scrub, TipBox } from "./svg";

const WW = 780, L = 36, R = WW - 8, TOP = 46, PH = 150;

export function WeeklyDistance({ weeks, hover, onHover }: { weeks: number; hover: number; onHover: (j: number) => void }) {
  const { cal, runs } = useData();
  const g = useMemo(() => {
    const mon = cal.monday(cal.today);
    const data: { a: number; km: number; n: number }[] = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const a = mon - 7 * w, inWeek = runs.filter(x => x.d >= a && x.d <= a + 6);
      data.push({ a, km: inWeek.reduce((s, x) => s + x.dist, 0), n: inWeek.length });
    }
    const step = (R - L) / weeks, bw = Math.min(24, step * 0.7);
    const yTicks = niceTicks(0, Math.max(...data.map(w => w.km), 5), 3);
    const Y = (v: number) => TOP + PH - (v / yTicks.hi) * PH;
    const bar = (j: number) => (data[j].km ? roundedBar(L + (j + 0.5) * step - bw / 2, bw, Y(data[j].km), TOP + PH, Math.min(4, bw / 2)) : "");
    const k = Math.min(weeks, 6), xIdx: number[] = [];
    for (let q = 0; q < k; q++) xIdx.push(Math.round((q * (weeks - 1)) / (k - 1)));
    return { data, step, bw, yTicks, Y, bar, xIdx };
  }, [cal, runs, weeks]);

  const j = clamp(hover, 0, weeks - 1), w = g.data[j], hx = L + (j + 0.5) * g.step;
  return (
    <svg className="chart" viewBox={`0 0 ${WW} ${TOP + PH + 22}`} role="img"
      aria-label={`Distance per week, last ${weeks} weeks, in km. Use the arrow keys to step through weeks.`}
      {...scrub({ W: WW, n: weeks, index: j, toIndex: x => clamp(Math.floor((x - L) / g.step), 0, weeks - 1), onIndex: onHover })}>
      {g.yTicks.ticks.map(q => <GridLine key={q} x1={L} x2={R} y={g.Y(q)} label={String(q)} />)}
      <path d={g.data.map((_, i) => g.bar(i)).join("")} style={{ fill: "var(--blue)" }} />
      {g.xIdx.map((i, q) => (
        <text key={i} x={fx(L + (i + 0.5) * g.step)} y={TOP + PH + 16}
          style={{ fontSize: 11, fill: "var(--muted)", textAnchor: q === 0 ? "start" : q === g.xIdx.length - 1 ? "end" : "middle" }}>
          {cal.fd(g.data[i].a)}
        </text>
      ))}
      <path d={g.bar(j)} style={{ fill: "var(--text)", opacity: 0.18 }} />
      <TipBox x={hx} y={2} gap={g.bw / 2 + 8} W={WW} value={`${w.km.toFixed(1)} km · ${w.n} ${w.n === 1 ? "run" : "runs"}`} label={"Week of " + cal.fd(w.a, true)} />
    </svg>
  );
}
