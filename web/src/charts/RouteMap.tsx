// Route map, coloured by pace quintile or heart-rate zone, with km markers and the hovered position.
import { useMemo, type MouseEvent } from "react";
import { Seg } from "../components/Seg";
import { fpace, fx, quantile } from "../lib/format";
import type { Point, RunDetail } from "../types";
import { polyline } from "./svg";

export const ZONE_COLORS = ["var(--z0)", "var(--z1)", "var(--z2)", "var(--z3)"];
const PACE_COLORS = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)"];

export type ColorBy = "pace" | "hr";

interface Props {
  det: RunDetail;
  distKm: number;
  zoneOf: (bpm: number) => number;
  phone: boolean;
  /** Per-sample charts exist, so the route can be coloured and hovered. */
  hasSeries: boolean;
  colorBy: ColorBy;
  onColorBy: (c: ColorBy) => void;
  hi: number;
  onHi: (i: number) => void;
}

export function RouteMap({ det, distKm, zoneOf, phone, hasSeries, colorBy, onColorBy, hi, onHi }: Props) {
  const MW = phone ? 340 : 720, MH = phone ? 300 : 430, N = det.n;
  const g = useMemo(() => {
    // fit the route into the box, keeping the aspect ratio
    const pad = 34, raw = det.route!;
    const xs = raw.map(p => p[0]), ys = raw.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const s = Math.min((MW - 2 * pad) / (x1 - x0 || 1), (MH - 2 * pad - 16) / (y1 - y0 || 1));
    const ox = MW / 2 - ((x0 + x1) / 2) * s, oy = (MH - 16) / 2 - ((y0 + y1) / 2) * s;
    const project = (p: number[]): Point => [p[0] * s + ox, p[1] * s + oy];
    const pts = raw.map(project);
    const gridStep = 250 * s, grid: [number, number, number, number][] = [];
    if (gridStep > 12) {
      for (let gx = ((ox % gridStep) + gridStep) % gridStep; gx < MW; gx += gridStep) grid.push([gx, 0, gx, MH]);
      for (let gy = ((oy % gridStep) + gridStep) % gridStep; gy < MH; gy += gridStep) grid.push([0, gy, MW, gy]);
    }
    const kms = (det.kms || []).map(k => { const p = project(k); return { x: p[0], y: p[1], n: k[2] }; });
    return { pts, halo: polyline(pts), grid, kms, scale500: 500 * s };
  }, [det, MW, MH]);

  // one sample per route point: colour each segment and allow hovering
  const aligned = hasSeries && g.pts.length === N;
  const coloured = useMemo(() => {
    if (!aligned) return null;
    let bin: (i: number) => number | null, colors: string[], legend;
    if (colorBy === "hr") {
      const hr = det.hr!;
      colors = ZONE_COLORS;
      bin = i => { const a = hr[i], b = hr[Math.min(i + 1, N - 1)]; return a == null ? null : zoneOf(b == null ? a : (a + b) / 2); };
      legend = { lo: "Light", hi: "Peak", note: "Heart-rate zones" };
    } else {
      const sp = det.sp!, fast = sp.filter(v => v != null && v > 0.5);
      const q = [0.2, 0.4, 0.6, 0.8].map(f => quantile(fast, f));
      colors = PACE_COLORS;
      bin = i => { const v = sp[i]; if (v == null) return null; let b = 0; while (b < 4 && v > q[b]) b++; return b; };
      legend = { lo: "Slower " + fpace(1000 / quantile(fast, 0.05)), hi: fpace(1000 / quantile(fast, 0.95)) + " Faster", note: "min/km, by quintile" };
    }
    const paths = colors.map(() => "");
    for (let i = 0; i < N - 1; i++) {
      const b = bin(i);
      if (b == null) continue;
      const [a, c] = [g.pts[i], g.pts[i + 1]];
      paths[b] += `M${fx(a[0])} ${fx(a[1])}L${fx(c[0])} ${fx(c[1])}`;
    }
    return { segs: paths.map((d, b) => ({ d, color: colors[b] })), legend: { ...legend, colors } };
  }, [aligned, colorBy, det, g, N, zoneOf]);

  const segs = coloured ? coloured.segs : [{ d: g.halo, color: "var(--blue)" }];
  const start = g.pts[0], here = aligned ? g.pts[hi] : null;
  const line = { fill: "none", strokeLinejoin: "round", strokeLinecap: "round" } as const;

  const onMouseMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!aligned) return;
    const rc = e.currentTarget.getBoundingClientRect();
    if (!rc.width) return;
    const mx = ((e.clientX - rc.left) / rc.width) * MW, my = ((e.clientY - rc.top) / rc.height) * MH;
    let best = 0, bd = 1e9;
    g.pts.forEach((p, i) => { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = i; } });
    if (bd < 900 && best !== hi) onHi(best);
  };

  return (
    <section className="card" aria-labelledby="map-h" style={{ flex: "999 1 560px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "8px 12px" }}>
        <h2 id="map-h">Route</h2>
        {aligned && (
          <div className="row small text2" style={{ gap: 8 }}>
            <span id="cb-l">Colour by</span>
            <Seg options={[["pace", "Pace"], ["hr", "Heart rate"]]} value={colorBy} onChange={onColorBy} labelledBy="cb-l" />
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${MW} ${MH}`} role="img" onMouseMove={onMouseMove}
        aria-label={`Route map of the ${distKm.toFixed(2)} km run${aligned ? ", coloured by " + (colorBy === "hr" ? "heart-rate zone" : "pace") : ""}. Gridlines every 250 m.`}
        style={{ display: "block", width: "100%", height: "auto", borderRadius: 8, background: "var(--page)" }}>
        {g.grid.map((l, i) => <line key={i} x1={fx(l[0])} y1={fx(l[1])} x2={fx(l[2])} y2={fx(l[3])} style={{ stroke: "var(--grid)", strokeWidth: 1 }} />)}
        <path d={g.halo} style={{ ...line, stroke: "var(--surface)", strokeWidth: 9 }} />
        <path d={g.halo} style={{ ...line, stroke: "var(--muted)", strokeWidth: 6, opacity: 0.35 }} />
        {segs.map(s => <path key={s.color} d={s.d} style={{ ...line, stroke: s.color, strokeWidth: 4 }} />)}
        {g.kms.map(k => (
          <g key={k.n}>
            <circle cx={fx(k.x)} cy={fx(k.y)} r={9} style={{ fill: "var(--surface)", stroke: "var(--text2)", strokeWidth: 1 }} />
            <text x={fx(k.x)} y={fx(k.y + 3.5)} style={{ fontSize: 10, fontWeight: 600, fill: "var(--text)", textAnchor: "middle" }}>{k.n}</text>
          </g>
        ))}
        <rect x={fx(start[0] - 7)} y={fx(start[1] - 7)} width={14} height={14} rx={3} style={{ fill: "var(--text)", stroke: "var(--surface)", strokeWidth: 2 }} />
        <text x={fx(start[0] + 12)} y={fx(start[1] - 10)} style={{ fontSize: 11, fill: "var(--text2)" }}>Start</text>
        {here && (
          <>
            <circle cx={fx(here[0])} cy={fx(here[1])} r={12} style={{ fill: "var(--text)", opacity: 0.12 }} />
            <circle cx={fx(here[0])} cy={fx(here[1])} r={6} style={{ fill: "var(--text)", stroke: "var(--surface)", strokeWidth: 2.5 }} />
          </>
        )}
        {/* 500 m scale bar and north arrow */}
        <line x1={16} x2={fx(16 + g.scale500)} y1={MH - 16} y2={MH - 16} style={{ stroke: "var(--text2)", strokeWidth: 2 }} />
        <text x={16} y={MH - 22} style={{ fontSize: 11, fill: "var(--text2)" }}>500 m</text>
        <text x={MW - 20} y={22} style={{ fontSize: 11, fontWeight: 600, fill: "var(--text2)", textAnchor: "middle" }}>N</text>
        <path d={`M${MW - 20} 27l-5 12h10z`} style={{ fill: "var(--text2)" }} />
      </svg>
      {coloured && (
        <div className="row small text2" style={{ gap: 10 }}>
          <span>{coloured.legend.lo}</span>
          <span aria-hidden="true" style={{ display: "flex", gap: 2 }}>
            {coloured.legend.colors.map(c => <span key={c} style={{ width: 28, height: 8, borderRadius: 2, background: c }} />)}
          </span>
          <span>{coloured.legend.hi}</span>
          <span className="muted">{coloured.legend.note}</span>
        </div>
      )}
    </section>
  );
}
