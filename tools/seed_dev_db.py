# -*- coding: utf-8 -*-
r"""Seed the DEV database with realistic fake immersion data.

NEVER touches the live DB: it refuses to run unless pointed at an explicit
data dir, and refuses that dir if it resolves to the live one
(~/immersion-tracker — which is also the repo root, so passing the repo root
is caught too).

Usage (PowerShell, from the repo root):
    $env:IMMERSION_TRACKER_DATA_DIR = Join-Path (pwd) 'dev-data'
    python tools/seed_dev_db.py --wipe
    .\dev.ps1
"""
import argparse
import json
import os
import random
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

# 8 titles designed to exercise every stat-portal feature: overlapping and
# disjoint calendar windows, an abandoned title, a tiny title (speed-gain
# guard), books alongside GSM games, ongoing vs finished.
# (title, source, game_id, start_days_ago, end_days_ago, active_days_per_week,
#  base_speed, end_speed, min_minutes, max_minutes)
TITLE_SPECS = [
    ("夜明けの旅路",   "gsm",        "seed-g1", 300,   0, 5.5,  5500, 11500, 40, 150),
    ("星屑のカルテ",   "gsm",        "seed-g2", 240, 170, 6.5,  6000,  9500, 90, 240),
    ("忘れられた庭",   "gsm",        "seed-g3", 200, 180, 3.0,  5000,  5400, 20,  60),
    ("硝子の街",       "gsm",        "seed-g4", 280,  40, 2.0,  7000,  9000, 30,  90),
    ("月光館の秘密",   "gsm",        "seed-g5",  45,   0, 5.0,  8000, 10000, 45, 120),
    ("風の図書館",     "ttsureader", None,      150,  60, 4.0,  4500,  7500, 30, 100),
    ("雨音の手紙",     "ttsureader", None,      120,   0, 3.5,  6500,  8200, 25,  80),
    ("短編VN",         "gsm",        "seed-g6",  90,  85, 7.0,  6000,  6000, 15,  30),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir",
                    help="target data dir; defaults to $IMMERSION_TRACKER_DATA_DIR")
    ap.add_argument("--wipe", action="store_true",
                    help="clear sessions/gsm_games/attributions/covers first")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed (default 42)")
    args = ap.parse_args()

    # ── Hard safety: never run against the live data dir ──────────────────
    data_dir = args.data_dir or os.environ.get("IMMERSION_TRACKER_DATA_DIR")
    if not data_dir:
        sys.exit("Refusing to run: set IMMERSION_TRACKER_DATA_DIR or pass "
                 "--data-dir (this tool never runs against the default live "
                 "data dir).")
    resolved = Path(data_dir).resolve()
    live_db = (Path.home() / "immersion-tracker" / "tracker.db").resolve()
    if (resolved / "tracker.db") == live_db:
        sys.exit(f"Refusing to touch the live DB at {live_db}.")

    # db.py computes DATA_DIR at import time — env var must be set BEFORE the
    # import, and the assert catches any regression of that ordering.
    os.environ["IMMERSION_TRACKER_DATA_DIR"] = str(resolved)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import db
    db_path = Path(db.DB_PATH).resolve()
    assert db_path == resolved / "tracker.db", \
        f"db.DB_PATH={db_path} escaped the target dir — aborting"
    assert db_path != live_db, f"db.DB_PATH resolved to the live DB — aborting"

    db.init_db()
    con = sqlite3.connect(db_path)

    if args.wipe:
        for table in ("sessions", "gsm_games", "gsm_rollover_attributions",
                      "manual_time_adjust", "book_covers"):
            con.execute(f"DELETE FROM {table}")
        con.commit()
    elif con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]:
        sys.exit("sessions table is not empty — pass --wipe to reseed.")

    random.seed(args.seed)
    today = date.today()
    now = datetime.now().isoformat()
    summary = []

    for (title, source, game_id, start_ago, end_ago, days_per_week,
         base_speed, end_speed, min_mins, max_mins) in TITLE_SPECS:
        start = today - timedelta(days=start_ago)
        duration = max(1, start_ago - end_ago)
        rows = total_chars = 0
        first_d = last_d = None
        for i in range(duration + 1):
            if random.random() >= days_per_week / 7:
                continue
            d = start + timedelta(days=i)
            p = i / duration
            speed = max(500.0, base_speed + (end_speed - base_speed) * p
                        + random.gauss(0, base_speed * 0.07))
            secs = random.uniform(min_mins, max_mins) * 60
            chars = int(secs / 3600 * speed)
            con.execute("""
                INSERT INTO sessions
                  (source, title, activity_type, session_date, chars_read, lines_read,
                   time_seconds, reading_speed, sentences_read, cards_mined, game_id,
                   raw_file, ingested_at, time_excluded)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (source, title, "Reading", d.isoformat(), chars, 0, secs,
                  chars / (secs / 3600), 0, 0, game_id, None, now, 0))
            rows += 1
            total_chars += chars
            first_d = first_d or d
            last_d = d
        if game_id:
            con.execute("""
                INSERT INTO gsm_games
                  (game_id, game_name, description, image_data, genres,
                   first_date, last_updated, track, count_as_time, char_count)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """, (game_id, title, "Seeded dev game", None,
                  json.dumps(["Adventure", "Drama"]), start.isoformat(), now,
                  1, 0, int(total_chars * 1.35)))
        summary.append((title, source, rows, first_d, last_d, total_chars))

    con.commit()
    con.close()

    print(f"Seeded {db_path}")
    for title, source, rows, first_d, last_d, chars in summary:
        print(f"  {title:12s} [{source:10s}] {rows:3d} days  "
              f"{first_d} → {last_d}  {chars:>9,d} chars")
    print("Now run:  .\\dev.ps1")


if __name__ == "__main__":
    main()
