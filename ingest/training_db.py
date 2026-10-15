"""Storage for what you enter yourself: training plans, run notes, shoes and weekly targets.

Unlike everything in health.duckdb this can't be rebuilt from raw/, so it lives in its own file,
data/training.duckdb (HEALTH_TRAINING_DB), attached to the server's connection as `tr`.
Rebuilding health.duckdb never touches it. Back it up together with data/health.duckdb.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import db

TRAINING_DB = Path(os.environ.get("HEALTH_TRAINING_DB", db.DB_PATH.parent / "training.duckdb"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS tr.plans (
    plan_id       VARCHAR PRIMARY KEY,
    name          VARCHAR,
    goal_km       DOUBLE NOT NULL,
    goal_date     DATE NOT NULL,
    goal_time_s   DOUBLE,                  -- optional target finish time
    runs_per_week INTEGER NOT NULL,
    days          INTEGER[] NOT NULL,      -- training weekdays, 0 = Monday
    long_day      INTEGER NOT NULL,
    params        JSON,                    -- inputs and the fitness snapshot the plan was built from
    status        VARCHAR NOT NULL,        -- active | archived
    created       TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS tr.sessions (
    session_id  VARCHAR PRIMARY KEY,
    plan_id     VARCHAR NOT NULL,
    date        DATE NOT NULL,
    kind        VARCHAR NOT NULL,          -- easy | strides | long | tempo | intervals | recovery | race
    title       VARCHAR,
    distance_km DOUBLE,
    duration_s  DOUBLE,
    pace_lo     DOUBLE,                    -- s/km, the faster end of the target range
    pace_hi     DOUBLE,
    hr_zone     VARCHAR,                   -- LIGHT | MODERATE | VIGOROUS | PEAK
    description VARCHAR,
    run_id      VARCHAR,                   -- set by hand; NULL = matched automatically by day
    status      VARCHAR NOT NULL,          -- planned | skipped
    edited      BOOLEAN NOT NULL           -- changed by hand: kept when the plan is rebuilt
);

CREATE TABLE IF NOT EXISTS tr.run_notes (
    run_id  VARCHAR PRIMARY KEY,
    rpe     INTEGER,                       -- effort 1-10
    feel    INTEGER,                       -- 1 (awful) - 5 (great)
    note    VARCHAR,
    shoe_id VARCHAR,                       -- NULL = the default shoe on the run's date
    updated TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS tr.shoes (
    shoe_id  VARCHAR PRIMARY KEY,
    name     VARCHAR NOT NULL,
    start_km DOUBLE NOT NULL,              -- km already on the shoe when it was added
    max_km   DOUBLE NOT NULL,
    retired  BOOLEAN NOT NULL,
    added    TIMESTAMP NOT NULL
);

-- Which shoe is the default from which date (shoe_id NULL = no default). Runs without a shoe of
-- their own count for the default that applied on their date, so changing it never moves old runs.
CREATE TABLE IF NOT EXISTS tr.shoe_defaults (
    since   DATE NOT NULL,
    shoe_id VARCHAR,
    set_at  TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS tr.settings (
    key   VARCHAR PRIMARY KEY,
    value JSON
);
"""


def attach(con, path=TRAINING_DB):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"ATTACH IF NOT EXISTS '{path.as_posix()}' AS tr")
    con.execute(SCHEMA)


def new_id():
    return uuid.uuid4().hex[:12]


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def rows(cur, sql, params=()):
    """Query results as a list of dicts."""
    res = cur.execute(sql, list(params))
    cols = [d[0] for d in res.description]
    return [dict(zip(cols, r)) for r in res.fetchall()]


def get_settings(cur):
    return {k: json.loads(v) for k, v in cur.execute("SELECT key, value FROM tr.settings").fetchall()}


def put_settings(cur, values):
    for k, v in values.items():
        cur.execute("INSERT OR REPLACE INTO tr.settings VALUES (?, ?)", [k, json.dumps(v)])
