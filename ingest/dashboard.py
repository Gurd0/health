"""Data for the dashboard (web/), served by server.py:
    api/data       daily series on one date index, run summaries, meta (web/src/types.ts DashboardData)
    api/runs/<id>  per-run detail: streams, route, splits, zones, context (RunDetail)
"""
from datetime import date, datetime, timezone

from . import runs

T0 = date(2019, 1, 1)

# Daily series: key -> SQL returning (local date, value). Same choices as before:
# steps = highest daily total of any source (they all count the same steps);
# sleep = main sleep (>= 3 h in bed) dated by wake-up day.
DAILY = {
    "steps": """
        WITH per_source AS (
            SELECT start_local::DATE AS d, source, sum(value) AS v
            FROM observations_local WHERE data_type = 'steps' AND origin <> 'fit-legacy' GROUP BY ALL
            UNION ALL
            SELECT date, 'Google Fit', value FROM daily WHERE data_type = 'daily-steps'
        )
        SELECT d, max(v) FROM per_source GROUP BY d""",
    "slH": """
        SELECT CAST(end_utc + to_seconds(COALESCE(end_offset_s, 3600)) AS DATE) AS d, sum(minutes_asleep) / 60.0
        FROM sleep WHERE minutes_in_sleep_period >= 180 GROUP BY d""",
    "slS": """
        SELECT CAST(end_utc + to_seconds(COALESCE(end_offset_s, 3600)) AS DATE) AS d, max(overall_score)
        FROM sleep WHERE minutes_in_sleep_period >= 180 AND overall_score IS NOT NULL GROUP BY d""",
    "rhr": "SELECT date, avg(value) FROM daily WHERE data_type = 'daily-resting-heart-rate' GROUP BY date",
    "hrv": "SELECT date, avg(value) FROM daily WHERE data_type = 'daily-heart-rate-variability' GROUP BY date",
    "spo2": "SELECT date, avg(value) FROM daily WHERE data_type = 'daily-oxygen-saturation' GROUP BY date",
    "vo2": "SELECT date, avg(value) FROM daily WHERE data_type = 'daily-vo2-max' GROUP BY date",
    "wt": "SELECT start_local::DATE, avg(value) / 1000 FROM observations_local WHERE data_type = 'weight' GROUP BY 1",
    "load": "SELECT start_local::DATE, sum(value) FROM observations_local WHERE data_type = 'cardio-load' GROUP BY 1",
}
DECIMALS = {"steps": 0, "slH": 2, "slS": 0, "rhr": 0, "hrv": 0, "spo2": 1, "vo2": 1, "wt": 1, "load": 0, "runKm": 2}


def collect(con):
    """Returns (data, details): window.DATA for the app, and run id -> run detail."""
    today = datetime.now(timezone.utc).date()
    n = (today - T0).days + 1
    series = {}
    for key, sql in DAILY.items():
        arr = [None] * n
        for d, v in con.execute(f"SELECT * FROM ({sql}) t(d, v) WHERE v IS NOT NULL").fetchall():
            i = (d - T0).days
            if 0 <= i < n:
                arr[i] = round(float(v), DECIMALS[key])
        series[key] = arr

    summaries, details = runs.build(con)
    run_km = [None] * n
    for s in summaries:
        i = (date.fromisoformat(s["date"]) - T0).days
        if 0 <= i < n:
            run_km[i] = round((run_km[i] or 0) + s["dist"], 2)
    series["runKm"] = run_km
    last_sync = con.execute("SELECT max(finished_at) FROM imports").fetchone()[0]

    data = {
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "lastSync": last_sync.isoformat(timespec="minutes") + "Z" if last_sync else None,
            "t0": T0.isoformat(), "today": today.isoformat(),
        },
        "daily": series,
        "runs": summaries,
    }
    return data, details
