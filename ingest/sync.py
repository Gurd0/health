"""Incremental sync from the Google Health API.

For each data type the sync window starts LOOKBACK before the newest row already
stored (takeout or API), so data the watch re-buckets after the fact gets corrected.

Observations and daily values: the API is authoritative for the window it returned.
Takeout/API rows of that type inside the window are replaced by the API rows (the API
returns all sources, and takeout source names don't always match the API's).
Sleep and exercise share ids between takeout and API, so they're merged by id, keeping
takeout-only fields (sleep scores, log type) that the API doesn't provide.

Every response page is archived to raw/api/<date>/<data_type>.jsonl.gz.
"""
import gzip
import json
from datetime import date, datetime, timedelta, timezone

from . import api, db

ORIGIN = "api"
LOOKBACK = timedelta(days=3)
DEFAULT_START = datetime(2026, 1, 1)
CHUNK = timedelta(days=7)

# API data type -> (value field, scale to the takeout's unit, text field).
# Field paths are relative to the type object (e.g. dataPoint.heartRate).
SAMPLES = {
    "heart-rate": ("beatsPerMinute", 1, None),
    "heart-rate-variability": ("rootMeanSquareOfSuccessiveDifferencesMilliseconds", 1, None),
    "oxygen-saturation": ("percentage", 1, None),
    "respiratory-rate-sleep-summary": ("fullSleepStats.breathsPerMinute", 1, None),
    "run-vo2-max": ("runVo2Max", 1, None),
    "vo2-max": ("vo2Max", 1, None),
    "weight": ("weightGrams", 1, None),
    "height": ("heightMillimeters", 1, None),
    "body-fat": ("percentage", 1, None),
}
INTERVALS = {
    "steps": ("count", 1, None),
    "distance": ("millimeters", 0.001, None),  # takeout stores meters
    "altitude": ("gainMillimeters", 1, None),
    "active-energy-burned": ("kcal", 1, None),
    "active-minutes": (None, 1, None),
    "active-zone-minutes": ("activeZoneMinutes", 1, "heartRateZone"),
    "activity-level": (None, 1, "activityLevelType"),
    "time-in-heart-rate-zone": (None, 1, "heartRateZoneType"),
    "sedentary-period": (None, 1, None),
    "swim-lengths-data": ("strokeCount", 1, None),
}
DAILY = {
    "daily-resting-heart-rate": ("beatsPerMinute", 1, None),
    "daily-heart-rate-variability": ("averageHeartRateVariabilityMilliseconds", 1, None),
    "daily-oxygen-saturation": ("averagePercentage", 1, None),
    "daily-respiratory-rate": ("breathsPerMinute", 1, None),
    "daily-sleep-temperature-derivations": ("nightlyTemperatureCelsius", 1, None),
    "daily-vo2-max": ("vo2Max", 1, "cardioFitnessLevel"),
    "daily-heart-rate-zones": (None, 1, None),
}
SESSIONS = ("sleep", "exercise")
ALL_TYPES = [*SAMPLES, *INTERVALS, *DAILY, *SESSIONS, "exercise-tcx"]

TIME_KEYS = ("interval", "sampleTime", "date")


def snake(name):
    return name.replace("-", "_")


def ts(s):
    return s.rstrip("Z") if s else None


def offset_s(s):
    return int(float(s.rstrip("s"))) if s else None


def dig(obj, path):
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def source_name(ds):
    """Map an API dataSource to the source names used in the takeout export."""
    device = ds.get("device", {})
    if device.get("displayName"):
        return device["displayName"]
    if ds.get("platform") == "HEALTH_CONNECT":
        return "Phone Health Connect" if device.get("formFactor") == "PHONE" else "Health Connect"
    if device.get("formFactor") == "PHONE":
        return "MobileTrack"
    return "Google Health App"


def api_id(point):
    name = point.get("name", "")
    return name.rsplit("/", 1)[-1] or None


def payload(point):
    """The type-specific object of a data point (e.g. point['heartRate'])."""
    return next(v for k, v in point.items() if k not in ("name", "dataSource"))


class Archive:
    def __init__(self, run_date):
        self.dir = db.RAW_DIR / "api" / run_date
        self.dir.mkdir(parents=True, exist_ok=True)

    def write(self, data_type, filter, page):
        line = json.dumps({
            "fetched_at": datetime.now(timezone.utc).isoformat(), "data_type": data_type,
            "filter": filter, "response": page,
        })
        with gzip.open(self.dir / f"{data_type}.jsonl.gz", "at", encoding="utf-8") as f:
            f.write(line + "\n")

    def write_file(self, rel_path, text):
        path = self.dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as f:
            f.write(text)


def fetch(client, archive, data_type, filter, page_size):
    points = []
    for page in client.list_points(data_type, filter, page_size):
        if archive:
            archive.write(data_type, filter, page)
        points += page.get("dataPoints", [])
    return points


def run(con, import_id, types=None, since=None, dry_run=False, interactive=True):
    """Sync each data type; returns the data types that failed."""
    client = api.Client(interactive)
    failed = []
    archive = None if dry_run else Archive(date.today().isoformat())
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for data_type in types or ALL_TYPES:
        try:
            if data_type in DAILY:
                sync_daily(con, client, archive, data_type, import_id, since, now, dry_run)
            elif data_type == "sleep":
                sync_sleep(con, client, archive, import_id, since, now, dry_run)
            elif data_type == "exercise":
                sync_exercise(con, client, archive, import_id, since, now, dry_run)
            elif data_type == "exercise-tcx":
                sync_run_tracks(con, client, archive, import_id, dry_run)
            else:
                sync_observations(con, client, archive, data_type, import_id, since, now, dry_run)
        except api.ApiError as e:
            print(f"  {data_type}: FAILED {e}")
            failed.append(data_type)
    return failed


def window_start(con, sql, params, since):
    if since:
        return since
    latest = con.execute(sql, params).fetchone()[0]
    if latest is None:
        return DEFAULT_START
    if not isinstance(latest, datetime):
        latest = datetime.combine(latest, datetime.min.time())
    return latest - LOOKBACK


# --- Samples and intervals -------------------------------------------------------------------


def sync_observations(con, client, archive, data_type, import_id, since, now, dry_run):
    is_sample = data_type in SAMPLES
    value_field, scale, text_field = (SAMPLES if is_sample else INTERVALS)[data_type]
    time_field = f"{snake(data_type)}.{'sample_time.physical_time' if is_sample else 'interval.start_time'}"
    start = window_start(
        con, "SELECT max(start_utc) FROM observations WHERE data_type = ? AND origin IN ('takeout', 'api')",
        [data_type], since,
    )
    start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now + timedelta(hours=1)
    fetched = inserted = replaced = 0
    a = start
    while a < end:
        b = min(a + CHUNK, end)
        f = f'{time_field} >= "{a.isoformat()}Z" AND {time_field} < "{b.isoformat()}Z"'
        points = fetch(client, archive, data_type, f, 10000)
        fetched += len(points)
        records = []
        for p in points:
            obj = payload(p)
            if is_sample:
                t = obj["sampleTime"]
                start_utc, end_utc, off = ts(t["physicalTime"]), None, offset_s(t.get("utcOffset"))
            else:
                t = obj["interval"]
                start_utc, end_utc, off = ts(t["startTime"]), ts(t["endTime"]), offset_s(t.get("startUtcOffset"))
            v = num(dig(obj, value_field)) if value_field else None
            rest = {k: v2 for k, v2 in obj.items() if k not in TIME_KEYS}
            records.append({
                "data_type": data_type, "start_utc": start_utc, "end_utc": end_utc, "utc_offset_s": off,
                "source": source_name(p.get("dataSource", {})),
                "value": v * scale if v is not None else None,
                "value_text": dig(obj, text_field) if text_field else None,
                "value_json": json.dumps(rest) if rest else None,
                "origin": ORIGIN, "api_id": api_id(p), "import_id": import_id,
            })
        r, n = replace_window(con, "observations", "start_utc", data_type, a, b, records, dry_run)
        replaced += r
        inserted += n
        a = b
    if not dry_run:
        db.register_type(con, data_type, ORIGIN, "sample" if is_sample else "interval", value_field, text_field)
    print(f"  {data_type}: {start.date()} .. now, fetched {fetched}, "
          + (f"would replace {replaced} stored rows" if dry_run else f"replaced {replaced}, net {inserted - replaced:+d}"))


# --- Daily -----------------------------------------------------------------------------------


def sync_daily(con, client, archive, data_type, import_id, since, now, dry_run):
    value_field, scale, text_field = DAILY[data_type]
    start = window_start(
        con, "SELECT max(date) FROM daily WHERE data_type = ? AND origin IN ('takeout', 'api')", [data_type], since,
    ).date()
    f = f'{snake(data_type)}.date >= "{start.isoformat()}"'
    points = fetch(client, archive, data_type, f, 10000)
    records = []
    for p in points:
        obj = payload(p)
        d = obj["date"]
        v = num(dig(obj, value_field)) if value_field else None
        rest = {k: v2 for k, v2 in obj.items() if k not in TIME_KEYS}
        records.append({
            "data_type": data_type, "date": date(d["year"], d["month"], d["day"]),
            "source": source_name(p.get("dataSource", {})),
            "value": v * scale if v is not None else None,
            "value_text": dig(obj, text_field) if text_field else None,
            "value_json": json.dumps(rest) if rest else None,
            "origin": ORIGIN, "api_id": api_id(p), "import_id": import_id,
        })
    replaced, inserted = replace_window(con, "daily", "date", data_type, start, None, records, dry_run)
    if dry_run:
        print(f"  {data_type}: from {start}, fetched {len(points)}, would replace {replaced} stored rows")
        return
    db.register_type(con, data_type, ORIGIN, "daily", value_field, text_field)
    print(f"  {data_type}: from {start}, fetched {len(points)}, replaced {replaced}, net {inserted - replaced:+d}")


def replace_window(con, table, time_col, data_type, a, b, records, dry_run):
    """Write API records for one data type and window [a, b) (b=None: open-ended).

    - API rows already stored in the window are dropped (the API re-buckets recent data).
    - Takeout rows at a time the API returned are dropped, whatever their source name:
      the takeout labels derived data "Google Health App" where the API names the device.
    - Takeout rows the API didn't return are kept (e.g. the API filters some SpO2 readings).
    Returns (rows_removed, rows_inserted); in a dry run nothing is written.
    """
    window = f"t.data_type = ? AND t.{time_col} >= ?" + (f" AND t.{time_col} < ?" if b is not None else "")
    params = [data_type, a] + ([b] if b is not None else [])
    con.execute(f"CREATE OR REPLACE TEMP TABLE _api AS {db.stage_records(con, table, records)}")
    removed = (
        f"SELECT count(*) FROM {table} t WHERE {window} AND (t.origin = 'api' OR (t.origin = 'takeout' AND "
        f"t.{time_col} IN (SELECT {time_col}::{'DATE' if time_col == 'date' else 'TIMESTAMP'} FROM _api)))"
    )
    if dry_run:
        return con.execute(removed, params).fetchone()[0], 0
    con.begin()
    n_removed = con.execute(removed.replace("SELECT count(*) FROM", "DELETE FROM"), params).fetchone()[0]
    inserted = 0
    if records:
        _, _, inserted = db.upsert(con, table, "SELECT * FROM _api", scope={"data_type": data_type})
    con.commit()
    return n_removed, inserted


# --- Sessions --------------------------------------------------------------------------------


def keep_existing(con, table, key, records, columns):
    """Fill `columns` that the API doesn't provide from the already-stored row with the same id."""
    ids = [r[key] for r in records]
    if not ids:
        return
    rows = con.execute(
        f"SELECT {key}, {', '.join(columns)} FROM {table} WHERE {key} IN (SELECT unnest(?))", [ids]
    ).fetchall()
    existing = {r[0]: dict(zip(columns, r[1:])) for r in rows}
    for rec in records:
        for col, val in existing.get(rec[key], {}).items():
            if rec.get(col) is None:
                rec[col] = val


def sync_sleep(con, client, archive, import_id, since, now, dry_run):
    start = window_start(
        con, "SELECT max(end_utc) FROM sleep_sessions WHERE origin IN ('takeout', 'api')", [], since,
    ).date()
    points = fetch(client, archive, "sleep", f'sleep.interval.civil_end_time >= "{start.isoformat()}T00:00:00"', 25)
    if dry_run:
        print(f"  sleep: from {start}, fetched {len(points)}")
        return
    sessions, stages = [], []
    for p in points:
        s = payload(p)
        sleep_id = api_id(p)
        summary = s.get("summary", {})
        iv = s["interval"]
        stage_minutes = {x["type"]: num(x.get("minutes")) for x in summary.get("stagesSummary", [])}
        sessions.append({
            "sleep_id": sleep_id, "start_utc": ts(iv["startTime"]), "end_utc": ts(iv["endTime"]),
            "start_offset_s": offset_s(iv.get("startUtcOffset")), "end_offset_s": offset_s(iv.get("endUtcOffset")),
            "sleep_type": s.get("type"),
            "minutes_in_sleep_period": num(summary.get("minutesInSleepPeriod")),
            "minutes_asleep": num(summary.get("minutesAsleep")),
            "minutes_awake": num(summary.get("minutesAwake")),
            "minutes_to_fall_asleep": num(summary.get("minutesToFallAsleep")),
            "minutes_after_wake_up": num(summary.get("minutesAfterWakeUp")),
            "deep_sleep_minutes": stage_minutes.get("DEEP"),
            "data_source": p.get("dataSource", {}).get("recordingMethod"),
            "details": json.dumps({k: v for k, v in s.items() if k not in ("interval", "stages")}),
            "created_utc": ts(s.get("createTime")), "updated_utc": ts(s.get("updateTime")),
            "origin": ORIGIN, "api_id": sleep_id, "import_id": import_id,
        })
        for st in s.get("stages", []):
            stages.append({
                "sleep_id": sleep_id, "start_utc": ts(st["startTime"]), "end_utc": ts(st["endTime"]),
                "stage": st["type"], "origin": ORIGIN, "import_id": import_id,
            })
    keep_existing(con, "sleep_sessions", "sleep_id", sessions, [
        "overall_score", "duration_score", "composition_score", "revitalization_score",
        "deep_sleep_minutes", "rem_sleep_percent", "resting_heart_rate", "restlessness", "algorithm_version",
    ])
    con.begin()
    _, _, n = db.upsert(con, "sleep_sessions", db.stage_records(con, "sleep_sessions", sessions))
    if sessions:
        # The API's stage list is complete for each session it returns.
        con.execute("DELETE FROM sleep_stages WHERE sleep_id IN (SELECT unnest(?))", [[s["sleep_id"] for s in sessions]])
    db.upsert(con, "sleep_stages", db.stage_records(con, "sleep_stages", stages))
    con.commit()
    print(f"  sleep: from {start}, fetched {len(points)} sessions ({n} new), {len(stages)} stages")


def sync_exercise(con, client, archive, import_id, since, now, dry_run):
    start = window_start(
        con, "SELECT max(start_utc) FROM workouts WHERE origin IN ('takeout', 'api')", [], since,
    ).date()
    points = fetch(client, archive, "exercise", f'exercise.interval.civil_start_time >= "{start.isoformat()}"', 25)
    if dry_run:
        print(f"  exercise: from {start}, fetched {len(points)}")
        return
    records = []
    for p in points:
        e = payload(p)
        iv = e["interval"]
        m = e.get("metricsSummary", {})
        start_utc, end_utc = ts(iv["startTime"]), ts(iv["endTime"])
        dist_mm = num(m.get("distanceMillimeters"))
        records.append({
            "workout_id": api_id(p), "start_utc": start_utc, "end_utc": end_utc,
            "utc_offset_s": offset_s(iv.get("startUtcOffset")),
            "activity": e.get("displayName") or e.get("exerciseType"),
            "source": source_name(p.get("dataSource", {})),
            "duration_s": (datetime.fromisoformat(end_utc[:19]) - datetime.fromisoformat(start_utc[:19])).total_seconds(),
            "calories": num(m.get("caloriesKcal")), "steps": num(m.get("steps")),
            "distance_m": dist_mm / 1000 if dist_mm else None,
            "avg_heart_rate": num(m.get("averageHeartRateBeatsPerMinute")),
            "details": json.dumps({k: v for k, v in e.items() if k != "interval"}),
            "origin": ORIGIN, "api_id": api_id(p), "import_id": import_id,
        })
    keep_existing(con, "workouts", "workout_id", records, ["log_type", "max_heart_rate"])
    _, _, n = db.upsert(con, "workouts", db.stage_records(con, "workouts", records))
    print(f"  exercise: from {start}, fetched {len(points)} ({n} new)")


# --- Run tracks (TCX) ------------------------------------------------------------------------


def sync_run_tracks(con, client, archive, import_id, dry_run):
    """Fetch the per-second track (GPS, distance, altitude, heart rate) of every watch run that has none yet."""
    from . import runs, tcx

    run_ids = [r for r, src in runs.identify(con)[["workout_id", "src"]].itertuples(index=False) if src == "watch"]
    have = {r[0] for r in con.execute("SELECT DISTINCT workout_id FROM workout_trackpoints").fetchall()}
    # runs whose TCX was fetched but held no trackpoints (e.g. some treadmill runs)
    have |= {r[0] for r in con.execute("SELECT path FROM imported_files WHERE unit = 'api:exercise-tcx'").fetchall()}
    todo = [r for r in run_ids if r not in have]
    if dry_run:
        print(f"  exercise-tcx: {len(todo)} runs without a track")
        return
    fetched = points = 0
    for rid in todo:
        try:
            body = client.get(f"dataTypes/exercise/dataPoints/{rid}:exportExerciseTcx")
        except api.ApiError as e:
            print(f"  exercise-tcx: {rid}: HTTP {e.status}, skipped")
            continue
        text = body.get("tcxData")
        if not text:
            continue
        archive.write_file(f"exercise-tcx/{rid}.tcx.gz", text)
        tps = [{"workout_id": rid, **tp, "origin": ORIGIN, "import_id": import_id} for tp in tcx.parse_text(text)]
        if tps:
            db.upsert(con, "workout_trackpoints", db.stage_records(con, "workout_trackpoints", tps))
        con.execute("INSERT OR REPLACE INTO imported_files VALUES ('api:exercise-tcx', ?, ?, ?, ?)",
                    [rid, f"{len(tps)} trackpoints", len(text), import_id])
        fetched += 1
        points += len(tps)
    print(f"  exercise-tcx: {fetched} of {len(todo)} runs fetched, {points} trackpoints")
