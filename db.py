"""
db.py  —  Database layer for Immersion Tracker
All schema setup, settings helpers, ingestion, and query functions.
"""

import sqlite3
import json
import csv
import os
from datetime import datetime, date, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME     = "Immersion Tracker"
DATA_DIR     = Path(os.environ.get("IMMERSION_TRACKER_DATA_DIR") or (Path.home() / "immersion-tracker"))
SESSIONS_DIR = DATA_DIR / "sessions"
DB_PATH      = DATA_DIR / "tracker.db"

SAFE_METRICS  = {'time_seconds', 'chars_read', 'lines_read'}
BUILTIN_CATS  = ['Reading', 'Listening', 'Watching', 'Speaking', 'Vocabulary', 'Other']

# ── Database setup ────────────────────────────────────────────────────────────
def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    SESSIONS_DIR.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH)

    con.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            source        TEXT NOT NULL,
            title         TEXT,
            activity_type TEXT DEFAULT 'Reading',
            session_date  TEXT NOT NULL,
            started_at    TEXT,
            ended_at      TEXT,
            chars_read    INTEGER DEFAULT 0,
            lines_read    INTEGER DEFAULT 0,
            time_seconds  REAL DEFAULT 0,
            raw_file      TEXT,
            ingested_at   TEXT NOT NULL
        )
    """)

    cols = [r[1] for r in con.execute("PRAGMA table_info(sessions)").fetchall()]

    if "activity_type" not in cols:
        con.execute("ALTER TABLE sessions ADD COLUMN activity_type TEXT DEFAULT 'Reading'")

    # Migrate: add GSM-specific columns if missing
    for col_name, col_def in [
        ("reading_speed",  "REAL DEFAULT 0"),
        ("sentences_read", "INTEGER DEFAULT 0"),
        ("cards_mined",    "INTEGER DEFAULT 0"),
        ("game_id",        "TEXT"),
        ("time_excluded",  "INTEGER DEFAULT 0"),
    ]:
        if col_name not in cols:
            con.execute(f"ALTER TABLE sessions ADD COLUMN {col_name} {col_def}")

    con.execute("""
        CREATE TABLE IF NOT EXISTS ingested_files (
            filepath    TEXT PRIMARY KEY,
            ingested_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS goals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            label         TEXT NOT NULL,
            metric        TEXT NOT NULL,
            target_value  REAL NOT NULL,
            deadline      TEXT NOT NULL,
            chunk_period  TEXT NOT NULL DEFAULT 'daily',
            activity_type TEXT,
            start_date    TEXT NOT NULL,
            created_at    TEXT NOT NULL
        )
    """)

    goal_cols = [r[1] for r in con.execute("PRAGMA table_info(goals)").fetchall()]
    if "user_finished" not in goal_cols:
        con.execute("ALTER TABLE goals ADD COLUMN user_finished INTEGER NOT NULL DEFAULT 0")

    # GSM game metadata table — stores cover images, descriptions, genres etc.
    con.execute("""
        CREATE TABLE IF NOT EXISTS gsm_games (
            game_id      TEXT PRIMARY KEY,
            game_name    TEXT NOT NULL,
            description  TEXT,
            image_data   TEXT,
            genres       TEXT,
            first_date   TEXT,
            last_updated TEXT NOT NULL
        )
    """)

    gsm_game_cols = [r[1] for r in con.execute("PRAGMA table_info(gsm_games)").fetchall()]
    for col_name, col_def in [
        ("track",         "INTEGER NOT NULL DEFAULT 0"),
        ("count_as_time", "INTEGER NOT NULL DEFAULT 0"),
    ]:
        if col_name not in gsm_game_cols:
            con.execute(f"ALTER TABLE gsm_games ADD COLUMN {col_name} {col_def}")

    # Backfill: any game that already has GSM sessions in the tracker should be
    # marked as tracked, so the new delta path keeps refreshing it on pulls.
    con.execute("""
        UPDATE gsm_games SET track=1
         WHERE track=0 AND game_id IN (
            SELECT DISTINCT game_id FROM sessions
             WHERE source='gsm' AND game_id IS NOT NULL AND game_id != ''
         )
    """)

    # GSM rollover attributions: when a pull happens during the rollover window,
    # we capture (chars, time, cards) for that GSM real_date so they display under
    # the rollover_date instead of source_date. PK ensures one row per (rollover, source) pair.
    con.execute("""
        CREATE TABLE IF NOT EXISTS gsm_rollover_attributions (
            rollover_date TEXT NOT NULL,
            source_date   TEXT NOT NULL,
            chars         INTEGER NOT NULL DEFAULT 0,
            time_seconds  REAL    NOT NULL DEFAULT 0,
            cards         INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT    NOT NULL,
            PRIMARY KEY (rollover_date, source_date)
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS title_aliases (
            original_title TEXT PRIMARY KEY,
            display_title  TEXT NOT NULL,
            updated_at     TEXT NOT NULL
        )
    """)

    # Audit log for GSM reconciliation that refused to overwrite an existing
    # session row because the rollup value would have zeroed it out. Surfaced
    # in the UI so the user can decide whether to apply, ignore, or investigate.
    con.execute("""
        CREATE TABLE IF NOT EXISTS gsm_sync_anomalies (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            detected_at    TEXT NOT NULL,
            game_id        TEXT NOT NULL,
            game_name      TEXT,
            session_date   TEXT NOT NULL,
            existing_chars INTEGER NOT NULL DEFAULT 0,
            existing_time  REAL    NOT NULL DEFAULT 0,
            rollup_chars   INTEGER NOT NULL DEFAULT 0,
            rollup_time    REAL    NOT NULL DEFAULT 0,
            acknowledged   INTEGER NOT NULL DEFAULT 0
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS book_covers (
            title      TEXT PRIMARY KEY,
            image_data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS custom_categories (
            name       TEXT PRIMARY KEY,
            color      TEXT NOT NULL DEFAULT '#6B6B8A',
            created_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS series (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT,
            created_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS series_members (
            series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
            title     TEXT NOT NULL,
            position  INTEGER NOT NULL DEFAULT 0,
            added_at  TEXT NOT NULL,
            PRIMARY KEY (series_id, title)
        )
    """)

    # Milestones: subdivisions of a single media item (e.g. trilogy parts, arcs).
    # Bounds are stored in native unit ('hours' or 'chars'); empties resolve at
    # query time. Each milestone slices the parent's session history.
    con.execute("""
        CREATE TABLE IF NOT EXISTS milestones (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            name       TEXT NOT NULL,
            unit       TEXT NOT NULL,
            start_val  REAL,
            end_val    REAL,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    con.execute("CREATE INDEX IF NOT EXISTS idx_milestones_title ON milestones(title)")

    con.commit()
    con.close()


# ── Settings ──────────────────────────────────────────────────────────────────
def get_setting(key, default=""):
    r = _q1("SELECT value FROM settings WHERE key=?", key) if Path(DB_PATH).exists() else None
    return r[0] if r else default

def set_setting(key, value):
    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", (key, str(value)))
    con.commit()
    con.close()

def get_today():
    rollover = int(get_setting("rollover_hour", "0"))
    now      = datetime.now()
    if rollover > 0 and now.hour < rollover:
        return str(date.today() - timedelta(days=1))
    return str(date.today())

def get_today_date():
    return datetime.strptime(get_today(), "%Y-%m-%d").date()


def in_rollover_window():
    """True when the rollover hour shifts get_today() to the previous calendar date."""
    return get_today() != str(date.today())


def window_bounds(n=None):
    """Canonical logical-day bounds for date-ranged queries over the sessions table.

    Returns (since, today) as 'YYYY-MM-DD' strings; since is None when n is None
    (all-time). The upper bound is required because GSM imports write
    session_date at the real calendar date, which can exceed logical today
    during the rollover window — any aggregation over a fixed window must clamp
    or it will leak future-dated rows."""
    today = get_today_date().isoformat()
    since = None if n is None else (get_today_date() - timedelta(days=n - 1)).isoformat()
    return since, today


def upsert_gsm_attribution(rollover_date, source_date, chars, time_seconds, cards):
    """Record (or refresh) chars/time/cards from GSM source_date that should display under rollover_date.
    Called only when pulling during the rollover window."""
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO gsm_rollover_attributions
          (rollover_date, source_date, chars, time_seconds, cards, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(rollover_date, source_date) DO UPDATE SET
          chars=excluded.chars,
          time_seconds=excluded.time_seconds,
          cards=excluded.cards,
          updated_at=excluded.updated_at
    """, (rollover_date, source_date, int(chars), float(time_seconds),
          int(cards), datetime.now().isoformat()))
    con.commit()
    con.close()


def refresh_gsm_attribution_tail(rollover_date, source_date, chars, time_seconds, cards):
    """Tail-settle refresh of an EXISTING attribution row, used when a post-rollover
    settle pull finds GSM has flushed additional tail time for pre-rollover reading.

    Guard: chars must not exceed what's already stored. If they grew, real new
    reading has happened post-rollover and the snapshot must not absorb it.
    Returns True if the row was refreshed, False otherwise."""
    con = sqlite3.connect(DB_PATH)
    row = con.execute(
        "SELECT chars, time_seconds, cards FROM gsm_rollover_attributions "
        "WHERE rollover_date=? AND source_date=?",
        (rollover_date, source_date),
    ).fetchone()
    if row is None:
        con.close()
        return False
    if int(chars) > row[0]:
        con.close()
        return False
    con.execute(
        "UPDATE gsm_rollover_attributions SET time_seconds=?, cards=?, updated_at=? "
        "WHERE rollover_date=? AND source_date=?",
        (float(time_seconds), int(cards), datetime.now().isoformat(),
         rollover_date, source_date),
    )
    con.commit()
    con.close()
    return True


def get_gsm_day_adjustment(d):
    """Return (chars, time_seconds, cards) net adjustment to apply to date d's GSM totals.
    Adds attributions where rollover_date=d (chars belonging to d from another source_date),
    subtracts attributions where source_date=d (chars belonging elsewhere)."""
    con = sqlite3.connect(DB_PATH)
    add = con.execute(
        "SELECT COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0), COALESCE(SUM(cards),0) "
        "FROM gsm_rollover_attributions WHERE rollover_date=? AND source_date<>?",
        (d, d)
    ).fetchone()
    sub = con.execute(
        "SELECT COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0), COALESCE(SUM(cards),0) "
        "FROM gsm_rollover_attributions WHERE source_date=? AND rollover_date<>?",
        (d, d)
    ).fetchone()
    con.close()
    return (add[0] - sub[0], add[1] - sub[1], add[2] - sub[2])


# ── Ingestion ─────────────────────────────────────────────────────────────────
def already_ingested(fp):
    con = sqlite3.connect(DB_PATH)
    r   = con.execute("SELECT 1 FROM ingested_files WHERE filepath=?", (fp,)).fetchone()
    con.close()
    return r is not None

def mark_ingested(fp):
    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT OR IGNORE INTO ingested_files VALUES (?,?)",
                (fp, datetime.now().isoformat()))
    con.commit()
    con.close()

def ingest_session_file(fp):
    if already_ingested(fp):
        return False
    try:
        data = json.load(open(fp, encoding="utf-8"))
        con  = sqlite3.connect(DB_PATH)
        con.execute("""
            INSERT INTO sessions
              (source,title,activity_type,session_date,started_at,ended_at,
               chars_read,lines_read,time_seconds,reading_speed,sentences_read,
               cards_mined,game_id,raw_file,ingested_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            data.get("source", "unknown"),
            data.get("title", ""),
            data.get("activity_type", "Reading"),
            data.get("session_date", data.get("date", str(date.today()))),
            data.get("started_at"),
            data.get("ended_at"),
            int(data.get("chars_read", data.get("characters_read", 0))),
            int(data.get("lines_read", 0)),
            float(data.get("time_seconds", data.get("total_time_seconds", 0))),
            float(data.get("reading_speed", 0)),
            int(data.get("sentences_read", 0)),
            int(data.get("cards_mined", 0)),
            data.get("game_id"),
            os.path.basename(fp),
            datetime.now().isoformat(),
        ))
        con.commit()
        con.close()
        mark_ingested(fp)
        return True
    except Exception as e:
        print(f"[ingest] {fp}: {e}")
        return False

def insert_manual_session(atype, minutes, title, session_date, chars=0):
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO sessions
          (source,title,activity_type,session_date,chars_read,lines_read,time_seconds,ingested_at)
        VALUES (?,?,?,?,?,?,?,?)
    """, ("manual", title or "", atype, session_date, int(chars or 0), 0,
          minutes * 60, datetime.now().isoformat()))
    con.commit()
    con.close()

def import_csv_file(fp):
    imported = skipped = 0
    try:
        con = sqlite3.connect(DB_PATH)
        for row in csv.DictReader(open(fp, encoding="utf-8-sig")):
            try:
                ms = row.get("Time (minutes)", "").strip()
                ds = row.get("Date", "").strip()
                if not ms or not ds:
                    skipped += 1
                    continue
                datetime.strptime(ds, "%Y-%m-%d")
                con.execute("""
                    INSERT INTO sessions
                      (source,title,activity_type,session_date,
                       chars_read,lines_read,time_seconds,ingested_at)
                    VALUES (?,?,?,?,?,?,?,?)
                """, (
                    "csv",
                    row.get("Activity", "").strip(),
                    row.get("Activity Type", "Reading").strip() or "Reading",
                    ds, 0, 0, float(ms) * 60, datetime.now().isoformat()
                ))
                imported += 1
            except Exception:
                skipped += 1
        con.commit()
        con.close()
    except Exception as e:
        print(f"[csv] {e}")
    return imported, skipped

def scan_existing_files():
    return sum(1 for f in sorted(SESSIONS_DIR.glob("*.json"))
               if ingest_session_file(str(f)))


# ── DB helpers ────────────────────────────────────────────────────────────────
def _q(sql, *args):
    con = sqlite3.connect(DB_PATH)
    r   = con.execute(sql, args).fetchall()
    con.close()
    return r

def _q1(sql, *args):
    con = sqlite3.connect(DB_PATH)
    r   = con.execute(sql, args).fetchone()
    con.close()
    return r

def _get_aliases():
    """Return {original_title: display_title} for all user-set aliases."""
    if not Path(DB_PATH).exists():
        return {}
    rows = _q("SELECT original_title, display_title FROM title_aliases")
    return {r[0]: r[1] for r in rows}


# ── Queries ───────────────────────────────────────────────────────────────────
def get_today_stats():
    # Today's bucket = get_today(). When rollover is active, also include sessions at
    # real calendar date — attributions between those two dates cancel out within the bucket
    # (chars stay accounted for in the listed rows). For attributions where only one of
    # rollover_date/source_date falls in the bucket, adjust per-row or synthesize phantom rows.
    today = get_today()
    real  = str(date.today())
    bucket = (today,) if today == real else (today, real)
    placeholders = ",".join("?" * len(bucket))
    rows = _q(f"""
        SELECT id,source,title,activity_type,chars_read,lines_read,time_seconds,session_date
        FROM sessions WHERE session_date IN ({placeholders})
          AND (time_excluded IS NULL OR time_excluded=0)
        ORDER BY session_date DESC, ingested_at DESC
    """, *bucket)

    # Outgoing attributions per source_date: chars leaving a bucket date toward a date outside.
    # Aggregate per source_date (not in total) so each is deducted from the first GSM row
    # on its OWN date — otherwise an empty GSM row on one bucket date can eat the deduction
    # via max(0, …) and the real row on the other date keeps its full unadjusted time.
    out_rows = _q(
        f"SELECT source_date, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE source_date IN ({placeholders}) "
        f"AND rollover_date NOT IN ({placeholders}) GROUP BY source_date",
        *bucket, *bucket
    )
    out_by_date = {r[0]: (r[1], r[2]) for r in out_rows}
    deducted_for = set()

    result = []
    for r in rows:
        rid, src, title, atype, chars, lines, secs, sd = r
        if src == 'gsm' and sd not in deducted_for and sd in out_by_date:
            oc, os_ = out_by_date[sd]
            if oc or os_:
                chars = max(0, chars - int(oc))
                secs  = max(0, secs - float(os_))
                deducted_for.add(sd)
        # Drop sessions whose displayed values are all zero (e.g. fully attributed-away GSM rows)
        if chars == 0 and secs == 0 and (lines or 0) == 0:
            continue
        result.append((rid, src, title, atype, chars, lines, secs))

    # Incoming attributions: chars coming from outside the bucket → add phantom rows
    in_rows = _q(
        f"SELECT source_date, SUM(chars), SUM(time_seconds) "
        f"FROM gsm_rollover_attributions WHERE rollover_date IN ({placeholders}) "
        f"AND source_date NOT IN ({placeholders}) GROUP BY source_date",
        *bucket, *bucket
    )
    for sd, ch, sec in in_rows:
        if (ch or 0) > 0 or (sec or 0) > 0:
            game_row = _q1(
                "SELECT title FROM sessions WHERE source='gsm' AND session_date=? "
                "ORDER BY ingested_at DESC LIMIT 1", sd
            )
            game_name = (game_row[0] if game_row and game_row[0] else 'GSM')
            result.append((None, 'gsm', game_name, 'Reading', int(ch or 0), 0, float(sec or 0)))

    return result

def get_weekly_summary():
    days = [(get_today_date() - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    con  = sqlite3.connect(DB_PATH)
    out  = []
    for d in days:
        chars, secs = con.execute(
            "SELECT COALESCE(SUM(chars_read),0), "
            "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0) "
            "FROM sessions WHERE session_date=?", (d,)).fetchone()
        adj_c, adj_t, _ = get_gsm_day_adjustment(d)
        out.append((d, max(0, chars + adj_c), max(0, secs + adj_t)))
    con.close()
    return out

def get_all_time_totals():
    return _q1("""
        SELECT COALESCE(SUM(chars_read),0), COALESCE(SUM(lines_read),0),
               COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0),
               COUNT(DISTINCT CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN session_date END)
        FROM sessions
    """)

def get_range_totals(n):
    _t = "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0)"
    _d = "COUNT(DISTINCT CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN session_date END)"
    if n is None:
        return _q1(f"SELECT COALESCE(SUM(chars_read),0),{_t},{_d} FROM sessions")
    since = (get_today_date() - timedelta(days=n - 1)).isoformat()
    return _q1(f"SELECT COALESCE(SUM(chars_read),0),{_t},{_d} FROM sessions WHERE session_date>=?", since)

def get_recent_sessions(limit=30):
    # Mirrors get_today_stats attribution handling, but generalized across every date
    # in the history window: deduct outgoing attributions from the first GSM row on
    # each date, drop fully-zeroed rows, and synthesize phantom rows for incoming
    # attributions. Over-fetch raw to absorb drops before slicing to `limit`.
    raw = _q("""
        SELECT id,session_date,source,title,activity_type,chars_read,lines_read,time_seconds
        FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0)
        ORDER BY session_date DESC,ingested_at DESC LIMIT ?
    """, limit * 2)
    if not raw:
        return []

    by_date = {}
    for r in raw:
        by_date.setdefault(r[1], []).append(r)
    dates = list(by_date.keys())
    placeholders = ",".join("?" * len(dates))

    out_rows = _q(
        f"SELECT source_date, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE source_date IN ({placeholders}) "
        f"AND rollover_date <> source_date GROUP BY source_date",
        *dates
    )
    out_by_date = {r[0]: (r[1], r[2]) for r in out_rows}

    # Pull incoming attributions that touch our window from either side, so phantom-only
    # rollover dates (where the source row was fully attributed away) still appear.
    in_rows = _q(
        f"SELECT rollover_date, source_date, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE rollover_date <> source_date "
        f"AND (source_date IN ({placeholders}) OR rollover_date IN ({placeholders})) "
        f"GROUP BY rollover_date, source_date",
        *dates, *dates
    )
    in_by_date = {}
    for rd, sd, ch, sec in in_rows:
        in_by_date.setdefault(rd, []).append((sd, ch, sec))

    all_dates = sorted(set(by_date.keys()) | set(in_by_date.keys()), reverse=True)

    result = []
    for d in all_dates:
        out_chars, out_secs = out_by_date.get(d, (0, 0))
        deducted = False
        for r in by_date.get(d, []):
            rid, sd, src, title, atype, chars, lines, secs = r
            if src == 'gsm' and not deducted and (out_chars or out_secs):
                chars = max(0, chars - int(out_chars))
                secs  = max(0, secs  - float(out_secs))
                deducted = True
            if chars == 0 and secs == 0 and (lines or 0) == 0:
                continue
            result.append((rid, sd, src, title, atype, chars, lines, secs))

        for sd2, ch, sec in in_by_date.get(d, []):
            if (ch or 0) <= 0 and (sec or 0) <= 0:
                continue
            game_row = _q1(
                "SELECT title FROM sessions WHERE source='gsm' AND session_date=? "
                "ORDER BY ingested_at DESC LIMIT 1", sd2
            )
            game_name = (game_row[0] if game_row and game_row[0] else 'GSM')
            result.append((None, d, 'gsm', game_name, 'Reading', int(ch or 0), 0, float(sec or 0)))

    return result[:limit]

def get_daily_time_series(days):
    if days is None:
        row = _q1("SELECT MIN(session_date) FROM sessions")
        if not row or not row[0]:
            return []
        earliest   = datetime.strptime(row[0], "%Y-%m-%d").date()
        total_days = (get_today_date() - earliest).days + 1
    else:
        earliest   = get_today_date() - timedelta(days=days - 1)
        total_days = days
    rows = _q(
        "SELECT session_date, "
        "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0), "
        "COALESCE(SUM(chars_read),0) "
        "FROM sessions WHERE session_date>=? GROUP BY session_date",
        earliest.isoformat()
    )
    secs  = {r[0]: r[1] for r in rows}
    chars = {r[0]: r[2] for r in rows}
    out = []
    for i in range(total_days):
        d = (earliest + timedelta(days=i)).isoformat()
        adj_c, adj_t, _ = get_gsm_day_adjustment(d)
        out.append((d,
                    max(0, secs.get(d, 0) + adj_t),
                    max(0, chars.get(d, 0) + adj_c)))
    return out

def get_activity_breakdown():
    return [(r[0], r[1]) for r in _q("""
        SELECT COALESCE(activity_type,'Other'), COALESCE(SUM(time_seconds),0)
        FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0)
        GROUP BY COALESCE(activity_type,'Other')
        ORDER BY SUM(time_seconds) DESC
    """) if r[1] > 0]

def get_streak():
    rows = _q("SELECT DISTINCT session_date FROM sessions "
              "WHERE time_seconds>0 AND (time_excluded IS NULL OR time_excluded=0) "
              "ORDER BY session_date DESC")
    if not rows:
        return 0, 0
    sd  = sorted({datetime.strptime(r[0], "%Y-%m-%d").date() for r in rows})
    cur = 0
    chk = get_today_date()
    for d in reversed(sd):
        if d == chk:
            cur += 1
            chk -= timedelta(days=1)
        elif d < chk:
            break
    lng = run = 1 if sd else 0
    for i in range(1, len(sd)):
        if sd[i] - sd[i-1] == timedelta(days=1):
            run += 1; lng = max(lng, run)
        else:
            run = 1
    return cur, lng

def get_top_titles(limit=8):
    aliases = _get_aliases()
    return [(aliases.get(r[0], r[0]), r[1]) for r in _q("""
        SELECT COALESCE(NULLIF(title,''),activity_type,'Untitled') t,
               COALESCE(SUM(time_seconds),0)/3600.0
        FROM sessions GROUP BY t ORDER BY SUM(time_seconds) DESC LIMIT ?
    """, limit) if r[1] > 0]


# ── Heatmap ───────────────────────────────────────────────────────────────────
def get_heatmap_data(days=371):
    earliest_d = get_today_date() - timedelta(days=days - 1)
    earliest   = earliest_d.isoformat()
    rows = _q(
        "SELECT session_date, COALESCE(SUM(time_seconds),0) "
        "FROM sessions WHERE session_date>=? AND (time_excluded IS NULL OR time_excluded=0) GROUP BY session_date",
        earliest
    )
    base = {r[0]: r[1] for r in rows}
    adj_rows = _q(
        "SELECT rollover_date, source_date, time_seconds "
        "FROM gsm_rollover_attributions WHERE rollover_date<>source_date "
        "AND (rollover_date>=? OR source_date>=?)", earliest, earliest
    )
    for rd, sd, t in adj_rows:
        if rd >= earliest:
            base[rd] = base.get(rd, 0) + t
        if sd >= earliest:
            base[sd] = base.get(sd, 0) - t
    return {d: v for d, v in base.items() if v > 0}


# ── Media stats ───────────────────────────────────────────────────────────────
def get_media_stats():
    rows = _q("""
        SELECT
            s.title                          AS t,
            MAX(s.source)                    AS source,
            MAX(s.activity_type)             AS activity_type,
            COALESCE(SUM(s.time_seconds), 0) AS total_secs,
            COALESCE(SUM(s.chars_read),  0)  AS total_chars,
            COUNT(*)                         AS session_count,
            MAX(s.session_date)              AS last_date,
            MIN(s.session_date)              AS first_date,
            COALESCE(MAX(b.image_data), MAX(g.image_data)) AS image_data
        FROM sessions s
        LEFT JOIN gsm_games   g ON s.title = g.game_name
        LEFT JOIN book_covers b ON s.title = b.title
        WHERE s.title IS NOT NULL AND s.title != ''
        GROUP BY s.title
        ORDER BY total_secs DESC
    """)
    aliases = _get_aliases()
    return [
        {
            "title":         r[0],
            "display_title": aliases.get(r[0], r[0]),
            "source":        r[1],
            "activity_type": r[2],
            "total_secs":    r[3],
            "total_chars":   r[4],
            "session_count": r[5],
            "last_date":     r[6],
            "first_date":    r[7],
            "image":         r[8] or "",
        }
        for r in rows
    ]

def get_series_data():
    series_rows = _q("SELECT id, name, created_at FROM series ORDER BY created_at DESC")
    if not series_rows:
        return []
    aliases = _get_aliases()
    result = []
    for s_id, s_name, _ in series_rows:
        members_rows = _q("""
            SELECT sm.title, sm.position,
                   COALESCE(b.image_data, g.image_data) AS image
            FROM series_members sm
            LEFT JOIN book_covers b ON sm.title = b.title
            LEFT JOIN gsm_games  g ON sm.title = g.game_name
            WHERE sm.series_id = ?
            ORDER BY sm.position ASC, sm.added_at ASC
        """, s_id)
        if not members_rows:
            continue
        members = [
            {"title": r[0], "display_title": aliases.get(r[0], r[0]), "image": r[2] or ""}
            for r in members_rows
        ]
        titles = tuple(m["title"] for m in members)
        ph = ",".join("?" * len(titles))
        con = sqlite3.connect(DB_PATH)
        stats = con.execute(
            f"SELECT COALESCE(SUM(time_seconds),0), COALESCE(SUM(chars_read),0) "
            f"FROM sessions WHERE title IN ({ph})", titles
        ).fetchone()
        con.close()
        result.append({
            "id":          s_id,
            "name":        s_name or members[0]["display_title"],
            "members":     members,
            "total_secs":  stats[0] if stats else 0,
            "total_chars": stats[1] if stats else 0,
        })
    return result


# ── Extra stats ───────────────────────────────────────────────────────────────
def get_extra_stats():
    best_day = _q1(
        "SELECT session_date, SUM(time_seconds) as t "
        "FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0) "
        "GROUP BY session_date ORDER BY t DESC LIMIT 1"
    )
    reading = _q1(
        "SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
        "WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0"
    )
    chars_per_hour = 0
    if reading and reading[1] and reading[1] > 0:
        chars_per_hour = int((reading[0] or 0) / reading[1] * 3600)

    unique_titles = (_q1(
        "SELECT COUNT(DISTINCT NULLIF(title,'')) FROM sessions"
    ) or (0,))[0] or 0

    first = (_q1("SELECT MIN(session_date) FROM sessions") or (None,))[0]
    consistency = 0
    total_tracked_days = 0
    if first:
        _, today = window_bounds()
        total_tracked_days = (get_today_date() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1
        active_days = (_q1(
            "SELECT COUNT(DISTINCT session_date) FROM sessions WHERE time_seconds>0 AND session_date<=?", today
        ) or (0,))[0] or 0
        consistency = round(active_days / total_tracked_days * 100, 1) if total_tracked_days > 0 else 0

    longest_session = (_q1(
        "SELECT MAX(time_seconds) FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0)"
    ) or (0,))[0] or 0
    _, longest_streak = get_streak()

    total_chars = (_q1("SELECT COALESCE(SUM(chars_read),0) FROM sessions") or (0,))[0]

    best_week_start = None
    best_week_secs  = 0
    if first:
        rows = _q(
            "SELECT session_date, SUM(time_seconds) FROM sessions "
            "WHERE (time_excluded IS NULL OR time_excluded=0) "
            "GROUP BY session_date ORDER BY session_date"
        )
        week_totals = {}
        for row in rows:
            d  = datetime.strptime(row[0], "%Y-%m-%d").date()
            wk = d - timedelta(days=d.weekday())
            week_totals[wk] = week_totals.get(wk, 0) + row[1]
        if week_totals:
            best_wk = max(week_totals, key=week_totals.get)
            best_week_start = str(best_wk)
            best_week_secs  = week_totals[best_wk]

    return {
        "best_day_date":          best_day[0] if best_day else None,
        "best_day_secs":          best_day[1] if best_day else 0,
        "best_week_start":        best_week_start,
        "best_week_secs":         best_week_secs,
        "chars_per_hour":         chars_per_hour,
        "unique_titles":          unique_titles,
        "consistency_pct":        consistency,
        "total_tracked_days":     total_tracked_days,
        "longest_session_secs":   longest_session,
        "longest_streak":         longest_streak,
    }


def get_range_extra_stats(n):
    """Range-filtered subset of extra stats used by the Stats page cards."""
    since, today = window_bounds(n)
    base  = "(time_excluded IS NULL OR time_excluded=0)"

    if since:
        reading = _q1(
            f"SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
            f"WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0 "
            f"AND session_date>=?", since
        )
        best_day = _q1(
            f"SELECT session_date, SUM(time_seconds) as t "
            f"FROM sessions WHERE {base} AND session_date>=? "
            f"GROUP BY session_date ORDER BY t DESC LIMIT 1", since
        )
        rows = _q(
            f"SELECT session_date, SUM(time_seconds) FROM sessions "
            f"WHERE {base} AND session_date>=? "
            f"GROUP BY session_date ORDER BY session_date", since
        )
        active_days = (_q1(
            "SELECT COUNT(DISTINCT session_date) FROM sessions "
            "WHERE time_seconds>0 AND session_date>=? AND session_date<=?", since, today
        ) or (0,))[0] or 0
        window = n
    else:
        reading = _q1(
            f"SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
            f"WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0"
        )
        best_day = _q1(
            f"SELECT session_date, SUM(time_seconds) as t "
            f"FROM sessions WHERE {base} "
            f"GROUP BY session_date ORDER BY t DESC LIMIT 1"
        )
        rows = _q(
            f"SELECT session_date, SUM(time_seconds) FROM sessions "
            f"WHERE {base} GROUP BY session_date ORDER BY session_date"
        )
        first = (_q1("SELECT MIN(session_date) FROM sessions") or (None,))[0]
        active_days = (_q1(
            "SELECT COUNT(DISTINCT session_date) FROM sessions WHERE time_seconds>0 AND session_date<=?", today
        ) or (0,))[0] or 0
        window = (get_today_date() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1 if first else 1

    chars_per_hour = 0
    if reading and reading[1] and reading[1] > 0:
        chars_per_hour = int((reading[0] or 0) / reading[1] * 3600)

    best_week_start, best_week_secs = None, 0
    if rows:
        week_totals = {}
        for row in rows:
            d  = datetime.strptime(row[0], "%Y-%m-%d").date()
            wk = d - timedelta(days=d.weekday())
            week_totals[wk] = week_totals.get(wk, 0) + row[1]
        if week_totals:
            best_wk        = max(week_totals, key=week_totals.get)
            best_week_start = str(best_wk)
            best_week_secs  = week_totals[best_wk]

    consistency = round(active_days / window * 100, 1) if window > 0 else 0

    return {
        "best_day_date":   best_day[0] if best_day else None,
        "best_day_secs":   best_day[1] if best_day else 0,
        "best_week_start": best_week_start,
        "best_week_secs":  best_week_secs,
        "chars_per_hour":  chars_per_hour,
        "consistency_pct": consistency,
        "active_days":     active_days,
        "window_days":     window,
    }


# ── Goals ─────────────────────────────────────────────────────────────────────
def db_finish_goal(goal_id):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE goals SET user_finished=1 WHERE id=?", (int(goal_id),))
    con.commit()
    con.close()

def db_get_goals():
    rows = _q(
        "SELECT id,label,metric,target_value,deadline,chunk_period,activity_type,start_date,user_finished "
        "FROM goals ORDER BY deadline"
    )
    return [
        {"id": r[0], "label": r[1], "metric": r[2], "target": r[3],
         "deadline": r[4], "chunk_period": r[5], "activity_type": r[6], "start_date": r[7],
         "user_finished": bool(r[8])}
        for r in rows
    ]

def db_add_goal(label, metric, target, deadline, chunk_period="daily", activity_type=None):
    if metric not in SAFE_METRICS:
        raise ValueError(f"Invalid metric: {metric}")
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT INTO goals "
        "(label,metric,target_value,deadline,chunk_period,activity_type,start_date,created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (label, metric, float(target), deadline, chunk_period,
         activity_type or None, get_today(), datetime.now().isoformat())
    )
    con.commit()
    con.close()

def db_update_goal(goal_id, label, target, deadline, activity_type):
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "UPDATE goals SET label=?, target_value=?, deadline=?, activity_type=? WHERE id=?",
        (label, float(target), deadline, activity_type or None, int(goal_id))
    )
    con.commit()
    con.close()

def db_delete_goal(goal_id):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM goals WHERE id=?", (int(goal_id),))
    con.commit()
    con.close()

def db_get_goal_progress():
    goals     = db_get_goals()
    results   = []
    today_str = get_today()
    today_d   = get_today_date()

    for g in goals:
        if g["metric"] not in SAFE_METRICS:
            continue

        try:
            deadline_d = datetime.strptime(g["deadline"], "%Y-%m-%d").date()
        except Exception:
            deadline_d = today_d
        try:
            start_d = datetime.strptime(g["start_date"], "%Y-%m-%d").date()
        except Exception:
            start_d = today_d

        # For past-deadline goals, don't count sessions recorded after the deadline
        count_up_to = min(today_str, g["deadline"])

        where_parts = ["session_date >= ?", "session_date <= ?"]
        params      = [g["start_date"], count_up_to]
        if g["activity_type"]:
            where_parts.append("activity_type=?")
            params.append(g["activity_type"])

        sql       = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(where_parts)}"
        completed = (_q1(sql, *params) or (0,))[0] or 0.0

        today_where  = ["session_date=?"] + (["activity_type=?"] if g["activity_type"] else [])
        today_params = [today_str] + ([g["activity_type"]] if g["activity_type"] else [])
        today_sql    = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(today_where)}"
        today_completed = (_q1(today_sql, *today_params) or (0,))[0] or 0.0

        # Apply GSM rollover attribution to today's number (GSM is always 'Reading')
        if (not g["activity_type"]) or g["activity_type"] == "Reading":
            adj_c, adj_t, adj_cards = get_gsm_day_adjustment(today_str)
            metric_adj = {"chars_read": adj_c, "time_seconds": adj_t, "cards_mined": adj_cards}.get(g["metric"], 0)
            today_completed = max(0.0, today_completed + metric_adj)

        # Weekly period: clamp start to goal start, end to min(sunday, deadline)
        week_cal_start = today_d - timedelta(days=today_d.weekday())
        week_cal_end   = week_cal_start + timedelta(days=6)
        week_start_d   = max(week_cal_start, start_d)
        week_end_d     = min(week_cal_end, deadline_d)
        week_period_days = max(1, (week_end_d - week_start_d).days + 1)
        week_sum_end_d   = min(week_end_d, today_d)
        week_start_str   = week_start_d.strftime("%Y-%m-%d")
        week_sum_end_str = week_sum_end_d.strftime("%Y-%m-%d")
        week_where       = ["session_date>=?", "session_date<=?"] + (["activity_type=?"] if g["activity_type"] else [])
        week_params      = [week_start_str, week_sum_end_str] + ([g["activity_type"]] if g["activity_type"] else [])
        week_sql         = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(week_where)}"
        week_completed   = (_q1(week_sql, *week_params) or (0,))[0] or 0.0

        # Monthly period: clamp start to goal start, end to min(end-of-month, deadline)
        month_cal_start = today_d.replace(day=1)
        if today_d.month == 12:
            month_cal_end = today_d.replace(year=today_d.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            month_cal_end = today_d.replace(month=today_d.month + 1, day=1) - timedelta(days=1)
        month_start_d    = max(month_cal_start, start_d)
        month_end_d      = min(month_cal_end, deadline_d)
        month_period_days = max(1, (month_end_d - month_start_d).days + 1)
        month_sum_end_d   = min(month_end_d, today_d)
        month_start_str   = month_start_d.strftime("%Y-%m-%d")
        month_sum_end_str = month_sum_end_d.strftime("%Y-%m-%d")
        month_where       = ["session_date>=?", "session_date<=?"] + (["activity_type=?"] if g["activity_type"] else [])
        month_params      = [month_start_str, month_sum_end_str] + ([g["activity_type"]] if g["activity_type"] else [])
        month_sql         = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(month_where)}"
        month_completed   = (_q1(month_sql, *month_params) or (0,))[0] or 0.0

        # GSM rollover attribution: per-day deltas for Reading goals (and untyped goals)
        if (not g["activity_type"]) or g["activity_type"] == "Reading":
            metric_key = g["metric"]
            def _sum_adj(start_d_, end_d_):
                total = 0.0
                cur = start_d_
                while cur <= end_d_:
                    ac, at, ak = get_gsm_day_adjustment(cur.strftime("%Y-%m-%d"))
                    total += {"chars_read": ac, "time_seconds": at, "cards_mined": ak}.get(metric_key, 0)
                    cur += timedelta(days=1)
                return total
            if week_start_d <= week_sum_end_d:
                week_completed = max(0.0, week_completed + _sum_adj(week_start_d, week_sum_end_d))
            if month_start_d <= month_sum_end_d:
                month_completed = max(0.0, month_completed + _sum_adj(month_start_d, month_sum_end_d))

        remaining = max(0.0, g["target"] - completed)
        pct       = min(100.0, round(completed / g["target"] * 100, 1)) if g["target"] > 0 else 0.0

        days_left  = max(0, (deadline_d - today_d).days)
        total_days = max(1, (deadline_d - start_d).days)

        original_chunk = None
        chunk_needed   = None

        if g["chunk_period"] == "daily":
            original_chunk = g["target"] / total_days
            chunk_needed   = remaining / days_left if days_left > 0 else 0.0
        elif g["chunk_period"] == "weekly":
            total_weeks    = max(1.0, total_days / 7.0)
            weeks_left     = days_left / 7.0
            original_chunk = g["target"] / total_weeks
            chunk_needed   = remaining / weeks_left if weeks_left > 0 else 0.0
        elif g["chunk_period"] == "monthly":
            total_months   = max(1.0, total_days / 30.44)
            months_left    = days_left / 30.44
            original_chunk = g["target"] / total_months
            chunk_needed   = remaining / months_left if months_left > 0 else 0.0

        results.append({
            **g,
            "completed":       completed,
            "remaining":       remaining,
            "pct":             pct,
            "days_left":       days_left,
            "total_days":      total_days,
            "chunk_needed":    chunk_needed,
            "original_chunk":  original_chunk,
            "today_completed":  today_completed,
            "week_completed":   week_completed,
            "month_completed":  month_completed,
            "week_period_days":  week_period_days,
            "month_period_days": month_period_days,
            "is_complete":     completed >= g["target"],
            "is_overdue":      days_left == 0 and completed < g["target"],
        })
    return results


# ── Custom categories ─────────────────────────────────────────────────────────
def db_get_custom_categories():
    rows = _q("SELECT name, color FROM custom_categories ORDER BY name")
    return [{"name": r[0], "color": r[1]} for r in rows]

def db_add_custom_category(name, color="#6B6B8A"):
    name = name.strip()
    if not name or name in BUILTIN_CATS:
        return
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT OR IGNORE INTO custom_categories (name,color,created_at) VALUES (?,?,?)",
        (name, color, datetime.now().isoformat())
    )
    con.commit()
    con.close()

def db_delete_custom_category(name):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM custom_categories WHERE name=?", (name,))
    con.commit()
    con.close()


# ── Title detail ──────────────────────────────────────────────────────────────
def _compute_title_core(title):
    """Inner helper: compute the effective daily history + metadata for a title,
    WITHOUT milestones. Used by both db_get_title_detail and the milestone
    slicing helper (to avoid mutual recursion)."""
    sessions = _q("""
        SELECT id, session_date, source, activity_type,
               chars_read, lines_read, time_seconds,
               reading_speed, cards_mined, sentences_read, game_id
        FROM sessions WHERE title=? ORDER BY session_date ASC
    """, title)

    if not sessions:
        return None

    source = sessions[0][2]

    game_meta = None
    if source == "gsm":
        gm = _q1(
            "SELECT game_id, description, image_data, genres, first_date "
            "FROM gsm_games WHERE game_name=?", title
        )
        if gm:
            game_meta = {
                "game_id":    gm[0],
                "desc":       gm[1] or "",
                "image":      gm[2] or "",
                "genres":     json.loads(gm[3]) if gm[3] else [],
                "first_date": gm[4] or "",
            }

    book_cover = _q1("SELECT image_data FROM book_covers WHERE title=?", title)
    if book_cover and book_cover[0]:
        if game_meta:
            game_meta["image"] = book_cover[0]
        else:
            game_meta = {"game_id": None, "desc": "", "image": book_cover[0], "genres": [], "first_date": ""}

    out_by_sd = {}
    in_by_rd  = {}
    gsm_sds = [s[1] for s in sessions if s[2] == 'gsm']
    if gsm_sds:
        ph = ",".join("?" * len(gsm_sds))
        attr_rows = _q(
            f"SELECT rollover_date, source_date, chars, time_seconds, cards "
            f"FROM gsm_rollover_attributions "
            f"WHERE source_date IN ({ph}) AND rollover_date <> source_date",
            *gsm_sds
        )
        for rd, sd, c, t, cards in attr_rows:
            out_by_sd.setdefault(sd, [0, 0, 0])
            out_by_sd[sd][0] += c; out_by_sd[sd][1] += t; out_by_sd[sd][2] += cards
            in_by_rd.setdefault(rd, []).append((sd, c, t, cards))

    daily_map = {}
    def _bump(d, chars, secs, cards, sentences, speed):
        v = daily_map.setdefault(d, {"chars": 0, "secs": 0, "cards": 0, "sentences": 0,
                                      "spd_w": 0, "spd_t": 0})
        v["chars"]     += chars
        v["secs"]      += secs
        v["cards"]     += cards
        v["sentences"] += sentences
        if speed > 0 and secs > 0:
            v["spd_w"] += speed * secs
            v["spd_t"] += secs

    for s in sessions:
        sd = s[1]
        chars, secs = s[4], s[6]
        speed = s[7] or 0
        cards = s[8] or 0
        sentences = s[9] or 0
        if s[2] == 'gsm' and sd in out_by_sd:
            oc, ot, ocards = out_by_sd[sd]
            chars = max(0, chars - oc)
            secs  = max(0.0, secs - ot)
            cards = max(0, cards - ocards)
        if chars > 0 or secs > 0 or cards > 0:
            _bump(sd, chars, secs, cards, sentences, speed)

    for rd, attrs in in_by_rd.items():
        for sd, c, t, cards in attrs:
            if c <= 0 and t <= 0 and cards <= 0:
                continue
            src = next((s for s in sessions if s[1] == sd and s[2] == 'gsm'), None)
            spd = src[7] if src and src[7] else 0
            _bump(rd, int(c), float(t), int(cards), 0, float(spd))

    daily = []
    for d in sorted(daily_map.keys()):
        v = daily_map[d]
        spd = (v["spd_w"] / v["spd_t"]) if v["spd_t"] > 0 else 0
        daily.append({
            "date":      d,
            "chars":     int(v["chars"]),
            "seconds":   v["secs"],
            "speed":     spd,
            "cards":     int(v["cards"]),
            "sentences": int(v["sentences"]),
        })

    total_chars = sum(d["chars"]   for d in daily)
    total_secs  = sum(d["seconds"] for d in daily)
    total_cards = sum(d["cards"]   for d in daily)
    spd_total_time = sum(d["seconds"] for d in daily if d["speed"] > 0)
    avg_speed      = (sum(d["speed"] * d["seconds"] for d in daily if d["speed"] > 0)
                      / spd_total_time) if spd_total_time > 0 else 0
    days_count = len(daily)
    first_date = daily[0]["date"]  if daily else (sessions[0][1]  if sessions else "")
    last_date  = daily[-1]["date"] if daily else (sessions[-1][1] if sessions else "")

    return {
        "title":         title,
        "display_title": _get_aliases().get(title, title),
        "source":        source,
        "activity_type": sessions[0][3],
        "total_chars":   total_chars,
        "total_secs":    total_secs,
        "avg_speed":     avg_speed,
        "total_cards":   total_cards,
        "session_count": len(sessions),
        "days_count":    days_count,
        "first_date":    first_date,
        "last_date":     last_date,
        "daily":         daily,
        "description":   game_meta["desc"]   if game_meta else "",
        "image":         game_meta["image"]  if game_meta else "",
        "genres":        game_meta["genres"] if game_meta else [],
        "game_id":       game_meta["game_id"] if game_meta else None,
    }


def db_get_title_detail(title):
    """Public: title detail including milestone summaries."""
    core = _compute_title_core(title)
    if core is None:
        return None
    core["milestones"] = db_list_milestones(title)
    return core


# ── Milestones ────────────────────────────────────────────────────────────────
# A milestone subdivides a single media item (e.g. trilogy parts within one
# game). Bounds are stored in native unit ('hours' or 'chars'); empties resolve
# at query time. The canonical-minute axis lets us slice and disjoint-check
# milestones whose bounds use different units.

def _build_session_walk(title):
    """Return chronological list of effective session entries for title, plus
    cumulative-before/after for both minutes and chars. Uses the GSM-rollover
    overlay from _compute_title_core (avoids recursion into milestone code).
    Returns: (walk, total_min, total_chars). Walk entries:
      {date, minutes, chars, before_min, after_min, before_chars, after_chars}
    """
    detail = _compute_title_core(title)
    if not detail:
        return [], 0.0, 0
    walk = []
    cum_min, cum_chars = 0.0, 0
    for d in detail["daily"]:
        mins  = (d["seconds"] or 0) / 60.0
        chars = d["chars"] or 0
        before_min, before_chars = cum_min, cum_chars
        cum_min   += mins
        cum_chars += chars
        walk.append({
            "date":         d["date"],
            "minutes":      mins,
            "chars":        chars,
            "speed":        d.get("speed", 0),
            "before_min":   before_min,
            "after_min":    cum_min,
            "before_chars": before_chars,
            "after_chars":  cum_chars,
        })
    return walk, cum_min, cum_chars


def _chars_bound_to_minutes(X, walk, total_min, total_chars):
    """Convert a chars-axis boundary X to a minutes-axis position.
    Convention: the session S that "owns" X satisfies
        before_chars <= X < after_chars
    so the boundary lives at the START of the session that pushes cum past X
    (i.e. 0-char sessions stick to the previous chars-bearing milestone).
    Within an owning session, the position is interpolated by chars fraction."""
    if X is None or X <= 0:
        return 0.0
    if X >= total_chars:
        return total_min
    for s in walk:
        if s["before_chars"] <= X < s["after_chars"]:
            if s["chars"] <= 0:
                return s["before_min"]
            frac = (X - s["before_chars"]) / s["chars"]
            return s["before_min"] + frac * s["minutes"]
    return total_min


def _resolve_milestone_bounds(milestones_rows, walk, total_min, total_chars):
    """Given milestone rows (ordered by position) and the title's session walk,
    return {milestone_id: (start_min, end_min)} resolved to canonical minutes.

    - empty start_val: previous milestone's resolved end (or 0 if position 0)
    - empty end_val:   total_min (ongoing — grows as new sessions log)
    - hours unit:      val * 60, clamped to [0, total_min]
    - chars unit:      _chars_bound_to_minutes
    """
    result = {}
    prev_end = 0.0
    for m in milestones_rows:
        mid, _name, unit, sv, ev, _pos = m
        if sv is None:
            start_min = prev_end
        elif unit == "hours":
            start_min = max(0.0, min(total_min, float(sv) * 60.0))
        else:
            start_min = _chars_bound_to_minutes(float(sv), walk, total_min, total_chars)

        if ev is None:
            end_min = total_min
        elif unit == "hours":
            end_min = max(0.0, min(total_min, float(ev) * 60.0))
        else:
            end_min = _chars_bound_to_minutes(float(ev), walk, total_min, total_chars)

        if end_min < start_min:
            end_min = start_min

        result[mid] = (start_min, end_min)
        prev_end = end_min
    return result


def _slice_totals(walk, start_min, end_min):
    """Compute pro-rata (chars, seconds) totals for the minute range
    [start_min, end_min] over the given session walk."""
    total_chars = 0.0
    total_secs  = 0.0
    for s in walk:
        overlap = max(0.0, min(end_min, s["after_min"]) - max(start_min, s["before_min"]))
        if overlap <= 0:
            continue
        frac = overlap / s["minutes"] if s["minutes"] > 0 else 0.0
        total_chars += s["chars"] * frac
        total_secs  += overlap * 60.0
    return int(round(total_chars)), total_secs


def db_list_milestones(title):
    """Return list of milestones for a title with bounds resolved to minutes
    and pro-rata chars/seconds totals."""
    rows = _q("""
        SELECT id, name, unit, start_val, end_val, position
        FROM milestones WHERE title=? ORDER BY position ASC, id ASC
    """, title)
    if not rows:
        return []
    walk, total_min, total_chars = _build_session_walk(title)
    bounds = _resolve_milestone_bounds(rows, walk, total_min, total_chars)
    out = []
    for r in rows:
        mid, name, unit, sv, ev, pos = r
        sm, em = bounds.get(mid, (0.0, 0.0))
        tc, ts = _slice_totals(walk, sm, em)
        out.append({
            "id":          mid,
            "title":       title,
            "name":        name,
            "unit":        unit,
            "start_val":   sv,
            "end_val":     ev,
            "position":    pos,
            "start_min":   sm,
            "end_min":     em,
            "duration_min": max(0.0, em - sm),
            "ongoing":     ev is None,
            "total_chars": tc,
            "total_secs":  ts,
        })
    return out


def _milestones_overlap(bounds_map, tol=0.01):
    """Return (id_a, id_b) of first pair of milestones whose minute intervals
    overlap by more than tol, or None if disjoint."""
    items = sorted(bounds_map.items(), key=lambda kv: kv[1][0])
    for i in range(len(items) - 1):
        _, (_, end_a) = items[i]
        _, (start_b, _) = items[i + 1]
        if start_b + tol < end_a:
            return (items[i][0], items[i+1][0])
    return None


def db_get_milestone(milestone_id):
    """Return the milestone row + resolved bounds + parent title."""
    r = _q1("""SELECT id, title, name, unit, start_val, end_val, position
               FROM milestones WHERE id=?""", int(milestone_id))
    if not r:
        return None
    mid, title, name, unit, sv, ev, pos = r
    walk, total_min, total_chars = _build_session_walk(title)
    all_rows = _q("""SELECT id, name, unit, start_val, end_val, position
                     FROM milestones WHERE title=? ORDER BY position ASC, id ASC""", title)
    bounds = _resolve_milestone_bounds(all_rows, walk, total_min, total_chars)
    sm, em = bounds.get(mid, (0.0, 0.0))
    return {
        "id": mid, "title": title, "name": name, "unit": unit,
        "start_val": sv, "end_val": ev, "position": pos,
        "start_min": sm, "end_min": em,
    }


def db_get_milestone_detail(milestone_id):
    """Return media-detail-shaped dict for the slice of sessions inside this
    milestone. Sessions straddling a boundary are pro-rata split: chars are
    scaled by time-fraction (equivalent to using per-session read speed)."""
    base = db_get_milestone(milestone_id)
    if not base:
        return None
    title = base["title"]
    parent = _compute_title_core(title)
    if not parent:
        return None
    start_min, end_min = base["start_min"], base["end_min"]

    sliced_daily = []
    cum_min = 0.0
    for d in parent["daily"]:
        session_min = (d["seconds"] or 0) / 60.0
        before_min  = cum_min
        after_min   = cum_min + session_min
        cum_min     = after_min

        overlap_min = max(0.0, min(end_min, after_min) - max(start_min, before_min))
        if overlap_min <= 0:
            continue
        frac = (overlap_min / session_min) if session_min > 0 else 0.0
        sliced_daily.append({
            "date":      d["date"],
            "chars":     int(round((d["chars"] or 0) * frac)),
            "seconds":   overlap_min * 60.0,
            "speed":     d.get("speed", 0),
            "cards":     int(round((d.get("cards") or 0) * frac)),
            "sentences": int(round((d.get("sentences") or 0) * frac)),
        })

    total_chars = sum(d["chars"]   for d in sliced_daily)
    total_secs  = sum(d["seconds"] for d in sliced_daily)
    spd_total_time = sum(d["seconds"] for d in sliced_daily if d["speed"] > 0)
    avg_speed = (sum(d["speed"] * d["seconds"] for d in sliced_daily if d["speed"] > 0)
                 / spd_total_time) if spd_total_time > 0 else 0
    first_date = sliced_daily[0]["date"]  if sliced_daily else ""
    last_date  = sliced_daily[-1]["date"] if sliced_daily else ""

    return {
        "id":            base["id"],
        "title":         title,
        "parent_title":  parent.get("display_title", title),
        "parent_image":  parent.get("image", ""),
        "name":          base["name"],
        "unit":          base["unit"],
        "start_val":     base["start_val"],
        "end_val":       base["end_val"],
        "start_min":     start_min,
        "end_min":       end_min,
        "position":      base["position"],
        "source":        parent.get("source", ""),
        "activity_type": parent.get("activity_type", "Reading"),
        "total_chars":   total_chars,
        "total_secs":    total_secs,
        "avg_speed":     avg_speed,
        "session_count": len(sliced_daily),
        "first_date":    first_date,
        "last_date":     last_date,
        "daily":         sliced_daily,
    }


def _validate_milestone_disjoint(title, candidate_id=None, candidate=None):
    """Validate that all milestones for `title` would be disjoint if `candidate`
    (a tuple matching the SELECT shape) replaced/added at `candidate_id`.
    Returns None if ok, else an error string."""
    rows = list(_q("""SELECT id, name, unit, start_val, end_val, position
                       FROM milestones WHERE title=? ORDER BY position ASC, id ASC""", title))
    if candidate is not None:
        if candidate_id is not None:
            rows = [candidate if r[0] == candidate_id else r for r in rows]
        else:
            rows.append(candidate)
        rows.sort(key=lambda r: (r[5], r[0]))
    if not rows:
        return None
    walk, total_min, total_chars = _build_session_walk(title)
    bounds = _resolve_milestone_bounds(rows, walk, total_min, total_chars)
    bad = _milestones_overlap(bounds)
    if bad:
        return f"Milestones would overlap (ids {bad[0]} and {bad[1]})"
    return None


def db_add_milestone(title, name, unit, start_val, end_val):
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "Name required"}
    if unit not in ("hours", "chars"):
        return {"ok": False, "error": "Unit must be 'hours' or 'chars'"}
    sv = float(start_val) if start_val not in (None, "", "null") else None
    ev = float(end_val)   if end_val   not in (None, "", "null") else None
    if sv is not None and ev is not None and ev < sv:
        return {"ok": False, "error": "End must be ≥ start"}

    max_pos = (_q1("SELECT COALESCE(MAX(position),-1) FROM milestones WHERE title=?", title) or (-1,))[0]
    new_pos = (max_pos if max_pos is not None else -1) + 1
    candidate = (None, name, unit, sv, ev, new_pos)
    err = _validate_milestone_disjoint(title, candidate_id=None, candidate=candidate)
    if err:
        return {"ok": False, "error": err}

    con = sqlite3.connect(DB_PATH)
    cur = con.execute(
        "INSERT INTO milestones (title, name, unit, start_val, end_val, position, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (title, name, unit, sv, ev, new_pos, datetime.now().isoformat())
    )
    new_id = cur.lastrowid
    con.commit()
    con.close()
    return {"ok": True, "id": new_id}


def db_update_milestone(milestone_id, name, unit, start_val, end_val):
    mid = int(milestone_id)
    existing = _q1("SELECT title, position FROM milestones WHERE id=?", mid)
    if not existing:
        return {"ok": False, "error": "Milestone not found"}
    title, pos = existing
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "Name required"}
    if unit not in ("hours", "chars"):
        return {"ok": False, "error": "Unit must be 'hours' or 'chars'"}
    sv = float(start_val) if start_val not in (None, "", "null") else None
    ev = float(end_val)   if end_val   not in (None, "", "null") else None
    if sv is not None and ev is not None and ev < sv:
        return {"ok": False, "error": "End must be ≥ start"}

    candidate = (mid, name, unit, sv, ev, pos)
    err = _validate_milestone_disjoint(title, candidate_id=mid, candidate=candidate)
    if err:
        return {"ok": False, "error": err}

    con = sqlite3.connect(DB_PATH)
    con.execute(
        "UPDATE milestones SET name=?, unit=?, start_val=?, end_val=? WHERE id=?",
        (name, unit, sv, ev, mid)
    )
    con.commit()
    con.close()
    return {"ok": True}


def db_delete_milestone(milestone_id):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM milestones WHERE id=?", (int(milestone_id),))
    con.commit()
    con.close()
    return {"ok": True}


def db_end_milestone(milestone_id):
    """Freeze an ongoing milestone at the current media-cumulative point.
    Sets end_val to the title's current total in the milestone's native unit."""
    mid = int(milestone_id)
    row = _q1("SELECT title, unit, end_val FROM milestones WHERE id=?", mid)
    if not row:
        return {"ok": False, "error": "Milestone not found"}
    title, unit, end_val = row
    if end_val is not None:
        return {"ok": False, "error": "Milestone is already ended"}
    _walk, total_min, total_chars = _build_session_walk(title)
    new_end = (total_min / 60.0) if unit == "hours" else float(total_chars)
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE milestones SET end_val=? WHERE id=?", (new_end, mid))
    con.commit()
    con.close()
    return {"ok": True, "end_val": new_end}


def db_reorder_milestones(title, ordered_ids):
    """Set position = index for each id in ordered_ids (restricted to title)."""
    con = sqlite3.connect(DB_PATH)
    for i, mid in enumerate(ordered_ids):
        con.execute(
            "UPDATE milestones SET position=? WHERE id=? AND title=?",
            (i, int(mid), title)
        )
    con.commit()
    con.close()
    err = _validate_milestone_disjoint(title)
    if err:
        return {"ok": False, "error": err}
    return {"ok": True}
