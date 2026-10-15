// Dialog for one planned session: move it, change it, skip it, link it to a run, or delete it.
// With session = null it adds a new session on `date`.
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { useData } from "../data";
import { fdur, fpace } from "../lib/format";
import { addDays, KINDS, parseTime } from "../lib/training";
import type { Plan, Session, SessionKind } from "../types";

interface Props {
  session: Session | null;
  date: string;
  plan: Plan;
  onClose: (changed: boolean) => void;
}

export function SessionEditor({ session: s, date, plan, onClose }: Props) {
  const { runs, cal } = useData();
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<SessionKind>(s?.kind ?? "easy");
  const [day, setDay] = useState(s?.date ?? date);
  const [title, setTitle] = useState(s?.title ?? "");
  const [km, setKm] = useState(s?.km != null ? String(s.km) : "");
  const [lo, setLo] = useState(s?.paceLo ? fpace(s.paceLo) : "");
  const [hi, setHi] = useState(s?.paceHi ? fpace(s.paceHi) : "");
  const [desc, setDesc] = useState(s?.description ?? "");
  const [runId, setRunId] = useState<string>(s?.manual ? s.runId! : "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { ref.current?.showModal(); }, []);

  // Changing the kind of a new session fills in the plan's paces for it.
  const pickKind = (k: SessionKind) => {
    setKind(k);
    const p = plan.paces?.[k === "strides" ? "easy" : k];
    if (p && (!s || (!lo && !hi))) { setLo(fpace(p[0])); setHi(fpace(p[1])); }
  };

  const nearby = runs.filter(r => Math.abs(cal.day(r.date) - cal.day(day)) <= 3).slice().reverse();
  const paceLo = lo.trim() ? parseTime(lo) : null, paceHi = hi.trim() ? parseTime(hi) : null;
  const paceBad = (!!lo.trim() && paceLo == null) || (!!hi.trim() && paceHi == null);

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); ref.current?.close(); onClose(true); } catch (e) { setError((e as Error).message); }
  };
  const fields = (): api.SessionPatch => ({
    date: day, kind, title: title.trim() || KINDS.find(x => x.kind === kind)!.label + " run",
    distance_km: km.trim() ? Number(km) : null,
    pace_lo: paceLo != null && paceHi != null ? Math.min(paceLo, paceHi) : null,
    pace_hi: paceLo != null && paceHi != null ? Math.max(paceLo, paceHi) : null,
    description: desc.trim() || null,
  });
  const save = () => act(async () => {
    if (s) {
      await api.editSession(s.id, fields());
      if ((s.manual ? s.runId : "") !== runId) await api.editSession(s.id, { run_id: runId || null });
    } else {
      await api.addSession({ ...fields(), run_id: runId || null });
    }
  });

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="se-h" onClose={() => onClose(false)}
      onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); save(); }} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="se-h">{s ? "Edit session" : "Add a session"}</h2>
          <button type="button" className="btn sm" onClick={() => ref.current?.close()} aria-label="Close">✕</button>
        </div>

        <div className="form">
          <label className="label" htmlFor="se-kind">Type</label>
          <select id="se-kind" value={kind} onChange={e => pickKind(e.target.value as SessionKind)}>
            {KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>

          <label className="label" htmlFor="se-date">Date</label>
          <div className="row" style={{ gap: 6 }}>
            <input id="se-date" type="date" value={day} onChange={e => setDay(e.target.value)} />
            <button type="button" className="btn sm" onClick={() => setDay(addDays(day, -1))} aria-label="One day earlier">−1 day</button>
            <button type="button" className="btn sm" onClick={() => setDay(addDays(day, 1))} aria-label="One day later">+1 day</button>
          </div>

          <label className="label" htmlFor="se-title">Title</label>
          <input id="se-title" type="text" value={title} placeholder={KINDS.find(x => x.kind === kind)!.label + " run"} onChange={e => setTitle(e.target.value)} />

          <label className="label" htmlFor="se-km">Distance</label>
          <span className="row" style={{ gap: 6 }}>
            <input id="se-km" type="number" min="0" max="100" step="0.5" value={km} onChange={e => setKm(e.target.value)} /> km
          </span>

          <span className="label" id="se-pace">Target pace</span>
          <span className="row" style={{ gap: 6 }}>
            <input type="text" inputMode="numeric" placeholder="5:30" value={lo} aria-labelledby="se-pace" aria-invalid={paceBad}
              onChange={e => setLo(e.target.value)} style={{ width: 70 }} />–
            <input type="text" inputMode="numeric" placeholder="5:45" value={hi} aria-label="Slowest target pace" aria-invalid={paceBad}
              onChange={e => setHi(e.target.value)} style={{ width: 70 }} /> /km
            {km && paceLo && paceHi && !paceBad && <span className="small muted">≈ {fdur(Number(km) * (paceLo + paceHi) / 2)}</span>}
          </span>

          <label className="label" htmlFor="se-desc">Details</label>
          <textarea id="se-desc" rows={3} value={desc} onChange={e => setDesc(e.target.value)} />

          <label className="label" htmlFor="se-run">Run</label>
          <div>
            <select id="se-run" value={runId} onChange={e => setRunId(e.target.value)}>
              <option value="">Automatic (a run on the same day)</option>
              {nearby.map(r => (
                <option key={r.id} value={r.id}>{cal.fdw(r.d)} {r.start.slice(11, 16)} · {r.dist.toFixed(1)} km · {fpace(r.pace)} /km</option>
              ))}
            </select>
            <div className="small muted" style={{ marginTop: 4 }}>Link a run by hand when you ran on a different day. Runs within 3 days are listed.</div>
          </div>
        </div>

        {error && <div className="banner" role="alert">{error}</div>}

        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            {s && (s.status === "skipped"
              ? <button type="button" className="btn" onClick={() => act(() => api.editSession(s.id, { status: "planned" }))}>Unskip</button>
              : <button type="button" className="btn" onClick={() => act(() => api.editSession(s.id, { status: "skipped" }))}>Skip</button>)}
            {s && <button type="button" className="btn danger" onClick={() => { if (confirm("Delete this session?")) act(() => api.deleteSession(s.id)); }}>Delete</button>}
          </div>
          <button type="submit" className="btn primary" disabled={paceBad}>Save</button>
        </div>
      </form>
    </dialog>
  );
}
