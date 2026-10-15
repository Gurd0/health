"""Usage:
    python -m ingest takeout raw/takeout-YYYY-MM-DD [--force]
    python -m ingest sync [--since YYYY-MM-DD] [--types heart-rate,steps] [--dry-run]
    python -m ingest status
    python -m ingest serve [--host 0.0.0.0] [--port 8000]
"""
import argparse
import time
from pathlib import Path

from . import db, takeout_fit, takeout_health


def cmd_takeout(args):
    path = Path(args.path).resolve()
    if not path.is_relative_to(db.RAW_DIR):
        raise SystemExit(f"Put the takeout under {db.RAW_DIR} first (it is the permanent archive).")
    con = db.connect()
    import_id = db.begin_import(con, "takeout", db.rel(path))
    t0 = time.time()
    print("Google Health:")
    takeout_health.import_all(con, path, import_id, args.force)
    print("Google Fit (legacy):")
    takeout_fit.import_all(con, path, import_id, args.force)
    db.finish_import(con, import_id)
    con.execute("CHECKPOINT")
    print(f"Done in {time.time() - t0:.0f}s -> {db.DB_PATH}")


def cmd_sync(args):
    from datetime import datetime

    from . import sync

    con = db.connect()
    since = datetime.fromisoformat(args.since) if args.since else None
    types = args.types.split(",") if args.types else None
    import_id = None if args.dry_run else db.begin_import(con, "api", "health.googleapis.com/v4")
    t0 = time.time()
    print("Google Health API" + (" (dry run, nothing written)" if args.dry_run else "") + ":")
    sync.run(con, import_id, types=types, since=since, dry_run=args.dry_run)
    if import_id:
        db.finish_import(con, import_id)
        con.execute("CHECKPOINT")
    print(f"Done in {time.time() - t0:.0f}s")


def cmd_serve(args):
    import uvicorn

    uvicorn.run("ingest.server:app", host=args.host, port=args.port, workers=1)


def cmd_status(args):
    con = db.connect()
    print(con.sql("""
        SELECT data_type, origin, source, count(*) AS rows,
               min(start_utc)::DATE AS first, max(start_utc)::DATE AS last
        FROM observations GROUP BY ALL ORDER BY data_type, origin, source
    """).to_df().to_string(index=False))
    print()
    print(con.sql("""
        SELECT data_type, origin, source, count(*) AS days, min(date) AS first, max(date) AS last
        FROM daily GROUP BY ALL ORDER BY data_type, origin, source
    """).to_df().to_string(index=False))
    print()
    for table in ("sleep_sessions", "sleep_stages", "workouts", "workout_trackpoints"):
        n, first, last = con.execute(
            f"SELECT count(*), min({'ts_utc' if table == 'workout_trackpoints' else 'start_utc'})::DATE, "
            f"max({'ts_utc' if table == 'workout_trackpoints' else 'start_utc'})::DATE FROM {table}"
        ).fetchone()
        print(f"{table}: {n} rows ({first} .. {last})")


def main():
    p = argparse.ArgumentParser(prog="ingest")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("takeout", help="import a Google Takeout folder")
    t.add_argument("path")
    t.add_argument("--force", action="store_true", help="re-import files even if unchanged")
    t.set_defaults(func=cmd_takeout)
    y = sub.add_parser("sync", help="fetch new data from the Google Health API")
    y.add_argument("--since", help="re-sync from this date (YYYY-MM-DD) instead of the latest stored data")
    y.add_argument("--types", help="comma-separated API data types (default: all)")
    y.add_argument("--dry-run", action="store_true", help="fetch and compare counts without writing")
    y.set_defaults(func=cmd_sync)
    s = sub.add_parser("status", help="summarize what's in the database")
    s.set_defaults(func=cmd_status)
    v = sub.add_parser("serve", help="run the dashboard web server with the daily sync")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8000)
    v.set_defaults(func=cmd_serve)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
