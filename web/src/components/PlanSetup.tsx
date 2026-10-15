// Goal form for a new training plan: pick the goal, preview the generated plan, then save it.
import { useState } from "react";
import * as api from "../api";
import { useData } from "../data";
import { fdur, fpace } from "../lib/format";
import { addDays, GOALS, goalName, KINDS, paceRange, parseTime, WEEKDAYS } from "../lib/training";
import type { PlanInput, PlanPreview } from "../types";
import { Seg } from "./Seg";

const PACE_ROWS: [string, string][] = [
  ["easy", "Easy and long runs"], ["tempo", "Tempo"], ["intervals", "Intervals"], ["race", "Race pace"],
];

export function PlanSetup({ today, onSaved, onCancel }: { today: string; onSaved: () => void; onCancel?: () => void }) {
  const [goal, setGoal] = useState<number | "custom">(10);
  const [customKm, setCustomKm] = useState("15");
  const [date, setDate] = useState(addDays(today, 7 * 10));
  const [time, setTime] = useState("");
  const [days, setDays] = useState<number[]>([1, 3, 6]);
  const [longDay, setLongDay] = useState(6);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const km = goal === "custom" ? parseFloat(customKm) : goal;
  const goalTime = time.trim() ? parseTime(time) : null;
  const timeBad = !!time.trim() && goalTime == null;
  const input = (): PlanInput => ({
    goal_km: km, goal_date: date, goal_time_s: goalTime, runs_per_week: days.length, days, long_day: longDay,
  });
  const change = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreview(null); setError(null); };

  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    change(setDays)(next);
    if (!next.includes(longDay) && next.length) setLongDay(next[next.length - 1]);
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const doPreview = () => run(async () => setPreview(await api.previewPlan(input())));
  const doSave = () => run(async () => { await api.createPlan(input()); onSaved(); });

  const valid = km > 0 && !timeBad && days.length >= 3 && days.length <= 6 && days.includes(longDay);

  return (
    <section className="card" aria-labelledby="ps-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 id="ps-h">New training plan</h2>
          <div className="sub">Built from your last 6 weeks of runs. You can edit every session afterwards.</div>
        </div>
        {onCancel && <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>}
      </div>

      <div className="form">
        <span className="label" id="goal-l">Goal</span>
        <div className="row">
          <Seg options={[...GOALS, ["custom", "Other"]] as [number | "custom", string][]} value={goal} onChange={change(setGoal)} size="md" labelledBy="goal-l" />
          {goal === "custom" && (
            <span className="row" style={{ gap: 6 }}>
              <input type="number" min="1" max="100" step="0.1" value={customKm} aria-label="Goal distance in km"
                onChange={e => change(setCustomKm)(e.target.value)} /> km
            </span>
          )}
        </div>

        <label className="label" htmlFor="ps-date">Race or goal date</label>
        <input id="ps-date" type="date" value={date} min={addDays(today, 21)} max={addDays(today, 182)}
          onChange={e => change(setDate)(e.target.value)} />

        <label className="label" htmlFor="ps-time">Goal time <span className="muted">(optional)</span></label>
        <div className="row" style={{ gap: 8 }}>
          <input id="ps-time" type="text" inputMode="numeric" placeholder={km >= 21 ? "h:mm:ss" : "mm:ss"} value={time}
            aria-invalid={timeBad} onChange={e => change(setTime)(e.target.value)} style={{ width: 110 }} />
          <span className="small muted">{timeBad ? "Write it as mm:ss or h:mm:ss." : "Leave empty to train for what your fitness predicts."}</span>
        </div>

        <span className="label" id="days-l">Training days</span>
        <div>
          <div className="seg" role="group" aria-labelledby="days-l">
            {WEEKDAYS.map((w, d) => (
              <button key={w} type="button" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}>{w}</button>
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {days.length} {days.length === 1 ? "run" : "runs"} a week{days.length < 3 || days.length > 6 ? " · pick 3 to 6 days" : ""}
          </div>
        </div>

        <label className="label" htmlFor="ps-long">Long run on</label>
        <select id="ps-long" value={longDay} onChange={e => change(setLongDay)(Number(e.target.value))}>
          {days.map(d => <option key={d} value={d}>{WEEKDAYS[d]}</option>)}
        </select>
      </div>

      {error && <div className="banner" role="alert">{error}</div>}

      <div className="row">
        <button type="button" className="btn" disabled={!valid || busy} onClick={doPreview}>{busy && !preview ? "Building…" : "Preview plan"}</button>
        {preview && <button type="button" className="btn primary" disabled={busy} onClick={doSave}>Start this plan</button>}
      </div>

      {preview && <Preview preview={preview} km={km} />}
    </section>
  );
}

function Preview({ preview: p, km }: { preview: PlanPreview; km: number }) {
  const { cal } = useData();
  const maxKm = Math.max(...p.weeks.map(w => w.km), 1);
  const first = p.sessions.slice(0, 8);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, borderTop: "1px solid var(--grid)", paddingTop: 16 }}>
      {p.warnings.map(w => <div key={w} className="banner" role="note">{w}</div>)}
      <div className="statgrid">
        <div><span className="small text2">Current volume</span><span className="v">{p.fitness.weekly_km} km</span><span className="small muted">a week, last 6 weeks</span></div>
        <div><span className="small text2">Longest recent run</span><span className="v">{p.fitness.longest_km} km</span></div>
        <div><span className="small text2">Predicted {goalName(km)}</span><span className="v">{fdur(p.predictedS)}</span><span className="small muted">from {p.fitness.basis}</span></div>
        <div><span className="small text2">Peak week</span><span className="v">{Math.max(...p.weeks.map(w => w.km)).toFixed(0)} km</span><span className="small muted">{p.weeks.length} weeks to the goal</span></div>
      </div>

      <div>
        <h3>Weekly volume</h3>
        <div className="sub">Grows at most 10 % (or 3 km) a week; every 4th week is lighter, then a taper</div>
        <div role="img" aria-label="Planned km per week" style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 90, marginTop: 10 }}>
          {p.weeks.map(w => (
            <div key={w.monday} title={`${cal.fd(cal.day(w.monday))}: ${w.km} km · ${w.phase}${w.recovery ? " (recovery)" : ""}`}
              style={{ flex: 1, height: Math.max(3, (w.km / maxKm) * 90), borderRadius: "3px 3px 0 0",
                background: w.phase === "taper" ? "var(--yellow)" : w.recovery ? "var(--p1)" : "var(--blue)" }} />
          ))}
        </div>
        <div className="row small muted" style={{ marginTop: 6, gap: 14 }}>
          <span className="legend"><span className="dot" style={{ background: "var(--blue)" }} />Training</span>
          <span className="legend"><span className="dot" style={{ background: "var(--p1)" }} />Recovery week</span>
          <span className="legend"><span className="dot" style={{ background: "var(--yellow)" }} />Taper and race</span>
        </div>
      </div>

      <div>
        <h3>Your paces</h3>
        <div className="table" role="table" style={{ marginTop: 6 }}>
          {PACE_ROWS.map(([k, label]) => (
            <div key={k} className="trow" role="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto", padding: "6px 0" }}>
              <span role="cell" className="text2">{label}</span>
              <span role="cell" className="num">{paceRange(p.paces[k][0], p.paces[k][1])}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3>First sessions</h3>
        <div className="table" role="table" style={{ marginTop: 6 }}>
          {first.map(s => (
            <div key={s.date + s.kind} className="trow" role="row" style={{ gridTemplateColumns: "110px 10px minmax(0,1fr) 60px", padding: "7px 0" }}>
              <span role="cell" className="text2">{cal.fdw(cal.day(s.date))}</span>
              <span className="dot" aria-hidden="true" style={{ background: KINDS.find(x => x.kind === s.kind)!.color }} />
              <span role="cell"><span style={{ fontWeight: 550 }}>{s.title}</span> <span className="small muted">{s.description}</span></span>
              <span role="cell" className="num">{s.km} km</span>
            </div>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Easy pace {fpace(p.paces.easy[0])}–{fpace(p.paces.easy[1])} /km is meant to feel conversational.</div>
      </div>
    </div>
  );
}
