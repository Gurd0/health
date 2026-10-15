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
    HEALTH_TRAINING_DB   plans, run notes and shoes (default data/training.duckdb, see training_db.py)
    HEALTH_WEB   the built front end (default web/dist; build it with `npm run build` in web/)

Training (plans, notes, shoes) is the only data written through the API. There is no login, so
writes only accept JSON bodies: a plain cross-site form post can't trigger them.
"""
import contextlib
import datetime as dt
import html
import json
import os
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from google.auth.exceptions import RefreshError
from pydantic import BaseModel, Field

from . import api, dashboard, db, sync, training, training_db

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
        training_db.attach(self.con)
        self.sync_lock = threading.Lock()
        self.write_lock = threading.Lock()  # training writes, one at a time
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

    @contextlib.contextmanager
    def cursor(self, write=False):
        """A cursor on the shared connection; with write=True also holds the training write lock."""
        with (self.write_lock if write else contextlib.nullcontext()):
            cur = self.con.cursor()
            try:
                yield cur
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


def _json(obj):
    return Response(json.dumps(obj, separators=(",", ":"), allow_nan=False, default=str),
                    media_type="application/json", headers=NO_STORE)


@app.middleware("http")
async def json_writes_only(request: Request, call_next):
    """Training writes must send JSON, which a cross-site <form> can't (see the module docstring)."""
    if request.method in ("POST", "PUT", "PATCH") and request.url.path.startswith("/api/") \
            and request.url.path != "/api/sync" \
            and not request.headers.get("content-type", "").startswith("application/json"):
        return JSONResponse({"detail": "Send a JSON body (Content-Type: application/json)."}, status_code=415)
    return await call_next(request)


@app.get("/api/data")
def get_data():
    with server.cursor() as cur:
        return _json({**server.data, "runs": training.annotate_runs(cur, server.data["runs"])})


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


# --- Training ---------------------------------------------------------------------------------------

KINDS = ("easy", "strides", "long", "tempo", "intervals", "recovery", "race")
ZONES = ("LIGHT", "MODERATE", "VIGOROUS", "PEAK")


class PlanIn(BaseModel):
    goal_km: float = Field(ge=1, le=100)
    goal_date: date
    goal_time_s: Optional[float] = Field(None, gt=0)
    runs_per_week: int = Field(ge=3, le=6)
    days: List[int]
    long_day: int = Field(ge=0, le=6)
    name: Optional[str] = Field(None, max_length=80)


class SessionIn(BaseModel):
    date: Optional[dt.date] = None  # dt.date: a field called `date` hides the type
    kind: Optional[str] = None
    title: Optional[str] = Field(None, max_length=80)
    distance_km: Optional[float] = Field(None, ge=0, le=100)
    pace_lo: Optional[float] = Field(None, gt=0)
    pace_hi: Optional[float] = Field(None, gt=0)
    hr_zone: Optional[str] = None
    description: Optional[str] = Field(None, max_length=500)
    status: Optional[str] = None
    run_id: Optional[str] = None


class SwapIn(BaseModel):
    a: str
    b: str


class NoteIn(BaseModel):
    rpe: Optional[int] = Field(None, ge=1, le=10)
    feel: Optional[int] = Field(None, ge=1, le=5)
    note: Optional[str] = Field(None, max_length=2000)
    shoe_id: Optional[str] = None


class ShoeIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    start_km: Optional[float] = Field(None, ge=0, le=5000)
    max_km: Optional[float] = Field(None, gt=0, le=5000)
    retired: Optional[bool] = None
    default: Optional[bool] = None
    since: Optional[dt.date] = None  # with default: true, the first day it counts as the default


class SettingsIn(BaseModel):
    target_km: Optional[float] = Field(None, ge=0, le=300)
    target_runs: Optional[int] = Field(None, ge=0, le=14)


def _inputs(body: PlanIn):
    return training.plan_inputs({**body.model_dump(), "goal_date": body.goal_date.isoformat()})


def _bad(e):
    return HTTPException(400, str(e))


@app.get("/api/training")
def get_training():
    with server.cursor() as cur:
        return _json(training.build(cur, server.data))


@app.post("/api/plans/preview")
def preview_plan(body: PlanIn):
    try:
        sessions, summary = training.preview(server.data, _inputs(body))
    except ValueError as e:
        raise _bad(e)
    with server.cursor() as cur:
        return _json(training.preview_json(sessions, summary, training.latest_zones(cur)))


@app.post("/api/plans", status_code=201)
def create_plan(body: PlanIn):
    with server.cursor(write=True) as cur:
        try:
            return {"id": training.create_plan(cur, server.data, _inputs(body), body.name)}
        except ValueError as e:
            raise _bad(e)


@app.post("/api/plans/{plan_id}/rebuild")
def rebuild_plan(plan_id: str):
    with server.cursor(write=True) as cur:
        try:
            return {"sessions": training.rebuild_plan(cur, server.data, plan_id)}
        except KeyError:
            raise HTTPException(404, "No such plan")
        except ValueError as e:
            raise _bad(e)


@app.delete("/api/plans/{plan_id}")
def archive_plan(plan_id: str):
    with server.cursor(write=True) as cur:
        n = cur.execute("UPDATE tr.plans SET status = 'archived' WHERE plan_id = ?", [plan_id]).fetchone()[0]
    if not n:
        raise HTTPException(404, "No such plan")
    return {"archived": plan_id}


def _check_session(fields):
    if "kind" in fields and fields["kind"] not in KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(KINDS)}")
    if fields.get("hr_zone") is not None and fields["hr_zone"] not in ZONES:
        raise HTTPException(400, f"hr_zone must be one of {', '.join(ZONES)}")
    if "status" in fields and fields["status"] not in ("planned", "skipped"):
        raise HTTPException(400, "status must be planned or skipped")
    if fields.get("run_id") and not any(r["id"] == fields["run_id"] for r in server.data["runs"]):
        raise HTTPException(400, "No such run")


@app.post("/api/sessions", status_code=201)
def add_session(body: SessionIn):
    fields = body.model_dump(exclude_unset=True)
    if not body.date or not body.kind:
        raise HTTPException(400, "date and kind are required")
    _check_session(fields)
    with server.cursor(write=True) as cur:
        p = training.active_plan(cur)
        if not p:
            raise HTTPException(400, "There is no active plan")
        sid = training_db.new_id()
        km = body.distance_km
        dur = round(km * (body.pace_lo + body.pace_hi) / 2) if km and body.pace_lo and body.pace_hi else None
        cur.execute("INSERT INTO tr.sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', true)",
                    [sid, p["plan_id"], body.date, body.kind, body.title or body.kind.capitalize() + " run", km, dur,
                     body.pace_lo, body.pace_hi, body.hr_zone, body.description, body.run_id])
    return {"id": sid}


@app.patch("/api/sessions/{session_id}")
def edit_session(session_id: str, body: SessionIn):
    fields = body.model_dump(exclude_unset=True)
    _check_session(fields)
    if not fields:
        return {"updated": 0}
    edits = set(fields) - {"status", "run_id"}  # links and skips are kept on rebuild anyway
    sets = [f"{k} = ?" for k in fields] + (["edited = true"] if edits else [])
    params = list(fields.values())
    if "distance_km" in fields or "pace_lo" in fields or "pace_hi" in fields:
        sets.append("duration_s = CASE WHEN distance_km IS NOT NULL AND pace_lo IS NOT NULL AND pace_hi IS NOT NULL "
                    "THEN round(distance_km * (pace_lo + pace_hi) / 2) END")
    with server.cursor(write=True) as cur:
        # SET expressions see the old row, so update the plain fields first, then the derived duration
        n = cur.execute(f"UPDATE tr.sessions SET {', '.join(s for s in sets if not s.startswith('duration_s'))} "
                        "WHERE session_id = ?", params + [session_id]).fetchone()[0]
        if n and any(s.startswith("duration_s") for s in sets):
            cur.execute(f"UPDATE tr.sessions SET {sets[-1]} WHERE session_id = ?", [session_id])
    if not n:
        raise HTTPException(404, "No such session")
    return {"updated": n}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    with server.cursor(write=True) as cur:
        n = cur.execute("DELETE FROM tr.sessions WHERE session_id = ?", [session_id]).fetchone()[0]
    if not n:
        raise HTTPException(404, "No such session")
    return {"deleted": n}


@app.post("/api/sessions/swap")
def swap_sessions(body: SwapIn):
    with server.cursor(write=True) as cur:
        found = dict(cur.execute("SELECT session_id, date FROM tr.sessions WHERE session_id IN (?, ?)",
                                 [body.a, body.b]).fetchall())
        if len(found) != 2:
            raise HTTPException(404, "No such session")
        cur.execute("UPDATE tr.sessions SET date = ?, edited = true WHERE session_id = ?", [found[body.b], body.a])
        cur.execute("UPDATE tr.sessions SET date = ?, edited = true WHERE session_id = ?", [found[body.a], body.b])
    return {"swapped": [body.a, body.b]}


@app.put("/api/runs/{run_id}/note")
def put_note(run_id: str, body: NoteIn):
    if not any(r["id"] == run_id for r in server.data["runs"]):
        raise HTTPException(404, "No such run")
    note = (body.note or "").strip() or None
    with server.cursor(write=True) as cur:
        if body.shoe_id and not cur.execute("SELECT 1 FROM tr.shoes WHERE shoe_id = ?", [body.shoe_id]).fetchone():
            raise HTTPException(400, "No such shoe")
        cur.execute("DELETE FROM tr.run_notes WHERE run_id = ?", [run_id])
        if body.rpe or body.feel or note or body.shoe_id:
            cur.execute("INSERT INTO tr.run_notes VALUES (?, ?, ?, ?, ?, ?)",
                        [run_id, body.rpe, body.feel, note, body.shoe_id, training_db.now()])
    return {"saved": run_id}


@app.get("/api/shoes")
def get_shoes():
    with server.cursor() as cur:
        return _json(training.shoes_view(cur, server.data["runs"]))


def _set_default(cur, shoe_id, since):
    cur.execute("INSERT INTO tr.shoe_defaults VALUES (?, ?, ?)",
                [since or training.local_today(), shoe_id, training_db.now()])


@app.post("/api/shoes", status_code=201)
def add_shoe(body: ShoeIn):
    if not body.name:
        raise HTTPException(400, "name is required")
    sid = training_db.new_id()
    with server.cursor(write=True) as cur:
        cur.execute("INSERT INTO tr.shoes VALUES (?, ?, ?, ?, false, ?)",
                    [sid, body.name, body.start_km or 0, body.max_km or 700, training_db.now()])
        if body.default:
            _set_default(cur, sid, body.since)
    return {"id": sid}


@app.patch("/api/shoes/{shoe_id}")
def edit_shoe(shoe_id: str, body: ShoeIn):
    fields = body.model_dump(exclude_unset=True)
    with server.cursor(write=True) as cur:
        if not cur.execute("SELECT 1 FROM tr.shoes WHERE shoe_id = ?", [shoe_id]).fetchone():
            raise HTTPException(404, "No such shoe")
        cols = {k: v for k, v in fields.items() if k in ("name", "start_km", "max_km", "retired") and v is not None}
        if cols:
            cur.execute(f"UPDATE tr.shoes SET {', '.join(k + ' = ?' for k in cols)} WHERE shoe_id = ?",
                        list(cols.values()) + [shoe_id])
        current = training.default_shoe_on(training.default_history(cur), date.max)
        if fields.get("default"):
            _set_default(cur, shoe_id, body.since)
        elif (fields.get("default") is False or fields.get("retired")) and current == shoe_id:
            _set_default(cur, None, None)  # no default from today
    return {"updated": shoe_id}


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    with server.cursor(write=True) as cur:
        training_db.put_settings(cur, body.model_dump(exclude_unset=True))
    return {"saved": True}


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
