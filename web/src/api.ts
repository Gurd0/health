// Calls to the Python server (ingest/server.py). URLs are relative so the app also works under a sub-path.
import type { DashboardData, PlanInput, PlanPreview, RunDetail, Shoe, SyncStatus, Training } from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const getData = () => getJSON<DashboardData>("api/data");
export const getStatus = () => getJSON<SyncStatus>("api/status");

const runCache = new Map<string, Promise<RunDetail>>();

/** Run detail, fetched once per run until the next sync. */
export function getRun(id: string): Promise<RunDetail> {
  let p = runCache.get(id);
  if (!p) {
    p = getJSON<RunDetail>("api/runs/" + encodeURIComponent(id));
    p.catch(() => runCache.delete(id));
    runCache.set(id, p);
  }
  return p;
}

export function clearRunCache() {
  runCache.clear();
}

/** Start a sync. Resolves when the server accepted it (or one was already running). */
export async function startSync() {
  const r = await fetch("api/sync", { method: "POST" });
  if (r.status !== 202 && r.status !== 409) throw new Error("HTTP " + r.status);
}

/** POST/PUT/PATCH/DELETE with a JSON body. Errors carry the server's message. */
async function sendJSON<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail)) msg = j.detail.map((d: { loc?: string[]; msg: string }) => (d.loc ? d.loc[d.loc.length - 1] + ": " : "") + d.msg).join("; ");
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

// Training: plans, sessions, notes, shoes (ingest/training.py)
export const getTraining = () => getJSON<Training>("api/training");
export const previewPlan = (p: PlanInput) => sendJSON<PlanPreview>("POST", "api/plans/preview", p);
export const createPlan = (p: PlanInput) => sendJSON<{ id: string }>("POST", "api/plans", p);
export const rebuildPlan = (id: string) => sendJSON<{ sessions: number }>("POST", `api/plans/${id}/rebuild`, {});
export const archivePlan = (id: string) => sendJSON<unknown>("DELETE", `api/plans/${id}`);

export interface SessionPatch {
  date?: string; kind?: string; title?: string; distance_km?: number | null; pace_lo?: number | null; pace_hi?: number | null;
  hr_zone?: string | null; description?: string | null; status?: "planned" | "skipped"; run_id?: string | null;
}
export const addSession = (s: SessionPatch) => sendJSON<{ id: string }>("POST", "api/sessions", s);
export const editSession = (id: string, s: SessionPatch) => sendJSON<unknown>("PATCH", `api/sessions/${id}`, s);
export const deleteSession = (id: string) => sendJSON<unknown>("DELETE", `api/sessions/${id}`);
export const swapSessions = (a: string, b: string) => sendJSON<unknown>("POST", "api/sessions/swap", { a, b });

export interface NoteInput { rpe: number | null; feel: number | null; note: string | null; shoe_id: string | null }
export const saveNote = (runId: string, n: NoteInput) => sendJSON<unknown>("PUT", `api/runs/${encodeURIComponent(runId)}/note`, n);

export const getShoes = () => getJSON<Shoe[]>("api/shoes");
export interface ShoeInput { name?: string; start_km?: number; max_km?: number; retired?: boolean; default?: boolean; since?: string }
export const addShoe = (s: ShoeInput) => sendJSON<{ id: string }>("POST", "api/shoes", s);
export const editShoe = (id: string, s: ShoeInput) => sendJSON<unknown>("PATCH", `api/shoes/${id}`, s);

export const saveSettings = (s: { target_km?: number | null; target_runs?: number | null }) => sendJSON<unknown>("PUT", "api/settings", s);
