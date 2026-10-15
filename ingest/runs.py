"""Runs: which workouts are runs, their summaries, and per-run detail (streams, route, splits, zones, context).

Sources per run, best first:
- track (time, distance, position, altitude, heart rate): workout_trackpoints, from the Health API's
  exportExerciseTcx (watch runs) or the Google Fit takeout TCX files (older runs).
- running form (cadence, stride, ground contact, vertical oscillation/ratio) and speed: takeout
  observations from the watch, only up to the latest takeout.
- summary values: API metricsSummary / takeout tracker_* fields, else computed from the streams.
"""
import json
import math
import re
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

STEP = 5  # seconds per sample in the per-run streams
WATCH = "Pixel Watch 4"
ZONE_NAMES = ["LIGHT", "MODERATE", "VIGOROUS", "PEAK"]
DEFAULT_ZONES = [30, 113, 143, 180, 220]

RUNS_SQL = """
WITH structured_runs AS (
    SELECT w.workout_id FROM workouts w
    WHERE w.activity = 'Structured Workout' AND EXISTS (
        SELECT 1 FROM observations o
        WHERE o.data_type = 'cadence' AND o.start_utc BETWEEN w.start_utc AND w.end_utc)
)
SELECT workout_id, origin, start_utc, end_utc, utc_offset_s, activity, log_type, duration_s, calories, steps,
       distance_m, avg_heart_rate, max_heart_rate, details
FROM workouts
WHERE json_extract_string(details, '$.exerciseType') = 'RUNNING'
   OR activity IN ('Run', 'Outdoor Run', 'Treadmill Run')
   OR workout_id IN (SELECT workout_id FROM structured_runs)
   OR (origin = 'fit-legacy' AND activity = 'running')
ORDER BY start_utc
"""


def num(v):
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def secs(v):
    """'2453s' -> 2453.0"""
    return num(str(v).rstrip("s")) if v is not None else None


def identify(con):
    """All runs that pass the sanity filter, as a DataFrame (one row per run)."""
    df = con.execute(RUNS_SQL).df()
    df["details"] = df["details"].map(lambda s: json.loads(s) if s else {})
    df["src"] = np.where(df["origin"] == "fit-legacy", "fit", "watch")
    df["moving_s"] = [
        secs(d.get("activeDuration")) or dur for d, dur in zip(df["details"], df["duration_s"])
    ]
    pace = df["moving_s"] / (df["distance_m"] / 1000)
    ok = df["distance_m"].between(300, 100_000) & pace.between(150, 900)
    return df[ok].reset_index(drop=True)


# --- Loading raw data for all runs at once ----------------------------------------------------

def _window_rows(con, runs, sql, params=()):
    con.register("_runwin", runs[["workout_id", "start_utc", "end_utc"]])
    return con.execute(sql, list(params)).df()


def load_tracks(con, runs):
    return _window_rows(con, runs, """
        SELECT tp.workout_id, tp.ts_utc, tp.latitude, tp.longitude, tp.altitude_m, tp.distance_m, tp.heart_rate
        FROM workout_trackpoints tp JOIN _runwin r USING (workout_id) ORDER BY tp.workout_id, tp.ts_utc""")


def load_obs(con, runs, data_type, source=WATCH):
    return _window_rows(con, runs, """
        SELECT r.workout_id, o.start_utc AS ts, o.value, o.value_json
        FROM observations o JOIN _runwin r ON o.start_utc BETWEEN r.start_utc AND r.end_utc
        WHERE o.data_type = ? AND o.source = ? ORDER BY r.workout_id, o.start_utc""", (data_type, source))


# --- Resampling -------------------------------------------------------------------------------

def grid_mean(ts, values, t0, n):
    """Mean of values per STEP-second bucket from t0; NaN where empty."""
    out = np.full(n, np.nan)
    if len(ts) == 0:
        return out
    idx = ((pd.to_datetime(ts) - t0).dt.total_seconds() // STEP).astype(int).to_numpy()
    v = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    m = (idx >= 0) & (idx < n) & ~np.isnan(v)
    if not m.any():
        return out
    s = pd.Series(v[m]).groupby(idx[m]).mean()
    out[s.index.to_numpy()] = s.to_numpy()
    return out


def fill_short_gaps(a, limit=6):
    return pd.Series(a).interpolate(limit=limit, limit_area="inside").to_numpy()


def interp_at(ts, values, t0, n):
    """Linear interpolation of a time series at each grid point."""
    if len(ts) == 0:
        return np.full(n, np.nan)
    x = (pd.to_datetime(ts) - t0).dt.total_seconds().to_numpy()
    v = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    m = ~np.isnan(v)
    if m.sum() < 2:
        return np.full(n, np.nan)
    g = np.arange(n) * STEP
    out = np.interp(g, x[m], v[m])
    out[(g < x[m][0] - STEP) | (g > x[m][-1] + STEP)] = np.nan
    return out


def smooth(a, w):
    return pd.Series(a).rolling(w, center=True, min_periods=1).mean().to_numpy()


# --- Geometry ---------------------------------------------------------------------------------

def project(lat, lon):
    """Lat/lon arrays -> local metres (x east, y south) around the centroid."""
    lat0, lon0 = np.nanmean(lat), np.nanmean(lon)
    x = (lon - lon0) * math.cos(math.radians(lat0)) * 111_320
    y = -(lat - lat0) * 110_540
    return x, y


def thumb(x, y, n=48):
    """Route outline scaled into the list thumbnail box (56x40, 4px margin)."""
    m = ~(np.isnan(x) | np.isnan(y))
    x, y = x[m], y[m]
    if len(x) < 2:
        return None
    pick = np.linspace(0, len(x) - 1, min(n, len(x))).round().astype(int)
    x, y = x[pick], y[pick]
    s = min(48 / ((x.max() - x.min()) or 1), 32 / ((y.max() - y.min()) or 1))
    ox, oy = 28 - (x.min() + x.max()) / 2 * s, 20 - (y.min() + y.max()) / 2 * s
    return [[round(float(a * s + ox), 1), round(float(b * s + oy), 1)] for a, b in zip(x, y)]


def best_effort(t, d, meters):
    """Fastest time (s) to cover `meters` within a run, from cumulative time/distance arrays."""
    m = ~(np.isnan(t) | np.isnan(d))
    t, d = t[m], d[m]
    if len(d) < 2 or d[-1] - d[0] < meters:
        return None
    best, j = None, 0
    for i in range(len(d)):
        while j < len(d) and d[j] - d[i] < meters:
            j += 1
        if j == len(d):
            break
        # interpolate the exact moment `meters` is reached between j-1 and j
        d0, d1, t0_, t1 = d[j - 1], d[j], t[j - 1], t[j]
        tj = t0_ + (t1 - t0_) * ((d[i] + meters - d0) / ((d1 - d0) or 1))
        dt = tj - t[i]
        if best is None or dt < best:
            best = dt
    return best


# --- Zones ------------------------------------------------------------------------------------

def zone_thresholds(row):
    """[light_min, moderate_min, vigorous_min, peak_min, peak_max] from a daily-heart-rate-zones row."""
    text, js = row
    mins, mx = {}, None
    if js:
        for z in json.loads(js).get("heartRateZones", []):
            mins[z["heartRateZoneType"]] = int(z["minBeatsPerMinute"])
            if z["heartRateZoneType"] == "PEAK":
                mx = int(z["maxBeatsPerMinute"])
    elif text:
        for name, lo, hi in re.findall(r"(LIGHT|MODERATE|VIGOROUS|PEAK)[^}]*?min_heart_rate_bpm\": (\d+), \"max_heart_rate_bpm\": (\d+)", text):
            mins[name] = int(lo)
            if name == "PEAK":
                mx = int(hi)
    if len(mins) != 4:
        return None
    return [mins[z] for z in ZONE_NAMES] + [mx or 220]


# --- Build ------------------------------------------------------------------------------------

def build(con):
    """Returns (summaries, details) where details maps run id -> detail dict."""
    runs = identify(con)
    if runs.empty:
        return [], {}
    tracks = load_tracks(con, runs)
    obs = {dt: load_obs(con, runs, dt) for dt in (
        "heart-rate", "speed", "cadence", "stride-length", "ground-contact-time", "vertical-oscillation",
        "vertical-ratio", "live-pace", "gps-location", "cardio-load")}
    vo2_rows = con.execute(
        "SELECT start_utc, value FROM observations WHERE data_type = 'run-vo2-max' ORDER BY start_utc").df()
    zones_by_date = {d: zone_thresholds((t, j)) for d, t, j in con.execute(
        "SELECT date, any_value(value_text), any_value(value_json::VARCHAR) FROM daily "
        "WHERE data_type = 'daily-heart-rate-zones' GROUP BY date").fetchall()}
    ctx = Context(con)

    summaries, details = [], {}
    for _, r in runs.iterrows():
        rid = r["workout_id"]
        det = r["details"]
        ms = det.get("metricsSummary", {})
        off = r["utc_offset_s"] if not pd.isna(r["utc_offset_s"]) else ctx.offset_at(r["start_utc"])
        t0 = pd.Timestamp(r["start_utc"])
        local = (t0 + pd.Timedelta(seconds=int(off))).to_pydatetime()
        dur = (pd.Timestamp(r["end_utc"]) - t0).total_seconds()
        n = int(dur // STEP) + 1
        sel = lambda df: df[df["workout_id"] == rid]

        tr = sel(tracks)
        has_track = len(tr) >= 2
        # cumulative distance (m) and time grid
        d = interp_at(tr["ts_utc"], tr["distance_m"], t0, n) if has_track else np.full(n, np.nan)
        if np.isnan(d).all():
            lp = sel(obs["live-pace"])
            if len(lp):
                inc = lp["value_json"].map(lambda s: json.loads(s).get("distance_millimeters", 0) / 1000)
                d = interp_at(lp["ts"], inc.cumsum(), t0, n)
        d = pd.Series(d).ffill().bfill().to_numpy() if not np.isnan(d).all() else d
        tgrid = np.arange(n) * STEP

        hr = grid_mean(tr["ts_utc"], tr["heart_rate"], t0, n) if has_track else np.full(n, np.nan)
        if np.isnan(hr).all():
            h = sel(obs["heart-rate"])
            hr = grid_mean(h["ts"], h["value"], t0, n)
        hr = fill_short_gaps(hr, 12)

        sp_obs = sel(obs["speed"])
        sp = grid_mean(sp_obs["ts"], sp_obs["value"] / 3.6, t0, n)
        if np.isnan(sp).all() and not np.isnan(d).all():
            sp = np.gradient(smooth(d, 3), STEP)
        sp = smooth(fill_short_gaps(sp), 3)

        def form(dt, scale=1.0):
            o = sel(obs[dt])
            return fill_short_gaps(grid_mean(o["ts"], o["value"] * scale, t0, n), 12)

        cad, stride, gct = form("cadence"), form("stride-length", 0.01), form("ground-contact-time")
        vo, vr = form("vertical-oscillation"), form("vertical-ratio", 0.01)

        # elevation: smoothed track altitude, positive changes summed, scaled to the summary gain
        alt = interp_at(tr["ts_utc"], tr["altitude_m"], t0, n) if has_track else np.full(n, np.nan)
        elev_sum = num(ms.get("elevationGainMillimeters"))
        elev_sum = elev_sum / 1000 if elev_sum is not None else None
        if elev_sum is None and det.get("tracker_total_altitude_mm") is not None:
            elev_sum = num(det["tracker_total_altitude_mm"]) / 1000
        cg = None
        if not np.isnan(alt).all():
            a = smooth(pd.Series(alt).ffill().bfill().to_numpy(), 7)
            cg = np.concatenate([[0], np.cumsum(np.clip(np.diff(a), 0, None))])
            if elev_sum and cg[-1] > 0:
                cg = cg * (elev_sum / cg[-1])
            if elev_sum is None:
                elev_sum = float(cg[-1])

        # route
        lat = lon = None
        if has_track and tr["latitude"].notna().sum() > 10:
            lat = interp_at(tr["ts_utc"], tr["latitude"], t0, n)
            lon = interp_at(tr["ts_utc"], tr["longitude"], t0, n)
        else:
            g = sel(obs["gps-location"])
            if len(g) > 10:
                ll = g["value_json"].map(json.loads)
                lat = interp_at(g["ts"], ll.map(lambda v: v.get("latitude")), t0, n)
                lon = interp_at(g["ts"], ll.map(lambda v: v.get("longitude")), t0, n)
        has_gps = lat is not None and (~np.isnan(lat)).sum() > 10
        is_treadmill = r["activity"] == "Treadmill Run" or (r["src"] == "watch" and not has_gps)
        x = y = None
        if has_gps:
            lat, lon = pd.Series(lat).ffill().bfill().to_numpy(), pd.Series(lon).ffill().bfill().to_numpy()
            x, y = project(lat, lon)

        dist_m = float(r["distance_m"])
        if not np.isnan(d).all() and d[-1] > 0:
            d = d * (dist_m / d[-1])  # align the stream with the run's official distance

        # splits: API splits when present, else from the distance stream
        splits = []
        cg_at = (lambda tt: float(np.interp(tt, tgrid, cg))) if cg is not None else (lambda tt: None)
        if det.get("splits"):
            for s in det["splits"]:
                a_t = (pd.Timestamp(s["startTime"].rstrip("Z")[:26]) - t0).total_seconds()
                b_t = (pd.Timestamp(s["endTime"].rstrip("Z")[:26]) - t0).total_seconds()
                ln = num(s["metricsSummary"].get("distanceMillimeters")) / 1e6
                el = (cg_at(b_t) - cg_at(a_t)) if cg is not None else None
                splits.append({"len": round(ln, 3), "pace": round(secs(s.get("activeDuration")) / ln, 1),
                               "elev": round(el) if el is not None else None, "a": round(a_t), "b": round(b_t)})
        elif not np.isnan(d).all() and r["src"] == "watch":
            marks = list(range(1000, int(dist_m), 1000)) + [dist_m]
            prev_t, prev_d = 0.0, 0.0
            for mk in marks:
                tt = float(np.interp(mk, d, tgrid))
                ln = (mk - prev_d) / 1000
                if ln < 0.05:
                    continue
                el = (cg_at(tt) - cg_at(prev_t)) if cg is not None else None
                splits.append({"len": round(ln, 3), "pace": round((tt - prev_t) / ln, 1),
                               "elev": round(el) if el is not None else None, "a": round(prev_t), "b": round(tt)})
                prev_t, prev_d = tt, mk

        # zones
        local_date = local.date()
        th = zones_by_date.get(local_date) or zones_by_date.get(ctx.nearest_date(zones_by_date, local_date)) or DEFAULT_ZONES
        hzd = ms.get("heartRateZoneDurations")
        if hzd:
            zsecs = [secs(hzd.get(k)) or 0 for k in ("lightTime", "moderateTime", "vigorousTime", "peakTime")]
        elif not np.isnan(hr).all():
            hv = hr[~np.isnan(hr)]
            zsecs = [float(((hv >= th[k]) & (hv < (th[k + 1] if k < 3 else 999))).sum() * STEP) for k in range(4)]
        else:
            zsecs = None
        azm = num(ms.get("activeZoneMinutes"))
        if azm is None and zsecs:
            azm = round(zsecs[1] / 60 + 2 * (zsecs[2] + zsecs[3]) / 60)

        # summary values
        moving = float(r["moving_s"])
        hr_avg = num(r["avg_heart_rate"]) or (float(np.nanmean(hr)) if not np.isnan(hr).all() else None)
        hr_max = num(r["max_heart_rate"]) or None
        if not hr_max and not np.isnan(hr).all():
            hr_max = float(np.nanmax(hr))
        load = num(det.get("tracker_cardio_load"))
        if load is None:
            cl = sel(obs["cardio-load"])
            if len(cl):
                load = float(cl["value"].sum())
        mob = ms.get("mobilityMetrics", {})
        cad_avg = num(mob.get("avgCadenceStepsPerMinute")) or (float(np.nanmean(cad)) if not np.isnan(cad).all() else None)
        vo2 = None
        if len(vo2_rows):
            near = vo2_rows[(vo2_rows["start_utc"] >= t0) & (vo2_rows["start_utc"] <= pd.Timestamp(r["end_utc"]) + pd.Timedelta(hours=3))]
            if len(near):
                vo2 = float(near["value"].iloc[0])
        tvec = tgrid.astype(float)
        avg_pace = moving / (dist_m / 1000)
        plausible = lambda pace: pace is not None and pace >= max(150, 0.75 * avg_pace)  # drops GPS glitches
        full_km = [s["pace"] for s in splits if s["len"] >= 0.999 and plausible(s["pace"])]
        def effort(m):
            t = best_effort(tvec, d, m) if (r["src"] == "watch" or has_track) else None
            return t if t is not None and plausible(t / (m / 1000)) else None

        has_series = r["src"] == "watch" and not np.isnan(hr).all()
        has_form = not np.isnan(cad).all()
        rid_s = str(rid)
        summary = {
            "id": rid_s, "src": r["src"], "type": "Treadmill" if is_treadmill else "Outdoor",
            "start": local.isoformat(timespec="minutes"), "date": local_date.isoformat(),
            "dist": round(dist_m / 1000, 3), "dur": round(moving), "elapsed": round(dur),
            "pace": round(moving / (dist_m / 1000), 1),
            "hr": round(hr_avg) if hr_avg and r["src"] == "watch" else None,
            "maxHr": round(hr_max) if hr_max and r["src"] == "watch" else None,
            "elev": round(elev_sum) if elev_sum is not None and not is_treadmill and r["src"] == "watch" else None,
            "load": round(load) if load is not None else None,
            "cal": num(r["calories"]), "steps": num(r["steps"]),
            "cad": round(cad_avg) if cad_avg else None,
            "vo2": round(vo2, 1) if vo2 else None,
            "best1k": min(full_km) if full_km else None,
            "best5k": effort(5000), "best10k": effort(10000),
            "gps": bool(has_gps), "route": thumb(x, y) if has_gps else None,
            "hasSeries": bool(has_series), "hasForm": bool(has_form),
        }
        summary = {k: (round(float(v), 1) if isinstance(v, float) and k != "dist" else v) for k, v in summary.items()}
        summaries.append(summary)

        def arr(a, nd=1):
            return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else round(float(v), nd) for v in a]

        detail = {
            "id": rid_s, "step": STEP, "n": n, "zones": th, "zoneSecs": zsecs, "azm": azm,
            "splits": splits, "context": ctx.for_run(local_date, summary),
            "formAvg": {k: (secs(v) if k.endswith("Duration") else num(v)) for k, v in mob.items()} if mob else None,
        }
        if has_series:
            detail.update({"d": arr(d, 0), "sp": arr(sp, 2), "hr": arr(hr, 0), "cg": arr(cg, 1) if cg is not None else None})
            if has_form:
                detail.update({"cad": arr(cad, 0), "stride": arr(stride, 2), "gct": arr(gct, 0),
                               "vo": arr(vo, 1), "vr": arr(vr, 1)})
        if has_gps:
            if has_series:
                detail["route"] = [[round(a, 1), round(b, 1)] for a, b in zip(x, y)]
            else:  # summary-only runs: a free route of up to 600 points
                pick = np.linspace(0, n - 1, min(600, n)).round().astype(int)
                detail["route"] = [[round(float(x[i]), 1), round(float(y[i]), 1)] for i in pick]
            kms = []
            if not np.isnan(d).all():
                for km in range(1, int(dist_m // 1000) + 1):
                    if km * 1000 >= dist_m:
                        break
                    i = int(np.searchsorted(d, km * 1000))
                    if i < n:
                        kms.append([round(float(x[i]), 1), round(float(y[i]), 1), km])
            detail["kms"] = kms
        details[rid_s] = detail
    return summaries, details


class Context:
    """Daily values around a run: the night before, VO2 max, training load."""

    def __init__(self, con):
        q = lambda sql: dict(con.execute(sql).fetchall())
        self.hrv = q("SELECT date, avg(value) FROM daily WHERE data_type = 'daily-heart-rate-variability' GROUP BY date")
        self.rhr = q("SELECT date, avg(value) FROM daily WHERE data_type = 'daily-resting-heart-rate' GROUP BY date")
        self.vo2 = q("SELECT date, avg(value) FROM daily WHERE data_type = 'daily-vo2-max' GROUP BY date")
        self.acwr = {d: (v, t) for d, v, t in con.execute(
            "SELECT date, any_value(value), any_value(value_text) FROM daily "
            "WHERE data_type = 'cardio-acute-chronic-workload-ratio' GROUP BY date").fetchall()}
        self.load = q("SELECT start_local::DATE, sum(value) FROM observations_local WHERE data_type = 'cardio-load' GROUP BY 1")
        self.sleep = {d: (h, s) for d, h, s in con.execute("""
            SELECT CAST(end_utc + to_seconds(COALESCE(end_offset_s, 3600)) AS DATE) AS d,
                   sum(minutes_asleep) / 60.0, max(overall_score)
            FROM sleep WHERE minutes_in_sleep_period >= 180 GROUP BY d""").fetchall()}

    def offset_at(self, ts):
        """UTC offset (s) for Europe/Oslo at a UTC timestamp."""
        t = pd.Timestamp(ts).to_pydatetime().replace(tzinfo=timezone.utc)
        return int(t.astimezone(ZoneInfo("Europe/Oslo")).utcoffset().total_seconds())

    @staticmethod
    def nearest_date(table, d):
        keys = [k for k in table if k <= d and table[k]]
        return max(keys) if keys else None

    @staticmethod
    def avg30(table, d):
        vals = [v for k, v in table.items() if d - timedelta(days=30) <= k < d and v is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    def for_run(self, d, summary):
        monday = d - timedelta(days=d.weekday())
        week = [self.load.get(monday + timedelta(days=i)) for i in range((d - monday).days + 1)]
        sl = self.sleep.get(d)
        ac = self.acwr.get(d)
        return {
            "vo2Daily": round(self.vo2[d], 1) if self.vo2.get(d) else None,
            "sleepH": round(sl[0], 2) if sl else None, "sleepScore": round(sl[1]) if sl and sl[1] else None,
            "hrv": round(self.hrv[d]) if self.hrv.get(d) else None, "hrv30": self.avg30(self.hrv, d),
            "rhr": round(self.rhr[d]) if self.rhr.get(d) else None, "rhr30": self.avg30(self.rhr, d),
            "weekLoad": round(sum(v for v in week if v)) if any(week) else None, "monday": monday.isoformat(),
            "acwr": round(ac[0], 2) if ac else None, "acwrLabel": ac[1] if ac else None,
        }
