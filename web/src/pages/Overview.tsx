// Overview page: latest-value tiles, trend charts and the load-and-recovery table.
import { useMemo } from "react";
import { Bucket, BucketMode, TrendChart, TrendSpec } from "../charts/TrendChart";
import { Seg } from "../components/Seg";
import { Dataset, useData } from "../data";
import { usePhone, useSessionState } from "../hooks";
import { Calendar, MON } from "../lib/calendar";
import { clamp, fhm, fhmShort, fint, fx, latest, mean, signed } from "../lib/format";
import type { Series } from "../types";

export type Range = 30 | 90 | 365 | "all";
export const RANGES: [Range, string][] = [[30, "30 days"], [90, "90 days"], [365, "1 year"], ["all", "All time"]];

/** Daily buckets for 30/90 days, weekly for a year, monthly for all time. */
function makeBuckets(cal: Calendar, range: Range): { buckets: Bucket[]; mode: BucketMode } {
  const T = cal.today, B: Bucket[] = [];
  if (range === 30 || range === 90) {
    for (let k = T - range + 1; k <= T; k++) B.push({ k, a: k, b: k, label: cal.fdw(k), tick: cal.fd(k) });
    return { buckets: B, mode: "daily" };
  }
  if (range === 365) {
    for (let k = cal.monday(T - 364); k <= T; k += 7) B.push({ k, a: k, b: Math.min(k + 6, T), label: "Week of " + cal.fd(k), tick: cal.fd(k) });
    return { buckets: B, mode: "weekly" };
  }
  const y0 = cal.date(0).getUTCFullYear(), y1 = cal.date(T).getUTCFullYear();
  for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) {
    const a = cal.dayOfTime(Date.UTC(y, m, 1));
    if (a > T) break;
    const b = Math.min(cal.dayOfTime(Date.UTC(y, m + 1, 1)) - 1, T);
    B.push({ k: a, a, b, label: MON[m] + " " + y, tick: m === 0 ? String(y) : MON[m], month: m });
  }
  return { buckets: B, mode: "monthly" };
}

function makeSpecs(S: Dataset["daily"], B: Bucket[], mode: BucketMode): TrendSpec[] {
  const agg = (arr: Series) => B.map(b => mean(arr, b.a, b.b));
  const per = mode === "daily" ? "Per day" : mode === "weekly" ? "Weekly averages" : "Monthly averages";
  const round = (q: number) => String(Math.round(q));
  const clip = mode === "monthly";
  return [
    { id: "steps", title: "Steps", sub: per + (mode === "daily" ? "" : " of daily steps"), mode, clip,
      panels: [{ v: agg(S.steps), kind: "bar", color: "var(--blue)", h: 140, min: 0, fmt: fint, unit: "steps", label: "Steps", tick: q => (q >= 1000 ? fx(q / 1000) + "k" : String(q)) }] },
    { id: "sleep", title: "Sleep", sub: per + " · hours asleep and sleep score", mode, clip,
      legend: [
        { label: "Hours asleep", color: "var(--blue)", swatch: { width: 10, height: 10, borderRadius: 2 } },
        { label: "Sleep score", color: "var(--orange)", swatch: { width: 14, height: 2, borderRadius: 1 } },
      ],
      panels: [
        { v: agg(S.slH), kind: "bar", color: "var(--blue)", h: 104, min: 0, max: 9, fmt: fhm, label: "Hours asleep", tick: q => q + " h" },
        { v: agg(S.slS), kind: "line", color: "var(--orange)", h: 72, min: 60, max: 100, fmt: round, short: "score", label: "Sleep score" },
      ] },
    { id: "rhr", title: "Resting heart rate", sub: per + " · bpm", mode, clip,
      panels: [{ v: agg(S.rhr), kind: "line", color: "var(--blue)", h: 140, fmt: round, unit: "bpm", label: "bpm" }] },
    { id: "hrv", title: "Heart rate variability", sub: per + " · RMSSD, ms", mode, clip,
      panels: [{ v: agg(S.hrv), kind: "line", color: "var(--blue)", h: 140, fmt: round, unit: "ms", label: "ms" }] },
    { id: "spo2", title: "Blood oxygen during sleep", sub: per + " · night average, %", mode, clip,
      panels: [{ v: agg(S.spo2), kind: "line", color: "var(--blue)", h: 140, min: 92, max: 100, fmt: q => q.toFixed(1), unit: "%", label: "%" }] },
    { id: "vo2", title: "VO2 max", sub: "Estimate · mL/kg/min · " + per.toLowerCase(), mode, clip,
      panels: [{ v: agg(S.vo2), kind: "line", color: "var(--blue)", h: 140, fmt: q => "≈ " + Math.round(q), label: "Estimate" }] },
    { id: "wt", title: "Weight", sub: "Logged measurements · kg" + (mode === "daily" ? "" : " · " + per.toLowerCase()), mode, clip: true, wide: true,
      panels: [{ v: agg(S.wt), kind: "line", color: "var(--blue)", h: 110, fmt: q => q.toFixed(1), unit: "kg", label: "kg", connect: true, markers: true }] },
  ];
}

/** Hover starts ~80 % along, on a bucket that has both sleep and steps. */
function defaultHover(B: Bucket[], S: Dataset["daily"]) {
  let j = Math.max(0, B.length - 1 - Math.round(B.length * 0.2));
  while (j > 0 && (mean(S.slH, B[j].a, B[j].b) == null || mean(S.steps, B[j].a, B[j].b) == null)) j--;
  return B[j].k;
}

export function Overview() {
  const { cal, daily: S } = useData();
  const phone = usePhone();
  const [range, setRange] = useSessionState<Range>("ov.range", 90);
  const [hover, setHover] = useSessionState<number | null>("ov.hover", null);
  const [tables, setTables] = useSessionState<Record<string, boolean>>("ov.tables", {});

  const { buckets, mode } = useMemo(() => makeBuckets(cal, range), [cal, range]);
  const specs = useMemo(() => makeSpecs(S, buckets, mode), [S, buckets, mode]);
  const hoverKey = hover != null && buckets.some(b => b.k === hover) ? hover : defaultHover(buckets, S);
  const first = range === "all" ? 0 : buckets[0].a;
  const caption = mode === "daily" ? "daily values" : mode === "weekly" ? "weekly averages" : "monthly averages";

  return (
    <>
      <div className="titlerow">
        <div>
          <h1>Overview</h1>
          <div className="caption">{cal.fd(first, true)} – {cal.fd(cal.today, true)} · {caption}</div>
        </div>
        <Seg options={RANGES} value={range} onChange={r => { setRange(r); setHover(null); }} size="lg" label="Date range" />
      </div>
      <Tiles />
      <section className="charts" aria-label="Trends">
        {specs.map(sp => (
          <TrendChart key={sp.id} spec={sp} buckets={buckets} W={sp.wide && !phone ? 1128 : phone ? 330 : 548} phone={phone}
            hoverKey={hoverKey} onHover={setHover}
            showTable={!!tables[sp.id]} onToggleTable={() => setTables({ ...tables, [sp.id]: !tables[sp.id] })} />
        ))}
      </section>
      <LoadRecovery range={range} />
      <footer className="small muted" style={{ padding: "8px 0 24px" }}>
        VO2 max and readiness are watch estimates. Gaps in the charts are days without data; values are never
        interpolated across them. Sleep scores come from takeout exports only.
      </footer>
    </>
  );
}

// --- tiles ------------------------------------------------------------------------------------

interface Tile { label: string; value: string; unit: string; date: string; avg: string; estimate?: boolean }

function Tiles() {
  const { cal, daily: S, runs } = useData();
  const T = cal.today, LAST = cal.last;
  const avg30 = (arr: Series, end: number) => mean(arr, end - 29, end) ?? 0;
  const tiles: Tile[] = [];

  const ri = latest(S.rhr, T), hi = latest(S.hrv, T), si = latest(S.slH, T), sti = latest(S.steps, LAST), vi = latest(S.vo2, T);
  if (ri >= 0) tiles.push({ label: "Resting heart rate", value: String(S.rhr[ri]), unit: "bpm", date: cal.fdw(ri), avg: `30-day avg ${Math.round(avg30(S.rhr, T))} bpm` });
  if (hi >= 0) tiles.push({ label: "HRV", value: String(S.hrv[hi]), unit: "ms", date: cal.fdw(hi), avg: `30-day avg ${Math.round(avg30(S.hrv, T))} ms` });
  if (si >= 0) {
    const score = S.slS[si], scoreAvg = mean(S.slS, T - 29, T);
    tiles.push({ label: "Last night’s sleep", value: fhm(S.slH[si]!), unit: score == null ? "· score pending" : "· score " + score,
      date: "Night to " + cal.fdw(si), avg: "30-day avg " + fhm(avg30(S.slH, T)) + (scoreAvg ? " · " + Math.round(scoreAvg) : "") });
  }
  if (sti >= 0) tiles.push({ label: "Steps", value: fint(S.steps[sti]!), unit: "", date: cal.fdw(sti) + (sti === LAST ? " (last full day)" : ""), avg: "30-day avg " + fint(avg30(S.steps, LAST)) });
  if (vi >= 0) tiles.push({ label: "VO2 max", value: "≈ " + Math.round(S.vo2[vi]!), unit: "mL/kg/min", date: cal.fdw(vi), avg: "30-day avg ≈ " + Math.round(avg30(S.vo2, T)), estimate: true });

  const mon = cal.monday(T);
  let weekKm = 0, km30 = 0;
  for (let i = mon; i <= T; i++) weekKm += S.runKm[i] || 0;
  for (let i = T - 29; i <= T; i++) km30 += S.runKm[i] || 0;
  const weekRuns = runs.filter(r => r.d >= mon && r.d <= T).length;
  tiles.push({ label: "Running this week", value: weekKm.toFixed(1), unit: "km",
    date: `${weekRuns} ${weekRuns === 1 ? "run" : "runs"} since Mon ${cal.fd(mon)}`, avg: `30-day avg ${((km30 / 30) * 7).toFixed(1)} km / week` });

  return (
    <section className="tiles" aria-label="Latest values">
      {tiles.map(t => (
        <div key={t.label} className="tile">
          <div className="row small text2" style={{ justifyContent: "space-between", gap: 8 }}>
            <span>{t.label}</span>{t.estimate && <span className="badge">Estimate</span>}
          </div>
          <div className="row" style={{ alignItems: "baseline", gap: 5, marginTop: 2 }}>
            <span className="big">{t.value}</span><span className="unit">{t.unit}</span>
          </div>
          <div className="small muted">{t.date}</div>
          <div className="avg">{t.avg}</div>
        </div>
      ))}
    </section>
  );
}

// --- load and recovery -------------------------------------------------------------------------

/** Each day's cardio load next to the night that followed it, with HRV and resting HR against the previous 30 days. */
function LoadRecovery({ range }: { range: Range }) {
  const { cal, daily: S } = useData();
  const phone = usePhone();
  const [showAll, setShowAll] = useSessionState("ov.stripAll", false);
  const maxRows = range === "all" ? 90 : Math.min(90, range);
  const nRows = showAll ? maxRows : 14;

  const rows = [];
  for (let i = cal.last; i > cal.last - nRows; i--) {
    const night = i + 1, load = S.load[i];
    const hrvBase = mean(S.hrv, night - 30, night - 1), rhrBase = mean(S.rhr, night - 30, night - 1);
    const hrv = S.hrv[night], rhr = S.rhr[night], sleepH = S.slH[night], score = S.slS[night];
    const noData = sleepH == null;
    const low = !noData && hrv != null && hrvBase != null && (hrv < hrvBase * 0.88 || (rhr != null && rhrBase != null && rhr >= rhrBase + 3));
    // HRV deviation bar: centred at 0, full width at ±30 %
    let hrvBar = { left: 50, width: 0 }, hrvDev = "";
    if (hrv != null && hrvBase) {
      const dv = clamp((hrv - hrvBase) / hrvBase, -0.3, 0.3), w = (Math.abs(dv) / 0.3) * 50;
      hrvBar = { left: dv < 0 ? fx(50 - w) : 50, width: fx(w) };
      hrvDev = signed(Math.round(((hrv - hrvBase) / hrvBase) * 100)) + "%";
    }
    const sleepTxt = sleepH == null ? "" : phone
      ? fhmShort(sleepH) + (score != null ? " · " + score : "")
      : fhm(sleepH) + (score != null ? " · " + score : " · no score");
    rows.push({
      i, day: phone ? cal.fd(i) : cal.fdw(i), load, noData, low, sleepH, sleepTxt, hrv, hrvBar, hrvDev, rhr,
      rhrDev: rhr != null && rhrBase ? signed(Math.round(rhr - rhrBase)) : "",
    });
  }
  const cols = phone ? "58px minmax(0,1fr) minmax(0,0.9fr) 30px 30px" : "112px minmax(0,1.1fr) minmax(0,1.5fr) minmax(0,1.3fr) 90px 130px";

  return (
    <section className="card" aria-labelledby="rec-h">
      <div className="chart-head" style={{ marginBottom: 12, gap: "8px 16px" }}>
        <div>
          <h2 id="rec-h">Load and recovery</h2>
          <div className="sub">Each day's training load next to the night that followed it. HRV and resting heart rate are compared with the previous 30 days.</div>
        </div>
        <div className="row small text2">
          <span className="legend"><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "var(--orange)" }} />Cardio load</span>
          <span className="legend"><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "var(--blue)" }} />Sleep</span>
          <span className="legend"><span className="dot" aria-hidden="true" style={{ width: 10, height: 10, background: "var(--yellow)" }} />Low recovery</span>
        </div>
      </div>
      <div className="table" role="table" aria-label="Load and recovery by day">
        <div className="trow thead" role="row" style={{ gridTemplateColumns: cols }}>
          <span role="columnheader">Day</span><span role="columnheader">Load</span><span role="columnheader">Sleep that night</span>
          <span role="columnheader">HRV</span><span role="columnheader">Rest HR</span>{!phone && <span role="columnheader">Status</span>}
        </div>
        {rows.map(r => (
          <div key={r.i} className="trow" role="row" style={{ gridTemplateColumns: cols, minHeight: 36 }}>
            <span role="cell" className="row text2" style={{ gap: 6, whiteSpace: "nowrap" }}>
              {r.day}{r.low && phone && <span className="dot" aria-label="Low recovery" style={{ background: "var(--yellow)" }} />}
            </span>
            <span role="cell" className="row" style={{ gap: 8, minWidth: 0, flexWrap: "nowrap" }}>
              <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: fx(Math.min(1, (r.load || 0) / 160) * 100) + "%", background: "var(--orange)" }} /></span>
              <span style={{ width: 26, textAlign: "right" }}>{r.load ?? "—"}</span>
            </span>
            {r.noData ? (
              <span role="cell" className="muted small" style={{ gridColumn: "3 / -1", fontStyle: "italic" }}>No night data (watch not worn)</span>
            ) : (
              <>
                <span role="cell" className="row" style={{ gap: 8, minWidth: 0, flexWrap: "nowrap" }}>
                  {!phone && <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: fx((r.sleepH! / 9) * 100) + "%", background: "var(--blue)" }} /></span>}
                  <span style={{ whiteSpace: "nowrap" }}>{r.sleepTxt}</span>
                </span>
                <span role="cell" className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                  <span style={{ width: 26, textAlign: "right" }}>{r.hrv ?? "—"}</span>
                  {!phone && <>
                    <span aria-hidden="true" style={{ position: "relative", width: 56, height: 8 }}>
                      <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--muted)" }} />
                      <span style={{ position: "absolute", top: 0, bottom: 0, left: r.hrvBar.left + "%", width: r.hrvBar.width + "%", background: "var(--text2)", opacity: 0.5, borderRadius: 1 }} />
                    </span>
                    <span className="small muted">{r.hrvDev}</span>
                  </>}
                </span>
                <span role="cell" className="row" style={{ gap: 6, alignItems: "baseline", flexWrap: "nowrap" }}>
                  <span>{r.rhr ?? "—"}</span>{!phone && <span className="small muted">{r.rhrDev}</span>}
                </span>
                {!phone && (
                  <span role="cell">
                    {r.low && <span className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text)" }}><span className="dot" aria-hidden="true" style={{ background: "var(--yellow)" }} />Low recovery</span>}
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => setShowAll(!showAll)}>{showAll ? "Show last 14 days" : `Show all ${maxRows} days`}</button>
      </div>
    </section>
  );
}
