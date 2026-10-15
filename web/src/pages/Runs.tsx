// Runs page: summary with weekly distance, personal records, progress charts and the table of all runs.
import { useMemo } from "react";
import { ProgressChart } from "../charts/ProgressChart";
import { WeeklyDistance } from "../charts/WeeklyDistance";
import { Seg } from "../components/Seg";
import { Run, useData } from "../data";
import { runHref, useSessionState } from "../hooks";
import { fdur, fint, fpace, hm } from "../lib/format";
import { Range, RANGES } from "./Overview";

export function Runs() {
  const { cal, runs } = useData();
  const [range, setRange] = useSessionState<Range>("runs.range", "all");
  const [hoverWeek, setHoverWeek] = useSessionState<number | null>("runs.hoverWeek", null);
  const T = cal.today;
  const start = range === "all" ? (runs[0] ? runs[0].d : T) : T - range + 1;
  const inRange = runs.filter(x => x.d >= start && x.d <= T);
  const km = inRange.reduce((s, x) => s + x.dist, 0), secs = inRange.reduce((s, x) => s + x.dur, 0);
  const stats: [string, string, string][] = [
    ["Runs", String(inRange.length), ""],
    ["Distance", km >= 100 ? fint(km) : km.toFixed(1), "km"],
    ["Time", hm(secs), ""],
    ["Average pace", km ? fpace(secs / km) : "—", "/km"],
  ];
  const weeks = range === 30 ? 12 : range === 90 ? 13 : 52;

  return (
    <>
      <div className="titlerow">
        <div>
          <h1>Runs</h1>
          <div className="caption">
            {(range === "all" ? "All time · " : "") + cal.fd(start, true) + " – " + cal.fd(T, true)} · Google Fit runs before 2026 have distance and time only
          </div>
        </div>
        <Seg options={RANGES} value={range} onChange={r => { setRange(r); setHoverWeek(null); }} size="lg" label="Date range" />
      </div>

      <section className="card" aria-label="Summary" style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
        <div style={{ flex: "1 1 260px", display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px 16px", alignContent: "start" }}>
          {stats.map(([label, value, unit]) => (
            <div key={label}>
              <div className="small text2">{label}</div>
              <div className="row" style={{ alignItems: "baseline", gap: 4, marginTop: 4 }}><span className="big">{value}</span><span className="unit">{unit}</span></div>
            </div>
          ))}
        </div>
        <div style={{ flex: "999 1 560px", minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <h2>Distance per week</h2><span className="small muted">Last {weeks} weeks · km</span>
          </div>
          <WeeklyDistance weeks={weeks} hover={hoverWeek ?? weeks - 1} onHover={setHoverWeek} />
        </div>
      </section>

      <PersonalRecords />
      <Progress />
      <RunsTable runs={inRange} range={range} />
    </>
  );
}

function PersonalRecords() {
  const { cal, runs } = useData();
  const best = (key: "best1k" | "best5k" | "best10k") =>
    runs.filter(x => x[key] != null).reduce<Run | null>((m, x) => (!m || x[key]! < m[key]! ? x : m), null);
  const b1 = best("best1k"), b5 = best("best5k"), b10 = best("best10k");
  const longest = runs.reduce<Run | null>((m, x) => (!m || x.dist > m.dist ? x : m), null);
  const records: { label: string; value: string; unit: string; sub: string; run: Run }[] = [];
  if (b1) records.push({ label: "Fastest 1 km", value: fpace(b1.best1k!), unit: "", sub: "Best single km split", run: b1 });
  if (b5) records.push({ label: "Fastest 5 km", value: fdur(b5.best5k!), unit: "", sub: fpace(b5.best5k! / 5) + " /km · best 5 km within a run", run: b5 });
  if (b10) records.push({ label: "Fastest 10 km", value: fdur(b10.best10k!), unit: "", sub: fpace(b10.best10k! / 10) + " /km · best 10 km within a run", run: b10 });
  if (longest) records.push({ label: "Longest run", value: longest.dist.toFixed(2), unit: "km", sub: fdur(longest.dur) + " · " + fpace(longest.pace) + " /km", run: longest });

  return (
    <section aria-labelledby="pr-h">
      <h2 id="pr-h" style={{ marginBottom: 12 }}>Personal records</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
        {records.map(p => (
          <a key={p.label} href={runHref(p.run.id)} className="tile" style={{ textDecoration: "none", color: "var(--text)" }}>
            <span className="small text2">{p.label}</span>
            <span className="row" style={{ alignItems: "baseline", gap: 5 }}><span className="big">{p.value}</span><span className="unit">{p.unit}</span></span>
            <span className="small muted">{p.sub}</span>
            <span className="small text2" style={{ marginTop: 6, textDecoration: "underline", textUnderlineOffset: 3 }}>
              {cal.fdw(p.run.d, true) + (p.label === "Longest run" ? "" : " · " + p.run.dist.toFixed(2) + " km run")}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function Progress() {
  const { runs } = useData();
  const watch = useMemo(() => runs.filter(x => x.src === "watch"), [runs]);
  return (
    <section aria-labelledby="pg-h">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 id="pg-h">Progress</h2>
        <span className="small muted">Dots are single runs, the line is a 5-run rolling average. Watch-recorded runs only.</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
        <ProgressChart title="Aerobic efficiency" sub="Pace adjusted to 155 bpm · min/km · faster is up" invert tick={fpace} fmt={fpace}
          points={watch.filter(x => x.hr && x.type === "Outdoor").map(x => ({ d: x.d, y: x.pace + (x.hr! - 155) * 2.2 }))} />
        <ProgressChart title="VO2 max per run" sub="Run estimate · mL/kg/min" estimate tick={String} fmt={q => "≈ " + Math.round(q)}
          points={watch.filter(x => x.vo2).map(x => ({ d: x.d, y: x.vo2! }))} />
        <ProgressChart title="Cadence" sub="Average per run · steps/min" tick={String} fmt={q => String(Math.round(q))}
          points={watch.filter(x => x.cad).map(x => ({ d: x.d, y: x.cad! }))} />
      </div>
    </section>
  );
}

type SortKey = "date" | "dist" | "pace" | "hr";
const SORT_VALUE: Record<SortKey, (x: Run) => string | number> = {
  date: x => x.start, dist: x => x.dist, pace: x => x.pace, hr: x => x.hr ?? -1,
};

function RunsTable({ runs, range }: { runs: Run[]; range: Range }) {
  const { cal } = useData();
  const [sort, setSort] = useSessionState<{ key: SortKey; dir: 1 | -1 }>("runs.sort", { key: "date", dir: -1 });
  const [type, setType] = useSessionState<"all" | "Outdoor" | "Treadmill">("runs.type", "all");
  const [minKm, setMinKm] = useSessionState("runs.minKm", "");
  const [maxKm, setMaxKm] = useSessionState("runs.maxKm", "");
  const [limit, setLimit] = useSessionState("runs.limit:" + range, 20);

  const mn = parseFloat(minKm), mx = parseFloat(maxKm);
  const value = SORT_VALUE[sort.key];
  const list = runs
    .filter(x => (type === "all" || x.type === type) && (isNaN(mn) || x.dist >= mn) && (isNaN(mx) || x.dist <= mx))
    .sort((a, b) => {
      const ka = value(a), kb = value(b);
      if (sort.key === "hr") { // runs without heart rate always last
        if ((ka as number) < 0 && (kb as number) >= 0) return 1;
        if ((kb as number) < 0 && (ka as number) >= 0) return -1;
      }
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sort.dir;
    });
  const shown = list.slice(0, limit);
  const cols = "minmax(170px,1.8fr) repeat(7,minmax(64px,1fr)) 64px";
  const dash = <span className="muted">—</span>;
  const filtered = (f: () => void) => () => { f(); setLimit(20); };

  const sortHead = (k: SortKey, label: string, align: "left" | "right") => {
    const on = sort.key === k;
    return (
      <span key={k} role="columnheader" aria-sort={on ? (sort.dir < 0 ? "descending" : "ascending") : "none"} style={{ textAlign: align }}>
        <button type="button" onClick={() => setSort(on ? { key: k, dir: (-sort.dir) as 1 | -1 } : { key: k, dir: k === "pace" ? 1 : -1 })}
          style={{ fontSize: 12, border: 0, background: "transparent", padding: "4px 0", cursor: "pointer", color: on ? "var(--text)" : "var(--muted)", fontWeight: on ? 600 : 400 }}>
          {label} {on ? (sort.dir < 0 ? "↓" : "↑") : ""}
        </button>
      </span>
    );
  };
  const plainHead = (label: string) => (
    <span key={label} role="columnheader" style={{ textAlign: "right" }}><span style={{ display: "inline-block", padding: "4px 0" }}>{label}</span></span>
  );

  return (
    <section className="card" aria-labelledby="all-h">
      <div className="row" style={{ justifyContent: "space-between", gap: "12px 16px", marginBottom: 12 }}>
        <div>
          <h2 id="all-h">All runs</h2>
          <div className="sub">{list.length} {list.length === 1 ? "run" : "runs"} in range · click a date for run detail</div>
        </div>
        <div className="row">
          <Seg options={[["all", "All"], ["Outdoor", "Outdoor"], ["Treadmill", "Treadmill"]]} value={type}
            onChange={v => filtered(() => setType(v))()} size="md" label="Run type" />
          <div className="row text2" style={{ gap: 6, fontSize: 13 }}>
            <label htmlFor="kmmin">Distance</label>
            <input id="kmmin" type="number" min="0" step="0.5" placeholder="min" value={minKm} aria-label="Minimum distance in km"
              onChange={e => filtered(() => setMinKm(e.target.value))()} />
            <span aria-hidden="true">–</span>
            <input type="number" min="0" step="0.5" placeholder="max" value={maxKm} aria-label="Maximum distance in km"
              onChange={e => filtered(() => setMaxKm(e.target.value))()} />
            <span>km</span>
          </div>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <div className="table" role="table" aria-label="Runs" style={{ minWidth: 940 }}>
          <div className="trow thead" role="row" style={{ gridTemplateColumns: cols, padding: "0 4px 8px" }}>
            {sortHead("date", "Date", "left")}
            {sortHead("dist", "Distance", "right")}
            {plainHead("Moving time")}
            {sortHead("pace", "Avg pace", "right")}
            {sortHead("hr", "Avg HR", "right")}
            {plainHead("Elev. gain")}
            {plainHead("Cardio load")}
            {plainHead("Effort")}
            {plainHead("Route")}
          </div>
          {shown.map(x => (
            <div key={x.id} className="trow" role="row" style={{ gridTemplateColumns: cols, padding: "8px 4px" }}>
              <span role="cell" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <a href={runHref(x.id)} style={{ color: "var(--text)", fontWeight: 550, textDecoration: "none" }}>{cal.fdw(x.d, true)}</a>
                <span className="row small muted" style={{ gap: 6 }}>
                  {x.start.slice(11, 16)} · {x.type}{x.src === "fit" && <span className="badge">Google Fit</span>}
                </span>
              </span>
              <span role="cell" className="num">{x.dist.toFixed(2)} km</span>
              <span role="cell" className="num">{fdur(x.dur)}</span>
              <span role="cell" className="num">{fpace(x.pace)} /km</span>
              <span role="cell" className="num">{x.hr != null ? x.hr + " bpm" : dash}</span>
              <span role="cell" className="num">{x.elev != null ? x.elev + " m" : dash}</span>
              <span role="cell" className="num">{x.load ?? dash}</span>
              <span role="cell" className="num" title={x.note ?? undefined}>
                {x.rpe != null ? "RPE " + x.rpe : dash}{x.note ? <span className="muted" aria-label="Has a note"> ✎</span> : null}
              </span>
              <span role="cell" style={{ display: "flex", justifyContent: "flex-end" }}>
                {x.route ? (
                  <svg viewBox="0 0 56 40" width="56" height="40" aria-hidden="true" style={{ display: "block", borderRadius: 6, background: "var(--page)" }}>
                    <path d={x.route.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join("")}
                      style={{ fill: "none", stroke: "var(--blue)", strokeWidth: 1.6, strokeLinejoin: "round" }} />
                  </svg>
                ) : <span className="small muted" style={{ width: 56, textAlign: "center" }}>No GPS</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {list.length > shown.length && <button type="button" className="btn" onClick={() => setLimit(limit + 20)}>Show 20 more</button>}
        <span className="small muted">Showing {shown.length} of {list.length}</span>
      </div>
    </section>
  );
}
