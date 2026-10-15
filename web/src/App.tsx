// App shell: loads the data and sync status, picks the page from the URL hash, and runs "Sync now".
import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import { Header } from "./components/Header";
import { DataContext, Dataset, makeDataset, ReloadContext } from "./data";
import { useHashRoute } from "./hooks";
import { Gear } from "./pages/Gear";
import { Overview } from "./pages/Overview";
import { RunDetail } from "./pages/RunDetail";
import { Runs } from "./pages/Runs";
import { Training } from "./pages/Training";
import type { SyncStatus } from "./types";

const POLL_MS = 3000;

export function App() {
  const route = useHashRoute();
  const [data, setData] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const loadData = useCallback(async () => {
    try {
      setData(makeDataset(await api.getData()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadStatus = useCallback(() => api.getStatus().then(setStatus, () => setStatus(null)), []);

  useEffect(() => { loadData(); loadStatus(); }, [loadData, loadStatus]);

  // While a sync runs, poll its status; when it finishes, reload the data.
  useEffect(() => {
    if (!status?.running) return;
    const t = setTimeout(async () => {
      const s = await api.getStatus().catch(() => null);
      setStatus(s);
      if (s && !s.running) { api.clearRunCache(); loadData(); }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [status, loadData]);

  const syncNow = async () => {
    try {
      await api.startSync();
    } catch (e) {
      alert("Couldn't start the sync: " + (e as Error).message);
    }
    loadStatus();
  };

  if (!data) {
    return (
      <div className="wrap">
        <div className="loading">{error ? `Couldn't load data from the server (${error}).` : "Loading…"}</div>
      </div>
    );
  }
  return (
    <DataContext.Provider value={data}>
      <ReloadContext.Provider value={loadData}>
        <div className={route.page === "run" ? "wrap tight" : "wrap"}>
          <Header page={route.page} status={status} onSync={syncNow} />
          {route.page === "overview" && <Overview />}
          {route.page === "training" && <Training />}
          {route.page === "runs" && <Runs />}
          {route.page === "run" && <RunDetail id={route.id} />}
          {route.page === "gear" && <Gear />}
        </div>
      </ReloadContext.Provider>
    </DataContext.Provider>
  );
}
