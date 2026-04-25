"""
tracker.py  —  Immersion Tracker backend
Serves ui.html via pywebview.  All DB/query logic lives here;
the web frontend calls into the Api class via window.pywebview.api.*
"""

import webview
import sqlite3
import json
import csv
import os
import threading
import requests
import zipfile
import io
import base64
from datetime import datetime, date, timedelta
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import time

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME     = "Immersion Tracker"
DATA_DIR     = Path.home() / "immersion-tracker"
SESSIONS_DIR = DATA_DIR / "sessions"
DB_PATH      = DATA_DIR / "tracker.db"
GSM_API      = "http://localhost:7275/api/stats"

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

def insert_manual_session(atype, minutes, title, session_date):
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO sessions
          (source,title,activity_type,session_date,chars_read,lines_read,time_seconds,ingested_at)
        VALUES (?,?,?,?,?,?,?,?)
    """, ("manual", title or "", atype, session_date, 0, 0,
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

# ── DB queries ────────────────────────────────────────────────────────────────
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
    sums = dict(_q(
        "SELECT session_date,COALESCE(SUM(time_seconds),0) "
        "FROM sessions WHERE session_date>=? AND (time_excluded IS NULL OR time_excluded=0) GROUP BY session_date",
        earliest.isoformat()
    ))
    return [(( earliest + timedelta(days=i)).isoformat(),
              sums.get((earliest + timedelta(days=i)).isoformat(), 0))
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

# ── GSM ───────────────────────────────────────────────────────────────────────
def _upsert_gsm_game(cur_stats):
    """Store or refresh game metadata from currentGameStats."""
    game_id = cur_stats.get("game_id", "")
    if not game_id:
        return
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT OR REPLACE INTO gsm_games
          (game_id, game_name, description, image_data, genres, first_date, last_updated)
        VALUES (?,?,?,?,?,?,?)
    """, (
        game_id,
        cur_stats.get("game_name", "Unknown"),
        cur_stats.get("description", ""),
        cur_stats.get("image", ""),
        json.dumps(cur_stats.get("genres", [])),
        cur_stats.get("first_date", ""),
        datetime.now().isoformat(),
    ))
    con.commit()
    con.close()


def import_ttsu_zip_data(zip_bytes):
    """Parse a ッツ Reader export zip and insert sessions. Returns {imported, skipped, titles}."""
    imported = 0
    skipped  = 0
    titles_seen = set()

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise ValueError(f"Not a valid zip file: {e}")

    with zf:
        import posixpath
        stat_files = [
            n for n in zf.namelist()
            if posixpath.basename(n).startswith('statistics_') and n.endswith('.json')
        ]
        for stat_path in stat_files:
            try:
                entries = json.loads(zf.read(stat_path).decode('utf-8'))
            except Exception:
                continue
            if not isinstance(entries, list):
                continue

            for entry in entries:
                date_key = (entry.get('dateKey') or '').strip()
                if not date_key:
                    continue

                title = (entry.get('title') or '').strip()
                if not title:
                    title = stat_path.split('/')[0]

                chars     = int(entry.get('charactersRead', 0) or 0)
                time_secs = float(entry.get('readingTime', 0) or 0)
                if chars == 0 and time_secs == 0:
                    skipped += 1
                    continue

                speed = float(entry.get('lastReadingSpeed', 0) or 0) or \
                        float(entry.get('maxReadingSpeed',  0) or 0)

                con = sqlite3.connect(DB_PATH)
                exists = con.execute(
                    "SELECT 1 FROM sessions WHERE source='ttsureader' AND title=? AND session_date=?",
                    (title, date_key)
                ).fetchone()
                if exists:
                    skipped += 1
                    con.close()
                    continue

                con.execute("""
                    INSERT INTO sessions
                      (source, title, activity_type, session_date,
                       chars_read, time_seconds, reading_speed, ingested_at, time_excluded)
                    VALUES (?,?,?,?,?,?,?,?,0)
                """, ('ttsureader', title, 'Reading', date_key,
                      chars, time_secs, speed, datetime.now().isoformat()))
                con.commit()
                con.close()
                imported += 1
                titles_seen.add(title)

    return {"imported": imported, "skipped": skipped, "titles": sorted(titles_seen)}


def pull_gsm_now(url=None):
    target = url or GSM_API
    try:
        r = requests.get(target, timeout=5)
        r.raise_for_status()
        data = r.json()

        today_str  = get_today()
        today_year = today_str[:4]

        cur       = data.get("currentGameStats") or {}
        game_name = cur.get("game_name", "Unknown game")
        game_id   = cur.get("game_id", "")

        # Store/refresh game metadata (description, cover image, genres)
        if game_id:
            _upsert_gsm_game(cur)

        # Today's characters — try all-games combined first, fall back to current game
        today_chars = (data.get("characterActivityData") or {}) \
                          .get(today_year, {}).get(today_str, 0)
        if not today_chars:
            today_chars = cur.get("daily_activity", {}).get(today_str, 0)

        # Today's reading speed from heatmap, fall back to global average
        today_speed = (data.get("readingSpeedHeatmapData") or {}) \
                          .get(today_year, {}).get(today_str, 0)
        if not today_speed:
            today_speed = (data.get("allGamesStats") or {}).get("reading_speed", 0)
        time_seconds = (today_chars / today_speed * 3600) if today_speed > 0 else 0

        # Today's cards mined
        cards_data  = data.get("cardsMinedLast30Days") or {}
        cl          = cards_data.get("labels", [])
        ct          = cards_data.get("totals", [])
        today_cards = ct[cl.index(today_str)] if today_str in cl else 0

        s = {
            "source":        "gsm",
            "activity_type": "Reading",
            "title":         game_name,
            "game_id":       game_id,
            "session_date":  today_str,
            "chars_read":    int(today_chars),
            "lines_read":    0,
            "time_seconds":  float(time_seconds),
            "reading_speed": float(today_speed),
            "cards_mined":   int(today_cards),
        }

        out = SESSIONS_DIR / f"gsm_{today_str}.json"
        json.dump(s, open(out, "w", encoding="utf-8"), indent=2)

        # Clear old entry so re-pulls always refresh with latest data
        con = sqlite3.connect(DB_PATH)
        con.execute("DELETE FROM ingested_files WHERE filepath=?", (str(out),))
        con.execute(
            "DELETE FROM sessions WHERE source='gsm' AND session_date=?",
            (today_str,)
        )
        con.commit()
        con.close()

        ingest_session_file(str(out))

        # Backfill historical dates for the current game (time_excluded=1)
        speed_heatmap = data.get("readingSpeedHeatmapData") or {}
        if game_id and cur.get("daily_activity"):
            con_hist = sqlite3.connect(DB_PATH)
            n = _upsert_gsm_daily_history(
                con_hist, game_name, game_id,
                cur["daily_activity"], speed_heatmap
            )
            con_hist.commit()
            con_hist.close()
            if n:
                print(f"[gsm] Backfilled {n} historical session(s) for {game_name}")

        return s
    except requests.exceptions.ConnectionError:
        return None
    except Exception as e:
        print(f"[gsm] {e}")
        return None

def _upsert_gsm_daily_history(con, game_name, game_id, daily_activity, speed_heatmap):
    """
    Backfill per-day historical sessions for the current game directly into
    the DB — no JSON files, no file-watcher pipeline.
    time_excluded=1: visible in Media tab only, not Stats/heatmap/streak.
    Skips today and any date already present for this game.
    """
    if not daily_activity:
        return 0
    today_str = get_today()
    existing  = {
        r[0] for r in con.execute(
            "SELECT DISTINCT session_date FROM sessions WHERE title=? AND source='gsm'",
            (game_name,)
        ).fetchall()
    }
    inserted = 0
    for date_str, chars in daily_activity.items():
        if date_str == today_str or date_str in existing or not chars or chars <= 0:
            continue
        year  = date_str[:4]
        speed = float((speed_heatmap.get(year) or {}).get(date_str, 0))
        con.execute("""
            INSERT INTO sessions
              (source, title, activity_type, session_date, chars_read, lines_read,
               time_seconds, reading_speed, sentences_read, cards_mined, game_id,
               raw_file, ingested_at, time_excluded)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            "gsm", game_name, "Reading", date_str,
            int(chars), 0, (chars / speed * 3600) if speed > 0 else 0.0,
            speed, 0, 0, game_id, None, datetime.now().isoformat(),
            1,  # time_excluded: visible in Media tab only
        ))
        inserted += 1
    return inserted


# ── GSM aggregate import — INACTIVE ──────────────────────────────────────────
#
# Problem: totalCharsPerGame uses different title strings than
# currentGameStats.game_name (e.g. "ひぐらしのなく頃に" vs "Higurashi When They
# Cry - Ch.1 Onikakushi"). There is no game_id or other shared key to
# reliably match them, so deduplication against existing per-day sessions is
# impossible without user intervention.
#
# Current approach: per-day history is populated automatically by
# _upsert_gsm_daily_history on each pull. Uncomment everything below if a
# reliable title-matching solution is found or the GSM API exposes a shared
# key across both endpoints.
#
# def gsm_aggregate_import(url=None):
#     target = url or GSM_API
#     try:
#         r = requests.get(target, timeout=15)
#         r.raise_for_status()
#         data = r.json()
#     except requests.exceptions.ConnectionError:
#         return None, "Could not connect to GSM"
#     except Exception as e:
#         return None, str(e)
#
#     chars_per_game = data.get("totalCharsPerGame") or {}
#     game_labels    = chars_per_game.get("labels", [])
#     game_totals    = chars_per_game.get("totals", [])
#     time_per_game  = data.get("readingTimePerGame") or {}
#     time_by_game   = dict(zip(time_per_game.get("labels", []), time_per_game.get("totals", [])))
#     speed_per_game = data.get("readingSpeedPerGame") or {}
#     speed_by_game  = dict(zip(speed_per_game.get("labels", []), speed_per_game.get("totals", [])))
#     cur = data.get("currentGameStats") or {}
#     if cur.get("game_id"):
#         _upsert_gsm_game(cur)
#     con = sqlite3.connect(DB_PATH)
#     today_str = get_today()
#     imported  = 0
#     for game_name, api_total_chars in zip(game_labels, game_totals):
#         if not api_total_chars or api_total_chars <= 0:
#             continue
#         has_real = con.execute(
#             "SELECT 1 FROM sessions WHERE title=? AND source='gsm' LIMIT 1", (game_name,)
#         ).fetchone()
#         if has_real:
#             continue
#         con.execute("DELETE FROM sessions WHERE source='gsm_import' AND title=?", (game_name,))
#         game_id = cur.get("game_id") if game_name == cur.get("game_name") else None
#         con.execute("""
#             INSERT INTO sessions
#               (source, title, activity_type, session_date, chars_read, lines_read,
#                time_seconds, reading_speed, sentences_read, cards_mined, game_id,
#                raw_file, ingested_at, time_excluded)
#             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
#         """, (
#             "gsm_import", game_name, "Reading", today_str,
#             int(api_total_chars), 0,
#             float(time_by_game.get(game_name, 0)) * 3600,
#             float(speed_by_game.get(game_name, 0)),
#             0, 0, game_id, None, datetime.now().isoformat(), 1,
#         ))
#         imported += 1
#     con.commit()
#     con.close()
#     set_setting("gsm_last_import", datetime.now().isoformat())
#     set_setting("gsm_last_import_count", str(imported))
#     return {"imported": imported}, None
#
# class Api — add back inside Api class to restore:
#     def import_gsm_history(self, url=None):
#         result, error = gsm_aggregate_import(url or get_setting("gsm_url", GSM_API))
#         if error: return {"ok": False, "error": error}
#         return {"ok": True, **result}
#     def get_gsm_import_status(self):
#         return {"last_import": get_setting("gsm_last_import", ""),
#                 "last_count": int(get_setting("gsm_last_import_count", "0") or "0")}
#
# ─────────────────────────────────────────────────────────────────────────────


# ── File watcher ──────────────────────────────────────────────────────────────
class SessionHandler(FileSystemEventHandler):
    def __init__(self, cb):
        self.cb = cb

    def on_created(self, e):
        if not e.is_directory and e.src_path.endswith(".json"):
            time.sleep(0.3)
            if ingest_session_file(e.src_path):
                self.cb()

    def on_modified(self, e):
        if not e.is_directory and e.src_path.endswith(".json"):
            time.sleep(0.3)
            if ingest_session_file(e.src_path):
                self.cb()

# ── JS-callable API ───────────────────────────────────────────────────────────
class Api:
    """All public methods are callable from JS via window.pywebview.api.*"""

    def __init__(self):
        self._window = None

    # ── Dashboard ─────────────────────────────────────────────────────────────
    def get_dashboard(self):
        today  = get_today_stats()
        weekly = get_weekly_summary()
        totals = get_all_time_totals()
        aliases = _get_aliases()
        return {
            "today": [
                {"id": r[0], "source": r[1], "title": aliases.get(r[2], r[2]),
                 "activity_type": r[3], "chars": r[4], "lines": r[5], "seconds": r[6]}
                for r in today
            ],
            "weekly": [
                {"date": r[0], "chars": r[1], "seconds": r[2]}
                for r in weekly
            ],
            "totals": {
                "chars": totals[0], "lines": totals[1],
                "seconds": totals[2], "days": totals[3]
            }
        }

    # ── History ───────────────────────────────────────────────────────────────
    def get_history(self):
        aliases = _get_aliases()
        return [
            {"id": r[0], "date": r[1], "source": r[2], "title": aliases.get(r[3], r[3]),
             "activity_type": r[4], "chars": r[5], "lines": r[6], "seconds": r[7]}
            for r in get_recent_sessions(30)
        ]

    # ── Stats ─────────────────────────────────────────────────────────────────
    def get_stats(self, range_val):
        n           = {"30d": 30, "90d": 90, "1y": 365, "All": None}.get(range_val, 30)
        rc, rs, _   = get_range_totals(n)
        cs, _       = get_streak()
        daily       = get_daily_time_series(n)
        activity    = get_activity_breakdown()
        titles      = get_top_titles(8)

        if n is None:
            first = _q1("SELECT MIN(session_date) FROM sessions")[0]
            w = (date.today() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1 if first else 1
        else:
            w = n

        return {
            "range_val":   range_val,
            "r_chars":     rc,
            "r_secs":      rs,
            "cur_streak":  cs,
            "avg_secs":    rs / max(w, 1),
            "daily":       [{"date": d, "seconds": s} for d, s in daily],
            "activity":    [{"type": a[0], "seconds": a[1]} for a in activity],
            "titles":      [{"title": t[0], "hours": t[1]} for t in titles],
        }

    def get_extra_stats(self):
        return get_extra_stats()

    def get_heatmap(self, year=None, days=371):
        if year is not None:
            start = f"{int(year)}-01-01"
            end   = f"{int(year)}-12-31"
            rows  = _q(
                "SELECT session_date, COALESCE(SUM(time_seconds),0) "
                "FROM sessions WHERE session_date>=? AND session_date<=? "
                "AND (time_excluded IS NULL OR time_excluded=0) "
                "GROUP BY session_date",
                start, end
            )
            return {r[0]: r[1] for r in rows}
        return get_heatmap_data(int(days) if days else 371)

    # ── Media ─────────────────────────────────────────────────────────────────
    def get_media(self):
        return get_media_stats()

    def get_title_detail(self, title):
        """Return per-session data and game metadata for a given title."""
        sessions = _q("""
            SELECT id, session_date, source, activity_type,
                   chars_read, lines_read, time_seconds,
                   reading_speed, cards_mined, sentences_read, game_id
            FROM sessions WHERE title=? ORDER BY session_date ASC
        """, title)

        if not sessions:
            return None

        source = sessions[0][2]

        # Try to load GSM game metadata
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

        # Manual cover overrides any auto-fetched image
        book_cover = _q1("SELECT image_data FROM book_covers WHERE title=?", title)
        if book_cover and book_cover[0]:
            if game_meta:
                game_meta["image"] = book_cover[0]
            else:
                game_meta = {"game_id": None, "desc": "", "image": book_cover[0], "genres": [], "first_date": ""}

        total_chars = sum(s[4] for s in sessions)
        total_secs  = sum(s[6] for s in sessions)
        speeds      = [s[7] for s in sessions if s[7] and s[7] > 0]
        avg_speed   = sum(speeds) / len(speeds) if speeds else 0
        total_cards = sum(s[8] for s in sessions if s[8])

        daily = [
            {
                "date":      s[1],
                "chars":     s[4],
                "seconds":   s[6],
                "speed":     s[7] or 0,
                "cards":     s[8] or 0,
                "sentences": s[9] or 0,
            }
            for s in sessions
        ]

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
            "first_date":    sessions[0][1],
            "last_date":     sessions[-1][1],
            "daily":         daily,
            "description":   game_meta["desc"]   if game_meta else "",
            "image":         game_meta["image"]  if game_meta else "",
            "genres":        game_meta["genres"] if game_meta else [],
            "game_id":       game_meta["game_id"] if game_meta else None,
        }

    # ── Goals ─────────────────────────────────────────────────────────────────
    def get_goals(self):
        return db_get_goal_progress()

    def add_goal(self, label, metric, target, deadline, chunk_period="daily", activity_type=None):
        try:
            db_add_goal(label, metric, float(target), deadline, chunk_period, activity_type)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_goal(self, goal_id):
        try:
            db_delete_goal(goal_id)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Custom categories ──────────────────────────────────────────────────────
    def get_categories(self):
        return db_get_custom_categories()

    def add_category(self, name, color="#6B6B8A"):
        try:
            db_add_custom_category(name, color)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_category(self, name):
        try:
            db_delete_custom_category(name)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Log ───────────────────────────────────────────────────────────────────
    def log_session(self, atype, minutes, title, session_date):
        try:
            datetime.strptime(session_date, "%Y-%m-%d")
            insert_manual_session(atype, float(minutes), title, session_date)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Delete session ────────────────────────────────────────────────────────
    def delete_session(self, session_id):
        try:
            con = sqlite3.connect(DB_PATH)
            con.execute("DELETE FROM sessions WHERE id=?", (int(session_id),))
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── CSV import ────────────────────────────────────────────────────────────
    def open_csv_dialog(self):
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=False,
                file_types=('CSV Files (*.csv)', 'All files (*.*)')
            )
            return result[0] if result else None
        except Exception as e:
            print(f"[dialog] {e}")
            return None

    def do_import_csv(self, path):
        imp, skip = import_csv_file(path)
        return {"imported": imp, "skipped": skip}

    # ── ッツ Reader ──────────────────────────────────────────────────────────────
    def open_ttsu_zip_dialog(self):
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=False,
                file_types=('Zip Files (*.zip)', 'All files (*.*)')
            )
            return result[0] if result else None
        except Exception as e:
            print(f"[dialog] {e}")
            return None

    def do_import_ttsu_zip(self, path):
        try:
            with open(path, 'rb') as f:
                zip_bytes = f.read()
            result = import_ttsu_zip_data(zip_bytes)
            self._notify()
            return {"ok": True, **result}
        except Exception as e:
            return {"ok": False, "error": str(e)}


    def do_import_ttsu_zip_b64(self, b64_str):
        try:
            zip_bytes = base64.b64decode(b64_str)
            result = import_ttsu_zip_data(zip_bytes)
            self._notify()
            return {"ok": True, **result}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── GSM ───────────────────────────────────────────────────────────────────
    def pull_gsm(self, url=None):
        global GSM_API
        if url:
            GSM_API = url
        r = pull_gsm_now(url)
        if r:
            return {"ok": True, "chars": r.get("chars_read", 0),
                    "title": r.get("title", ""),
                    "cards": r.get("cards_mined", 0),
                    "speed": r.get("reading_speed", 0)}
        return {"ok": False}

    def test_gsm(self, url):
        try:
            r = requests.get(url, timeout=4)
            r.raise_for_status()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Book covers ───────────────────────────────────────────────────────────
    def set_book_cover(self, title, b64_str):
        try:
            raw = base64.b64decode(b64_str[:16])
            if raw[:4] == b'\x89PNG':
                mime = 'image/png'
            elif raw[:6] in (b'\xff\xd8\xff\xe0', b'\xff\xd8\xff\xe1') or raw[:2] == b'\xff\xd8':
                mime = 'image/jpeg'
            elif raw[:6] in (b'GIF87a', b'GIF89a'):
                mime = 'image/gif'
            elif raw[:4] == b'RIFF' or raw[8:12] == b'WEBP':
                mime = 'image/webp'
            else:
                mime = 'image/jpeg'
            data_url = f"data:{mime};base64,{b64_str}"
            con = sqlite3.connect(DB_PATH)
            con.execute("""
                INSERT OR REPLACE INTO book_covers (title, image_data, updated_at)
                VALUES (?, ?, ?)
            """, (title, data_url, datetime.now().isoformat()))
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Series ────────────────────────────────────────────────────────────────
    def get_series(self):
        return get_series_data()

    def create_series(self, title1, title2):
        try:
            con = sqlite3.connect(DB_PATH)
            con.execute("PRAGMA foreign_keys = ON")
            now = datetime.now().isoformat()
            cur = con.execute(
                "INSERT INTO series (name, created_at) VALUES (?, ?)", (None, now)
            )
            s_id = cur.lastrowid
            con.execute(
                "INSERT INTO series_members (series_id, title, position, added_at) VALUES (?,?,?,?)",
                (s_id, title1, 0, now)
            )
            con.execute(
                "INSERT INTO series_members (series_id, title, position, added_at) VALUES (?,?,?,?)",
                (s_id, title2, 1, now)
            )
            con.commit()
            con.close()
            return {"ok": True, "series_id": s_id}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def add_to_series(self, series_id, title):
        try:
            con = sqlite3.connect(DB_PATH)
            con.execute("PRAGMA foreign_keys = ON")
            max_pos = con.execute(
                "SELECT COALESCE(MAX(position),0) FROM series_members WHERE series_id=?",
                (int(series_id),)
            ).fetchone()[0]
            con.execute(
                "INSERT OR IGNORE INTO series_members (series_id, title, position, added_at) "
                "VALUES (?,?,?,?)",
                (int(series_id), title, max_pos + 1, datetime.now().isoformat())
            )
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_from_series(self, series_id, title):
        try:
            con = sqlite3.connect(DB_PATH)
            con.execute("PRAGMA foreign_keys = ON")
            con.execute(
                "DELETE FROM series_members WHERE series_id=? AND title=?",
                (int(series_id), title)
            )
            remaining = con.execute(
                "SELECT COUNT(*) FROM series_members WHERE series_id=?", (int(series_id),)
            ).fetchone()[0]
            if remaining < 2:
                con.execute("DELETE FROM series_members WHERE series_id=?", (int(series_id),))
                con.execute("DELETE FROM series WHERE id=?", (int(series_id),))
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def rename_series(self, series_id, name):
        try:
            con = sqlite3.connect(DB_PATH)
            con.execute("UPDATE series SET name=? WHERE id=?", (name.strip() or None, int(series_id)))
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Title aliases ──────────────────────────────────────────────────────────
    def set_title_alias(self, original, display):
        """Set or clear a display alias for a title. Pass display='' to clear."""
        try:
            display = (display or "").strip()
            con = sqlite3.connect(DB_PATH)
            if not display or display == original:
                con.execute("DELETE FROM title_aliases WHERE original_title=?", (original,))
            else:
                con.execute("""
                    INSERT OR REPLACE INTO title_aliases (original_title, display_title, updated_at)
                    VALUES (?,?,?)
                """, (original, display, datetime.now().isoformat()))
            con.commit()
            con.close()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_sessions_dir(self):
        return str(SESSIONS_DIR)

    def get_all_settings(self):
        return {
            "rollover_hour": int(get_setting("rollover_hour", "0")),
            "gsm_url":       get_setting("gsm_url", GSM_API),
        }

    def save_settings(self, data):
        for key, value in data.items():
            set_setting(key, str(value))
        global GSM_API
        if "gsm_url" in data:
            GSM_API = data["gsm_url"]
        return {"ok": True}

    # ── Internal ──────────────────────────────────────────────────────────────
    def _notify(self):
        if self._window:
            try:
                self._window.evaluate_js(
                    "if(typeof onDataChanged==='function') onDataChanged()"
                )
            except Exception:
                pass


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    init_db()
    scan_existing_files()

    api      = Api()
    html_dir  = Path(__file__).parent
    html_path = html_dir / "ui.html"

    win = webview.create_window(
        APP_NAME,
        str(html_path),
        js_api=api,
        width=1040,
        height=720,
        min_size=(860, 580),
        background_color="#1C1C28",
    )
    api._window = win

    handler  = SessionHandler(api._notify)
    observer = Observer()
    observer.schedule(handler, str(SESSIONS_DIR), recursive=False)
    observer.start()

    try:
        webview.start()
    finally:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()