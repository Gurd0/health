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

**Only available through takeout** (keep doing a takeout now and then): sleep scores, body
and skin temperature, EDA/stress, readiness, cardio load, GPS, running dynamics (cadence,
speed, stride, ground contact), micro motion, breathing quality. `floors`, `total-calories`
and `calories-in-heart-rate-zone` exist in the API only as rollups (not synced yet).

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
- Back up `data/` and `secrets/`. `token.json` is the login.

Run it without Docker: build the front end once (`cd web`, `npm ci`, `npm run build`), then
`.venv\Scripts\python -m ingest serve` (listens on 127.0.0.1:8000). Don't run `sync.cmd` against the
same database while the server is running.

## Dashboard

Served by `ingest serve` (see above). Pages, from the Claude Design canvas "Health & running dashboard": **Overview** (tiles, trends, load and recovery), **Runs**
(weekly distance, records, progress, all runs) and **Run detail** (route, splits, heart-rate zones,
pace/elevation, running form, context). Theme: Auto/Light/Dark.

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
  main.tsx, App.tsx      start-up, loading data and status, routing (#/overview, #/runs, #/run/<id>), Sync now
  api.ts                 calls to the server
  types.ts               shapes of the server's JSON
  data.ts                the loaded data (useData()), runs with day indexes
  hooks.ts               phone layout, theme, URL routing, state that survives page changes
  lib/format.ts          number/time formatting, mean/quantile/ticks
  lib/calendar.ts        day indexes <-> dates ("15. okt.")
  components/            Header (with the sync/login banner), Seg (segmented buttons)
  charts/                TrendChart (Overview), WeeklyDistance, ProgressChart, TimeSeriesChart, RouteMap, svg.tsx (shared bits)
  pages/                 Overview, Runs, RunDetail
  styles.css             colour tokens (light/dark) and layout classes
```

Development: run `python -m ingest serve` (port 8000), then `npm run dev` in `web/` and open
http://localhost:5173. Changes show up immediately, and `api/` calls go to the Python server.
`npm run typecheck` checks types; `npm run build` writes `web/dist/`, which the server serves.

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

## Not imported yet (still in raw/)

`Global Export Data/` (Fitbit-format duplicates of the above), top-level `Temperature/`,
`Heart Rate Variability/`, `Oxygen Saturation (SpO2)/`, `Stress Journal/`, `Biometrics/`,
`UserActivityProbabilities`, and account/settings files.
