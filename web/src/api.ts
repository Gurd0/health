// Calls to the Python server (ingest/server.py). URLs are relative so the app also works under a sub-path.
import type { DashboardData, RunDetail, SyncStatus } from "./types";

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
