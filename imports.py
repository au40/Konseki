"""
imports.py  —  External data import integrations
Handles GSM (GameSentenceMiner) pulls and ッツ Reader zip imports.
"""

import sqlite3
import json
import zipfile
import io
import requests
from datetime import datetime

from db import DB_PATH, SESSIONS_DIR, get_today, get_today_date, _q1, ingest_session_file

# ── Config ────────────────────────────────────────────────────────────────────
GSM_API = "http://localhost:7275/api/stats"


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


# ── ッツ Reader ────────────────────────────────────────────────────────────────
def log_manual_session(activity_type, time_seconds, session_date):
    """Insert a manually timed stopwatch session into the DB."""
    if not activity_type:
        return {"error": "activity_type is required"}
    if not session_date:
        session_date = get_today()
    time_secs = float(time_seconds or 0)
    if time_secs <= 0:
        return {"error": "time_seconds must be > 0"}

    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO sessions
          (source, title, activity_type, session_date, time_seconds, ingested_at, time_excluded)
        VALUES (?,?,?,?,?,?,0)
    """, ("manual", None, activity_type, session_date, time_secs, datetime.now().isoformat()))
    con.commit()
    con.close()
    return {"logged": True}


def import_ttsu_entries(entries):
    """Insert a list of ッツ Reader stat dicts into the DB. Returns {imported, skipped, titles}."""
    imported    = 0
    skipped     = 0
    titles_seen = set()

    for entry in entries:
        if isinstance(entry, str):
            try:
                entry = json.loads(entry)
            except Exception:
                skipped += 1
                continue

        date_key = (entry.get('dateKey') or '').strip()
        if not date_key:
            skipped += 1
            continue

        title = (entry.get('title') or '').strip()
        if not title:
            skipped += 1
            continue

        chars     = int(entry.get('charactersRead', 0) or 0)
        time_secs = float(entry.get('readingTime', 0) or 0)
        if chars == 0 and time_secs == 0:
            skipped += 1
            continue

        speed = float(entry.get('lastReadingSpeed', 0) or 0) or \
                float(entry.get('maxReadingSpeed',  0) or 0)

        con      = sqlite3.connect(DB_PATH)
        existing = con.execute(
            "SELECT rowid, chars_read FROM sessions WHERE source='ttsureader' AND title=? AND session_date=?",
            (title, date_key)
        ).fetchone()
        if existing:
            existing_rowid, existing_chars = existing
            if chars <= existing_chars:
                skipped += 1
                con.close()
                continue
            con.execute("""
                UPDATE sessions
                   SET chars_read=?, time_seconds=?, reading_speed=?, ingested_at=?
                 WHERE rowid=?
            """, (chars, time_secs, speed, datetime.now().isoformat(), existing_rowid))
            con.commit()
            con.close()
            imported += 1
            titles_seen.add(title)
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


def import_ttsu_zip_data(zip_bytes):
    """Parse a ッツ Reader export zip and insert sessions. Returns {imported, skipped, titles}."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise ValueError(f"Not a valid zip file: {e}")

    all_entries = []
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
                if not entry.get('title'):
                    entry = dict(entry)
                    entry['title'] = stat_path.split('/')[0]
                all_entries.append(entry)

    return import_ttsu_entries(all_entries)


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
#     from db import set_setting
#     set_setting("gsm_last_import", datetime.now().isoformat())
#     set_setting("gsm_last_import_count", str(imported))
#     return {"imported": imported}, None
#
# Add back inside Api class in tracker.py to restore:
#     def import_gsm_history(self, url=None):
#         result, error = gsm_aggregate_import(url or get_setting("gsm_url", GSM_API))
#         if error: return {"ok": False, "error": error}
#         return {"ok": True, **result}
#     def get_gsm_import_status(self):
#         return {"last_import": get_setting("gsm_last_import", ""),
#                 "last_count": int(get_setting("gsm_last_import_count", "0") or "0")}
#
# ─────────────────────────────────────────────────────────────────────────────
