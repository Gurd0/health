"""Parsers for the legacy `Fit/` part of a Google Takeout export (Google Fit, 2019-2026).

Values are converted to the units used by the Google Health export so the same
data type means the same thing regardless of origin (e.g. speed in km/h, weight in grams).
Folder and column names are the Norwegian ones from this account's export.
"""
import csv
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from . import db, tcx

ORIGIN = "fit-legacy"

# Merged ("best") streams in `Alle data/`:
# file suffix -> (data type, kind, value_field, scale)
STREAMS = {
    "com.google.step_count.delta_com.google.android.gms_merge_step_deltas": ("steps", "interval", "steps", 1),
    "com.google.distance.delta_com.google.android.gms_merge_distance_delta": ("distance", "interval", "distance meters", 1),
    "com.google.calories.expended_com.google.android.gms_merge_calories_expended": ("calories", "interval", "kcal", 1),
    "com.google.heart_minutes_com.google.android.gms_merge_heart_minutes": ("heart-minutes", "interval", "heart points", 1),
    "com.google.active_minutes_com.google.android.gms_merge_active_minutes": ("active-minutes", "interval", "minutes", 1),
    "com.google.speed_com.google.android.gms_merge_speed": ("speed", "sample", "speed km/h", 3.6),
    "com.google.weight_com.google.android.gms_merge_weight": ("weight", "sample", "weight grams", 1000),
    "com.google.height_com.google.android.gms_merge_height": ("height", "sample", "height millimeters", 1000),
    "com.google.calories.bmr_com.google.android.gms_merged": ("basal-metabolic-rate", "sample", "kcal per day", 1),
    "com.google.location.sample_com.google.android.gms_merge_location_samples": ("gps-location", "sample", None, None),
    "com.google.activity.segment_com.google.android.gms_merge_activity_segments": ("activity-segment", "interval", "activity type code", 1),
}

# Google Fit activity type codes (subset seen in practice).
ACTIVITY_TYPES = {
    0: "IN_VEHICLE", 1: "BIKING", 2: "ON_FOOT", 3: "STILL", 4: "UNKNOWN", 5: "TILTING", 7: "WALKING", 8: "RUNNING",
    9: "AEROBICS", 72: "SLEEP", 80: "STRENGTH_TRAINING", 82: "SWIMMING_POOL", 93: "WALKING_FITNESS",
    97: "WEIGHTLIFTING", 108: "OTHER", 113: "CROSSFIT", 114: "HIIT",
}

# Daily summary CSV column -> (daily data type, value_field)
DAILY_COLUMNS = {
    "Trinnantall": ("daily-steps", "steps"),
    "Distanse (m)": ("daily-distance", "meters"),
    "Kalorier (kcal)": ("daily-calories", "kcal"),
    "Hjertepoeng": ("daily-heart-points", "heart points"),
    "Hjerteminutter": ("daily-heart-minutes", "minutes"),
    "Antall aktivitetsminutter": ("daily-active-minutes", "minutes"),
    "Gjennomsnittlig vekt (kg)": ("daily-weight", "kg"),
    "Gange varighet (ms)": ("daily-walking-duration", "ms"),
    "Løping varighet (ms)": ("daily-running-duration", "ms"),
    "Sykling varighet (ms)": ("daily-biking-duration", "ms"),
    "Inaktiv varighet (ms)": ("daily-inactive-duration", "ms"),
}

AGGREGATES = {
    "com.google.calories.expended": "calories",
    "com.google.step_count.delta": "steps",
    "com.google.distance.delta": "distance_m",
}


def import_all(con, takeout, import_id, force=False):
    base = Path(takeout) / "Fit"
    if not base.exists():
        return
    import_streams(con, base / "Alle data", import_id, force)
    import_daily(con, base / "Verdier om daglig aktivitet", import_id, force)
    import_sessions(con, base, import_id, force)


def ns_to_ts(ns):
    return datetime(1970, 1, 1) + timedelta(microseconds=int(ns) // 1000)


def source_name(origin_id):
    """'raw:com.google.step_count.cumulative:Google:Pixel 9 Pro XL:dc1b...:Step Counter' -> 'Google Pixel 9 Pro XL'."""
    parts = (origin_id or "").split(":")
    if len(parts) < 3:
        return "Google Fit"
    rest = parts[3:] if "." in parts[2] else parts[2:]
    if len(rest) >= 3:  # manufacturer, model, uid, stream
        return f"{rest[0]} {rest[1]}"
    return f"Google Fit ({parts[2]})"


def fit_value(v):
    v = v.get("value", v)
    for k in ("fpVal", "intVal"):
        if k in v:
            return v[k]
    return None


def import_streams(con, folder, import_id, force):
    for suffix, (data_type, kind, value_field, scale) in STREAMS.items():
        path = folder / f"derived_{suffix}.json"
        if not path.exists():
            continue
        unit = f"fit:{suffix}"
        if not force and db.unit_is_current(con, unit, [path]):
            print(f"  {data_type}: unchanged, skipped")
            continue
        points = json.load(open(path, encoding="utf-8"))["Data Points"]
        records = []
        for p in points:
            vals = [fit_value(v) for v in p.get("fitValue", [])]
            rec = {
                "data_type": data_type,
                "start_utc": ns_to_ts(p["startTimeNanos"]),
                "end_utc": ns_to_ts(p["endTimeNanos"]) if kind == "interval" else None,
                "source": source_name(p.get("originDataSourceId")),
                "origin": ORIGIN,
                "import_id": import_id,
            }
            if data_type == "gps-location":
                lat, lon, acc, alt = (vals + [None] * 4)[:4]
                rec["value_json"] = json.dumps({"latitude": lat, "longitude": lon, "accuracy_m": acc, "altitude_m": alt})
            elif data_type == "activity-segment":
                rec["value"] = vals[0]
                rec["value_text"] = ACTIVITY_TYPES.get(vals[0], str(vals[0]))
            elif vals and vals[0] is not None:
                rec["value"] = vals[0] * scale
            records.append(rec)
        n, uniq, inserted = db.upsert(
            con, "observations", db.stage_records(con, "observations", records), scope={"data_type": data_type}
        )
        db.register_type(con, data_type, ORIGIN, kind, value_field)
        db.mark_imported(con, unit, [path], import_id)
        dupes = f", {n - uniq} duplicate keys dropped" if n != uniq else ""
        print(f"  {path.name[:60]} -> observations.{data_type}: {n} rows, {inserted} new{dupes}")


def import_daily(con, folder, import_id, force):
    path = folder / "Verdier om daglig aktivitet.csv"
    unit = "fit:daily"
    if not path.exists():
        return
    if not force and db.unit_is_current(con, unit, [path]):
        print("  daily summary: unchanged, skipped")
        return
    records = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            for col, (data_type, _) in DAILY_COLUMNS.items():
                v = row.get(col)
                if v:
                    records.append({
                        "data_type": data_type, "date": row["Dato"], "source": "Google Fit",
                        "value": float(v), "origin": ORIGIN, "import_id": import_id,
                    })
    types = [t for t, _ in DAILY_COLUMNS.values()]
    n, _, inserted = db.upsert(con, "daily", db.stage_records(con, "daily", records), scope={"data_type": types})
    for data_type, value_field in DAILY_COLUMNS.values():
        db.register_type(con, data_type, ORIGIN, "daily", value_field)
    db.mark_imported(con, unit, [path], import_id)
    print(f"  daily summary -> daily: {n} rows, {inserted} new")


def session_key(stem):
    """'2019-10-22T07_23_08.496+02_00_WALKING' -> ('2019-10-22T07_23_08.496+02_00', offset seconds)."""
    m = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}(?:\.\d+)?([+-]\d{2})_(\d{2}))", stem)
    if not m:
        return None, None
    sign = -1 if m.group(2).startswith("-") else 1
    offset = sign * (abs(int(m.group(2))) * 3600 + int(m.group(3)) * 60)
    return m.group(1), offset


def iso(s):
    return s.rstrip("Z") if s else None


def import_sessions(con, base, import_id, force):
    session_files = sorted((base / "Alle økter").glob("*.json"))
    tcx_files = sorted((base / "Aktiviteter").glob("*.tcx"))
    unit = "fit:sessions"
    if not session_files:
        return
    if not force and db.unit_is_current(con, unit, session_files + tcx_files):
        print("  sessions: unchanged, skipped")
        return

    workouts = []
    for path in session_files:
        key, offset = session_key(path.stem)
        s = json.load(open(path, encoding="utf-8"))
        agg = {a["metricName"]: a.get("floatValue", a.get("intValue")) for a in s.get("aggregate", [])}
        rec = {
            "workout_id": f"fit:{key}",
            "start_utc": iso(s["startTime"]),
            "end_utc": iso(s["endTime"]),
            "utc_offset_s": offset,
            "activity": s.get("fitnessActivity"),
            "log_type": None,
            "source": s.get("application", {}).get("packageName", "Google Fit"),
            "duration_s": float(s["duration"].rstrip("s")) if s.get("duration") else None,
            "details": json.dumps({"aggregate": agg, "segment": s.get("segment", [])}),
            "origin": ORIGIN,
            "import_id": import_id,
        }
        for metric, col in AGGREGATES.items():
            rec[col] = agg.get(metric)
        workouts.append(rec)
    n, _, inserted = db.upsert(con, "workouts", db.stage_records(con, "workouts", workouts))
    print(f"  sessions -> workouts: {n} rows, {inserted} new")

    points = []
    for path in tcx_files:
        key, _ = session_key(path.stem)
        for tp in tcx.parse_file(path):
            points.append({"workout_id": f"fit:{key}", **tp, "origin": ORIGIN, "import_id": import_id})
    n, uniq, inserted = db.upsert(con, "workout_trackpoints", db.stage_records(con, "workout_trackpoints", points))
    dupes = f", {n - uniq} duplicate keys dropped" if n != uniq else ""
    print(f"  activities (tcx) -> workout_trackpoints: {n} rows, {inserted} new{dupes}")
    db.mark_imported(con, unit, session_files + tcx_files, import_id)

