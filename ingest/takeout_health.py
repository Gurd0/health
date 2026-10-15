"""Parsers for the `Google Health/` part of a Google Takeout export (Pixel Watch / Fitbit)."""
import csv
import json
import re
from datetime import datetime
from pathlib import Path

from . import db

ORIGIN = "takeout"
ACTIVITY_DIR = "Physical Activity_GoogleData"

# Folder name -> API data type name, where the default kebab-casing doesn't match.
TYPE_NAMES = {
    "Run Vo2max": "run-vo2-max",
}

# Daily types (one row per civil date). Everything else is a sample or interval.
DAILY_PREFIXES = ("Daily ", "general-", "Cardio Acute Chronic Workload Ratio", "Cardio Load Observed Interval")

# Folder -> (value column, text column) for multi-column files. Files with a single
# value column use it automatically. All columns are also kept in value_json.
VALUE_COLUMNS = {
    "Active Minutes": (None, None),
    "Active Zone Minutes": ("total minutes", "heart rate zone"),
    "Body Response Algorithm Features": ("hr mean bpm", None),
    "Body Response Event": ("Body Response Score", None),
    "Breathing Quality": ("oxygen desaturation probability", "sleep state"),
    "Calories In Heart Rate Zone": ("kcal", "heart rate zone type"),
    "Cardio Acute Chronic Workload Ratio": ("ratio", "label"),
    "Cardio Load": ("total", None),
    "Cardio Load Observed Interval": (None, None),
    "Continuous Eda": ("eda level real micro siemens", None),
    "Daily Heart Rate Variability": ("average heart rate variability milliseconds", None),
    "Daily Oxygen Saturation": ("average percentage", None),
    "Daily Readiness": ("score", "readiness level"),
    "Daily Sleep Breathing Quality": ("sufficient oxygen percentage", "breathing quality sleep score"),
    "Daily Sleep Temperature Derivations": ("nightly temperature celsius", None),
    "general-BreathingQualityAssessment": (None, "Breathing Quality Classification"),
    "Gps Location": (None, None),
    "Heart Rate Variability": ("root mean square of successive differences milliseconds", None),
    "Live Pace": ("steps", None),
    "Micro Motion": (None, None),
    "Moods": (None, "moods"),
    "Respiratory Rate Sleep Summary": ("full sleep stats - milli breaths per minute", None),
    "Swim Lengths Data": ("stroke count", "stroke type"),
    "Vo2 Max": ("vo2 max value", None),
}

# Folders that interleave two unlabelled series: each timestamp appears twice, and the
# row order tells them apart. Body Temperature: first row ~skin temperature (20-36 °C),
# second row ~37-43 °C (matches `nightly_temperature` in Temperature/Computed Temperature).
PAIRED_SERIES = {
    "Body Temperature": "body-temperature-2",
}

TS_COLUMNS =("timestamp", "date", "start time")
END_COLUMN = "end time"
SOURCE_COLUMN = "data source"


def type_name(folder):
    if folder in TYPE_NAMES:
        return TYPE_NAMES[folder]
    name = folder.removeprefix("general-")
    name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)  # BloodPressureAssessment -> Blood Pressure Assessment
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def snake(col):
    return re.sub(r"[^a-z0-9]+", "_", col.lower()).strip("_")


def q(col):
    return '"' + col.replace('"', '""') + '"'


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def read_header(path):
    with open(path, newline="", encoding="utf-8") as f:
        return next(csv.reader(f))


def import_all(con, takeout, import_id, force=False):
    base = Path(takeout) / "Google Health"
    if not base.exists():
        return
    activity = base / ACTIVITY_DIR
    for folder in sorted(p for p in activity.iterdir() if p.is_dir()):
        import_activity_folder(con, folder, import_id, force)
    import_sleep(con, base, import_id, force)
    import_exercises(con, base, import_id, force)


def import_activity_folder(con, folder, import_id, force):
    files = sorted(folder.glob("*.csv"))
    unit = f"health:{folder.name}"
    if not files:
        return
    if not force and db.unit_is_current(con, unit, files):
        print(f"  {folder.name}: unchanged, skipped")
        return

    header = read_header(files[0])
    ts_col = next(c for c in header if c in TS_COLUMNS)
    end_col = END_COLUMN if END_COLUMN in header else None
    extras = [c for c in header if c not in (ts_col, end_col, SOURCE_COLUMN)]
    if folder.name in VALUE_COLUMNS:
        value_col, text_col = VALUE_COLUMNS[folder.name]
    elif len(extras) == 1:
        value_col, text_col = extras[0], extras[0]  # numeric goes to value, otherwise to value_text
    elif not extras:
        value_col, text_col = None, None
    else:
        raise ValueError(f"{folder.name}: multiple value columns {extras}; add it to VALUE_COLUMNS")

    data_type = type_name(folder.name)
    data_types = [data_type]
    type_sql = lit(data_type)
    daily = folder.name.startswith(DAILY_PREFIXES)
    if folder.name in PAIRED_SERIES:
        con.register("_paired", _with_sequence(files, ts_col))
        src = "_paired"
        data_types.append(PAIRED_SERIES[folder.name])
        type_sql = f"CASE WHEN _seq = 1 THEN {lit(data_type)} ELSE {lit(data_types[1])} END"
    else:
        file_list = "[" + ", ".join(lit(f.as_posix()) for f in files) + "]"
        src = (
            f"read_csv({file_list}, header=true, all_varchar=true, union_by_name=true, "
            f"quote='\"', escape='\"', max_line_size=10000000)"
        )

    value_sql = f"TRY_CAST({q(value_col)} AS DOUBLE)" if value_col else "NULL::DOUBLE"
    if text_col and text_col == value_col:
        text_sql = f"CASE WHEN TRY_CAST({q(text_col)} AS DOUBLE) IS NULL THEN {q(text_col)} END"
    else:
        text_sql = q(text_col) if text_col else "NULL"
    if len(extras) > 1:
        parts = []
        for c in extras:
            typed = f"COALESCE(to_json(TRY_CAST({q(c)} AS DOUBLE)), to_json({q(c)}))"
            parts += [lit(snake(c)), typed]
        json_sql = f"json_object({', '.join(parts)})"
    else:
        json_sql = "NULL::JSON"
    source_sql = f"COALESCE({q(SOURCE_COLUMN)}, 'unknown')" if SOURCE_COLUMN in header else "'unknown'"

    if daily:
        sql = f"""
            SELECT {type_sql} AS data_type, CAST(left({q(ts_col)}, 10) AS DATE) AS date,
                   {source_sql} AS source, {value_sql} AS value, {text_sql} AS value_text,
                   {json_sql} AS value_json, '{ORIGIN}' AS origin, NULL AS api_id, {import_id} AS import_id
            FROM {src} WHERE {q(ts_col)} IS NOT NULL"""
        table, kind = "daily", "daily"
    else:
        end_sql = f"CAST(rtrim({q(end_col)}, 'Z') AS TIMESTAMP)" if end_col else "NULL::TIMESTAMP"
        sql = f"""
            SELECT {type_sql} AS data_type, CAST(rtrim({q(ts_col)}, 'Z') AS TIMESTAMP) AS start_utc,
                   {end_sql} AS end_utc, NULL::INTEGER AS utc_offset_s, {source_sql} AS source,
                   {value_sql} AS value, {text_sql} AS value_text, {json_sql} AS value_json,
                   '{ORIGIN}' AS origin, NULL AS api_id, {import_id} AS import_id
            FROM {src} WHERE {q(ts_col)} IS NOT NULL"""
        table, kind = "observations", ("interval" if end_col else "sample")

    n, uniq, inserted = db.upsert(con, table, sql, scope={"data_type": data_types})
    for dt in data_types:
        db.register_type(con, dt, ORIGIN, kind, value_col, text_col)
    db.mark_imported(con, unit, files, import_id)
    dupes = f", {n - uniq} duplicate keys dropped" if n != uniq else ""
    print(f"  {folder.name} -> {table}.{', '.join(data_types)}: {n} rows, {inserted} new{dupes}")


def _with_sequence(files, ts_col):
    """Read CSVs as strings, adding `_seq` = occurrence number of each timestamp within its file."""
    import pandas as pd

    frames = []
    for f in files:
        df = pd.read_csv(f, dtype=str, keep_default_na=False, na_values=[""])
        df["_seq"] = df.groupby([ts_col, SOURCE_COLUMN]).cumcount() + 1
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


# --- Sleep -----------------------------------------------------------------------------------


def parse_offset(s):
    """'+02:00' / '+2:0' / '-05:30' -> seconds."""
    if not s:
        return None
    m = re.fullmatch(r"([+-])(\d{1,2}):(\d{1,2})", s.strip())
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    return sign * (int(m.group(2)) * 3600 + int(m.group(3)) * 60)


def ts(s):
    return s.rstrip("Z") if s else None


def num(s):
    if s in (None, "", "-1", "NaN"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def read_rows(paths):
    for p in paths:
        with open(p, newline="", encoding="utf-8") as f:
            yield from csv.DictReader(f)


def import_sleep(con, base, import_id, force):
    hfd = base / "Health Fitness Data_GoogleData"
    sleeps = sorted(hfd.glob("UserSleeps_*.csv"))
    scores = sorted(hfd.glob("UserSleepScores_*.csv"))
    stages = sorted(hfd.glob("UserSleepStages_*.csv"))
    restless = sorted((base / "Sleep Score").glob("sleep_score*.csv"))
    files = sleeps + scores + stages + restless
    unit = "health:sleep"
    if not sleeps:
        return
    if not force and db.unit_is_current(con, unit, files):
        print("  sleep: unchanged, skipped")
        return

    score_by_id = {r["sleep_id"]: r for r in read_rows(scores)}
    # The older sleep_score.csv uses different ids; match it on the session end time.
    restless_by_end = {ts(r["timestamp"]): num(r["restlessness"]) for r in read_rows(restless)}

    core = {
        "sleep_id", "sleep_type", "minutes_in_sleep_period", "minutes_asleep", "minutes_awake",
        "minutes_to_fall_asleep", "minutes_after_wake_up", "start_utc_offset", "sleep_start",
        "end_utc_offset", "sleep_end", "data_source", "sleep_created", "sleep_last_updated",
    }
    records = []
    for r in read_rows(sleeps):
        s = score_by_id.get(r["sleep_id"], {})
        records.append({
            "sleep_id": r["sleep_id"],
            "start_utc": ts(r["sleep_start"]),
            "end_utc": ts(r["sleep_end"]),
            "start_offset_s": parse_offset(r["start_utc_offset"]),
            "end_offset_s": parse_offset(r["end_utc_offset"]),
            "sleep_type": r["sleep_type"],
            "minutes_in_sleep_period": num(r["minutes_in_sleep_period"]),
            "minutes_asleep": num(r["minutes_asleep"]),
            "minutes_awake": num(r["minutes_awake"]),
            "minutes_to_fall_asleep": num(r["minutes_to_fall_asleep"]),
            "minutes_after_wake_up": num(r["minutes_after_wake_up"]),
            "overall_score": num(s.get("overall_score")),
            "duration_score": num(s.get("duration_score")),
            "composition_score": num(s.get("composition_score")),
            "revitalization_score": num(s.get("revitalization_score")),
            "deep_sleep_minutes": num(s.get("deep_sleep_minutes")),
            "rem_sleep_percent": num(s.get("rem_sleep_percent")),
            "resting_heart_rate": num(s.get("resting_heart_rate")),
            "restlessness": restless_by_end.get(ts(r["sleep_end"])),
            "data_source": r["data_source"],
            "algorithm_version": r.get("algorithm_version") or None,
            "details": json.dumps({
                "sleep": {k: v for k, v in r.items() if k not in core and v not in ("", None)},
                "score": {k: v for k, v in s.items() if v not in ("", None)},
            }),
            "created_utc": ts(r["sleep_created"]),
            "updated_utc": ts(r["sleep_last_updated"]),
            "origin": ORIGIN,
            "import_id": import_id,
        })
    n, _, inserted = db.upsert(con, "sleep_sessions", db.stage_records(con, "sleep_sessions", records))
    print(f"  sleep sessions: {n} rows, {inserted} new")

    stage_records = [{
        "sleep_id": r["sleep_id"],
        "start_utc": ts(r["sleep_stage_start"]),
        "end_utc": ts(r["sleep_stage_end"]),
        "stage": r["sleep_stage_type"],
        "origin": ORIGIN,
        "import_id": import_id,
    } for r in read_rows(stages)]
    n, uniq, inserted = db.upsert(con, "sleep_stages", db.stage_records(con, "sleep_stages", stage_records))
    print(f"  sleep stages: {n} rows, {inserted} new" + (f", {n - uniq} duplicate keys dropped" if n != uniq else ""))
    db.mark_imported(con, unit, files, import_id)


# --- Exercises -------------------------------------------------------------------------------


def import_exercises(con, base, import_id, force):
    files = sorted((base / "Health Fitness Data_GoogleData").glob("UserExercises_*.csv"))
    unit = "health:exercises"
    if not files:
        return
    if not force and db.unit_is_current(con, unit, files):
        print("  exercises: unchanged, skipped")
        return

    core = {
        "exercise_id", "exercise_start", "exercise_end", "utc_offset", "activity_name", "log_type",
        "tracker_total_calories", "tracker_total_steps", "tracker_total_distance_mm",
        "tracker_avg_heart_rate", "tracker_peak_heart_rate",
    }
    records = []
    for r in read_rows(files):
        r.pop(None, None)  # trailing columns without a header
        start, end = ts(r["exercise_start"]), ts(r["exercise_end"])
        dist_mm = num(r.get("tracker_total_distance_mm")) or num(r.get("manually_logged_total_distance_mm"))
        records.append({
            "workout_id": r["exercise_id"],
            "start_utc": start,
            "end_utc": end,
            "utc_offset_s": parse_offset(r["utc_offset"]),
            "activity": r["activity_name"],
            "log_type": r["log_type"],
            "source": "Google Health",
            "duration_s": duration_s(start, end),
            "calories": num(r.get("tracker_total_calories")) or num(r.get("manually_logged_total_calories")),
            "steps": num(r.get("tracker_total_steps")) or num(r.get("manually_logged_total_steps")),
            "distance_m": dist_mm / 1000 if dist_mm else None,
            "avg_heart_rate": num(r.get("tracker_avg_heart_rate")),
            "max_heart_rate": num(r.get("tracker_peak_heart_rate")),
            "details": json.dumps({k: v for k, v in r.items() if k not in core and v not in ("", None)}),
            "origin": ORIGIN,
            "import_id": import_id,
        })
    n, _, inserted = db.upsert(con, "workouts", db.stage_records(con, "workouts", records))
    db.mark_imported(con, unit, files, import_id)
    print(f"  exercises: {n} rows, {inserted} new")


def duration_s(start, end):
    if not (start and end):
        return None
    return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
