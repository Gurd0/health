// Run detail: your effort (RPE), how it felt, a note and the shoe, plus the planned session the run
// was matched to. Saved as soon as you change something (the note when you leave the text box).
import { useEffect, useState } from "react";
import * as api from "../api";
import { Run, useReload } from "../data";
import { fpace } from "../lib/format";
import { kindOf, paceRange } from "../lib/training";
import type { Session, Shoe } from "../types";

const FEEL = ["Awful", "Poor", "OK", "Good", "Great"];
const RPE_HINT = ["", "Very easy", "Easy", "Easy", "Moderate", "Moderate", "Hard", "Hard", "Very hard", "Very hard", "Max"];

export function RunNotes({ run }: { run: Run }) {
  const reload = useReload();
  const [shoes, setShoes] = useState<Shoe[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [rpe, setRpe] = useState(run.rpe);
  const [feel, setFeel] = useState(run.feel);
  const [note, setNote] = useState(run.note ?? "");
  const [shoe, setShoe] = useState(run.shoeAuto ? "" : run.shoe ?? "");
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");

  useEffect(() => {
    api.getShoes().then(setShoes, () => setShoes([]));
    api.getTraining().then(t => setSession(t.sessions.find(s => s.runId === run.id) ?? null), () => setSession(null));
  }, [run.id]);

  const save = async (next: Partial<{ rpe: number | null; feel: number | null; note: string; shoe: string }>) => {
    const v = { rpe, feel, note, shoe, ...next };
    setState("saving");
    try {
      await api.saveNote(run.id, { rpe: v.rpe, feel: v.feel, note: v.note.trim() || null, shoe_id: v.shoe || null });
      setState("saved");
      reload();
    } catch (e) {
      setState((e as Error).message);
    }
  };

  const autoShoe = shoes.find(s => s.id === run.shoe && run.shoeAuto);
  const usable = shoes.filter(s => !s.retired || s.id === shoe);

  return (
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }} aria-label="Your notes and plan">
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Your notes</h2>
          <span className="small muted" aria-live="polite">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state}</span>
        </div>
        <div>
          <div className="small text2" id="rpe-l">Effort (RPE){rpe ? ` · ${rpe} ${RPE_HINT[rpe].toLowerCase()}` : ""}</div>
          <div className="seg" role="group" aria-labelledby="rpe-l" style={{ marginTop: 6, width: "fit-content", maxWidth: "100%", flexWrap: "wrap" }}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map(v => (
              <button key={v} type="button" aria-pressed={rpe === v} title={RPE_HINT[v]}
                onClick={() => { const x = rpe === v ? null : v; setRpe(x); save({ rpe: x }); }}>{v}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="small text2" id="feel-l">How it felt</div>
          <div className="seg" role="group" aria-labelledby="feel-l" style={{ marginTop: 6, width: "fit-content", maxWidth: "100%", flexWrap: "wrap" }}>
            {FEEL.map((f, i) => (
              <button key={f} type="button" aria-pressed={feel === i + 1}
                onClick={() => { const x = feel === i + 1 ? null : i + 1; setFeel(x); save({ feel: x }); }}>{f}</button>
            ))}
          </div>
        </div>
        <label className="field">Note
          <textarea rows={3} value={note} placeholder="Legs, weather, route, anything worth remembering"
            onChange={e => { setNote(e.target.value); setState(""); }} onBlur={() => note !== (run.note ?? "") && save({})} />
        </label>
        <label className="field">Shoe
          <select value={shoe} onChange={e => { setShoe(e.target.value); save({ shoe: e.target.value }); }}>
            <option value="">{autoShoe ? `Default (${autoShoe.name})` : shoes.length ? "No shoe" : "No shoes yet: add them under Gear"}</option>
            {usable.map(s => <option key={s.id} value={s.id}>{s.name}{s.retired ? " (retired)" : ""}</option>)}
          </select>
        </label>
      </div>
      {session && <PlannedCard s={session} run={run} />}
    </section>
  );
}

function PlannedCard({ s, run }: { s: Session; run: Run }) {
  const k = kindOf(s.kind), v = s.verdict;
  const items: [string, string][] = [["Distance", `${run.dist.toFixed(2)} of ${s.km ?? "—"} km`]];
  if (s.paceLo && s.paceHi) {
    items.push(["Pace", `${fpace(run.pace)} /km vs ${paceRange(s.paceLo, s.paceHi)}`
      + (v?.pace === "fast" ? " · faster" : v?.pace === "slow" ? " · slower" : v?.pace === "on" ? " · on target" : "")]);
  }
  if (s.hrRange && run.hr) {
    items.push(["Heart rate", `${run.hr} bpm vs ${s.hrRange[0]}–${s.hrRange[1]}`
      + (v?.hr === "above" ? " · above zone" : v?.hr === "below" ? " · below zone" : v?.hr === "in" ? " · in zone" : "")]);
  }
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Planned session</h2>
        <a href="#/training" className="small">Training plan</a>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="dot" style={{ background: k.color }} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>{s.title}</span>
        <span className="pill">{s.status === "done" ? "Done" : "Partly done"}</span>
      </div>
      {s.description && <div className="small text2">{s.description}</div>}
      <div className="table" role="table" aria-label="Planned against actual">
        {items.map(([l, val]) => (
          <div key={l} className="trow" role="row" style={{ gridTemplateColumns: "90px minmax(0,1fr)", padding: "6px 0" }}>
            <span role="cell" className="text2">{l}</span><span role="cell">{val}</span>
          </div>
        ))}
      </div>
      {!v && <div className="small muted">Structured session: check the splits for the fast parts.</div>}
    </div>
  );
}
