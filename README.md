# Health data

Personal health data from Google Health (Pixel Watch) and legacy Google Fit, stored in DuckDB.

## Layout

```
raw/takeout-YYYY-MM-DD/   Google Takeout exports, kept as-is (permanent archive)
raw/api/YYYY-MM-DD/       raw Google Health API responses, one .jsonl.gz per data type
data/health.duckdb        the database; can always be rebuilt from raw/
ingest/                   importer, sync and web server (Python)
web/                      dashboard front end (React + TypeScript)
```

## Setup

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Importing a new takeout

1. Unzip the export to `raw/takeout-YYYY-MM-DD/` (it contains `Google Health/` and/or `Fit/`).
2. `.venv\Scripts\python -m ingest takeout raw/takeout-YYYY-MM-DD`
3. `.venv\Scripts\python -m ingest status`

Files that were already imported (same SHA-1) are skipped; `--force` re-reads everything.
Rows are merged on a natural key, so overlapping exports never create duplicates and
old history is never deleted. Precedence when keys collide: `api` > `takeout` > `fit-legacy`.

To rebuild from scratch: delete `data/health.duckdb` and import each takeout in date order.

## Syncing from the Google Health API

```
.venv\Scripts\python -m ingest sync              # everything new since the last sync
.venv\Scripts\python -m ingest sync --dry-run    # fetch and compare, write nothing
.venv\Scripts\python -m ingest sync --since 2026-09-01 --types heart-rate,steps
```

`sync.cmd` runs the sync and appends to `data\sync.log` (for Task Scheduler).

- Login: OAuth desktop client in `secrets/client_secret.json`; the token is cached in
  `secrets/token.json`. While the Cloud project is in *Testing* mode Google expires the
  login after 7 days and the next sync opens the browser to log in again.
- Each data type syncs from 3 days before its newest stored row, so data the watch
  re-buckets later gets corrected.
- Samples/intervals/daily: an API point replaces takeout rows at the same time, whatever
  their source name (the takeout says "Google Health App" where the API names the device).
  Takeout rows the API doesn't return are kept: the API filters out some SpO2 readings
  that the takeout includes.
- Sleep and exercise ids are the same in takeout and API; they merge by id. The API has
  no sleep scores or exercise log type, so those are kept from the takeout.

**Some data is only available through takeout** (sleep scores, running form, cardio load,
readiness, stress/EDA, temperature, ...), so import a new takeout now and then. See
[DATA.md](DATA.md) for what comes from the API, what only comes from a takeout, and what the
dashboard uses.

## Server (Docker)

`ingest serve` runs the dashboard as a web app with a JSON API (`api/data`, `api/runs/<id>`,
`api/status`, `POST api/sync`), owns the Google login and syncs daily. It is meant for a private
network (LAN or Tailscale): there is no login in the app, so don't expose the port publicly.

1. **Google Cloud Console.** Create an OAuth client of type *Web application* with the redirect URI
   `<PUBLIC_URL>/oauth/callback` (default `http://localhost:8000/oauth/callback`) and save its JSON
   as `secrets/client_secret.json`. The current desktop client and its `token.json` also work as
   they are, so you can skip this step until you need to reconnect. Set the OAuth consent screen
   to **In production**: in *Testing* mode Google kills the login after 7 days. An unverified app is
   fine for personal use; click past the warning. On the consent screen choose ongoing access, not
   time-limited access.
2. **Copy to the server:** `README.md`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`,
   `.dockerignore`, `ingest/`, `web/` (without `node_modules/` and `dist/`), and the data folders `data/` (at least `health.duckdb`), `raw/` and
   `secrets/`. Then run `cp .env.example .env` and edit it.
3. `docker compose up -d --build`. Logs: `docker compose logs -f`. The sync output is also appended
   to `data/sync.log`.
4. **Connect Google** (first time, or when the dashboard says the login needs renewing): run
   `ssh -L 8000:localhost:8000 <server>`, open `http://localhost:8000` and click **Reconnect Google**
   (or go to `/oauth/start`). This runs the consent once with `access_type=offline&prompt=consent`
   and saves the refresh token in `secrets/token.json`. From then on the server refreshes the
   1-hour access tokens itself.

How it behaves:
- It syncs every day at `SYNC_TIME`, and also at startup if the last good sync is more than
  26 hours old. Daily use also keeps the refresh token alive, since Google drops tokens unused for
  6 months. **Sync now** in the header runs a sync immediately.
- If Google rejects the refresh token (`invalid_grant`: Testing mode, revoked access, 6 months
  unused), the status changes to `reconnect_needed` and the dashboard shows a banner with
  **Reconnect Google**. Don't reconnect over and over: each consent issues a new refresh token, and
  Google keeps only about 100 per account, revoking the oldest.
- Status is kept in `data/status.json`.
- **Takeout imports** need the database to themselves:
  `docker compose stop && docker compose run --rm health python -m ingest takeout raw/takeout-YYYY-MM-DD && docker compose start`.
  The CLI commands `status` and `sync --dry-run` work the same way, with the server stopped.
- Back up `data/` and `secrets/`. `token.json` is the login; `data/training.duckdb` holds your plans,
  notes and shoes, which can't be rebuilt from `raw/`.

Run it without Docker: build the front end once (`cd web`, `npm ci`, `npm run build`), then
`.venv\Scripts\python -m ingest serve` (listens on 127.0.0.1:8000). Don't run `sync.cmd` against the
same database while the server is running.

## Dashboard

Served by `ingest serve` (see above). Pages, from the Claude Design canvas "Health & running dashboard": **Overview** (tiles, trends, load and recovery), **Training**
(plan, today, targets, load; see below), **Runs** (weekly distance, records, progress, all runs),
**Run detail** (route, splits, heart-rate zones, pace/elevation, running form, context, your notes)
and **Gear** (shoes). Theme: Auto/Light/Dark.

- `ingest/runs.py` decides what is a run and builds per-run data. A workout is a run if the API says
  RUNNING, its activity is Run/Outdoor Run/Treadmill Run, it's a "Structured Workout" with cadence data,
  or a Google Fit "running" session; distance 0.3-100 km and pace 2:30-15:00 /km.
- Route, distance, altitude and heart rate per second come from the API's `exportExerciseTcx`
  (synced as `exercise-tcx`, archived in `raw/api/<date>/exercise-tcx/`). Running form (cadence,
  stride, ground contact, vertical oscillation/ratio) only exists in takeouts, so runs newer than the
  last takeout show form averages only.
- Splits faster than 75 % of a run's average pace are treated as GPS glitches and ignored for records.
- Old Google Fit runs have distance, time, calories and steps only (no GPS in their TCX files).
- Data for the pages: `ingest/dashboard.py` (daily series) and `ingest/runs.py`, served as `api/data`
  and `api/runs/<id>`. Their shapes are typed in `web/src/types.ts`.

### Front end (`web/`)

React + TypeScript, built with Vite. No chart library: the charts are small SVG components.

```
web/src/
  main.tsx, App.tsx      start-up, loading data and status, routing (#/overview, #/training, #/runs, #/run/<id>, #/gear), Sync now
  api.ts                 calls to the server
  types.ts               shapes of the server's JSON
  data.ts                the loaded data (useData()), runs with day indexes
  hooks.ts               phone layout, theme, URL routing, state that survives page changes
  lib/format.ts          number/time formatting, mean/quantile/ticks
  lib/calendar.ts        day indexes <-> dates ("15. okt.")
  lib/training.ts        session kinds/statuses (labels, colours), pace and time parsing
  components/            Header (with the sync/login banner), Seg (segmented buttons), PlanSetup, SessionEditor, RunNotes
  charts/                TrendChart (Overview), WeeklyDistance, ProgressChart, TimeSeriesChart, RouteMap, TrainingCharts, svg.tsx (shared bits)
  pages/                 Overview, Training, Runs, RunDetail, Gear
  styles.css             colour tokens (light/dark) and layout classes
```

Development: run `python -m ingest serve` (port 8000), then `npm run dev` in `web/` and open
http://localhost:5173. Changes show up immediately, and `api/` calls go to the Python server.
`npm run typecheck` checks types; `npm run build` writes `web/dist/`, which the server serves.

## Training

Plans, run notes, shoes and weekly targets live in `data/training.duckdb` (`HEALTH_TRAINING_DB`),
attached to the server's connection as `tr` (`ingest/training_db.py`). It's the only data written
through the API, and writes only accept JSON bodies, so a cross-site form can't post to them.

- **Plan generator** (`ingest/plan.py`). From a goal (5 km to marathon, date 3–26 weeks away,
  optional goal time), the training days and long-run day, and your last 6 weeks of runs:
  - fitness: weekly km, longest run, and a 5 km-equivalent time from the best effort of the last
    90 days (Riegel, exponent 1.06), which also predicts the race time;
  - paces as multiples of that 5 km pace: easy 1.25–1.35, tempo 1.06–1.09, intervals 0.97–1.00;
    race pace from the goal time, at most 3 % faster than predicted;
  - volume from current weekly km, +10 % (or +3 km) a week at most towards a peak set by the goal
    (25/35/45/60 km), every 4th week at 80 %, then a 1–3 week taper; the long run grows 1.5 km a
    week at most; quality sessions (tempo, intervals) take about 25 % of the week, two a week only
    from 30 km and 5 runs;
  - phases: base (easy + strides), build and peak (tempo and intervals alternate), taper, race.
- **Rebuild remaining weeks** regenerates future sessions from current fitness. Past sessions and
  sessions you edited, linked or skipped are kept.
- **Matching** (`ingest/training.py`): a session takes a run on the same day (closest distance
  first); a run linked by hand or a skip always wins. Done = at least 80 % of the planned distance.
  Steady sessions get a pace verdict (±5 s/km around the range) and a heart-rate-zone check.
- **Weeks**: a week is on target with ≥ 80 % of the planned km and every long, tempo, interval and
  race session done; the streak counts such weeks in a row. Without a plan, the weekly targets apply.
- **Load**: Banister TRIMP per run from average heart rate (rest = that day's resting HR, max = the
  highest of the last year); without heart rate, minutes × RPE × 0.4. ACWR = last 7 days ÷ (last 28
  days ÷ 4): above 1.3 is a caution, above 1.5 high. Weekly km more than 10 % (or 3 km) above the
  week before is flagged too.
- **Recovery check** for today: HRV below its 30-day mean − 1 SD, resting HR more than 3 bpm above
  its 30-day mean, or under 6 h of sleep. With a quality session planned today it offers to swap it
  with the next easy run.
- **Shoes**: km = km already on the shoe + its runs. A run without its own shoe counts for the shoe
  that was the default on its date, so changing the default never moves old runs.

## Tables

| table | key | contents |
|---|---|---|
| `observations` | data_type, start_utc, source | samples and intervals (heart-rate, steps, spo2, ...) |
| `daily` | data_type, date, source | one value per civil day (resting HR, HRV, readiness, ...) |
| `sleep_sessions` / `sleep_stages` | sleep_id / sleep_id, start_utc | sleep with scores and stages |
| `sleep` (view) | | one record per sleep: drops takeout `sleep_session_v1` duplicates of v2/API sleeps |
| `workouts` / `workout_trackpoints` | workout_id / workout_id, ts_utc | exercises and GPS/HR tracks |
| `data_types` | data_type, origin | which column/unit `value` came from |
| `imports`, `imported_files` | | import log |

- `data_type` uses Google Health API names (`heart-rate`, `daily-resting-heart-rate`, ...).
- Times are naive UTC. `utc_offset_s` is set when the source provides it; the
  `observations_local` view adds `start_local` (falls back to Europe/Oslo).
- `value` is the main number, `value_text` a category/label, `value_json` all fields.
- Units follow the Google Health export (speed km/h, weight grams, height mm, distance m);
  legacy Fit values are converted to match.
- The same activity can be recorded by several sources (e.g. phone + watch steps).
  Don't sum across `source`; pick one per period.

## Data sources

[DATA.md](DATA.md) lists every data type by origin (API, takeout, legacy Google Fit), including
the takeout folders that aren't imported yet.
