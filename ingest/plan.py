"""Training plan generator: goal + current fitness -> dated sessions.

Pure functions (no database), so plans can be previewed and checked without saving anything.

- Fitness comes from the run summaries (runs.build()): weekly km and longest run over the last
  6 weeks, and a 5 km-equivalent time from the best recent efforts (Riegel: T2 = T1 * (D2/D1)^1.06).
- Paces are derived from that 5 km pace; the race pace from the goal time, but never more than
  3 % faster than what current fitness predicts.
- Volume starts at the current weekly km and grows at most 10 % (or 3 km) a week towards a peak set by the
  goal distance; every 4th week is a recovery week at 80 %, and the last 1-3 weeks taper down to
  the race. The long run grows by at most 1.5 km a week, up to 45 % of the week's volume.
- Quality sessions (tempo, intervals) are kept to about 25 % of the week's volume; a second one
  a week only from 30 km/week and 5 runs.
"""
from datetime import date, timedelta

RIEGEL = 1.06
RAMP = 1.10
RAMP_KM = 3.0  # low volumes may add up to 3 km a week even when that's more than 10 %
RECOVERY = 0.8
FITNESS_WEEKS = 6

# goal km -> (peak weekly km, long-run cap km, taper weeks)
GOALS = [(5, 25, 10, 1), (10, 35, 14, 1), (21.1, 45, 20, 2), (42.2, 60, 32, 3)]

# kind -> pace range as multiples of the 5 km-equivalent pace (faster end first), HR zone
PACES = {
    "recovery": (1.35, 1.45, "LIGHT"),
    "easy": (1.25, 1.35, "MODERATE"),
    "strides": (1.25, 1.35, "MODERATE"),
    "long": (1.27, 1.38, "MODERATE"),
    "tempo": (1.06, 1.09, "VIGOROUS"),
    "intervals": (0.97, 1.00, "VIGOROUS"),
}
QUALITY = ("tempo", "intervals")
KEY_KINDS = ("long", "tempo", "intervals", "race")
WARMUP_KM, COOLDOWN_KM, JOG_KM = 2.0, 1.5, 0.4
MIN_RUN_KM = 3.0


def fpace(s):
    m, x = divmod(round(s), 60)
    return f"{m}:{x:02d}"


def fdur(s):
    s = round(s)
    h, r = divmod(s, 3600)
    m, x = divmod(r, 60)
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m}:{x:02d}"


def goal_name(km):
    names = {5: "5 km", 10: "10 km", 21.1: "half marathon", 42.2: "marathon"}
    for k, v in names.items():
        if abs(km - k) < 0.15:
            return v
    return f"{km:g} km"


def goal_params(km):
    """Peak weekly km, long-run cap and taper weeks, interpolated between the standard distances."""
    if km <= GOALS[0][0]:
        return GOALS[0][1:]
    for (k0, p0, l0, t0), (k1, p1, l1, t1) in zip(GOALS, GOALS[1:]):
        if km <= k1:
            f = (km - k0) / (k1 - k0)
            return p0 + f * (p1 - p0), l0 + f * (l1 - l0), t1 if f > 0.5 else t0
    return GOALS[-1][1:]


def riegel(t, d_from, d_to):
    return t * (d_to / d_from) ** RIEGEL


# --- Fitness ------------------------------------------------------------------------------------


def fitness(runs, today, goal_km=None, goal_time_s=None):
    """Current fitness from run summaries (dicts with date, dist, dur, best5k, best10k)."""
    a = today - timedelta(weeks=FITNESS_WEEKS)
    recent = [r for r in runs if a <= date.fromisoformat(r["date"]) < today]
    weekly_km = sum(r["dist"] for r in recent) / FITNESS_WEEKS
    longest = max((r["dist"] for r in recent), default=0.0)

    # 5 km-equivalent time: the best effort of the last 90 days
    since = today - timedelta(days=90)
    estimates = []
    for r in runs:
        if date.fromisoformat(r["date"]) < since:
            continue
        if r.get("best5k"):
            estimates.append((r["best5k"], "best 5 km within a run on " + r["date"]))
        if r.get("best10k"):
            estimates.append((riegel(r["best10k"], 10, 5), "best 10 km within a run on " + r["date"]))
        if r["dist"] >= 3 and r.get("dur"):
            estimates.append((riegel(r["dur"], r["dist"], 5), f"{r['dist']:.1f} km run on {r['date']}"))
    if estimates:
        t5, basis = min(estimates)
    elif goal_km and goal_time_s:
        t5, basis = riegel(goal_time_s, goal_km, 5), "your goal time (no recent runs)"
    else:
        t5, basis = 35 * 60, "a default (no recent runs)"
    return {"weekly_km": round(weekly_km, 1), "longest_km": round(longest, 1), "t5": round(t5), "basis": basis,
            "runs": len(recent)}


# --- Generator ----------------------------------------------------------------------------------


def monday(d):
    return d - timedelta(days=d.weekday())


def r05(x):
    return round(x * 2) / 2


def paces(t5, goal_km, goal_time_s):
    p5 = t5 / 5
    out = {k: (round(p5 * lo), round(p5 * hi), zone) for k, (lo, hi, zone) in PACES.items()}
    predicted = riegel(t5, 5, goal_km) / goal_km
    race = predicted if not goal_time_s else max(goal_time_s / goal_km, predicted * 0.97)
    out["race"] = (round(race) - 3, round(race) + 3, "VIGOROUS")
    return out, round(predicted * goal_km)


def validate(inp, today):
    days = sorted(set(inp["days"]))
    if not 3 <= inp["runs_per_week"] <= 6:
        raise ValueError("Runs per week must be between 3 and 6.")
    if len(days) != inp["runs_per_week"]:
        raise ValueError(f"Pick exactly {inp['runs_per_week']} training days.")
    if inp["long_day"] not in days:
        raise ValueError("The long-run day must be one of the training days.")
    if inp["goal_date"] <= today:
        raise ValueError("The goal date must be in the future.")
    if not 1 <= inp["goal_km"] <= 100:
        raise ValueError("Goal distance must be between 1 and 100 km.")
    weeks = (monday(inp["goal_date"]) - monday(today)).days // 7 + 1
    if weeks < 3 or weeks > 26:
        raise ValueError("The goal date must be 3 to 26 weeks away.")
    return days, weeks


def generate(inp, fit, today):
    """Sessions from `today` up to and including the goal date.

    inp: goal_km, goal_date (date), goal_time_s (or None), runs_per_week, days (weekdays, 0 = Mon),
    long_day. fit: fitness(). Returns (sessions, summary).
    """
    days, n_weeks = validate(inp, today)
    goal_km, goal_date = inp["goal_km"], inp["goal_date"]
    peak_target, long_cap, taper = goal_params(goal_km)
    pace, predicted = paces(fit["t5"], goal_km, inp.get("goal_time_s"))
    w0 = max(fit["weekly_km"], inp["runs_per_week"] * MIN_RUN_KM)
    peak = max(w0, peak_target)

    taper = min(taper, n_weeks - 2)
    train_weeks = n_weeks - taper
    base_n = max(1, round(train_weeks * 0.4))
    build_n = max(1, round(train_weeks * 0.4)) if train_weeks >= 3 else 0
    taper_factors = {1: [0.6], 2: [0.75, 0.55], 3: [0.8, 0.65, 0.5]}[max(taper, 1)] if taper else []

    weeks = []
    level, long_level = w0, min(max(fit["longest_km"], w0 * 0.3, MIN_RUN_KM + 1), long_cap)
    for i in range(n_weeks):
        if i < train_weeks:
            phase = "base" if i < base_n else "build" if i < base_n + build_n else "peak"
            recovery = i % 4 == 3 and i < train_weeks - 1
            if i > 0 and not recovery:
                level = min(level * RAMP, peak)
                long_level = min(long_level + 1.5, long_cap, max(level * 0.45, long_level))
            vol = level * (RECOVERY if recovery else 1)
            long_km = long_level * (0.8 if recovery else 1)
        else:
            phase, recovery = "taper", False
            f = taper_factors[i - train_weeks]
            vol, long_km = level * f, long_level * (f + 0.1)
        weeks.append({"index": i, "monday": monday(today) + timedelta(weeks=i), "phase": phase,
                      "recovery": recovery, "km": vol, "long": long_km})

    sessions = []
    quality_turn = 0
    prev_total = prev_long = None
    for w in weeks:
        dates = {wd: w["monday"] + timedelta(days=wd) for wd in days}
        race_week = w["monday"] == monday(goal_date)
        if race_week:
            sessions += race_week_sessions(w, dates, goal_km, goal_date, inp.get("goal_time_s"), predicted, pace, today)
            continue
        q = 0 if w["phase"] == "base" else (2 if inp["runs_per_week"] >= 5 and w["km"] >= 30 and w["phase"] != "taper" else 1)
        if w["recovery"]:
            q = min(q, 1)
        quality_days = pick_quality_days([d for d in days if d != inp["long_day"]], inp["long_day"], q)
        week = []
        long_km = r05(max(w["long"], MIN_RUN_KM + 1))
        week.append(make("long", dates[inp["long_day"]], long_km, pace, w, goal_km=goal_km))
        for k, wd in enumerate(quality_days):
            kind = QUALITY[(quality_turn + k) % 2]
            week.append(make(kind, dates[wd], None, pace, w, goal_km=goal_km))
        quality_turn += len(quality_days)
        easy_days = [d for d in days if d != inp["long_day"] and d not in quality_days]
        rest_km = w["km"] - sum(s["distance_km"] for s in week)
        each = r05(max(MIN_RUN_KM, rest_km / max(1, len(easy_days))))
        for k, wd in enumerate(easy_days):
            kind = "strides" if k == 0 and w["phase"] in ("base", "build") and not w["recovery"] else \
                "recovery" if w["recovery"] and k == 0 else "easy"
            week.append(make(kind, dates[wd], each, pace, w))
        if prev_total and w["phase"] != "taper":
            if w["recovery"]:
                trim(week, prev_total * RECOVERY, prev_long * RECOVERY, prev_long * RECOVERY, pace, w, goal_km)
            else:
                trim(week, max(prev_total * RAMP, prev_total + RAMP_KM), prev_long, prev_long + 1.5, pace, w, goal_km)
        if not w["recovery"]:
            prev_total = sum(s["distance_km"] for s in week)
            prev_long = next(s["distance_km"] for s in week if s["kind"] == "long")
        sessions += week

    sessions = sorted((s for s in sessions if s["date"] >= today), key=lambda s: s["date"])
    summary = {
        "weeks": [{"monday": w["monday"].isoformat(), "phase": w["phase"], "recovery": w["recovery"],
                   "km": round(sum(s["distance_km"] for s in sessions
                                   if w["monday"] <= s["date"] < w["monday"] + timedelta(days=7)), 1)}
                  for w in weeks],
        "fitness": fit, "predicted_s": predicted, "paces": {k: [v[0], v[1]] for k, v in pace.items()},
        "warnings": [],
    }
    longest = max((s["distance_km"] for s in sessions if s["kind"] == "long"), default=0)
    if goal_km >= 21 and longest < 0.75 * goal_km:
        summary["warnings"].append(
            f"The longest run in this plan is {longest:g} km, short of the usual {0.75 * goal_km:.0f}+ km for a "
            f"{goal_name(goal_km)}, because volume can only grow slowly from your current {fit['weekly_km']:g} km a week. "
            "A later goal date gives it room to build.")
    if fit["runs"] < 4:
        summary["warnings"].append("Few runs in the last 6 weeks, so the paces are rough estimates. "
                                   "Rebuild the plan after a couple of weeks of training.")
    return sessions, summary


def trim(week, allowed, long_floor, long_max, pace, w, goal_km):
    """Shrink a week to `allowed` km: easy runs first (to 3 km), then the long run (to long_floor),
    then the quality sessions (fewer reps or minutes). The long run never exceeds long_max."""
    total = lambda: sum(s["distance_km"] for s in week)
    long_run = next(s for s in week if s["kind"] == "long")
    if long_run["distance_km"] > long_max:
        resize(long_run, max(MIN_RUN_KM + 1, r05(long_max)))
    easy = [s for s in week if s["kind"] in ("easy", "strides", "recovery")]
    while total() > allowed + 0.25:
        s = max(easy, key=lambda x: x["distance_km"], default=None)
        if not s or s["distance_km"] <= MIN_RUN_KM:
            break
        resize(s, s["distance_km"] - 0.5)
    while total() > allowed + 0.25 and long_run["distance_km"] - 0.5 >= max(long_floor, MIN_RUN_KM + 1):
        resize(long_run, long_run["distance_km"] - 0.5)
    for i, s in enumerate(week):
        if s["kind"] not in QUALITY:
            continue
        smaller = dict(w)
        while total() > allowed + 0.25 and quality_room(smaller) > 5.5:
            smaller["km"] = max(0, smaller["km"] - 2)
            week[i] = s = make(s["kind"], s["date"], None, pace, smaller, goal_km=goal_km)


def resize(s, km):
    s["distance_km"] = km
    s["duration_s"] = round(km * (s["pace_lo"] + s["pace_hi"]) / 2)


def pick_quality_days(candidates, long_day, q):
    """Spread q quality days away from the long run and from each other."""
    if q <= 0 or not candidates:
        return []
    gap = lambda a, b: min((a - b) % 7, (b - a) % 7)
    picked = []
    for _ in range(min(q, len(candidates))):
        best = max((c for c in candidates if c not in picked),
                   key=lambda c: (min([gap(c, long_day)] + [gap(c, p) for p in picked]), -c))
        picked.append(best)
    return sorted(picked)


def quality_room(week):
    """Km a quality session may take, warm-up and cool-down included."""
    return max(0.25 * week["km"], 5.5)


def make(kind, day, km, pace, week, goal_km=None):
    lo, hi, zone = pace[kind]
    rng = f"{fpace(lo)}–{fpace(hi)} /km"
    peak = week["phase"] in ("peak", "taper")
    if kind == "long":
        title, desc = "Long run", f"Steady and easy, {rng}."
        if peak and goal_km and goal_km >= 21 and not week["recovery"]:
            rp = pace["race"]
            desc = f"Easy at {rng}, with the last 3 km at goal pace ({fpace((rp[0] + rp[1]) / 2)} /km)."
    elif kind == "tempo":
        minutes = {"build": 15, "peak": 25 if (goal_km or 0) < 21 else 30, "taper": 12, "base": 12}[week["phase"]]
        minutes = round(minutes * (0.7 if week["recovery"] else 1))
        room = quality_room(week) - WARMUP_KM - COOLDOWN_KM
        minutes = max(10, min(minutes, round(room * (lo + hi) / 2 / 60)))
        km = WARMUP_KM + minutes * 60 / ((lo + hi) / 2) + COOLDOWN_KM
        title = "Tempo run"
        desc = f"{WARMUP_KM:g} km warm-up, {minutes} min at {rng}, {COOLDOWN_KM:g} km cool-down. Comfortably hard."
    elif kind == "intervals":
        long_goal = (goal_km or 0) >= 21
        reps, rep_m = {("build", False): (6, 800), ("peak", False): (5, 1000), ("taper", False): (4, 800),
                       ("build", True): (5, 1000), ("peak", True): (4, 1600), ("taper", True): (3, 1000)
                       }.get((week["phase"], long_goal), (5, 800))
        if week["recovery"]:
            reps = max(3, reps - 2)
        room = quality_room(week) - WARMUP_KM - COOLDOWN_KM + JOG_KM
        reps = max(3, min(reps, int(room // (rep_m / 1000 + JOG_KM))))
        km = WARMUP_KM + reps * rep_m / 1000 + (reps - 1) * JOG_KM + COOLDOWN_KM
        title = "Intervals"
        desc = (f"{WARMUP_KM:g} km warm-up, {reps} × {rep_m} m at {rng} with {JOG_KM * 1000:.0f} m easy jog between, "
                f"{COOLDOWN_KM:g} km cool-down.")
    elif kind == "strides":
        title, desc = "Easy run + strides", f"Conversational pace, {rng}, then 6 × 20 s strides: fast but relaxed, walk back."
    elif kind == "recovery":
        title, desc = "Recovery run", f"Very easy, {rng}. Slower is fine."
    else:
        title, desc = "Easy run", f"Conversational pace, {rng}."
    km = r05(km)
    return {"date": day, "kind": kind, "title": title, "distance_km": km,
            "duration_s": round(km * (lo + hi) / 2), "pace_lo": lo, "pace_hi": hi, "hr_zone": zone,
            "description": desc}


def race_week_sessions(w, dates, goal_km, goal_date, goal_time_s, predicted, pace, today):
    lo, hi, zone = pace["race"]
    rp = (lo + hi) / 2
    target = goal_time_s or rp * goal_km
    race = {"date": goal_date, "kind": "race", "title": f"Race: {goal_name(goal_km)}", "distance_km": goal_km,
            "duration_s": round(target), "pace_lo": lo, "pace_hi": hi, "hr_zone": zone,
            "description": (f"Goal {fdur(target)} ({fpace(rp)} /km); current fitness predicts about {fdur(predicted)}. "
                            "Start the first km a little conservatively, then settle into goal pace.")}
    before = sorted(d for d in dates.values() if d < goal_date and (goal_date - d).days >= 1)
    out = []
    easy_km = r05(max(MIN_RUN_KM, min(6, w["km"] * 0.2)))
    for d in before[-3:]:
        if (goal_date - d).days == 1:
            continue  # rest the day before
        if (goal_date - d).days in (2, 3) and not any(s["kind"] == "strides" for s in out):
            s = make("strides", d, MIN_RUN_KM + 1, pace, w)
            s["title"] = "Easy run + race-pace strides"
            s["description"] = f"Easy {fpace(pace['easy'][0])}–{fpace(pace['easy'][1])} /km, then 4 × 1 min at race pace ({fpace(rp)} /km)."
            out.append(s)
        else:
            out.append(make("easy", d, easy_km, pace, w))
    return out + [race]


def rebuild(inp, fit, today, kept_dates):
    """Fresh future sessions from current fitness, leaving out the dates of sessions that are kept."""
    sessions, summary = generate(inp, fit, today)
    return [s for s in sessions if s["date"] not in kept_dates], summary
