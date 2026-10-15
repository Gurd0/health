"""Database connection, schema and upsert helpers.

All timestamps are stored as naive UTC. `utc_offset_s` holds the local offset
when the source provides one (API data and sleep/exercise records do; most
takeout CSVs don't). Daily data is keyed by civil date.

Data types use the Google Health API names (`heart-rate`, `daily-resting-heart-rate`,
...) so the takeout backfill and the API sync land in the same rows.
"""
import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
DB_PATH = Path(os.environ.get("HEALTH_DB", ROOT / "data" / "health.duckdb"))
HOME_TZ = "Europe/Oslo"  # used for local time when a row has no utc_offset_s

# When two rows share a key, the one from the higher-precedence origin wins.
ORIGIN_PRECEDENCE = {"fit-legacy": 1, "takeout": 2, "api": 3}

SCHEMA = """
CREATE SEQUENCE IF NOT EXISTS import_seq;

CREATE TABLE IF NOT EXISTS imports (
    import_id   INTEGER PRIMARY KEY,
    kind        VARCHAR NOT NULL,          -- 'takeout' | 'api'
    path        VARCHAR,
    started_at  TIMESTAMP NOT NULL,
    finished_at TIMESTAMP
);

-- One row per raw file ingested, so re-running an import skips unchanged files.
CREATE TABLE IF NOT EXISTS imported_files (
    unit       VARCHAR NOT NULL,           -- parser unit, e.g. 'health:Heart Rate'
    path       VARCHAR NOT NULL,           -- relative to raw/
    sha1       VARCHAR NOT NULL,
    size       BIGINT,
    import_id  INTEGER,
    PRIMARY KEY (unit, path)
);

CREATE TABLE IF NOT EXISTS data_types (
    data_type   VARCHAR NOT NULL,
    origin      VARCHAR NOT NULL,
    kind        VARCHAR NOT NULL,          -- 'sample' | 'interval' | 'daily'
    value_field VARCHAR,                   -- source column/field that `value` came from (incl. unit)
    text_field  VARCHAR,
    PRIMARY KEY (data_type, origin)
);

-- Samples and intervals. Key: (data_type, start_utc, source).
CREATE TABLE IF NOT EXISTS observations (
    data_type    VARCHAR NOT NULL,
    start_utc    TIMESTAMP NOT NULL,
    end_utc      TIMESTAMP,                -- NULL for point samples
    utc_offset_s INTEGER,
    source       VARCHAR NOT NULL,         -- device or app, e.g. 'Pixel Watch 4'
    value        DOUBLE,
    value_text   VARCHAR,
    value_json   JSON,                     -- remaining fields for multi-field types
    origin       VARCHAR NOT NULL,         -- 'takeout' | 'api' | 'fit-legacy'
    api_id       VARCHAR,                  -- data point name from the API
    import_id    INTEGER
);

-- One value per civil day. Key: (data_type, date, source).
CREATE TABLE IF NOT EXISTS daily (
    data_type  VARCHAR NOT NULL,
    date       DATE NOT NULL,
    source     VARCHAR NOT NULL,
    value      DOUBLE,
    value_text VARCHAR,
    value_json JSON,
    origin     VARCHAR NOT NULL,
    api_id     VARCHAR,
    import_id  INTEGER
);

CREATE TABLE IF NOT EXISTS sleep_sessions (
    sleep_id                VARCHAR NOT NULL,
    start_utc               TIMESTAMP NOT NULL,
    end_utc                 TIMESTAMP NOT NULL,
    start_offset_s          INTEGER,
    end_offset_s            INTEGER,
    sleep_type              VARCHAR,       -- STAGES | CLASSIC
    minutes_in_sleep_period INTEGER,
    minutes_asleep          INTEGER,
    minutes_awake           INTEGER,
    minutes_to_fall_asleep  INTEGER,
    minutes_after_wake_up   INTEGER,
    overall_score           DOUBLE,
    duration_score          DOUBLE,
    composition_score       DOUBLE,
    revitalization_score    DOUBLE,
    deep_sleep_minutes      INTEGER,
    rem_sleep_percent       DOUBLE,
    resting_heart_rate      DOUBLE,
    restlessness            DOUBLE,
    data_source             VARCHAR,       -- MANUAL | DERIVED | ...
    algorithm_version       VARCHAR,       -- takeout only: sleep_session_v1 | sleep_session_v2
    details                 JSON,
    created_utc             TIMESTAMP,
    updated_utc             TIMESTAMP,
    origin                  VARCHAR NOT NULL,
    api_id                  VARCHAR,
    import_id               INTEGER
);

CREATE TABLE IF NOT EXISTS sleep_stages (
    sleep_id  VARCHAR NOT NULL,
    start_utc TIMESTAMP NOT NULL,
    end_utc   TIMESTAMP NOT NULL,
    stage     VARCHAR NOT NULL,            -- AWAKE | LIGHT | DEEP | REM | ...
    origin    VARCHAR NOT NULL,
    import_id INTEGER
);

CREATE TABLE IF NOT EXISTS workouts (
    workout_id     VARCHAR NOT NULL,
    start_utc      TIMESTAMP NOT NULL,
    end_utc        TIMESTAMP,
    utc_offset_s   INTEGER,
    activity       VARCHAR,
    log_type       VARCHAR,
    source         VARCHAR,
    duration_s     DOUBLE,
    calories       DOUBLE,
    steps          DOUBLE,
    distance_m     DOUBLE,
    avg_heart_rate DOUBLE,
    max_heart_rate DOUBLE,
    details        JSON,
    origin         VARCHAR NOT NULL,
    api_id         VARCHAR,
    import_id      INTEGER
);

CREATE TABLE IF NOT EXISTS workout_trackpoints (
    workout_id VARCHAR NOT NULL,
    ts_utc     TIMESTAMP NOT NULL,
    latitude   DOUBLE,
    longitude  DOUBLE,
    altitude_m DOUBLE,
    distance_m DOUBLE,
    heart_rate DOUBLE,
    origin     VARCHAR NOT NULL,
    import_id  INTEGER
);
"""

VIEWS = f"""
CREATE OR REPLACE VIEW observations_local AS
SELECT *,
       COALESCE(start_utc + to_seconds(utc_offset_s),
                timezone('{HOME_TZ}', start_utc::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP) AS start_local
FROM observations;

-- One record per sleep. The takeout often holds the same sleep twice, scored by
-- sleep_session_v1 and v2; the API only returns the current (v2) record. Drop a v1
-- record when a v2/API record overlaps it.
CREATE OR REPLACE VIEW sleep AS
SELECT s.* FROM sleep_sessions s
WHERE NOT (
    COALESCE(s.algorithm_version, '') = 'sleep_session_v1'
    AND EXISTS (
        SELECT 1 FROM sleep_sessions o
        WHERE (o.algorithm_version = 'sleep_session_v2' OR o.origin = 'api')
          AND o.start_utc < s.end_utc AND s.start_utc < o.end_utc
    )
);
"""

MIGRATIONS = """
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS algorithm_version VARCHAR;
"""

# Natural keys used by upsert().
KEYS = {
    "observations": ["data_type", "start_utc", "source"],
    "daily": ["data_type", "date", "source"],
    "sleep_sessions": ["sleep_id"],
    "sleep_stages": ["sleep_id", "start_utc"],
    "workouts": ["workout_id"],
    "workout_trackpoints": ["workout_id", "ts_utc"],
}


def connect(path=DB_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(path))
    con.execute("SET TimeZone = 'UTC'")
    con.execute(SCHEMA)
    con.execute(MIGRATIONS)
    con.execute(VIEWS)
    return con


def begin_import(con, kind, path):
    import_id = con.execute("SELECT nextval('import_seq')").fetchone()[0]
    con.execute(
        "INSERT INTO imports VALUES (?, ?, ?, ?, NULL)",
        [import_id, kind, str(path), _now()],
    )
    return import_id


def finish_import(con, import_id):
    con.execute("UPDATE imports SET finished_at = ? WHERE import_id = ?", [_now(), import_id])


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def file_sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    return Path(path).resolve().relative_to(RAW_DIR).as_posix()


def unit_is_current(con, unit, files):
    """True if every file in `files` was already imported for `unit` with the same content."""
    if not files:
        return True
    known = dict(con.execute("SELECT path, sha1 FROM imported_files WHERE unit = ?", [unit]).fetchall())
    return all(known.get(rel(f)) == file_sha1(f) for f in files)


def mark_imported(con, unit, files, import_id):
    for f in files:
        con.execute(
            "INSERT OR REPLACE INTO imported_files VALUES (?, ?, ?, ?, ?)",
            [unit, rel(f), file_sha1(f), Path(f).stat().st_size, import_id],
        )


def register_type(con, data_type, origin, kind, value_field=None, text_field=None):
    con.execute(
        "INSERT OR REPLACE INTO data_types VALUES (?, ?, ?, ?, ?)",
        [data_type, origin, kind, value_field, text_field],
    )


def upsert(con, table, source_sql, scope=None):
    """Merge rows produced by `source_sql` into `table` on its natural key.

    Existing rows with the same key are replaced unless they come from a
    higher-precedence origin (an API row is never overwritten by a takeout row).
    `scope` is an optional {column: value} filter on the target (e.g. {"data_type": "steps"})
    that narrows the join so large tables aren't scanned in full.
    Returns (rows_in_source, unique_keys_in_source, new_keys_added).
    """
    keys = KEYS[table]
    key_list = ", ".join(keys)
    on = " AND ".join(f"t.{k} = s.{k}" for k in keys)
    scope = scope or {}
    where = " AND ".join(
        [f"t.{c} IN ({', '.join(repr(x) for x in (v if isinstance(v, (list, tuple)) else [v]))})"
         for c, v in scope.items()] or ["TRUE"]
    )
    prec = "CASE {col} " + " ".join(f"WHEN '{o}' THEN {p}" for o, p in ORIGIN_PRECEDENCE.items()) + " ELSE 0 END"

    con.execute(f"CREATE OR REPLACE TEMP TABLE _stage AS SELECT * FROM ({source_sql})")
    n_source = con.execute("SELECT count(*) FROM _stage").fetchone()[0]
    # Drop duplicate keys inside the batch (keep the last-updated-looking row arbitrarily but deterministically).
    con.execute(
        f"CREATE OR REPLACE TEMP TABLE _stage AS SELECT * FROM _stage "
        f"QUALIFY row_number() OVER (PARTITION BY {key_list} ORDER BY {key_list}) = 1"
    )
    n_unique = con.execute("SELECT count(*) FROM _stage").fetchone()[0]
    replaced = con.execute(
        f"DELETE FROM {table} t USING _stage s WHERE {on} AND {where} "
        f"AND {prec.format(col='t.origin')} <= {prec.format(col='s.origin')}"
    ).fetchone()[0]
    before = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    cols = [r[0] for r in con.execute(f"DESCRIBE {table}").fetchall()]
    col_list = ", ".join(cols)
    con.execute(
        f"INSERT INTO {table} ({col_list}) SELECT {', '.join('s.' + c for c in cols)} FROM _stage s "
        f"ANTI JOIN (SELECT {key_list} FROM {table} t WHERE {where}) t ON {on}"
    )
    after = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    con.execute("DROP TABLE _stage")
    return n_source, n_unique, after - before - replaced


def stage_records(con, table, records, name="_records"):
    """Register a list of dicts as a view with exactly `table`'s columns (missing ones NULL)."""
    import pandas as pd

    cols = [r[0] for r in con.execute(f"DESCRIBE {table}").fetchall()]
    df = pd.DataFrame.from_records(records, columns=cols)
    con.register(name, df)
    return f"SELECT * FROM {name}"
