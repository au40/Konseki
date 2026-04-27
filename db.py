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
DATA_DIR     = Path.home() / "immersion-tracker"
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

    con.execute("""
        CREATE TABLE IF NOT EXISTS title_aliases (
            original_title TEXT PRIMARY KEY,
            display_title  TEXT NOT NULL,
            updated_at     TEXT NOT NULL
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
    return _q("""
        SELECT id,source,title,activity_type,chars_read,lines_read,time_seconds
        FROM sessions WHERE session_date=? AND (time_excluded IS NULL OR time_excluded=0)
        ORDER BY ingested_at DESC
    """, get_today())

def get_weekly_summary():
    days = [(get_today_date() - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    con  = sqlite3.connect(DB_PATH)
    out  = [(d,) + con.execute(
        "SELECT COALESCE(SUM(chars_read),0), "
        "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0) "
        "FROM sessions WHERE session_date=?", (d,)).fetchone()
        for d in days]
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
    return _q("""
        SELECT id,session_date,source,title,activity_type,chars_read,lines_read,time_seconds
        FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0)
        ORDER BY session_date DESC,ingested_at DESC LIMIT ?
    """, limit)

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
    return [((earliest + timedelta(days=i)).isoformat(),
              secs.get((earliest + timedelta(days=i)).isoformat(), 0),
              chars.get((earliest + timedelta(days=i)).isoformat(), 0))
            for i in range(total_days)]

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
    earliest = (get_today_date() - timedelta(days=days - 1)).isoformat()
    rows = _q(
        "SELECT session_date, COALESCE(SUM(time_seconds),0) "
        "FROM sessions WHERE session_date>=? AND (time_excluded IS NULL OR time_excluded=0) GROUP BY session_date",
        earliest
    )
    return {r[0]: r[1] for r in rows}


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
        "WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0 "
        "AND (time_excluded IS NULL OR time_excluded=0)"
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
        total_tracked_days = (get_today_date() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1
        active_days = (_q1(
            "SELECT COUNT(DISTINCT session_date) FROM sessions WHERE time_seconds>0"
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


# ── Goals ─────────────────────────────────────────────────────────────────────
def db_get_goals():
    rows = _q(
        "SELECT id,label,metric,target_value,deadline,chunk_period,activity_type,start_date "
        "FROM goals ORDER BY deadline"
    )
    return [
        {"id": r[0], "label": r[1], "metric": r[2], "target": r[3],
         "deadline": r[4], "chunk_period": r[5], "activity_type": r[6], "start_date": r[7]}
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

        where_parts = ["session_date >= ?", "session_date <= ?"]
        params      = [g["start_date"], today_str]
        if g["activity_type"]:
            where_parts.append("activity_type=?")
            params.append(g["activity_type"])

        sql       = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(where_parts)}"
        completed = (_q1(sql, *params) or (0,))[0] or 0.0
        remaining = max(0.0, g["target"] - completed)
        pct       = min(100.0, round(completed / g["target"] * 100, 1)) if g["target"] > 0 else 0.0

        try:
            deadline_d = datetime.strptime(g["deadline"], "%Y-%m-%d").date()
        except Exception:
            deadline_d = today_d
        try:
            start_d = datetime.strptime(g["start_date"], "%Y-%m-%d").date()
        except Exception:
            start_d = today_d

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

        results.append({
            **g,
            "completed":      completed,
            "remaining":      remaining,
            "pct":            pct,
            "days_left":      days_left,
            "total_days":     total_days,
            "chunk_needed":   chunk_needed,
            "original_chunk": original_chunk,
            "is_complete":    completed >= g["target"],
            "is_overdue":     days_left == 0 and completed < g["target"],
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
