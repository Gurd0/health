// Run detail page: summary, route, splits, heart rate, pace/elevation, running form and context.
// Hovering any chart or the map moves one shared position (hi) through all of them.
import { useEffect, useMemo, useState } from "react";
import { getRun } from "../api";
import { ColorBy, RouteMap, ZONE_COLORS } from "../charts/RouteMap";
import { TimeSeriesChart, TsSpec } from "../charts/TimeSeriesChart";
import { Run, useData } from "../data";
import { usePhone, useSessionState } from "../hooks";
import { avg, clamp, fdur, fhm, fint, fpace, fx, labelCase, signed } from "../lib/format";
import type { RunDetail as Detail } from "../types";

const ZONE_NAMES = ["Light", "Moderate", "Vigorous", "Peak"];
const DEFAULT_ZONES = [30, 113, 143, 180, 220];

export function RunDetail({ id }: { id: string }) {
  const { runById } = useData();
  const run = runById.get(id);
  const [state, setState] = useState<{ id: string; det?: Detail; error?: string } | null>(null);

  useEffect(() => {
    if (!run) return;
    let live = true;
    getRun(id).then(det => live && setState({ id, det }), e => live && setState({ id, error: String(e.message || e) }));
    return () => { live = false; };
  }, [id, run]);

  if (!run) return <div className="loading">Run not found. <a href="#/runs">All runs</a></div>;
  if (state?.id === id && state.error) return <div className="loading">Couldn't load this run ({state.error}).</div>;
  if (state?.id !== id || !state.det) return <div className="loading">Loading run…</div>;
  return <RunPage key={id} run={run} det={state.det} />;
}

function RunPage({ run, det }: { run: Run; det: Detail }) {
  const { cal } = useData();
  const phone = usePhone();
  const isFit = run.src === "fit", isTreadmill = run.type === "Treadmill";
  const hasSeries = !!det.hr && !isFit, hasMap = !!det.route, hasForm = hasSeries && !!det.cad;
  const N = det.n;
  const [hi, setHi] = useState(() => Math.round(N * 0.62));
  const [colorBy, setColorBy] = useSessionState<ColorBy>("run.colorBy", "pace");

  const zones = det.zones || DEFAULT_ZONES;
  const zoneOf = useMemo(() => (h: number) => (h < zones[1] ? 0 : h < zones[2] ? 1 : h < zones[3] ? 2 : 3), [zones]);

  // title and time: "Morning run · Sat 11. okt. 2026 · 11:38–12:20"
  const st = new Date(run.start + ":00Z"), sh = st.getUTCHours(), sm = st.getUTCMinutes();
  const hhmm = (m: number) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const title = isTreadmill ? "Treadmill run" : sh < 12 ? "Morning run" : sh < 17 ? "Afternoon run" : "Evening run";
  const when = `${cal.fdw(run.d, true)} · ${hhmm(sh * 60 + sm)}–${hhmm(sh * 60 + sm + Math.round(run.elapsed / 60))}`;

  const stats: [string, string, string][] = [["Distance", run.dist.toFixed(2), "km"], [isFit ? "Duration" : "Moving time", fdur(run.dur), ""], ["Average pace", fpace(run.pace), "/km"]];
  if (!isFit && run.hr) stats.push(["Avg heart rate", String(run.hr), "bpm"]);
  if (!isFit && run.maxHr) stats.push(["Max heart rate", String(run.maxHr), "bpm"]);
  if (run.cal) stats.push(["Calories", fint(run.cal), "kcal"]);
  if (!isFit && !isTreadmill && run.elev != null) stats.push(["Elevation gain", String(run.elev), "m"]);
  if (run.steps) stats.push(["Steps", fint(run.steps), ""]);

  const chart = { n: N, step: det.step, phone, hi, onHi: setHi };
  const hasSplits = hasSeries && det.splits.length > 0;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <a href="#/runs" style={{ fontSize: 13, color: "var(--text2)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 0", alignSelf: "flex-start" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ fill: "none", stroke: "var(--text2)", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="M15 18l-6-6 6-6" /></svg>
          All runs
        </a>
        <div className="row" style={{ alignItems: "baseline", gap: "6px 14px" }}>
          <h1>{title}</h1><span className="text2">{when}</span><span className="pill">{run.type}</span>
          {isFit && <span className="pill outline">Google Fit · summary only</span>}
        </div>
      </div>

      <section className="statgrid" aria-label="Run summary">
        {stats.map(([label, value, unit]) => (
          <div key={label}>
            <span className="small text2">{label}</span>
            <span className="row" style={{ alignItems: "baseline", gap: 4 }}><span className="v">{value}</span><span className="small text2">{unit}</span></span>
          </div>
        ))}
      </section>

      {isFit && <FitNote run={run} hasMap={hasMap} />}

      {(hasMap || hasSplits) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "stretch" }}>
          {hasMap && <RouteMap det={det} distKm={run.dist} zoneOf={zoneOf} phone={phone} hasSeries={hasSeries}
            colorBy={colorBy} onColorBy={setColorBy} hi={hi} onHi={setHi} />}
          {hasSplits && <Splits run={run} det={det} isTreadmill={isTreadmill} t={hi * det.step} />}
        </div>
      )}

      {hasSeries && (
        <>
          <Readout det={det} i={hi} hasForm={hasForm} showClimb={!isTreadmill && !!det.cg} />
          <HeartRate det={det} zones={zones} chart={chart} />
          <PaceElevation run={run} det={det} isTreadmill={isTreadmill} chart={chart} />
          {hasForm ? <RunningForm det={det} chart={chart} /> : <FormAverages run={run} det={det} />}
          <Context run={run} det={det} />
        </>
      )}
      {isTreadmill && <div className="small muted">Treadmill run: distance and pace come from the watch's motion sensors, so there is no route map or elevation.</div>}
      <div style={{ height: 24 }} />
    </>
  );
}

/** Props every time-series chart on this page shares. */
interface ChartCtx { n: number; step: number; phone: boolean; hi: number; onHi: (i: number) => void }

function FitNote({ run, hasMap }: { run: Run; hasMap: boolean }) {
  return (
    <div className="card" role="note" style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5, color: "var(--text2)", padding: "14px 16px" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none", marginTop: 1, fill: "none", stroke: "var(--text2)", strokeWidth: 2, strokeLinecap: "round" }}>
        <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" />
      </svg>
      <div>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>Recorded with Google Fit on the phone.</span>{" "}
        This run has distance, duration{run.cal ? ", calories" : ""}{run.steps ? ", steps" : ""}{hasMap ? " and a GPS track" : ""}.{" "}
        {hasMap ? "" : "Google Fit didn't keep a GPS track for it. "}
        Heart rate, splits, pace samples, elevation and running form weren't recorded, so those sections are left out rather
        than shown empty. Average pace is calculated from distance and duration.
      </div>
    </div>
  );
}

function Splits({ run, det, isTreadmill, t }: { run: Run; det: Detail; isTreadmill: boolean; t: number }) {
  const paces = det.splits.map(x => x.pace), fastest = Math.min(...paces), slowest = Math.max(...paces);
  const cols = "44px 52px 52px minmax(0,1fr) 40px";
  return (
    <section className="card" aria-labelledby="sp-h" style={{ flex: "1 1 340px" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 id="sp-h">Splits</h2><span className="small muted">avg {fpace(run.pace)} /km</span>
      </div>
      <div className="table" role="table" aria-label="Splits per km" style={{ marginTop: 10 }}>
        <div className="trow thead" role="row" style={{ gridTemplateColumns: cols, gap: 10, paddingBottom: 6 }}>
          <span role="columnheader">Km</span><span role="columnheader" className="num">Pace</span><span role="columnheader" className="num">vs avg</span>
          <span role="columnheader"><span className="sr">Speed bar</span></span><span role="columnheader" className="num">Elev.</span>
        </div>
        {det.splits.map((x, j) => (
          <div key={j} className="trow" role="row"
            style={{ gridTemplateColumns: cols, gap: 10, minHeight: 34, background: t >= x.a && t < x.b ? "var(--chip)" : "transparent" }}>
            <span role="cell" className="text2">{x.len < 0.999 ? x.len.toFixed(2) : j + 1}</span>
            <span role="cell" className="num" style={{ fontWeight: 550 }}>{fpace(x.pace)}</span>
            <span role="cell" className="num text2">{signed(Math.round(x.pace - run.pace), fpace)}</span>
            <span role="cell" aria-hidden="true" style={{ height: 10, background: "var(--grid)", borderRadius: 2, position: "relative", overflow: "hidden" }}>
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 2, background: "var(--blue)",
                width: fx(clamp(((slowest + 20 - x.pace) / (slowest + 20 - fastest)) * 100, 6, 100)) + "%" }} />
            </span>
            <span role="cell" className="num text2">{isTreadmill || x.elev == null ? "—" : x.elev + " m"}</span>
          </div>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>Longer bar = faster km. The last split is a partial km.</div>
    </section>
  );
}

/** Sticky line with the values at the hovered moment. */
function Readout({ det, i, hasForm, showClimb }: { det: Detail; i: number; hasForm: boolean; showClimb: boolean }) {
  const d = det.d?.[i], sp = det.sp![i], hr = det.hr![i];
  const items: [string, string][] = [
    [fdur(i * det.step), "elapsed"],
    [d != null ? (d / 1000).toFixed(2) + " km" : "—", "distance"],
    [sp && sp > 0.8 ? fpace(1000 / sp) : "—", "min/km"],
    [hr != null ? String(hr) : "—", "bpm"],
  ];
  if (hasForm) { const c = det.cad![i]; items.push([c != null ? String(Math.round(c)) : "—", "spm"]); }
  if (showClimb) { const c = det.cg![i]; items.push([c != null ? Math.round(c) + " m" : "—", "climbed"]); }
  return (
    <div className="readout" aria-live="polite">
      {items.map(([v, l]) => <span key={l} style={{ whiteSpace: "nowrap" }}><span style={{ fontWeight: 600 }}>{v}</span> <span className="muted">{l}</span></span>)}
    </div>
  );
}

function HeartRate({ det, zones, chart }: { det: Detail; zones: number[]; chart: ChartCtx }) {
  const spec = useMemo<TsSpec>(() => {
    const hv = det.hr!.filter((v): v is number => v != null);
    return {
      title: "Heart rate", vals: det.hr!, h: chart.phone ? 150 : 180, nt: 4, color: "var(--blue)", fmt: v => Math.round(v) + " bpm", xlabels: true,
      lo: Math.min(80, Math.floor(Math.min(...hv) / 10) * 10), hi: Math.max(190, Math.ceil(Math.max(...hv) / 10) * 10),
      bands: ZONE_NAMES.map((label, z) => ({ from: zones[z], to: zones[z + 1], color: ZONE_COLORS[z], label })),
    };
  }, [det, zones, chart.phone]);
  const secs = det.zoneSecs || [0, 0, 0, 0], total = secs.reduce((a, b) => a + b, 0) || 1;
  const rows = ZONE_NAMES.map((name, z) => ({
    name, color: ZONE_COLORS[z], time: fdur(secs[z]), share: secs[z] / total,
    range: zones[z] + (z < 3 ? "–" + (zones[z + 1] - 1) : "+") + " bpm",
  }));

  return (
    <section className="card" aria-labelledby="hr-h" style={{ display: "flex", flexWrap: "wrap", gap: "16px 24px" }}>
      <div style={{ flex: "999 1 560px", minWidth: 0 }}>
        <h2 id="hr-h">Heart rate</h2>
        <div className="sub">bpm · zones shaded behind the line, from that day's thresholds</div>
        <TimeSeriesChart spec={spec} W={chart.phone ? 330 : 1128} {...chart} />
      </div>
      <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h3>Time in zones</h3>
          <div aria-hidden="true" style={{ display: "flex", height: 14, borderRadius: 3, overflow: "hidden", marginTop: 10, gap: 2 }}>
            {rows.map(z => <span key={z.name} style={{ width: fx(z.share * 100) + "%", background: z.color }} />)}
          </div>
          <div className="table" role="table" aria-label="Time in heart-rate zones" style={{ marginTop: 10 }}>
            {rows.map(z => (
              <div key={z.name} className="trow" role="row" style={{ gridTemplateColumns: "14px minmax(0,1fr) auto 44px", gap: 8, padding: "6px 0" }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: z.color }} />
                <span role="cell"><span style={{ fontWeight: 550 }}>{z.name}</span> <span className="small muted">{z.range}</span></span>
                <span role="cell" className="num">{z.time}</span>
                <span role="cell" className="num text2">{Math.round(z.share * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
        {det.azm != null && (
          <div className="row" style={{ alignItems: "baseline", gap: 8, padding: "12px 14px", borderRadius: 8, background: "var(--chip)", flexWrap: "nowrap" }}>
            <span className="big">{Math.round(det.azm)}</span>
            <span className="unit">active zone minutes<br /><span className="small muted">1 per minute moderate, 2 per minute vigorous or peak</span></span>
          </div>
        )}
      </div>
    </section>
  );
}

function PaceElevation({ run, det, isTreadmill, chart }: { run: Run; det: Detail; isTreadmill: boolean; chart: ChartCtx }) {
  const showElev = !isTreadmill && !!det.cg;
  const pace = useMemo<TsSpec>(() => ({
    title: "Pace", vals: det.sp!.map(v => (v != null && v > 0.8 ? 1000 / v : null)), h: chart.phone ? 110 : 130, invert: true, nt: 3,
    color: "var(--blue)", fmt: v => fpace(v) + " /km", tick: fpace, avg: run.pace, xlabels: !showElev,
  }), [det, run.pace, chart.phone, showElev]);
  const elev = useMemo<TsSpec | null>(() => showElev ? {
    title: "Elevation gain", vals: det.cg!, h: chart.phone ? 60 : 70, lo: 0, nt: 2, color: "var(--aqua)", fmt: v => Math.round(v) + " m", area: true, xlabels: true,
  } : null, [det, chart.phone, showElev]);
  const style = { display: "block", width: "100%", height: "auto", marginTop: 6, overflow: "visible" } as const;
  const W = chart.phone ? 330 : 1128;

  return (
    <section className="card" aria-labelledby="pe-h">
      <h2 id="pe-h">{elev ? "Pace and elevation" : "Pace"}</h2>
      <div style={{ marginTop: 12 }}>
        <div className="row small" style={{ justifyContent: "space-between", gap: 8 }}><span className="text2">Pace</span><span className="muted">min/km · faster is up</span></div>
        <TimeSeriesChart spec={pace} W={W} style={style} {...chart} />
      </div>
      {elev && (
        <div style={{ marginTop: 12 }}>
          <div className="row small" style={{ justifyContent: "space-between", gap: 8 }}><span className="text2">Elevation gain</span><span className="muted">cumulative · m</span></div>
          <TimeSeriesChart spec={elev} W={W} style={style} {...chart} />
        </div>
      )}
    </section>
  );
}

/** Per-second running form (only in takeout-imported runs). */
function RunningForm({ det, chart }: { det: Detail; chart: ChartCtx }) {
  const specs = useMemo(() => {
    const metrics = [
      { title: "Cadence", vals: det.cad!, fmt: (v: number) => Math.round(v) + " spm" },
      { title: "Stride length", vals: det.stride!, fmt: (v: number) => v.toFixed(2) + " m", tick: (q: number) => q.toFixed(2) },
      { title: "Ground contact time", vals: det.gct!, fmt: (v: number) => Math.round(v) + " ms" },
      { title: "Vertical oscillation", vals: det.vo!, fmt: (v: number) => v.toFixed(1) + " cm", tick: (q: number) => q.toFixed(1) },
      { title: "Vertical ratio", vals: det.vr!, fmt: (v: number) => v.toFixed(1) + " %", tick: (q: number) => q.toFixed(1) },
    ];
    return metrics.map((m, k): TsSpec & { mean: number | null } => ({
      ...m, mean: avg(m.vals), avg: avg(m.vals), avgLabel: false, thin: true, nt: 1, color: "var(--blue)",
      h: chart.phone ? 48 : 54, xlabels: k === metrics.length - 1,
    }));
  }, [det, chart.phone]);

  return (
    <section className="card" aria-labelledby="rf-h">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 id="rf-h">Running form</h2><span className="small muted">Same time axis · dashed line is the run average</span>
      </div>
      {specs.filter(s => s.mean != null).map(s => (
        <div key={s.title} className="row" style={{ gap: "4px 16px", marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--grid)" }}>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 550 }}>{s.title}</div>
            <div className="small muted">avg {s.fmt(s.mean!)}</div>
          </div>
          <TimeSeriesChart spec={s} W={chart.phone ? 330 : 900} {...chart}
            style={{ flex: "999 1 560px", minWidth: 0, display: "block", width: "100%", height: "auto", overflow: "visible" }} />
        </div>
      ))}
    </section>
  );
}

/** Running-form averages only (runs synced from the API, until the next takeout import). */
function FormAverages({ run, det }: { run: Run; det: Detail }) {
  const fa = det.formAvg || {};
  const num = (k: string) => fa[k] ?? null;
  const items = ([
    ["Cadence", num("avgCadenceStepsPerMinute") != null ? Math.round(num("avgCadenceStepsPerMinute")!) + " spm" : run.cad ? run.cad + " spm" : null],
    ["Stride length", num("avgStrideLengthMillimeters") != null ? (num("avgStrideLengthMillimeters")! / 1000).toFixed(2) + " m" : null],
    ["Ground contact time", num("avgGroundContactTimeDuration") != null ? Math.round(num("avgGroundContactTimeDuration")! * 1000) + " ms" : null],
    ["Vertical oscillation", num("avgVerticalOscillationMillimeters") != null ? (num("avgVerticalOscillationMillimeters")! / 10).toFixed(1) + " cm" : null],
    ["Vertical ratio", num("avgVerticalRatio") != null ? num("avgVerticalRatio")!.toFixed(1) + " %" : null],
  ] as [string, string | null][]).filter((x): x is [string, string] => !!x[1]);

  return (
    <section className="card" aria-labelledby="rf-h">
      <h2 id="rf-h">Running form</h2>
      <div className="sub">
        {items.length
          ? "Run averages only. Per-second running form comes from the Google Takeout export; it appears for this run after the next takeout import."
          : "No running-form data was recorded for this run."}
      </div>
      {items.length > 0 && (
        <div className="statgrid" style={{ marginTop: 12 }}>
          {items.map(([l, v]) => <div key={l}><span className="small text2">{l}</span><span className="v">{v}</span></div>)}
        </div>
      )}
    </section>
  );
}

/** VO2 max from the run, the night before, and the week's training load. */
function Context({ run, det }: { run: Run; det: Detail }) {
  const { cal } = useData();
  const c = det.context;
  const night: [string, string, string][] = [
    c?.sleepH != null ? ["Sleep", fhm(c.sleepH), c.sleepScore != null ? "score " + c.sleepScore : "no score yet"] : ["Sleep", "No data", "watch not worn or not synced"],
    ["HRV", c?.hrv != null ? c.hrv + " ms" : "—", c?.hrv30 != null ? "30-day avg " + Math.round(c.hrv30) + " ms" : ""],
    ["Resting heart rate", c?.rhr != null ? c.rhr + " bpm" : "—", c?.rhr30 != null ? "30-day avg " + Math.round(c.rhr30) + " bpm" : ""],
  ];
  const gx = (v: number) => clamp(v / 2, 0, 1) * 300; // ratio 0..2 on a 300-wide gauge
  const acwrLabel = c?.acwrLabel ? labelCase(c.acwrLabel) : "";
  const big = { fontSize: 22, fontWeight: 600 } as const;

  return (
    <section aria-label="Context" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}><h2>VO2 max from this run</h2><span className="badge">Estimate</span></div>
        {run.vo2 ? (
          <>
            <div className="row" style={{ alignItems: "baseline", gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>≈ {Math.round(run.vo2)}</span><span className="unit">mL/kg/min</span>
            </div>
            <div className="small text2">Likely range {Math.round(run.vo2 - 1)}–{Math.round(run.vo2 + 1)} mL/kg/min</div>
          </>
        ) : <div className="small muted" style={{ marginTop: 4 }}>No run estimate for this run.</div>}
        <div className="small muted" style={{ marginTop: "auto" }}>{c?.vo2Daily ? "Daily VO2 max that day ≈ " + Math.round(c.vo2Daily) : ""}</div>
      </div>

      <div className="card">
        <h2>The night before</h2>
        <div className="sub">Night to {cal.fdw(run.d)}</div>
        <div className="table" role="table" aria-label="Sleep and recovery the night before" style={{ marginTop: 10 }}>
          {night.map(([l, v, note]) => (
            <div key={l} className="trow" role="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, padding: "7px 0" }}>
              <span role="cell" className="text2">{l}</span>
              <span role="cell" className="num"><span style={{ fontWeight: 600 }}>{v}</span> <span className="small muted">{note}</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2>Training load that week</h2>
        <div className="row" style={{ gap: 24, alignItems: "flex-start" }}>
          <div>
            <div className="small text2">Cardio load, week to date</div>
            <div style={big}>{c?.weekLoad ?? "—"}</div>
            <div className="small muted">{(run.load != null ? "This run: " + run.load + " · " : "") + "since Mon " + cal.fd(cal.day(c?.monday || run.date))}</div>
          </div>
          <div>
            <div className="small text2">Acute : chronic</div>
            <div style={big}>{c?.acwr != null ? c.acwr.toFixed(2) : "—"}</div>
            <div className="small">{acwrLabel}</div>
          </div>
        </div>
        {c?.acwr != null && (
          <>
            <svg viewBox="0 0 300 40" role="img" aria-label={`Acute to chronic workload ratio ${c.acwr.toFixed(2)}, ${acwrLabel}`} style={{ display: "block", width: "100%", height: "auto", marginTop: 4 }}>
              <rect x={0} y={12} width={300} height={8} rx={2} style={{ fill: "var(--grid)" }} />
              <rect x={gx(0.8)} y={12} width={fx(gx(1.3) - gx(0.8))} height={8} style={{ fill: "var(--aqua)", opacity: 0.55 }} />
              <path d={`M${fx(gx(c.acwr))} 10l-5 -8h10z`} style={{ fill: "var(--text)" }} />
              {[0, 0.5, 1, 1.5, 2].map(v => (
                <text key={v} x={fx(clamp(gx(v), 6, 294))} y={36} style={{ fontSize: 10, fill: "var(--muted)", textAnchor: "middle" }}>{v.toFixed(1)}</text>
              ))}
            </svg>
            <div className="small muted">Shaded band is the optimal range (0.8–1.3).</div>
          </>
        )}
      </div>
    </section>
  );
}
