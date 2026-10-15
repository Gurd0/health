// Training page: today's session and recovery check, warnings, the plan week by week with what you
// actually ran, weekly targets and streak, and training load. Without a plan: the goal form and
// plain weekly targets.
import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { LoadChart, PlanWeeksChart } from "../charts/TrainingCharts";
import { PlanSetup } from "../components/PlanSetup";
import { SessionEditor } from "../components/SessionEditor";
import { useData } from "../data";
import { runHref } from "../hooks";
import { fdur, fhm, fpace } from "../lib/format";
import { goalName, kindOf, paceRange, STATUS } from "../lib/training";
import type { Flag, Session, Training as TrainingData, Verdict, Week } from "../types";

export function Training() {
  const { meta } = useData();
  const [t, setT] = useState<TrainingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPlan, setNewPlan] = useState(false);
  const [editor, setEditor] = useState<{ session: Session | null; date: string } | null>(null);

  const load = useCallback(() => api.getTraining().then(x => { setT(x); setError(null); }, e => setError(e.message)), []);
  useEffect(() => { load(); }, [load, meta.generated]);

  if (error) return <div className="loading">Couldn't load training data ({error}).</div>;
  if (!t) return <div className="loading">Loading…</div>;

  const act = async (f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { alert((e as Error).message); }
    await load();
  };

  if (!t.plan || newPlan) {
    return (
      <>
        <div className="titlerow"><div><h1>Training</h1><div className="caption">Set a goal and get a plan built from your recent running.</div></div></div>
        <PlanSetup today={t.today} onSaved={() => { setNewPlan(false); load(); }} onCancel={t.plan ? () => setNewPlan(false) : undefined} />
        {!t.plan && <Targets t={t} onSaved={load} />}
        {!t.plan && <Flags flags={t.flags} />}
        {!t.plan && <LoadCard t={t} />}
      </>
    );
  }

  const plan = t.plan;
  const weeksLeft = Math.ceil((Date.parse(plan.goalDate) - Date.parse(t.today)) / 864e5 / 7);
  return (
    <>
      <div className="titlerow">
        <div>
          <h1>{plan.name}</h1>
          <div className="caption">
            {goalName(plan.goalKm)} on {fmtDate(plan.goalDate)}
            {plan.goalTimeS ? " · goal " + fdur(plan.goalTimeS) : ""}
            {weeksLeft > 0 ? ` · ${weeksLeft} ${weeksLeft === 1 ? "week" : "weeks"} to go` : ""}
            {plan.predictedS ? " · fitness predicts " + fdur(plan.predictedS) : ""}
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={() => {
            if (confirm("Rebuild the remaining weeks from your current fitness? Past sessions and sessions you edited, linked or skipped are kept.")) act(() => api.rebuildPlan(plan.id));
          }}>Rebuild remaining weeks</button>
          <button type="button" className="btn" onClick={() => setNewPlan(true)}>New plan</button>
        </div>
      </div>

      <Flags flags={t.flags} onAction={a => a === "rebuild" ? act(() => api.rebuildPlan(plan.id))
        : confirm("Archive this plan?") && act(() => api.archivePlan(plan.id))} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
        <Today t={t} onEdit={s => setEditor({ session: s, date: s.date })} onSwap={(a, b) => act(() => api.swapSessions(a, b))} />
        <ThisWeek t={t} />
      </div>

      <section className="card" aria-labelledby="pw-h">
        <div className="chart-head">
          <div><h2 id="pw-h">Km per week</h2><div className="sub">Outline = planned · filled = done (green when the week's target was hit)</div></div>
        </div>
        <PlanWeeksChart weeks={t.weeks} />
      </section>

      <WeekList t={t} onEdit={(session, date) => setEditor({ session, date })} />
      <LoadCard t={t} />

      {editor && <SessionEditor session={editor.session} date={editor.date} plan={plan}
        onClose={changed => { setEditor(null); if (changed) load(); }} />}
    </>
  );
}

const fmtDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + " " + d.getUTCDate() + ". "
    + ["jan.", "feb.", "mars", "apr.", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."][d.getUTCMonth()];
};

function Flags({ flags, onAction }: { flags: Flag[]; onAction?: (a: "rebuild" | "archive") => void }) {
  if (!flags.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {flags.map(f => (
        <div key={f.text} className={"banner " + f.level} role={f.level === "high" ? "alert" : "status"}>
          <div>{f.text}</div>
          {f.action && onAction && (
            <button type="button" className="btn sm" onClick={() => onAction(f.action!)}>
              {f.action === "rebuild" ? "Rebuild remaining weeks" : "Archive plan"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Today({ t, onEdit, onSwap }: { t: TrainingData; onEdit: (s: Session) => void; onSwap: (a: string, b: string) => void }) {
  const { runById } = useData();
  const today = t.sessions.filter(s => s.date === t.today);
  const next = t.sessions.find(s => s.date > t.today && s.status === "upcoming");
  const r = t.recovery;
  return (
    <section className="card" aria-labelledby="td-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="td-h">Today</h2>
      {today.length ? today.map(s => <SessionLine key={s.id} s={s} onEdit={onEdit} big />)
        : <div className="text2">Rest day.{next ? <> Next: <strong>{next.title}</strong>, {fmtDate(next.date)}{next.km ? `, ${next.km} km` : ""}.</> : ""}</div>}
      {today.some(s => s.runId) && today.filter(s => s.runId).map(s => {
        const run = runById.get(s.runId!);
        return run && <a key={s.id} href={runHref(run.id)} className="small">See today's run: {run.dist.toFixed(2)} km at {fpace(run.pace)} /km</a>;
      })}
      <div style={{ borderTop: "1px solid var(--grid)", paddingTop: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="dot" style={{ background: r.status === "low" ? "var(--orange)" : r.status === "ok" ? "var(--aqua)" : "var(--grid)" }} />
          <strong style={{ fontSize: 13 }}>{r.status === "low" ? "Recovery looks low" : r.status === "ok" ? "Recovery looks normal" : "No recovery data for last night yet"}</strong>
        </div>
        <div className="small text2" style={{ marginTop: 4 }}>
          {r.status === "low" ? capital(r.reasons.join("; ")) + "." : [
            r.hrv != null ? `HRV ${Math.round(r.hrv)} ms` + (r.hrv30 ? ` (avg ${Math.round(r.hrv30)})` : "") : null,
            r.rhr != null ? `resting HR ${Math.round(r.rhr)}` + (r.rhr30 ? ` (avg ${Math.round(r.rhr30)})` : "") : null,
            r.sleep != null ? `slept ${fhm(r.sleep)}` : null,
          ].filter(Boolean).join(" · ")}
        </div>
        {r.status === "low" && r.swap && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small">Consider swapping today's hard session with the easy run on {fmtDate(r.swap.bDate)}.</span>
            <button type="button" className="btn sm" onClick={() => onSwap(r.swap!.a, r.swap!.b)}>Swap them</button>
          </div>
        )}
      </div>
    </section>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ThisWeek({ t }: { t: TrainingData }) {
  const w = t.weeks.find(x => x.state === "current");
  if (!w) return null;
  const share = w.plannedKm ? Math.min(1, w.doneKm / w.plannedKm) : 0;
  return (
    <section className="card" aria-labelledby="tw-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="tw-h">This week</h2>
        <span className="pill" title="Weeks in a row with at least 80 % of the planned km and every key session done">
          {t.streak} {t.streak === 1 ? "week" : "weeks"} streak
        </span>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
        <span className="big">{w.doneKm.toFixed(1)}</span><span className="unit">of {w.plannedKm.toFixed(1)} km</span>
      </div>
      <div className="bar-track" style={{ height: 10 }} role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Weekly km done">
        <span className="bar-fill" style={{ width: share * 100 + "%", background: w.hit ? "var(--aqua)" : "var(--blue)" }} />
      </div>
      <div className="small text2">
        {w.done} of {w.planned} sessions done{w.adherence != null ? ` · ${w.adherence}% of the sessions due so far` : ""}
      </div>
      <Adherence weeks={t.weeks} />
    </section>
  );
}

function Adherence({ weeks }: { weeks: Week[] }) {
  const past = weeks.filter(w => w.state === "past");
  if (!past.length) return null;
  const hits = past.filter(w => w.hit).length;
  const due = past.reduce((s, w) => s + w.planned, 0), done = past.reduce((s, w) => s + w.done, 0);
  return (
    <div className="small muted" style={{ borderTop: "1px solid var(--grid)", paddingTop: 10 }}>
      So far: {hits} of {past.length} weeks on target · {done} of {due} sessions done
    </div>
  );
}

function verdictText(v: Verdict | null) {
  if (!v) return null;
  const parts = [];
  if (v.pace === "on") parts.push("pace on target");
  else if (v.pace === "fast") parts.push(`${fpace(Math.abs(v.paceDiff!))} /km faster than planned`);
  else if (v.pace === "slow") parts.push(`${fpace(Math.abs(v.paceDiff!))} /km slower than planned`);
  if (v.hr === "above") parts.push("heart rate above the zone");
  else if (v.hr === "below") parts.push("heart rate below the zone");
  else if (v.hr === "in") parts.push("heart rate in zone");
  return parts.join(" · ");
}

function SessionLine({ s, onEdit, big }: { s: Session; onEdit: (s: Session) => void; big?: boolean }) {
  const { runById } = useData();
  const k = kindOf(s.kind), st = STATUS[s.status];
  const run = s.runId ? runById.get(s.runId) : undefined;
  const vt = verdictText(s.verdict);
  return (
    <button type="button" className={"session " + s.status + (big ? " big" : "")} onClick={() => onEdit(s)}
      aria-label={`${s.title}, ${s.km ?? ""} km, ${st.label}. Edit`}>
      <span className="kind" style={{ background: k.color }} aria-hidden="true" />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="row" style={{ gap: 6, justifyContent: "space-between", flexWrap: "nowrap" }}>
          <span className="title">{s.title}</span>
          <span className="small" style={{ whiteSpace: "nowrap" }}>{s.km != null ? s.km + " km" : ""}</span>
        </span>
        {big && s.description && <span className="small text2" style={{ display: "block", marginTop: 4 }}>{s.description}</span>}
        {!big && s.paceLo && <span className="small muted" style={{ display: "block" }}>{paceRange(s.paceLo, s.paceHi)}</span>}
        <span className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
          <span className="status-dot" style={{ background: st.color }} aria-hidden="true" />
          <span className={s.status === "missed" ? "" : "text2"}>{st.label}</span>
          {run && <span className="muted">· {run.dist.toFixed(1)} km{s.manual ? " (linked)" : ""}</span>}
        </span>
        {vt && <span className="small muted" style={{ display: "block", marginTop: 2 }}>{vt}</span>}
      </span>
    </button>
  );
}

function WeekList({ t, onEdit }: { t: TrainingData; onEdit: (s: Session | null, date: string) => void }) {
  const { runById, cal } = useData();
  const cur = t.weeks.findIndex(w => w.state === "current");
  const [showPast, setShowPast] = useState(false);
  const first = showPast || cur < 0 ? 0 : Math.max(0, cur - 1);
  const extra = t.extra.map(id => runById.get(id)).filter(Boolean);
  return (
    <section aria-labelledby="wl-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="wl-h">Plan</h2>
        <span className="row small muted" style={{ gap: 12 }}>
          {Object.entries(STATUS).filter(([k]) => k !== "today").map(([k, v]) => (
            <span key={k} className="legend"><span className="status-dot" style={{ background: v.color }} />{v.label}</span>
          ))}
        </span>
      </div>
      {first > 0 && <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowPast(true)}>Show {first} earlier {first === 1 ? "week" : "weeks"}</button>}
      {t.weeks.slice(first).map((w, k) => {
        const i = first + k;
        const days = Array.from({ length: 7 }, (_, d) => {
          const di = cal.day(w.monday) + d;
          const iso = cal.date(di).toISOString().slice(0, 10);
          return { iso, di, sessions: t.sessions.filter(s => s.date === iso), extra: extra.filter(r => r!.date === iso) };
        });
        return (
          <div key={w.monday} className={"card week " + w.state}>
            <div className="row" style={{ justifyContent: "space-between", gap: "6px 16px" }}>
              <div className="row" style={{ gap: 10 }}>
                <h3>Week {i + 1}</h3>
                <span className="small muted">{cal.fd(cal.day(w.monday))} – {cal.fd(cal.day(w.monday) + 6)}</span>
                {w.state === "current" && <span className="badge">This week</span>}
                {w.hit && <span className="badge ok">Target hit</span>}
                {w.state === "past" && w.hit === false && <span className="badge">Below target</span>}
              </div>
              <div className="row small" style={{ gap: 10, minWidth: 200, flex: "0 1 280px" }}>
                <span className="text2" style={{ whiteSpace: "nowrap" }}>{w.state === "future" ? `${w.plannedKm.toFixed(1)} km planned` : `${w.doneKm.toFixed(1)} / ${w.plannedKm.toFixed(1)} km`}</span>
                {w.state !== "future" && (
                  <span className="bar-track"><span className="bar-fill" style={{ width: Math.min(100, (w.doneKm / (w.plannedKm || 1)) * 100) + "%", background: w.hit ? "var(--aqua)" : "var(--blue)" }} /></span>
                )}
              </div>
            </div>
            <div className="days">
              {days.map(d => (
                <div key={d.iso} className={"day" + (d.iso === t.today ? " today" : "")}>
                  <div className="row small" style={{ justifyContent: "space-between" }}>
                    <span className={d.iso === t.today ? "" : "muted"} style={{ fontWeight: d.iso === t.today ? 600 : 400 }}>{cal.fdw(d.di)}</span>
                    {w.state !== "past" && <button type="button" className="add" onClick={() => onEdit(null, d.iso)} aria-label={"Add a session on " + cal.fdw(d.di)}>+</button>}
                  </div>
                  {d.sessions.map(s => <SessionLine key={s.id} s={s} onEdit={x => onEdit(x, x.date)} />)}
                  {d.extra.map(r => (
                    <a key={r!.id} href={runHref(r!.id)} className="extra small">Extra run · {r!.dist.toFixed(1)} km</a>
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function LoadCard({ t }: { t: TrainingData }) {
  const a = [...t.load.acwr].reverse().find(v => v != null);
  return (
    <section className="card" aria-labelledby="ld-h">
      <div className="chart-head">
        <div>
          <h2 id="ld-h">Training load</h2>
          <div className="sub">
            Line: acute:chronic ratio (last 7 days vs 4-week average; shaded = 0.8–1.3, dashed = 1.5) · bars: load per day, from heart rate (TRIMP)
          </div>
        </div>
        {a != null && <span className="pill">Now {a.toFixed(2)}</span>}
      </div>
      <LoadChart start={t.load.start} load={t.load.load} acwr={t.load.acwr} />
    </section>
  );
}

function Targets({ t, onSaved }: { t: TrainingData; onSaved: () => void }) {
  const [km, setKm] = useState(t.targets.km != null ? String(t.targets.km) : "");
  const [runs, setRuns] = useState(t.targets.runs != null ? String(t.targets.runs) : "");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await api.saveSettings({ target_km: km ? Number(km) : null, target_runs: runs ? Number(runs) : null });
    setSaved(true);
    onSaved();
  };
  return (
    <section className="card" aria-labelledby="tg-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 id="tg-h">Weekly targets</h2><div className="sub">Used while you have no plan</div></div>
        <span className="pill">{t.streak} {t.streak === 1 ? "week" : "weeks"} streak</span>
      </div>
      <div className="row">
        <label className="row text2" style={{ gap: 6 }}>Distance <input type="number" min="0" step="1" value={km} onChange={e => { setKm(e.target.value); setSaved(false); }} /> km</label>
        <label className="row text2" style={{ gap: 6 }}>Runs <input type="number" min="0" max="14" step="1" value={runs} onChange={e => { setRuns(e.target.value); setSaved(false); }} /></label>
        <button type="button" className="btn" onClick={save}>{saved ? "Saved" : "Save"}</button>
      </div>
      {(t.targets.km || t.targets.runs) ? <PlanWeeksChart weeks={t.weeks} /> : null}
    </section>
  );
}
