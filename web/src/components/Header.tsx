// Top bar (title, page links, last sync, Sync now, theme) and the sync/login banner below it.
import { useData } from "../data";
import { useTheme } from "../hooks";
import { fdt } from "../lib/calendar";
import type { SyncStatus } from "../types";
import { Seg } from "./Seg";

interface Props {
  page: "overview" | "runs" | "run";
  status: SyncStatus | null;
  onSync: () => void;
}

export function Header({ page, status, onSync }: Props) {
  const { meta } = useData();
  const [theme, setTheme] = useTheme();
  const busy = !!status?.running;
  return (
    <>
      <header className="topbar">
        <div className="row" style={{ gap: 20 }}>
          <div className="brand">Health &amp; running</div>
          <nav className="nav" aria-label="Pages">
            <a href="#/overview" aria-current={page === "overview" ? "page" : undefined}>Overview</a>
            <a href="#/runs" aria-current={page !== "overview" ? "page" : undefined}>Runs</a>
          </nav>
        </div>
        <div className="row">
          {meta.lastSync && <span className="synced">Synced {fdt(meta.lastSync)}</span>}
          <button type="button" className="btn sm" disabled={busy} onClick={onSync}>{busy ? "Syncing…" : "Sync now"}</button>
          <Seg options={[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} value={theme} onChange={setTheme} label="Colour theme" />
        </div>
      </header>
      {status && <StatusBanner status={status} />}
    </>
  );
}

function StatusBanner({ status }: { status: SyncStatus }) {
  const last = status.last;
  if (status.auth === "reconnect_needed") {
    return (
      <div className="banner" role="alert">
        <div>
          <strong>Google login needs to be renewed.</strong> Syncing is paused until you connect again.{" "}
          <span className="muted">{status.auth_error}</span>
        </div>
        <a className="btn" href="oauth/start">Reconnect Google</a>
      </div>
    );
  }
  if (status.running || !last) return null;
  if (last.result === "error") {
    return (
      <div className="banner" role="alert">
        <div><strong>Last sync failed</strong> ({fdt(last.finished)}). <span className="muted">{last.error}</span></div>
      </div>
    );
  }
  if (last.failed.length) {
    return (
      <div className="banner" role="status">
        <div>
          <strong>Last sync ({fdt(last.finished)}) skipped some data:</strong>{" "}
          <span className="muted">{last.failed.join(", ")}</span>. See data/sync.log.
        </div>
      </div>
    );
  }
  return null;
}
