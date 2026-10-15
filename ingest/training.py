"""Training view: planned sessions matched to synced runs, weekly targets, load, recovery and shoes.

Computed per request from the cached dashboard data (dashboard.collect()) and the tr.* tables
(training_db.py), so a new sync shows up as soon as the cache is rebuilt.

- Matching: a session's own run_id (set by hand) or status 'skipped' always wins. Otherwise each
  planned session takes an unclaimed run on the same local date, the closest in distance first.
- Load per run: Banister TRIMP from average heart rate and moving time, using that day's resting
  heart rate and the highest heart rate of the last year. Without heart rate: session RPE
  (minutes x RPE x 0.4, scaled to roughly match TRIMP), else minutes x 1.2.
- ACWR: load of the last 7 days / (load of the last 28 days / 4).
"""
import json
import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import db, plan, runs as runs_mod
from .training_db import get_settings, rows

DONE_SHARE = 0.8  # a session is done at 80 % of its planned distance
PACE_TOLERANCE = 5  # s/km either side of the target range
SRPE_SCALE = 0.4
LOAD_DAYS = 90
SHOE_WARN = 0.9
STREAK_KM_SHARE = 0.8
ZONE_NAMES = runs_mod.ZONE_NAMES


def local_today():
    return datetime.now(ZoneInfo(db.HOME_TZ)).date()


def monday(d):
    return d - timedelta(days=d.weekday())


# --- Runs, notes and shoes ----------------------------------------------------------------------


def notes_by_run(cur):
    return {r["run_id"]: r for r in rows(cur, "SELECT * FROM tr.run_notes")}


def shoe_rows(cur):
    return rows(cur, "SELECT * FROM tr.shoes ORDER BY retired, added")


def default_history(cur):
    return rows(cur, "SELECT since, shoe_id FROM tr.shoe_defaults ORDER BY since, set_at")


def default_shoe_on(history, d):
    shoe = None
    for h in history:
        if h["since"] <= d:
            shoe = h["shoe_id"]
    return shoe


def annotate_runs(cur, runs):
    """Run summaries with your notes and the shoe each run counts for."""
    notes, history = notes_by_run(cur), default_history(cur)
    out = []
    for r in runs:
        n = notes.get(r["id"]) or {}
        shoe = n.get("shoe_id")
        out.append({**r, "rpe": n.get("rpe"), "feel": n.get("feel"), "note": n.get("note"),
                    "shoe": shoe or default_shoe_on(history, date.fromisoformat(r["date"])), "shoeAuto": not shoe})
    return out


def shoes_view(cur, runs):
    """Shoes with their km (start_km + the runs counted for them) and wear warnings."""
    annotated = annotate_runs(cur, runs)
    history = default_history(cur)
    current_default = default_shoe_on(history, date.max)
    out = []
    for s in shoe_rows(cur):
        mine = [r for r in annotated if r["shoe"] == s["shoe_id"]]
        km = s["start_km"] + sum(r["dist"] for r in mine)
        share = km / s["max_km"] if s["max_km"] else 0
        out.append({
            "id": s["shoe_id"], "name": s["name"], "km": round(km, 1), "startKm": s["start_km"], "maxKm": s["max_km"],
            "retired": s["retired"], "isDefault": s["shoe_id"] == current_default, "runs": len(mine),
            "lastUsed": max((r["date"] for r in mine), default=None),
            "wear": "over" if share >= 1 else "warn" if share >= SHOE_WARN else "ok",
        })
    return out


# --- Load ---------------------------------------------------------------------------------------


def run_loads(runs, daily, t0, notes):
    """run id -> (load, method)"""
    year_ago = (local_today() - timedelta(days=365)).isoformat()
    hr_max = max((r["maxHr"] for r in runs if r.get("maxHr") and r["date"] >= year_ago), default=None) or 190
    rhr = daily.get("rhr") or []
    out = {}
    for r in runs:
        minutes = r["dur"] / 60
        i = (date.fromisoformat(r["date"]) - t0).days
        rest = next((rhr[j] for j in range(min(i, len(rhr) - 1), max(-1, i - 8), -1) if 0 <= j < len(rhr) and rhr[j]), 60)
        rpe = (notes.get(r["id"]) or {}).get("rpe")
        if r.get("hr") and hr_max > rest:
            x = max(0.0, min(1.0, (r["hr"] - rest) / (hr_max - rest)))
            out[r["id"]] = (round(minutes * x * 0.64 * math.exp(1.92 * x), 1), "hr")
        elif rpe:
            out[r["id"]] = (round(minutes * rpe * SRPE_SCALE, 1), "rpe")
        else:
            out[r["id"]] = (round(minutes * 1.2, 1), "estimate")
    return out


def load_series(runs, loads, today):
    start = today - timedelta(days=LOAD_DAYS + 27)
    n = (today - start).days + 1
    per_day = [0.0] * n
    for r in runs:
        i = (date.fromisoformat(r["date"]) - start).days
        if 0 <= i < n:
            per_day[i] += loads[r["id"]][0]
    acwr = []
    for i in range(27, n):
        acute = sum(per_day[i - 6:i + 1])
        chronic = sum(per_day[i - 27:i + 1]) / 4
        acwr.append(round(acute / chronic, 2) if chronic > 0 else None)
    return {"start": (start + timedelta(days=27)).isoformat(), "load": [round(v, 1) for v in per_day[27:]], "acwr": acwr}


# --- Plan, sessions, matching -------------------------------------------------------------------


def active_plan(cur):
    p = rows(cur, "SELECT * FROM tr.plans WHERE status = 'active' ORDER BY created DESC LIMIT 1")
    return p[0] if p else None


def match(sessions, runs, today):
    """Attach a run to each session and work out its status. Returns the run ids that were used."""
    by_id = {r["id"]: r for r in runs}
    taken = {s["run_id"] for s in sessions if s["run_id"] and s["status"] != "skipped"}
    by_date = {}
    for r in runs:
        if r["id"] not in taken:
            by_date.setdefault(r["date"], []).append(r)
    auto = {}
    for d, day_runs in by_date.items():
        open_sessions = [s for s in sessions if s["date"].isoformat() == d and not s["run_id"] and s["status"] != "skipped"]
        pairs = sorted(((abs((s["distance_km"] or 0) - r["dist"]), s["session_id"], r["id"])
                        for s in open_sessions for r in day_runs))
        used_s, used_r = set(), set()
        for _, sid, rid in pairs:
            if sid not in used_s and rid not in used_r:
                auto[sid] = rid
                used_s.add(sid)
                used_r.add(rid)
    used = set()
    for s in sessions:
        rid = s["run_id"] if s["run_id"] and s["status"] != "skipped" else auto.get(s["session_id"])
        run = by_id.get(rid) if rid else None
        s["_run"], s["_manual"] = run, bool(s["run_id"])
        if run:
            used.add(run["id"])
        if s["status"] == "skipped":
            s["_status"] = "skipped"
        elif run:
            planned = s["distance_km"]
            s["_status"] = "done" if not planned or run["dist"] >= DONE_SHARE * planned else "partial"
        elif s["date"] < today:
            s["_status"] = "missed"
        elif s["date"] == today:
            s["_status"] = "today"
        else:
            s["_status"] = "upcoming"
    return used


def verdict(s, run, zones):
    """Pace and heart rate against the target, for steady sessions (structured ones mix paces)."""
    if not run or s["kind"] not in ("easy", "strides", "long", "recovery", "race"):
        return None
    out = {"pace": None, "paceDiff": None, "hr": None}
    if s["pace_lo"] and s["pace_hi"]:
        if run["pace"] < s["pace_lo"] - PACE_TOLERANCE:
            out["pace"], out["paceDiff"] = "fast", round(run["pace"] - s["pace_lo"])
        elif run["pace"] > s["pace_hi"] + PACE_TOLERANCE:
            out["pace"], out["paceDiff"] = "slow", round(run["pace"] - s["pace_hi"])
        else:
            out["pace"] = "on"
    rng = zone_range(s["hr_zone"], zones)
    if run.get("hr") and rng:
        out["hr"] = "above" if run["hr"] > rng[1] else "below" if run["hr"] < rng[0] else "in"
    return out


def zone_range(zone, zones):
    if not zone or not zones or zone not in ZONE_NAMES:
        return None
    k = ZONE_NAMES.index(zone)
    return [zones[k], zones[k + 1] - 1 if k < 3 else zones[4]]


def latest_zones(cur):
    row = cur.execute("SELECT any_value(value_text), any_value(value_json::VARCHAR) FROM daily "
                      "WHERE data_type = 'daily-heart-rate-zones' GROUP BY date ORDER BY date DESC LIMIT 1").fetchone()
    return (runs_mod.zone_thresholds(row) if row else None) or runs_mod.DEFAULT_ZONES


# --- Weeks --------------------------------------------------------------------------------------


def weeks_view(first_monday, last_monday, sessions, runs, today, targets):
    out = []
    w = first_monday
    while w <= last_monday:
        end = w + timedelta(days=7)
        ws = [s for s in sessions if w <= s["date"] < end]
        wr = [r for r in runs if w.isoformat() <= r["date"] < end.isoformat()]
        done_km = sum(r["dist"] for r in wr)
        if sessions:
            # A skipped session still counts as planned: skipping is acknowledged, not done.
            planned_km = sum(s["distance_km"] or 0 for s in ws)
            due = [s for s in ws if s["date"] <= today and s["_status"] != "today"]
            done = [s for s in ws if s["_status"] in ("done", "partial")]
            key_ok = all(s["_status"] == "done" for s in ws if s["kind"] in plan.KEY_KINDS)
            hit = done_km >= STREAK_KM_SHARE * planned_km and key_ok if planned_km else None
            planned_n, done_n = len(ws), len(done)
            adherence = round(100 * len([s for s in due if s in done]) / len(due)) if due else None
        else:
            planned_km = targets.get("km") or 0
            planned_n = targets.get("runs") or 0
            done_n = len(wr)
            hit = (done_km >= planned_km and done_n >= planned_n) if (planned_km or planned_n) else None
            adherence = round(100 * min(1, done_km / planned_km)) if planned_km else None
        state = "past" if end <= today else "current" if w <= today else "future"
        out.append({"monday": w.isoformat(), "plannedKm": round(planned_km, 1), "doneKm": round(done_km, 1),
                    "planned": planned_n, "done": done_n, "adherence": adherence,
                    # a week that isn't over yet only counts once it's already hit
                    "hit": hit if state == "past" else (True if state == "current" and hit else None),
                    "state": state})
        w = end
    return out


def streak(weeks):
    n = 0
    for w in reversed([w for w in weeks if w["state"] != "future"]):
        if w["state"] == "current" and not w["hit"]:
            continue  # the current week doesn't break a streak until it's over
        if not w["hit"]:
            break
        n += 1
    return n


# --- Guidance -----------------------------------------------------------------------------------


def recovery_check(daily, t0, today):
    i = (today - t0).days

    def at(key, j):
        a = daily.get(key) or []
        return a[j] if 0 <= j < len(a) else None

    def base(key):
        vals = [v for v in (at(key, j) for j in range(i - 30, i)) if v is not None]
        if len(vals) < 7:
            return None, None
        m = sum(vals) / len(vals)
        return m, (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5

    hrv, rhr, sleep = at("hrv", i), at("rhr", i), at("slH", i)
    hrv_m, hrv_sd = base("hrv")
    rhr_m, _ = base("rhr")
    reasons = []
    if hrv is not None and hrv_m is not None and hrv < hrv_m - hrv_sd:
        reasons.append(f"HRV {hrv:.0f} ms is below your 30-day range ({hrv_m - hrv_sd:.0f}–{hrv_m + hrv_sd:.0f} ms)")
    if rhr is not None and rhr_m is not None and rhr > rhr_m + 3:
        reasons.append(f"resting heart rate {rhr:.0f} bpm is {rhr - rhr_m:.0f} above your 30-day average")
    if sleep is not None and sleep < 6:
        reasons.append(f"you slept {int(sleep)} h {round(sleep % 1 * 60):02d} m")
    known = any(v is not None for v in (hrv, rhr, sleep))
    return {"status": "low" if reasons else "ok" if known else "unknown", "reasons": reasons,
            "hrv": hrv, "hrv30": round(hrv_m, 1) if hrv_m else None, "rhr": rhr,
            "rhr30": round(rhr_m, 1) if rhr_m else None, "sleep": sleep}


def swap_suggestion(sessions, today):
    """Today's quality session and the next easy one within 4 days, to swap when recovery is low."""
    hard = next((s for s in sessions if s["date"] == today and s["kind"] in plan.QUALITY and s["_status"] == "today"), None)
    if not hard:
        return None
    easy = next((s for s in sessions if today < s["date"] <= today + timedelta(days=4)
                 and s["kind"] in ("easy", "strides", "recovery") and s["_status"] == "upcoming"), None)
    return {"a": hard["session_id"], "b": easy["session_id"], "bDate": easy["date"].isoformat()} if easy else None


def flags_view(p, weeks, load, today, shoes):
    flags = []
    acwr = next((v for v in reversed(load["acwr"]) if v is not None), None)
    if acwr is not None:
        if acwr > 1.5:
            flags.append({"level": "high", "text": f"Load is spiking: acute:chronic ratio {acwr:.2f} (above 1.5). "
                          "Injury risk rises quickly here; keep the next days easy."})
        elif acwr > 1.3:
            flags.append({"level": "caution", "text": f"Load is building fast: acute:chronic ratio {acwr:.2f} (1.3–1.5)."})
        elif acwr < 0.8 and p:
            flags.append({"level": "info", "text": f"Load is low compared with the last 4 weeks (ratio {acwr:.2f}); fitness fades if this lasts."})
    past = [w for w in weeks if w["state"] == "past"]
    if len(past) >= 2:
        last, prev = past[-1]["doneKm"], past[-2]["doneKm"]
        avg3 = sum(w["doneKm"] for w in past[-4:-1]) / len(past[-4:-1])
        if prev > 0 and last > max(prev * plan.RAMP, prev + plan.RAMP_KM):
            flags.append({"level": "caution", "text": f"Last week you ran {last:.1f} km, {100 * (last / prev - 1):.0f}% more than the week before "
                          f"({prev:.1f} km). More than 10% a week raises injury risk."})
        elif avg3 > 0 and last > max(avg3 * 1.15, avg3 + plan.RAMP_KM):
            flags.append({"level": "caution", "text": f"Last week ({last:.1f} km) was well above your 3-week average ({avg3:.1f} km)."})
    if p:
        cur = next((w for w in weeks if w["state"] == "current"), None)
        if past and cur:
            last = past[-1]
            projected = max(cur["plannedKm"], cur["doneKm"])
            if last["plannedKm"] and last["doneKm"] < 0.8 * last["plannedKm"] and \
                    projected > max(last["doneKm"] * plan.RAMP, last["doneKm"] + plan.RAMP_KM):
                flags.append({"level": "info", "action": "rebuild",
                              "text": f"Last week came in at {last['doneKm']:.1f} of {last['plannedKm']:.1f} km planned, and this week's plan "
                                      f"asks for {projected:.1f} km. Rebuild the remaining weeks from your current fitness?"})
        if p["goal_date"] < today:
            flags.append({"level": "info", "action": "archive",
                          "text": "The goal date has passed. Archive this plan and set a new goal."})
    for s in shoes:
        if not s["retired"] and s["wear"] != "ok":
            flags.append({"level": "caution" if s["wear"] == "over" else "info",
                          "text": f"{s['name']} has {s['km']:.0f} km" + (" — past its " if s["wear"] == "over" else ", close to its ")
                                  + f"{s['maxKm']:.0f} km limit."})
    return flags


# --- Everything for the Training page -----------------------------------------------------------


def preview_json(sessions, summary, zones):
    return {
        "sessions": [{"date": s["date"].isoformat(), "kind": s["kind"], "title": s["title"], "km": s["distance_km"],
                      "durS": s["duration_s"], "paceLo": s["pace_lo"], "paceHi": s["pace_hi"], "hrZone": s["hr_zone"],
                      "hrRange": zone_range(s["hr_zone"], zones), "description": s["description"]} for s in sessions],
        "weeks": summary["weeks"], "fitness": summary["fitness"], "predictedS": summary["predicted_s"],
        "paces": summary["paces"], "warnings": summary["warnings"],
    }


def session_json(s, zones):
    run = s["_run"]
    return {
        "id": s["session_id"], "date": s["date"].isoformat(), "kind": s["kind"], "title": s["title"],
        "km": s["distance_km"], "durS": s["duration_s"], "paceLo": s["pace_lo"], "paceHi": s["pace_hi"],
        "hrZone": s["hr_zone"], "hrRange": zone_range(s["hr_zone"], zones), "description": s["description"],
        "status": s["_status"], "runId": run["id"] if run else None, "manual": s["_manual"], "edited": s["edited"],
        "verdict": verdict(s, run, zones),
    }


def plan_json(p):
    params = json.loads(p["params"]) if p["params"] else {}
    return {"id": p["plan_id"], "name": p["name"], "goalKm": p["goal_km"], "goalDate": p["goal_date"].isoformat(),
            "goalTimeS": p["goal_time_s"], "runsPerWeek": p["runs_per_week"], "days": list(p["days"]),
            "longDay": p["long_day"], "created": p["created"].isoformat(timespec="minutes"),
            "predictedS": params.get("predicted_s"), "fitness": params.get("fitness"),
            "warnings": params.get("warnings", []), "paces": params.get("paces"), "rebuilt": params.get("rebuilt")}


def build(cur, data, today=None):
    today = today or local_today()
    runs, daily = data["runs"], data["daily"]
    t0 = date.fromisoformat(data["meta"]["t0"])
    notes = notes_by_run(cur)
    zones = latest_zones(cur)
    settings = get_settings(cur)
    targets = {"km": settings.get("target_km"), "runs": settings.get("target_runs")}

    p = active_plan(cur)
    sessions = rows(cur, "SELECT * FROM tr.sessions WHERE plan_id = ? ORDER BY date, session_id", [p["plan_id"]]) if p else []
    used = match(sessions, runs, today)
    if sessions:
        first = monday(min(sessions[0]["date"], p["created"].date()))
        last = monday(max(p["goal_date"], sessions[-1]["date"]))
        extra = [r["id"] for r in runs if first.isoformat() <= r["date"] <= today.isoformat() and r["id"] not in used]
    else:
        first, last, extra = monday(today) - timedelta(weeks=11), monday(today), []
    weeks = weeks_view(first, last, sessions, runs, today, targets)

    loads = run_loads(runs, daily, t0, notes)
    load = load_series(runs, loads, today)
    shoes = shoes_view(cur, runs)
    recovery = recovery_check(daily, t0, today)
    if recovery["status"] == "low":
        recovery["swap"] = swap_suggestion(sessions, today)

    return {
        "today": today.isoformat(),
        "plan": plan_json(p) if p else None,
        "sessions": [session_json(s, zones) for s in sessions],
        "extra": extra,
        "weeks": weeks,
        "streak": streak(weeks),
        "targets": targets,
        "load": load,
        "runLoad": {k: v[0] for k, v in loads.items()},
        "flags": flags_view(p, weeks, load, today, shoes),
        "recovery": recovery,
        "shoes": shoes,
        "zones": zones,
    }


# --- Plan creation ------------------------------------------------------------------------------


def plan_inputs(body):
    return {"goal_km": float(body["goal_km"]), "goal_date": date.fromisoformat(body["goal_date"]),
            "goal_time_s": float(body["goal_time_s"]) if body.get("goal_time_s") else None,
            "runs_per_week": int(body["runs_per_week"]), "days": [int(d) for d in body["days"]],
            "long_day": int(body["long_day"])}


def preview(data, inp, today=None):
    today = today or local_today()
    fit = plan.fitness(data["runs"], today, inp["goal_km"], inp["goal_time_s"])
    return plan.generate(inp, fit, today)


def insert_sessions(cur, plan_id, sessions):
    from .training_db import new_id
    for s in sessions:
        cur.execute("INSERT INTO tr.sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'planned', false)",
                    [new_id(), plan_id, s["date"], s["kind"], s["title"], s["distance_km"], s["duration_s"],
                     s["pace_lo"], s["pace_hi"], s["hr_zone"], s["description"]])


def create_plan(cur, data, inp, name=None, today=None):
    from .training_db import new_id, now
    today = today or local_today()
    sessions, summary = preview(data, inp, today)
    plan_id = new_id()
    params = {"inputs": {**inp, "goal_date": inp["goal_date"].isoformat()}, "fitness": summary["fitness"],
              "predicted_s": summary["predicted_s"], "warnings": summary["warnings"], "paces": summary["paces"]}
    cur.execute("BEGIN")
    try:
        cur.execute("UPDATE tr.plans SET status = 'archived' WHERE status = 'active'")
        cur.execute("INSERT INTO tr.plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
                    [plan_id, name or ("Road to " + plan.goal_name(inp["goal_km"])), inp["goal_km"], inp["goal_date"],
                     inp["goal_time_s"], inp["runs_per_week"], inp["days"], inp["long_day"], json.dumps(params), now()])
        insert_sessions(cur, plan_id, sessions)
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise
    return plan_id


def rebuild_plan(cur, data, plan_id, today=None):
    """Replace the future, untouched sessions with fresh ones from current fitness."""
    today = today or local_today()
    p = rows(cur, "SELECT * FROM tr.plans WHERE plan_id = ?", [plan_id])
    if not p:
        raise KeyError(plan_id)
    p = p[0]
    inp = {"goal_km": p["goal_km"], "goal_date": p["goal_date"], "goal_time_s": p["goal_time_s"],
           "runs_per_week": p["runs_per_week"], "days": list(p["days"]), "long_day": p["long_day"]}
    keep_sql = "plan_id = ? AND (date < ? OR edited OR run_id IS NOT NULL OR status = 'skipped')"
    kept = {r[0] for r in cur.execute(f"SELECT date FROM tr.sessions WHERE {keep_sql}", [plan_id, today]).fetchall()}
    fit = plan.fitness(data["runs"], today, inp["goal_km"], inp["goal_time_s"])
    sessions, summary = plan.rebuild(inp, fit, today, kept)
    params = json.loads(p["params"]) if p["params"] else {}
    params.update({"fitness": summary["fitness"], "predicted_s": summary["predicted_s"], "warnings": summary["warnings"],
                   "paces": summary["paces"], "rebuilt": today.isoformat()})
    cur.execute("BEGIN")
    try:
        cur.execute(f"DELETE FROM tr.sessions WHERE plan_id = ? AND NOT ({keep_sql})", [plan_id, plan_id, today])
        insert_sessions(cur, plan_id, sessions)
        cur.execute("UPDATE tr.plans SET params = ? WHERE plan_id = ?", [json.dumps(params), plan_id])
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise
    return len(sessions)
