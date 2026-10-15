"""Web server: the dashboard with a JSON API, the Google login, and the daily sync.

    python -m ingest serve [--host 0.0.0.0] [--port 8000]

Everything runs in one process, because DuckDB allows only one process to write the database:
requests read through cursors of one shared connection while the sync writes through another.

Google login (no browser on the server): /oauth/start sends you to Google's consent screen
(access_type=offline, prompt=consent), /oauth/callback saves the refresh token to
secrets/token.json. From then on the sync refreshes access tokens itself. If Google rejects the
refresh token (invalid_grant: Testing-mode expiry, revoked access, 6 months unused) the status
says reconnect_needed and the dashboard shows a Reconnect Google button.

Settings (environment):
    PUBLIC_URL   how your browser reaches the server; the OAuth redirect URI is
                 PUBLIC_URL/oauth/callback (default http://localhost:8000, e.g. via an SSH tunnel)
    SYNC_TIME    daily sync time, HH:MM (default 04:30)
    SYNC_TZ      time zone for SYNC_TIME (default Europe/Oslo)
    HEALTH_DB, HEALTH_SECRETS   database file and secrets folder (see db.py, api.py)
    HEALTH_WEB   the built front end (default web/dist; build it with `npm run build` in web/)
"""
import contextlib
import html
import json
import os
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from google.auth.exceptions import RefreshError

from . import api, dashboard, db, sync

PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
REDIRECT_URI = PUBLIC_URL + "/oauth/callback"
SYNC_TIME = os.environ.get("SYNC_TIME", "04:30")
SYNC_TZ = ZoneInfo(os.environ.get("SYNC_TZ", "Europe/Oslo"))
STATUS_FILE = db.DB_PATH.parent / "status.json"
LOG_FILE = db.DB_PATH.parent / "sync.log"
WEB_DIST = Path(os.environ.get("HEALTH_WEB", db.ROOT / "web" / "dist"))
LOGIN_TTL = 600  # seconds a started Google login stays valid
CATCH_UP = timedelta(hours=26)  # sync at startup if the last good sync is older than this

if PUBLIC_URL.startswith("http://"):
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")  # oauthlib refuses http:// otherwise
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")  # include_granted_scopes may add scopes


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Server:
    def __init__(self):
        self.con = db.connect()
        self.sync_lock = threading.Lock()
        self.data = None
        self.details = {}
        self.logins = {}  # OAuth state -> (PKCE verifier, expiry time)
        self.next_sync = None
        self.status = {"auth": "unknown", "auth_error": None, "last": None, "last_ok": None}
        if STATUS_FILE.exists():
            self.status.update(json.loads(STATUS_FILE.read_text(encoding="utf-8")))
        if not api.TOKEN.exists():
            self.set_auth("reconnect_needed", "Not connected to Google yet.")

    # --- status ------------------------------------------------------------------------------------
    def save_status(self):
        STATUS_FILE.write_text(json.dumps(self.status, indent=2), encoding="utf-8")

    def set_auth(self, state, error=None):
        self.status["auth"], self.status["auth_error"] = state, error
        self.save_status()

    def public_status(self):
        return {**self.status, "running": self.sync_lock.locked(),
                "next": self.next_sync.isoformat(timespec="minutes") if self.next_sync else None}

    # --- data ---------------------------------------------------------------------------------------
    def refresh_cache(self):
        cur = self.con.cursor()
        try:
            self.data, self.details = dashboard.collect(cur)
        finally:
            cur.close()

    # --- sync ---------------------------------------------------------------------------------------
    def run_sync(self, trigger):
        """Run one sync unless one is already running. Returns False if it didn't start."""
        if not self.sync_lock.acquire(blocking=False):
            return False
        last = {"trigger": trigger, "started": _now(), "finished": None, "result": None, "error": None, "failed": []}
        try:
            with _log_to_file():
                print(f"===== {last['started']} sync ({trigger})")
                cur = self.con.cursor()
                try:
                    api.credentials(interactive=False)  # fail fast if the login is dead
                    import_id = db.begin_import(cur, "api", "health.googleapis.com/v4")
                    last["failed"] = sync.run(cur, import_id, interactive=False)
                    db.finish_import(cur, import_id)
                    cur.execute("CHECKPOINT")
                    last["result"] = "ok"
                    self.status["last_ok"] = _now()
                    self.set_auth("ok")
                except (api.LoginRequired, RefreshError) as e:
                    print(f"Google login needs to be renewed: {e}")
                    last["result"], last["error"] = "error", "Google login needs to be renewed."
                    self.set_auth("reconnect_needed", str(e))
                except Exception as e:
                    traceback.print_exc(file=sys.stdout)
                    last["result"], last["error"] = "error", f"{type(e).__name__}: {e}"
                finally:
                    cur.close()
                if last["result"] == "ok":
                    self.refresh_cache()
                print(f"Sync {last['result']}" + (f", failed: {', '.join(last['failed'])}" if last["failed"] else ""))
        except Exception as e:  # e.g. the dashboard rebuild failed
            traceback.print_exc()
            last["result"], last["error"] = "error", f"{type(e).__name__}: {e}"
        finally:
            last["finished"] = _now()
            self.status["last"] = last
            self.save_status()
            self.sync_lock.release()
        return True

    def start_sync(self, trigger):
        if self.sync_lock.locked():
            return False
        threading.Thread(target=self.run_sync, args=(trigger,), daemon=True, name="sync").start()
        return True

    def scheduler(self):
        """Sync every day at SYNC_TIME. Daily use also keeps the refresh token from expiring
        (Google drops refresh tokens unused for 6 months)."""
        h, m = (int(x) for x in SYNC_TIME.split(":"))
        while True:
            now = datetime.now(SYNC_TZ)
            nxt = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if nxt <= now:
                nxt += timedelta(days=1)
            self.next_sync = nxt
            print(f"Next sync {nxt.isoformat(timespec='minutes')}", flush=True)
            while (left := (nxt - datetime.now(SYNC_TZ)).total_seconds()) > 0:
                time.sleep(min(left, 300))
            self.run_sync("scheduled")

    def start(self):
        self.refresh_cache()
        threading.Thread(target=self.scheduler, daemon=True, name="scheduler").start()
        last_ok = self.status.get("last_ok")
        if self.status["auth"] != "reconnect_needed" and (
                not last_ok or datetime.now(timezone.utc) - datetime.fromisoformat(last_ok) > CATCH_UP):
            self.start_sync("startup catch-up")

    # --- Google login -------------------------------------------------------------------------------
    def begin_login(self):
        if not api.CLIENT_SECRET.exists():
            raise HTTPException(500, f"OAuth client file missing: {api.CLIENT_SECRET}")
        url, state, verifier = api.auth_url(REDIRECT_URI)
        now = time.time()
        self.logins = {s: v for s, v in self.logins.items() if v[1] > now}
        self.logins[state] = (verifier, now + LOGIN_TTL)
        return url

    def finish_login(self, state, query):
        verifier, expires = self.logins.pop(state, (None, 0))
        if expires < time.time():
            raise ValueError("This login link has expired or was already used. Start again.")
        api.finish_login(REDIRECT_URI, state, verifier, f"{REDIRECT_URI}?{query}")
        self.set_auth("ok")


@contextlib.contextmanager
def _log_to_file():
    """Send print() output to the console and to data/sync.log."""
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        with contextlib.redirect_stdout(_Tee(sys.__stdout__, f)):
            yield


class _Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, s):
        for st in self.streams:
            st.write(s)
        return len(s)

    def flush(self):
        for st in self.streams:
            st.flush()


def _page(title, body):
    return HTMLResponse(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;background:#f9f9f7;color:#0b0b0b}}
@media (prefers-color-scheme:dark){{body{{background:#0d0d0d;color:#f2f1ee}}a{{color:#76abf0}}}}</style></head>
<body><h1>{html.escape(title)}</h1>{body}<p><a href="../">Back to the dashboard</a></p></body></html>""")


server: Server = None


@asynccontextmanager
async def lifespan(_app):
    global server
    server = Server()
    server.start()
    print(f"Serving; Google redirect URI is {REDIRECT_URI}", flush=True)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
NO_STORE = {"Cache-Control": "no-store"}


@app.get("/", response_class=HTMLResponse)
def index():
    page = WEB_DIST / "index.html"
    if not page.exists():
        return _page("Front end not built", f"<p>{html.escape(str(page))} is missing. Run <code>npm ci</code> and "
                     "<code>npm run build</code> in <code>web/</code>.</p>")
    return FileResponse(page, headers=NO_STORE)


# Built JS/CSS; file names contain a content hash, so browsers may cache them.
app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets", check_dir=False), name="assets")


@app.get("/api/data")
def get_data():
    return Response(json.dumps(server.data, separators=(",", ":"), allow_nan=False),
                    media_type="application/json", headers=NO_STORE)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    det = server.details.get(run_id)
    if det is None:
        raise HTTPException(404, "No such run")
    return Response(json.dumps(det, separators=(",", ":"), allow_nan=False),
                    media_type="application/json", headers=NO_STORE)


@app.get("/api/status")
def get_status():
    return JSONResponse(server.public_status(), headers=NO_STORE)


@app.post("/api/sync", status_code=202)
def post_sync():
    if not server.start_sync("manual"):
        raise HTTPException(409, "A sync is already running")
    return {"started": True}


@app.get("/oauth/start")
def oauth_start():
    return RedirectResponse(server.begin_login())


@app.get("/oauth/callback")
def oauth_callback(request: Request, state: str = "", error: str = ""):
    if error:
        return _page("Google login cancelled", f"<p>Google said: {html.escape(error)}.</p>"
                     '<p><a href="start">Try again</a></p>')
    try:
        server.finish_login(state, request.url.query)
    except Exception as e:
        if server.status["auth"] != "ok":
            server.set_auth("reconnect_needed", f"Login failed: {e}")
        return _page("Google login failed", f"<p>{html.escape(str(e))}</p><p><a href=\"start\">Try again</a></p>")
    server.start_sync("after login")
    return RedirectResponse("../")
