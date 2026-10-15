// A per-run metric over time: one dot per run and a 5-run rolling average line.
import { useData } from "../data";
import { DAY, MON } from "../lib/calendar";
import { fx, niceTicks } from "../lib/format";
import { GridLine } from "./svg";

const W = 360, H = 150, L = 40, R = W - 40, TOP = 8, PH = 112;

interface Props {
  title: string;
  sub: string;
  points: { d: number; y: number }[]; // day index, value; oldest first
  invert?: boolean; // smaller is better (pace): draw it higher
  estimate?: boolean;
  tick: (q: number) => string;
  fmt: (q: number) => string;
}

export function ProgressChart({ title, sub, points, invert, estimate, tick, fmt }: Props) {
  const { cal } = useData();
  const head = (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h3 style={{ fontSize: 14 }}>{title}</h3>{estimate && <span className="badge">Estimate</span>}
      </div>
      <div className="sub">{sub}</div>
    </>
  );
  if (points.length < 2) {
    return <div className="card" style={{ padding: "16px 16px 12px" }}>{head}<div className="muted small" style={{ padding: "40px 0" }}>Not enough runs yet</div></div>;
  }

  const x0 = points[0].d - 3, x1 = cal.today, X = (d: number) => L + ((d - x0) / (x1 - x0)) * (R - L);
  const ys = points.map(p => p.y), pad = (Math.max(...ys) - Math.min(...ys)) * 0.12 || 1;
  const tk = niceTicks(Math.min(...ys) - pad, Math.max(...ys) + pad, 3), lo = tk.lo, hi = tk.hi;
  const Y = (v: number) => (invert ? TOP + ((v - lo) / (hi - lo)) * PH : TOP + PH - ((v - lo) / (hi - lo)) * PH);
  const rolling = points.map((_, i) => { const w = points.slice(Math.max(0, i - 4), i + 1); return w.reduce((s, q) => s + q.y, 0) / w.length; });
  const line = points.map((p, i) => (i ? "L" : "M") + fx(X(p.d)) + " " + fx(Y(rolling[i]))).join("");
  const lastP = points[points.length - 1], lastM = rolling[rolling.length - 1];

  // x labels at the start of each quarter
  const xl: { x: number; label: string }[] = [];
  const start = cal.date(x0);
  for (let k = 1; k < 40; k++) {
    const t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + k, 1), d = Math.round((t - cal.t0) / DAY);
    if (d > x1) break;
    const m = new Date(t).getUTCMonth();
    if (m % 3 === 0) xl.push({ x: X(d), label: m === 0 ? String(new Date(t).getUTCFullYear()) : MON[m] });
  }

  return (
    <div className="card" style={{ padding: "16px 16px 12px" }}>
      {head}
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, latest ${fmt(lastM)}`}>
        {tk.ticks.map(q => <GridLine key={q} x1={L} x2={R} y={Y(q)} label={tick(q)} />)}
        {points.map((p, i) => <circle key={i} cx={fx(X(p.d))} cy={fx(Y(p.y))} r={2.5} style={{ fill: "var(--blue)", opacity: 0.45 }} />)}
        <path d={line} style={{ fill: "none", stroke: "var(--blue)", strokeWidth: 2, strokeLinejoin: "round" }} />
        <text x={fx(X(lastP.d) + 6)} y={fx(Y(lastM) + 4)} style={{ fontSize: 11, fontWeight: 600, fill: "var(--text)" }}>{fmt(lastM)}</text>
        {xl.map(x => <text key={x.x} x={fx(x.x)} y={TOP + PH + 18} style={{ fontSize: 11, fill: "var(--muted)", textAnchor: "middle" }}>{x.label}</text>)}
      </svg>
    </div>
  );
}
