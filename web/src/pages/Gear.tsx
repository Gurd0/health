// Gear page: running shoes with their mileage. Runs count for the shoe set on the run, else for the
// shoe that was the default on the run's date.
import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { useData, useReload } from "../data";
import { fint } from "../lib/format";
import type { Shoe } from "../types";

export function Gear() {
  const { meta, cal } = useData();
  const reloadData = useReload();
  const [shoes, setShoes] = useState<Shoe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.getShoes().then(setShoes, e => setError(e.message)), []);
  useEffect(() => { load(); }, [load, meta.generated]);

  const act = async (f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { alert((e as Error).message); }
    await Promise.all([load(), reloadData()]);
  };

  if (error) return <div className="loading">Couldn't load shoes ({error}).</div>;
  if (!shoes) return <div className="loading">Loading…</div>;
  const active = shoes.filter(s => !s.retired), retired = shoes.filter(s => s.retired);

  return (
    <>
      <div className="titlerow">
        <div>
          <h1>Gear</h1>
          <div className="caption">Shoe mileage from your synced runs. Set a default shoe and new runs count for it automatically; change a single run's shoe on its run page.</div>
        </div>
      </div>
      {active.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>
          {active.map(s => <ShoeCard key={s.id} s={s} act={act} lastUsed={s.lastUsed ? cal.fd(cal.day(s.lastUsed), true) : null} />)}
        </div>
      )}
      <AddShoe first={!shoes.length} onAdd={x => act(() => api.addShoe(x))} />
      {retired.length > 0 && (
        <section aria-labelledby="ret-h">
          <h2 id="ret-h" style={{ marginBottom: 12 }}>Retired</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>
            {retired.map(s => <ShoeCard key={s.id} s={s} act={act} lastUsed={s.lastUsed ? cal.fd(cal.day(s.lastUsed), true) : null} />)}
          </div>
        </section>
      )}
    </>
  );
}

function ShoeCard({ s, act, lastUsed }: { s: Shoe; act: (f: () => Promise<unknown>) => void; lastUsed: string | null }) {
  const [editing, setEditing] = useState(false);
  const [maxKm, setMaxKm] = useState(String(s.maxKm));
  const share = Math.min(1, s.km / s.maxKm);
  const color = s.wear === "over" ? "var(--orange)" : s.wear === "warn" ? "var(--yellow)" : "var(--aqua)";
  return (
    <div className="tile" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{s.name}</span>
        <span className="row" style={{ gap: 4 }}>
          {s.isDefault && <span className="badge ok">Default</span>}
          {s.retired && <span className="badge">Retired</span>}
        </span>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 4 }}><span className="big">{fint(s.km)}</span><span className="unit">of {fint(s.maxKm)} km</span></div>
      <div className="bar-track" style={{ height: 8 }} role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={s.name + " wear"}>
        <span className="bar-fill" style={{ width: share * 100 + "%", background: color }} />
      </div>
      <div className="small muted">
        {s.runs} {s.runs === 1 ? "run" : "runs"}{s.startKm ? ` + ${fint(s.startKm)} km before tracking` : ""}{lastUsed ? ` · last used ${lastUsed}` : ""}
        {s.wear === "over" ? " · past its limit" : s.wear === "warn" ? " · nearly worn out" : ""}
      </div>
      {editing ? (
        <div className="row" style={{ gap: 6 }}>
          <label className="row small text2" style={{ gap: 6 }}>Limit <input type="number" min="1" step="50" value={maxKm} onChange={e => setMaxKm(e.target.value)} /> km</label>
          <button type="button" className="btn sm" onClick={() => { setEditing(false); act(() => api.editShoe(s.id, { max_km: Number(maxKm) })); }}>Save</button>
        </div>
      ) : (
        <div className="row" style={{ gap: 6, marginTop: "auto" }}>
          {!s.retired && !s.isDefault && <button type="button" className="btn sm" onClick={() => act(() => api.editShoe(s.id, { default: true }))}>Make default</button>}
          {s.isDefault && <button type="button" className="btn sm" onClick={() => act(() => api.editShoe(s.id, { default: false }))}>Stop default</button>}
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>Change limit</button>
          <button type="button" className="btn sm" onClick={() => act(() => api.editShoe(s.id, { retired: !s.retired }))}>{s.retired ? "Unretire" : "Retire"}</button>
        </div>
      )}
    </div>
  );
}

function AddShoe({ first, onAdd }: { first: boolean; onAdd: (s: api.ShoeInput) => void }) {
  const [name, setName] = useState("");
  const [startKm, setStartKm] = useState("0");
  const [maxKm, setMaxKm] = useState("700");
  const [isDefault, setIsDefault] = useState(true);
  const [since, setSince] = useState("");
  return (
    <section className="card" aria-labelledby="as-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 id="as-h">Add a shoe</h2>
        {first && <div className="sub">Most running shoes last 500–800 km.</div>}
      </div>
      <form className="row" style={{ gap: "10px 16px", alignItems: "flex-end" }}
        onSubmit={e => { e.preventDefault(); if (!name.trim()) return; onAdd({ name: name.trim(), start_km: Number(startKm) || 0, max_km: Number(maxKm) || 700, default: isDefault, since: isDefault && since ? since : undefined }); setName(""); }}>
        <label className="field">Name<input type="text" value={name} placeholder="e.g. Pegasus 41" onChange={e => setName(e.target.value)} required /></label>
        <label className="field">Km already on it<input type="number" min="0" step="10" value={startKm} onChange={e => setStartKm(e.target.value)} /></label>
        <label className="field">Limit, km<input type="number" min="1" step="50" value={maxKm} onChange={e => setMaxKm(e.target.value)} /></label>
        <label className="row small text2" style={{ gap: 6, paddingBottom: 8 }}><input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} /> Default for new runs</label>
        {isDefault && <label className="field">Counting runs from <input type="date" value={since} onChange={e => setSince(e.target.value)} /></label>}
        <button type="submit" className="btn primary">Add shoe</button>
      </form>
      {isDefault && <div className="small muted">Leave the date empty to count runs from today. Pick an earlier date to count the runs you've already done in it.</div>}
    </section>
  );
}
