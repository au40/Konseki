"""
imports.py  —  External data import integrations
Handles GSM (GameSentenceMiner) pulls and ッツ Reader zip imports.
"""

import os
import re
import sqlite3
import json
import zipfile
import io
import base64
import html
import posixpath
import requests
from urllib.parse import unquote
from pathlib import Path
from datetime import datetime, date, timedelta
from db import (DB_PATH, get_today, get_today_date, _q1,
                in_rollover_window, upsert_gsm_attribution,
                refresh_gsm_attribution_tail, get_setting)

# ── Config ────────────────────────────────────────────────────────────────────
GSM_API = "http://localhost:7275/api/stats"


# ── GSM local DB access (read-only) ───────────────────────────────────────────
# GSM stores authoritative per-day-per-game time in its SQLite at gsm.db. We
# read it directly because /api/stats does not expose per-day time. Connection
# is opened read-only via URI so we never block or corrupt GSM's writer.

def _default_gsm_db_path():
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
    return str(Path(appdata) / "GameSentenceMiner" / "gsm.db")


def get_gsm_db_path():
    override = get_setting("gsm_db_path", "")
    return override if override else _default_gsm_db_path()


def _open_gsm_db():
    """Open GSM's SQLite read-only. Returns connection or None if unavailable."""
    p = get_gsm_db_path()
    if not Path(p).exists():
        return None
    try:
        uri = f"file:{p}?mode=ro"
        return sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error:
        return None


def list_gsm_db_games():
    """Enumerate games found in GSM's DB with their rollup totals and a flag
    indicating whether the tracker is currently set to track them.

    Returns a list of dicts: {game_id, game_name, total_chars, total_time_s,
    first_date, last_date, tracked, count_as_time, in_tracker_rows}.
    """
    gsm = _open_gsm_db()
    if gsm is None:
        return []
    try:
        rows = gsm.execute("""
            SELECT r.game_id,
                   COALESCE(NULLIF(g.obs_scene_name,''),
                            NULLIF(g.title_original,''),
                            NULLIF(g.title_english, ''),
                            NULLIF(g.title_romaji,  ''),
                            r.game_id),
                   SUM(CAST(r.total_characters AS INTEGER)),
                   SUM(CAST(r.total_reading_time_seconds AS REAL)),
                   MIN(r.date),
                   MAX(r.date)
            FROM game_daily_rollup r
            LEFT JOIN games g ON g.id = r.game_id
            GROUP BY r.game_id
        """).fetchall()
    finally:
        gsm.close()

    if not rows:
        return []

    tracker = sqlite3.connect(DB_PATH)
    try:
        prefs = {
            gid: (track, cat) for gid, track, cat in tracker.execute(
                "SELECT game_id, track, count_as_time FROM gsm_games"
            ).fetchall()
        }
        row_counts = {
            gid: n for gid, n in tracker.execute(
                "SELECT game_id, COUNT(*) FROM sessions "
                "WHERE source='gsm' AND game_id IS NOT NULL AND game_id != '' "
                "GROUP BY game_id"
            ).fetchall()
        }
    finally:
        tracker.close()

    out = []
    for gid, name, chars, secs, fd, ld in rows:
        track, count_t = prefs.get(gid, (0, 0))
        out.append({
            "game_id":         gid,
            "game_name":       name or gid,
            "total_chars":     int(chars or 0),
            "total_time_s":    float(secs or 0),
            "first_date":      fd,
            "last_date":       ld,
            "tracked":         bool(track),
            "count_as_time":   bool(count_t),
            "in_tracker_rows": row_counts.get(gid, 0),
        })
    out.sort(key=lambda g: g["total_time_s"], reverse=True)
    return out


def read_gsm_rollup(game_ids=None, dates=None):
    """Read rows from GSM's game_daily_rollup table.

    game_ids: iterable of game_id strings to filter (None = all tracked games).
    dates:    iterable of date strings to filter (None = all dates).

    Returns list of dicts: {game_id, date, chars, time_seconds, cards}.
    """
    gsm = _open_gsm_db()
    if gsm is None:
        return []
    try:
        sql = ("SELECT game_id, date, "
               "CAST(total_characters AS INTEGER), "
               "CAST(total_reading_time_seconds AS REAL), "
               "CAST(total_cards_mined AS INTEGER) "
               "FROM game_daily_rollup")
        clauses, params = [], []
        if game_ids:
            ids = list(game_ids)
            clauses.append(f"game_id IN ({','.join('?'*len(ids))})")
            params.extend(ids)
        if dates:
            ds = list(dates)
            clauses.append(f"date IN ({','.join('?'*len(ds))})")
            params.extend(ds)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        rows = gsm.execute(sql, params).fetchall()
    finally:
        gsm.close()
    return [
        {"game_id": gid, "date": d, "chars": int(c or 0),
         "time_seconds": float(t or 0), "cards": int(cd or 0)}
        for gid, d, c, t, cd in rows
    ]


# ── GSM history reconciliation (uses gsm.db rollup as source of truth) ───────

def _speed_from(chars, time_seconds):
    """Reading speed (chars/hour) derived from chars and seconds. Matches the
    relationship GSM uses: total_chars / total_hours."""
    if time_seconds <= 0:
        return 0.0
    return float(chars) / (float(time_seconds) / 3600.0)


# Block destructive overwrites: if GSM's rollup says a row is empty but the
# tracker has real data there, that's almost certainly a wipe/corruption (or
# the rare legit case where the user manually deleted lines from GSM). We
# refuse and log the anomaly so the user can review.
ZERO_OUT_GUARD_CHARS = 1000


def _would_zero_out(rollup_chars, rollup_time, existing_chars):
    return (rollup_chars == 0 and rollup_time <= 0.5
            and existing_chars > ZERO_OUT_GUARD_CHARS)


def _record_sync_anomaly(con, game_id, game_name, session_date,
                         existing_chars, existing_time,
                         rollup_chars, rollup_time):
    con.execute("""
        INSERT INTO gsm_sync_anomalies
          (detected_at, game_id, game_name, session_date,
           existing_chars, existing_time, rollup_chars, rollup_time)
        VALUES (?,?,?,?,?,?,?,?)
    """, (datetime.now().isoformat(), game_id, game_name, session_date,
          int(existing_chars or 0), float(existing_time or 0),
          int(rollup_chars or 0), float(rollup_time or 0)))


def list_gsm_sync_anomalies():
    """Return open (unacknowledged) anomalies, newest first."""
    con = sqlite3.connect(DB_PATH)
    try:
        rows = con.execute("""
            SELECT id, detected_at, game_id, game_name, session_date,
                   existing_chars, existing_time, rollup_chars, rollup_time
            FROM gsm_sync_anomalies WHERE acknowledged=0
            ORDER BY detected_at DESC
        """).fetchall()
    finally:
        con.close()
    return [
        {"id": r[0], "detected_at": r[1], "game_id": r[2], "game_name": r[3],
         "session_date": r[4], "existing_chars": r[5], "existing_time": r[6],
         "rollup_chars": r[7], "rollup_time": r[8]}
        for r in rows
    ]


def acknowledge_gsm_sync_anomaly(anomaly_id, apply_change):
    """Mark an anomaly resolved. If apply_change=True, perform the deferred
    update that was originally blocked (zeroing the tracker row). Otherwise
    just dismiss it and leave the tracker row as-is."""
    con = sqlite3.connect(DB_PATH)
    try:
        row = con.execute(
            "SELECT game_id, session_date, rollup_chars, rollup_time "
            "FROM gsm_sync_anomalies WHERE id=? AND acknowledged=0",
            (anomaly_id,)
        ).fetchone()
        if not row:
            return {"ok": False, "error": "not found or already acknowledged"}
        if apply_change:
            gid, d, rc, rt = row
            speed = _speed_from(rc, rt)
            con.execute("""
                UPDATE sessions
                   SET chars_read=?, time_seconds=?, reading_speed=?, ingested_at=?
                 WHERE source='gsm' AND game_id=? AND session_date=?
            """, (int(rc or 0), float(rt or 0), speed,
                  datetime.now().isoformat(), gid, d))
        con.execute(
            "UPDATE gsm_sync_anomalies SET acknowledged=1 WHERE id=?",
            (anomaly_id,)
        )
        con.commit()
    finally:
        con.close()
    return {"ok": True}


def _tracked_games_with_prefs():
    """Return {game_id: count_as_time_bool} for games marked tracked=1."""
    con = sqlite3.connect(DB_PATH)
    try:
        rows = con.execute(
            "SELECT game_id, count_as_time FROM gsm_games WHERE track=1"
        ).fetchall()
    finally:
        con.close()
    return {gid: bool(ct) for gid, ct in rows}


def _tracker_gsm_rows_for(game_id):
    """Existing tracker rows for this game's GSM data, keyed by date."""
    con = sqlite3.connect(DB_PATH)
    try:
        rows = con.execute(
            "SELECT rowid, session_date, chars_read, time_seconds, cards_mined, "
            "       reading_speed, time_excluded, title "
            "FROM sessions WHERE source='gsm' AND game_id=?",
            (game_id,)
        ).fetchall()
    finally:
        con.close()
    return {
        d: {"rowid": r, "chars": c or 0, "time_seconds": t or 0,
            "cards": cm or 0, "speed": sp or 0,
            "time_excluded": te or 0, "title": ti}
        for (r, d, c, t, cm, sp, te, ti) in rows
    }


def _sync_rollover_attribution_to(con, game_id, session_date, chars, time_seconds, cards):
    """CLAMP existing rollover attributions for this source_date so the displaced
    chunk never exceeds the (possibly updated) session-row total — never grow it.

    A rollover attribution records a FIXED historical displacement: the chars/time
    that rolled over from this source_date into the previous logical day, captured
    during the rollover window. An import-driven total correction must not enlarge
    that displacement — a 0-displacement row must stay 0, a partial must stay
    partial. Overwriting to the full day's totals (the old behavior) would shove an
    entire day's reading onto the prior day for any non-full displacement.

    The only legitimate adjustment here is to SHRINK a displacement when the new
    total is now smaller than what was displaced — otherwise per-title charts get
    ghost rows (the deduction in _compute_title_core would drive the source row
    negative and the phantom would exceed the real total). Clamp each dimension
    independently to the new total; leave anything already within bounds untouched."""
    new_c = int(chars or 0)
    new_t = float(time_seconds or 0)
    new_cards = int(cards or 0)
    # Clamp only THIS game's attributions on this source_date — the history import
    # updates one game's row, so it must not touch another game's displacement that
    # happens to share the date.
    rows = con.execute(
        "SELECT rollover_date, chars, time_seconds, cards "
        "FROM gsm_rollover_attributions WHERE source_date=? AND game_id=?",
        (session_date, game_id or '')
    ).fetchall()
    for rollover_date, ac, at, acards in rows:
        ac = int(ac or 0); at = float(at or 0); acards = int(acards or 0)
        cc, ct, ccards = min(ac, new_c), min(at, new_t), min(acards, new_cards)
        if cc == ac and abs(ct - at) <= 1e-9 and ccards == acards:
            continue  # already within bounds — don't churn updated_at
        con.execute(
            "UPDATE gsm_rollover_attributions "
            "SET chars=?, time_seconds=?, cards=?, updated_at=? "
            "WHERE rollover_date=? AND source_date=? AND game_id=?",
            (cc, ct, ccards, datetime.now().isoformat(), rollover_date, session_date, game_id or '')
        )


def _sync_game_metadata_from_gsm(con, gsm, game_id):
    """Copy title/description/image/genres from GSM's games table into the
    tracker's gsm_games row. Preserves the user's track / count_as_time prefs.
    Skips silently if the game isn't present in GSM's games table."""
    row = gsm.execute("""
        SELECT COALESCE(NULLIF(obs_scene_name,''),
                        NULLIF(title_original,''),
                        NULLIF(title_english, ''),
                        NULLIF(title_romaji,  ''), id),
               description, image, genres,
               CAST(NULLIF(character_count,'') AS INTEGER)
        FROM games WHERE id=?
    """, (game_id,)).fetchone()
    if not row:
        return
    name, desc, image, genres, char_count = row
    fd_row = gsm.execute(
        "SELECT MIN(date) FROM game_daily_rollup WHERE game_id=?", (game_id,)
    ).fetchone()
    first_date = fd_row[0] if fd_row else None
    con.execute("""
        INSERT INTO gsm_games
          (game_id, game_name, description, image_data, genres, char_count, first_date, last_updated)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(game_id) DO UPDATE SET
          game_name    = excluded.game_name,
          description  = excluded.description,
          image_data   = excluded.image_data,
          genres       = excluded.genres,
          char_count   = excluded.char_count,
          first_date   = excluded.first_date,
          last_updated = excluded.last_updated
    """, (game_id, name or game_id, desc or '', image or '', genres or '[]',
          int(char_count or 0), first_date, datetime.now().isoformat()))


def _resolve_game_title(game_id, fallback):
    """Pick a display title: prefer existing tracker GSM rows, then gsm_games
    metadata, then the fallback from GSM's games table."""
    con = sqlite3.connect(DB_PATH)
    try:
        r = con.execute(
            "SELECT title FROM sessions WHERE source='gsm' AND game_id=? "
            "AND title IS NOT NULL AND title != '' LIMIT 1", (game_id,)
        ).fetchone()
        if r and r[0]:
            return r[0]
        r = con.execute(
            "SELECT game_name FROM gsm_games WHERE game_id=?", (game_id,)
        ).fetchone()
        if r and r[0]:
            return r[0]
    finally:
        con.close()
    return fallback


def import_gsm_history_preview():
    """Show what a full GSM history import would change. Read-only — no writes.

    For each tracked game: compare every game_daily_rollup row in GSM's DB to
    the matching tracker row (by game_id + date). Categorize as insert/update/
    unchanged and report aggregate chars and time deltas.

    Returns: list of per-game dicts, each with:
      {game_id, game_name, count_as_time, n_insert, n_update, n_unchanged,
       chars_before, chars_after, time_before_s, time_after_s}
    """
    games = list_gsm_db_games()
    if not games:
        return []

    tracked = _tracked_games_with_prefs()
    rows = read_gsm_rollup(game_ids=list(tracked.keys()))

    by_game = {}
    for r in rows:
        by_game.setdefault(r["game_id"], []).append(r)

    out = []
    for g in games:
        gid = g["game_id"]
        if gid not in tracked:
            continue
        existing = _tracker_gsm_rows_for(gid)
        rollup = by_game.get(gid, [])

        n_ins = n_upd = n_un = 0
        chars_before = sum(e["chars"] for e in existing.values())
        time_before  = sum(e["time_seconds"] for e in existing.values())
        chars_after = time_after = 0
        seen_dates = set()
        for r in rollup:
            seen_dates.add(r["date"])
            chars_after += r["chars"]
            time_after  += r["time_seconds"]
            e = existing.get(r["date"])
            if e is None:
                n_ins += 1
            elif (e["chars"] != r["chars"]
                  or abs(e["time_seconds"] - r["time_seconds"]) > 0.5):
                # cards excluded — no longer imported, must match apply's check
                n_upd += 1
            else:
                n_un += 1
        # Existing tracker rows for dates not in rollup are left alone —
        # they're still part of the "after" totals.
        for d, e in existing.items():
            if d not in seen_dates:
                chars_after += e["chars"]
                time_after  += e["time_seconds"]

        out.append({
            "game_id":       gid,
            "game_name":     g["game_name"],
            "count_as_time": tracked[gid],
            "n_insert":      n_ins,
            "n_update":      n_upd,
            "n_unchanged":   n_un,
            "chars_before":  chars_before,
            "chars_after":   chars_after,
            "time_before_s": time_before,
            "time_after_s":  time_after,
        })
    out.sort(key=lambda x: x["time_after_s"], reverse=True)
    return out


def import_gsm_history_apply():
    """Reconcile tracker.sessions with GSM's game_daily_rollup for every game
    marked track=1 in gsm_games. UPDATEs preserve time_excluded; INSERTs set it
    from the per-game count_as_time preference.

    Returns: list of per-game dicts {game_id, game_name, inserted, updated}.
    """
    tracked = _tracked_games_with_prefs()
    if not tracked:
        return []

    rows = read_gsm_rollup(game_ids=list(tracked.keys()))
    by_game = {}
    for r in rows:
        by_game.setdefault(r["game_id"], []).append(r)

    games = {g["game_id"]: g for g in list_gsm_db_games()}
    now = datetime.now().isoformat()
    summary = []

    gsm = _open_gsm_db()
    con = sqlite3.connect(DB_PATH)
    try:
        for gid, count_t in tracked.items():
            if gsm is not None:
                try:
                    _sync_game_metadata_from_gsm(con, gsm, gid)
                except Exception as e:
                    print(f"[gsm] metadata sync failed for {gid}: {e}")
            existing = _tracker_gsm_rows_for(gid)
            rollup   = by_game.get(gid, [])
            title    = _resolve_game_title(gid, games.get(gid, {}).get("game_name", gid))
            inserted = updated = 0

            for r in rollup:
                e = existing.get(r["date"])
                speed = _speed_from(r["chars"], r["time_seconds"])
                if e is None:
                    excl = 0 if count_t else 1
                    # cards_mined intentionally written as 0 — cards are no longer
                    # tracked; importing them only created churn and graph husks.
                    con.execute("""
                        INSERT INTO sessions
                          (source, title, activity_type, session_date,
                           chars_read, lines_read, time_seconds, reading_speed,
                           sentences_read, cards_mined, game_id, raw_file,
                           ingested_at, time_excluded)
                        VALUES ('gsm', ?, 'Reading', ?, ?, 0, ?, ?, 0, 0, ?,
                                NULL, ?, ?)
                    """, (title, r["date"], r["chars"], r["time_seconds"],
                          speed, gid, now, excl))
                    inserted += 1
                else:
                    # cards excluded from the change check — we no longer import
                    # them, so a cards-only difference must not trigger a rewrite.
                    if (e["chars"] == r["chars"]
                            and abs(e["time_seconds"] - r["time_seconds"]) <= 0.5):
                        continue
                    if _would_zero_out(r["chars"], r["time_seconds"], e["chars"]):
                        _record_sync_anomaly(
                            con, gid, title, r["date"],
                            e["chars"], e["time_seconds"],
                            r["chars"], r["time_seconds"]
                        )
                        continue
                    con.execute("""
                        UPDATE sessions
                           SET chars_read=?, time_seconds=?, reading_speed=?,
                               cards_mined=0, ingested_at=?
                         WHERE rowid=?
                    """, (r["chars"], r["time_seconds"], speed,
                          now, e["rowid"]))
                    _sync_rollover_attribution_to(
                        con, gid, r["date"],
                        r["chars"], r["time_seconds"], 0
                    )
                    updated += 1

            summary.append({
                "game_id":   gid,
                "game_name": title,
                "inserted":  inserted,
                "updated":   updated,
            })
        con.commit()
    finally:
        con.close()
        if gsm is not None:
            gsm.close()
    return summary


# ── GSM ───────────────────────────────────────────────────────────────────────
def _upsert_gsm_game(cur_stats):
    """Store or refresh game metadata from currentGameStats. Preserves
    user-set track and count_as_time prefs across refreshes."""
    game_id = cur_stats.get("game_id", "")
    if not game_id:
        return
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO gsm_games
          (game_id, game_name, description, image_data, genres, char_count, first_date, last_updated)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(game_id) DO UPDATE SET
          game_name    = excluded.game_name,
          description  = excluded.description,
          image_data   = excluded.image_data,
          genres       = excluded.genres,
          char_count   = excluded.char_count,
          first_date   = excluded.first_date,
          last_updated = excluded.last_updated
    """, (
        game_id,
        cur_stats.get("game_name", "Unknown"),
        cur_stats.get("description", ""),
        cur_stats.get("image", ""),
        json.dumps(cur_stats.get("genres", [])),
        int(cur_stats.get("game_character_count", 0) or 0),
        cur_stats.get("first_date", ""),
        datetime.now().isoformat(),
    ))
    con.commit()
    con.close()


def _upsert_gsm_daily_history(con, game_name, game_id, daily_activity, speed_heatmap):
    """
    Backfill per-day historical sessions for the current game directly into
    the DB — no JSON files, no file-watcher pipeline.
    time_excluded follows gsm_history_include_time setting (default 1 = chars-only).
    Skips today and any date already present for this game.
    """
    if not daily_activity:
        return 0
    today_str = str(date.today())
    today_d   = get_today_date()
    live_keys = {today_str, get_today(), (today_d - timedelta(days=1)).isoformat()}
    include_time = get_setting("gsm_history_include_time", "0") == "1"
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
        excl  = 0 if (date_str in live_keys or include_time) else 1
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
            excl,
        ))
        inserted += 1
    return inserted


def pull_gsm_api_only(url=None):
    """Original /api/stats-based pull. Computes today's time via chars/speed.
    Kept as a fallback for when GSM's local SQLite isn't available, and as a
    safety net we can route back to via the gsm_time_source setting."""
    target = url or GSM_API
    try:
        r = requests.get(target, timeout=5)
        r.raise_for_status()
        data = r.json()

        real_date  = str(date.today())
        today_year = real_date[:4]

        cur       = data.get("currentGameStats") or {}
        game_name = cur.get("game_name", "Unknown game")
        game_id   = cur.get("game_id", "")

        # Store/refresh game metadata (description, cover image, genres)
        if game_id:
            _upsert_gsm_game(cur)

        # Today's characters (keyed by real calendar date in GSM's response)
        today_chars = (data.get("characterActivityData") or {}) \
                          .get(today_year, {}).get(real_date, 0)
        if not today_chars:
            today_chars = cur.get("daily_activity", {}).get(real_date, 0)

        # Today's reading speed from heatmap, fall back to global average
        today_speed = (data.get("readingSpeedHeatmapData") or {}) \
                          .get(today_year, {}).get(real_date, 0)
        if not today_speed:
            today_speed = (data.get("allGamesStats") or {}).get("reading_speed", 0)
        time_seconds = (today_chars / today_speed * 3600) if today_speed > 0 else 0

        # Cards are no longer tracked — stored as 0 (column kept for schema compat).
        today_cards = 0

        # Session is stored at the real calendar date. Rollover bucketing happens at
        # display time via gsm_rollover_attributions (captured below).
        s = {
            "source":        "gsm",
            "activity_type": "Reading",
            "title":         game_name,
            "game_id":       game_id,
            "session_date":  real_date,
            "chars_read":    int(today_chars),
            "lines_read":    0,
            "time_seconds":  float(time_seconds),
            "reading_speed": float(today_speed),
            "cards_mined":   0,
        }

        # One session row PER GAME per real date (matching the
        # sessions(game_id, session_date) unique index). Scoping by game_id is what
        # lets two different games read on the same real date coexist — the old
        # date-only DELETE kept only the last game pulled, which erased an
        # earlier game's session (badly so across the rollover boundary; see CLAUDE.md).
        #
        # Delete-then-insert, in that order: the unique index is what makes a
        # racing second pull collide instead of double-counting (see init_db).
        # This used to round-trip through a JSON file in the sessions folder —
        # written, then immediately read back by ingest_session_file one line
        # later. The file was never consulted again, so the pull now inserts
        # directly. `raw_file` stays NULL, matching the GSM history path.
        con = sqlite3.connect(DB_PATH)
        if game_id:
            con.execute(
                "DELETE FROM sessions WHERE source='gsm' AND session_date=? AND game_id=?",
                (real_date, game_id)
            )
        else:
            con.execute(
                "DELETE FROM sessions WHERE source='gsm' AND session_date=? "
                "AND (game_id IS NULL OR game_id='')",
                (real_date,)
            )
        con.execute("""
            INSERT INTO sessions
              (source,title,activity_type,session_date,chars_read,lines_read,
               time_seconds,reading_speed,sentences_read,cards_mined,game_id,
               raw_file,ingested_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)
        """, (
            s["source"], s["title"], s["activity_type"], s["session_date"],
            s["chars_read"], s["lines_read"], s["time_seconds"],
            s["reading_speed"], 0, s["cards_mined"], s["game_id"],
            datetime.now().isoformat(),
        ))
        con.commit()
        con.close()

        # If we're in the rollover window, snapshot today's GSM totals for attribution to
        # yesterday's bucket. Once the rollover hour passes, future pulls fall through to
        # a guarded tail-settle refresh that can only grow time (not chars) on an existing
        # snapshot — this catches GSM's AFK/tail accumulator updates that flush after the
        # last char arrived, without ever absorbing genuinely new post-rollover reading.
        if in_rollover_window():
            upsert_gsm_attribution(
                rollover_date=get_today(),
                source_date=real_date,
                game_id=game_id,
                chars=int(today_chars),
                time_seconds=float(time_seconds),
                cards=int(today_cards),
            )
        else:
            refresh_gsm_attribution_tail(
                rollover_date=(get_today_date() - timedelta(days=1)).isoformat(),
                source_date=real_date,
                game_id=game_id,
                chars=int(today_chars),
                time_seconds=float(time_seconds),
                cards=int(today_cards),
            )

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


# Day-to-day pulls stay on the original API-based logic: chars/speed-derived
# time is functionally identical to GSM's rollup measurement to within
# floating-point noise, and the API's "skip today" backfill gap self-heals
# the next time a game is opened. The DB-read path is reserved for the
# explicit history import (one-shot, user-triggered) below.
pull_gsm_now = pull_gsm_api_only


# ── ッツ Reader ────────────────────────────────────────────────────────────────
def log_manual_session(activity_type, time_seconds, session_date, client_id=None):
    """Insert a manually timed stopwatch session into the DB.

    `client_id` makes the insert idempotent. It matters because this row has no
    natural key — two separate 30-minute Listening sessions on one day are
    indistinguishable from one logged twice — so any caller that can retry needs
    a way to say "this is the same session I already sent". Two callers can:

      * the extension's stopwatch, retrying after a failed/timed-out POST;
      * the drain loop, replaying an inbox row after a crash landed between the
        INSERT here and its high-water-mark write.

    Both re-send the SAME id, so the second attempt is a no-op rather than a
    duplicate. Omitting it (in-app logging, CSV import) keeps the old behaviour
    exactly: client_id NULL is outside the partial unique index, so those rows
    never collide with each other.

    Returns {"logged": True} — plus "duplicate": True when the key had already
    been stored, so a caller can tell "accepted" from "accepted again".
    """
    if not activity_type:
        return {"error": "activity_type is required"}
    if not session_date:
        session_date = get_today()
    time_secs = float(time_seconds or 0)
    if time_secs <= 0:
        return {"error": "time_seconds must be > 0"}

    key = (str(client_id).strip() or None) if client_id else None

    con = sqlite3.connect(DB_PATH)
    try:
        # The WHERE clause is not optional: a partial unique index requires the
        # conflict target to repeat it (see the index in init_db).
        cur = con.execute("""
            INSERT INTO sessions
              (source, title, activity_type, session_date, time_seconds,
               ingested_at, time_excluded, client_id)
            VALUES (?,?,?,?,?,?,0,?)
            ON CONFLICT(client_id) WHERE client_id IS NOT NULL DO NOTHING
        """, ("manual", None, activity_type, session_date, time_secs,
              datetime.now().isoformat(), key))
        con.commit()
        inserted = cur.rowcount
    finally:
        con.close()

    if key and not inserted:
        return {"logged": True, "duplicate": True}
    return {"logged": True}


def import_ttsu_entries(entries):
    """Insert a list of ッツ Reader stat dicts into the DB. Returns {imported, skipped, titles}.
    Past-dated rows: time_excluded follows ttsu_history_include_time setting (default 1).
    Today: always time_excluded=0."""
    imported    = 0
    skipped     = 0
    titles_seen = set()
    today_d     = get_today_date()
    live_keys   = {get_today(), str(date.today()), (today_d - timedelta(days=1)).isoformat()}
    include_past_time = get_setting("ttsu_history_include_time", "0") == "1"

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

        excl = 0 if (date_key in live_keys or include_past_time) else 1

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
                   SET chars_read=?, time_seconds=?, reading_speed=?, ingested_at=?, time_excluded=?
                 WHERE rowid=?
            """, (chars, time_secs, speed, datetime.now().isoformat(), excl, existing_rowid))
            con.commit()
            con.close()
            imported += 1
            titles_seen.add(title)
            continue

        con.execute("""
            INSERT INTO sessions
              (source, title, activity_type, session_date,
               chars_read, time_seconds, reading_speed, ingested_at, time_excluded)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, ('ttsureader', title, 'Reading', date_key,
              chars, time_secs, speed, datetime.now().isoformat(), excl))
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


# ── YouTube passive tracker ────────────────────────────────────────────────────
_YT_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def import_youtube_day(session_date, time_seconds, client_id=None):
    """Upsert one logical day's passive YouTube listening time, per device.

    The extension accrues a cumulative total per LOGICAL day and re-posts that
    total every couple of minutes, so this is last-write-wins on the row it
    finds. That makes it idempotent: a drain replaying an inbox row rewrites the
    same row with the same total instead of adding a second one — the property
    that makes `import_ttsu_entries` safe to replay and `log_manual_session`
    not.

    `client_id` (`youtube:<device>:<date>`) is what makes that safe with more
    than one machine watching. Keyed on the date alone, a second device's post
    would *overwrite* the first's total rather than add to it — silently, and
    looking exactly like a quiet day. Keyed per device, each machine owns its
    own row and the day's total is their sum, which every aggregate downstream
    already computes by summing rows.

    Absent (older extension builds) it falls back to the date-only key it always
    used, and — importantly — only ever matches a row that is *itself* keyless.
    A keyed row belongs to a device that will keep rewriting it; letting an
    unkeyed post land on it would hand one device's total to another.

    **Adoption.** The first keyed post from a machine that used to post keyless
    claims that date's existing keyless row instead of inserting alongside it.
    Without that, the changeover day would carry two rows for one machine and
    double-count. plans/YOUTUBE-PLAN.md proposed a one-shot backfill migration
    for this; doing it at write time instead needs no guess about which device
    name the old rows belonged to, and is correct whether or not any exist.

    There is deliberately NO monotonic guard. ttsu skips when the incoming total
    is lower, because IndexedDB can report stale values and tabs can race.
    Neither applies here — each device's background script is a single instance
    and the sole authority for its own row — and a guard would reject the one
    thing it must accept: the user's correction lowering the total.

    Rows carry title='YouTube' so all YouTube time pools under one entry, and
    **no game_id**. That column is what makes a row eligible for the GSM
    rollover-attribution and manual_time_adjust rails in CLAUDE.md; leaving it
    NULL is what keeps this source outside those cross-cutting concerns. The
    extension pins the logical date itself, so attribution is never needed.
    """
    session_date = (session_date or "").strip()
    if not _YT_DATE_RE.match(session_date):
        return {"error": "session_date must be YYYY-MM-DD"}

    secs = float(time_seconds or 0)
    if secs <= 0:
        return {"error": "time_seconds must be > 0"}

    key = (client_id or "").strip() or None

    con = sqlite3.connect(DB_PATH)
    try:
        now = datetime.now().isoformat()

        if key:
            # Looked up on the key alone, not (source, key): the partial unique
            # index on client_id is already global, so a second row with this
            # key cannot exist to be missed by a narrower WHERE.
            row = con.execute(
                "SELECT rowid FROM sessions WHERE client_id=?", (key,)
            ).fetchone()
            if not row:
                row = con.execute(
                    "SELECT rowid FROM sessions WHERE source='youtube' "
                    "AND session_date=? AND client_id IS NULL",
                    (session_date,),
                ).fetchone()
                if row:                       # adopt, don't duplicate
                    con.execute(
                        "UPDATE sessions SET client_id=? WHERE rowid=?",
                        (key, row[0]),
                    )
        else:
            row = con.execute(
                "SELECT rowid FROM sessions WHERE source='youtube' "
                "AND session_date=? AND client_id IS NULL",
                (session_date,),
            ).fetchone()

        if row:
            con.execute(
                "UPDATE sessions SET time_seconds=?, ingested_at=? WHERE rowid=?",
                (secs, now, row[0]),
            )
        else:
            con.execute(
                "INSERT INTO sessions "
                "(source, title, activity_type, session_date, time_seconds, "
                " ingested_at, time_excluded, client_id) "
                "VALUES ('youtube','YouTube','Listening',?,?,?,0,?)",
                (session_date, secs, now, key),
            )
        con.commit()
    finally:
        con.close()

    return {"logged": True, "session_date": session_date, "time_seconds": secs}


def import_mangawari_day(title, session_date, time_seconds, client_id=None):
    """Upsert one title's manga reading for one logical day, per device.

    Same shape as `import_youtube_day` — cumulative total, last-write-wins,
    idempotent on a stable reused `client_id` — but keyed per *title* so each
    volume gets its own media entry, and its own cover via `/cover`.

    **Why this exists rather than reusing the ttsu shape.** A manga reader has no
    character count, so it posts `charactersRead: 0`, and `import_ttsu_entries`
    guards its update with `chars <= existing_chars`. With chars pinned at 0 that
    guard trips on every post after the first, so the second sitting of a day is
    skipped and its time never lands. That guard is right for ttsu (IndexedDB can
    report stale values, tabs race) and wrong here: the reader is a single
    instance and the sole authority for its own row, exactly like the YouTube
    background script. So, deliberately, **no monotonic guard** — the incoming
    total replaces whatever is stored, including a correction downward.

    `chars_read` stays 0 and `activity_type` is 'Reading', which is what keeps
    manga hours out of the chars/hour figures: every cph denominator filters on
    `chars_read>0` (see CLAUDE.md, reading-speed invariant). The time still counts
    everywhere else, because `time_excluded` is 0 — a sitting drained a week late
    was read, and dating it correctly is the client's job, already done.

    `client_id` (`mangawari:<device>:<title>:<date>`) is what makes two readers
    safe: keyed on title and date alone, a second device's post would *replace*
    the first's total rather than add to it. Absent, it falls back to the
    keyless (title, date) row and only ever matches a row that is itself keyless,
    so a keyed device's row can never be hijacked by an unkeyed post.

    No `game_id`, like every non-GSM source — that column is what opts a row into
    the rollover-attribution and manual-overlay rails, and this source pins its
    own logical date before posting, so it needs neither.
    """
    title = (title or "").strip()
    if not title:
        return {"error": "title is required"}

    session_date = (session_date or "").strip()
    if not _YT_DATE_RE.match(session_date):
        return {"error": "session_date must be YYYY-MM-DD"}

    secs = float(time_seconds or 0)
    if secs <= 0:
        return {"error": "time_seconds must be > 0"}

    key = (client_id or "").strip() or None

    con = sqlite3.connect(DB_PATH)
    try:
        now = datetime.now().isoformat()

        if key:
            # By key alone: the partial unique index on client_id is global, so
            # a second row carrying this key cannot exist to be missed.
            row = con.execute(
                "SELECT rowid FROM sessions WHERE client_id=?", (key,)
            ).fetchone()
            if not row:
                row = con.execute(
                    "SELECT rowid FROM sessions WHERE source='mangawari' "
                    "AND title=? AND session_date=? AND client_id IS NULL",
                    (title, session_date),
                ).fetchone()
                if row:                       # adopt, don't duplicate
                    con.execute(
                        "UPDATE sessions SET client_id=? WHERE rowid=?",
                        (key, row[0]),
                    )
        else:
            row = con.execute(
                "SELECT rowid FROM sessions WHERE source='mangawari' "
                "AND title=? AND session_date=? AND client_id IS NULL",
                (title, session_date),
            ).fetchone()

        if row:
            con.execute(
                "UPDATE sessions SET time_seconds=?, ingested_at=? WHERE rowid=?",
                (secs, now, row[0]),
            )
        else:
            con.execute(
                "INSERT INTO sessions "
                "(source, title, activity_type, session_date, chars_read, "
                " time_seconds, ingested_at, time_excluded, client_id) "
                "VALUES ('mangawari',?,'Reading',?,0,?,?,0,?)",
                (title, session_date, secs, now, key),
            )
        con.commit()
    finally:
        con.close()

    return {
        "logged": True,
        "title": title,
        "session_date": session_date,
        "time_seconds": secs,
    }


# ── Book-cover downscaling ────────────────────────────────────────────────────
# Covers are never displayed larger than ~250px anywhere in the UI (the media
# grid cards and the 160px detail box). A dropped book cover, though, is stored
# at the file's full resolution — routinely 1500–2560px on the long edge, vs the
# ~400px GSM game covers. The webview then live-downscales that ~10x in a single
# cheap pass, which aliases badly: soft, "low-res"/artifacty covers on the grid,
# while the already-small game covers stay crisp through the identical CSS. We
# fix it at the source: resample big covers down to COVER_MAX_EDGE with a proper
# Lanczos filter before storing, so the browser only has to scale a modest
# amount. Small images pass through untouched (no needless recompression).
#
# Lives here rather than in tracker.py because network-delivered covers need it
# too, and tracker.py already imports from this module (not the reverse).
try:
    from PIL import Image as _CoverImage
    _COVER_PIL_OK = True
except Exception:
    _COVER_PIL_OK = False

COVER_MAX_EDGE = 600  # long-edge cap; 2x+ HiDPI headroom over the largest card

# A cover is a display asset, not data. Anything past this is a client bug or a
# hostile payload, and decoding it would be the expensive way to find out.
COVER_MAX_B64_BYTES = 6 * 1024 * 1024


def _shrink_cover_b64(b64_str):
    """Return (mime, b64) ready for a data URL. Downscales oversized covers with
    Lanczos and re-encodes; passes small/animated images through unchanged. Any
    decode/encode failure (or missing PIL) falls back to the original bytes, so a
    cover upload never breaks over this."""
    raw = base64.b64decode(b64_str)

    def _sniff(b):
        if b[:4] == b'\x89PNG':                       return 'image/png'
        if b[:2] == b'\xff\xd8':                      return 'image/jpeg'
        if b[:6] in (b'GIF87a', b'GIF89a'):           return 'image/gif'
        if b[:4] == b'RIFF' and b[8:12] == b'WEBP':   return 'image/webp'
        return 'image/jpeg'

    if not _COVER_PIL_OK:
        return _sniff(raw), b64_str
    try:
        im = _CoverImage.open(io.BytesIO(raw))
        im.load()
        if getattr(im, 'is_animated', False):
            return _sniff(raw), b64_str               # don't flatten animations
        w, h = im.size
        if max(w, h) <= COVER_MAX_EDGE:
            return _sniff(raw), b64_str               # already display-sized
        scale = COVER_MAX_EDGE / max(w, h)
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                       _CoverImage.LANCZOS)
        has_alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
        buf = io.BytesIO()
        if has_alpha:
            im.convert('RGBA').save(buf, format='PNG', optimize=True)
            mime = 'image/png'
        else:
            im.convert('RGB').save(buf, format='JPEG', quality=88,
                                   optimize=True, progressive=True)
            mime = 'image/jpeg'
        return mime, base64.b64encode(buf.getvalue()).decode('ascii')
    except Exception:
        return _sniff(raw), b64_str


def import_cover(title, cover_b64):
    """Store a network-delivered cover for `title` — **only if none exists**.

    Insert-if-absent, deliberately, unlike `set_book_cover`'s INSERT OR REPLACE.
    A cover the user chose by hand (dropping an image or an EPUB on the media
    entry) outranks whatever a reader app happens to ship, and a client that
    re-sends after a reinstall must not be able to undo that choice. The cost,
    accepted: a wrong cover from a client can only be corrected in the app.

    The client does NOT declare a mime type. `_shrink_cover_b64` may re-encode
    the image — a resized PNG comes back as JPEG — so a client-supplied type
    would be a lie exactly when it mattered. We sniff and use what we produced.

    Note the client cannot ask whether a cover already exists: the always-on
    inbox has no database and cannot answer such a question (see pi/README.md).
    So clients send once per title on their own initiative and this is the only
    thing standing between that and an overwrite.
    """
    title = (title or "").strip()
    if not title:
        return {"error": "title is required"}
    if not cover_b64:
        return {"error": "cover_b64 is required"}
    if len(cover_b64) > COVER_MAX_B64_BYTES:
        return {"error": "cover_b64 exceeds the size limit"}

    con = sqlite3.connect(DB_PATH)
    try:
        # Fast path: don't spend a Lanczos resample on an image we'll discard.
        if con.execute("SELECT 1 FROM book_covers WHERE title=?", (title,)).fetchone():
            return {"stored": False, "existing": True, "title": title}

        try:
            mime, b64_out = _shrink_cover_b64(cover_b64)
        except Exception:
            return {"error": "cover_b64 is not valid base64 image data"}

        # OR IGNORE rather than a second existence check: `title` is the primary
        # key, so this is the atomic form of insert-if-absent and closes the
        # window between the SELECT above and here.
        cur = con.execute(
            "INSERT OR IGNORE INTO book_covers (title, image_data, updated_at) "
            "VALUES (?,?,?)",
            (title, f"data:{mime};base64,{b64_out}", datetime.now().isoformat()),
        )
        con.commit()
        stored = cur.rowcount > 0
    finally:
        con.close()

    return {"stored": stored, "existing": not stored, "title": title}


# ── EPUB extraction ────────────────────────────────────────────────────────────
# Dropping an EPUB on a media entry's cover box fills two display-only fields in
# one go: the cover image (book_covers) and the progress-bar length
# (media_char_counts). Neither touches session/reading data — this only sets how
# long the bar thinks the book is, plus its picture.
#
# The char count mirrors ッツ Reader's counting so it lines up with the
# chars_read numerator the same bar divides against: keep only Japanese-script
# code points (ttu-ebook-reader get-character-count.ts), with two deliberate
# departures —
#   * furigana (<rt>/<rp>) is dropped, not counted as extra reading;
#   * gaiji image-glyphs (ttsu counts each as 1) are invisible to a text scan.
# Both make our total a hair LOWER than ttsu's; immaterial for a progress bar.

# ッツ keeps only this set, stripping everything else before counting. Python's
# re has no \p{...}; Unified_Ideograph / Radical are spelled out as explicit
# ranges (U+F900-FAFF compatibility ideographs omitted — a dozen glyphs that
# never occur in prose).
_TTSU_KEEP = (
    "0-9A-Za-z"                                    # ASCII alnum (source /i keeps a-z)
    "○◯"                                 # ○ ◯
    "々-〇〻"                          # 々 〆 〇 〻
    "ぁ-ゖゝ-ゞ"                   # hiragana ぁ-ゖ, ゝ ゞ
    "ァ-ヺー"                          # katakana ァ-ヺ, ー
    "０-９Ａ-Ｚａ-ｚ"      # fullwidth ０-９ Ａ-Ｚ ａ-ｚ
    "ｦ-ﾝ"                                # halfwidth katakana ｦ-ﾝ
    "⺀-⻳⼀-⿕"                   # CJK radicals   (\p{Radical})
    "㐀-䶿一-鿿"                   # Ext A + URO    (\p{Unified_Ideograph})
    "\U00020000-\U0002EBEF\U00030000-\U000323AF"  # SIP ideograph extensions
)
_TTSU_STRIP_RE = re.compile("[^" + _TTSU_KEEP + "]+")
_HEAD_RE  = re.compile(r"<head\b[^>]*>.*?</head\s*>", re.IGNORECASE | re.DOTALL)
_RUBY_RE  = re.compile(r"<(rt|rp)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_TAG_RE   = re.compile(r"<[^>]+>")
_IMG_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
             "jpe": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
             "svg": "image/svg+xml"}


def _ttsu_clean(xhtml):
    """Rendered text of an XHTML document: head, script/style, ruby and markup
    stripped. Split out from _ttsu_char_count so tools/epub_boundary_check.py can
    break the same text down by character class without re-deriving the pipeline."""
    t = _HEAD_RE.sub("", xhtml)  # <title>/meta aren't rendered text; ttsu ignores them
    t = _STYLE_RE.sub("", t)     # inline <style>/<script> left in the body
    t = _RUBY_RE.sub("", t)      # drop furigana before it collapses into bare text
    t = _TAG_RE.sub("", t)
    return html.unescape(t)


def _ttsu_char_count(xhtml):
    """Japanese-script code points in an XHTML document, ruby + markup removed."""
    return len(_TTSU_STRIP_RE.sub("", _ttsu_clean(xhtml)))


def _epub_attr(tag, name):
    """Value of attribute `name` in an OPF/XHTML start-tag (quote-agnostic)."""
    m = re.search(r'\b' + re.escape(name) + r'\s*=\s*"([^"]*)"', tag, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r"\b" + re.escape(name) + r"\s*=\s*'([^']*)'", tag, re.IGNORECASE)
    return m.group(1) if m else None


def _epub_title(opf):
    """The book's title from the OPF metadata (first <dc:title>), entity-decoded
    and tag-stripped; None if absent. Used to prefill the Add-media form on an
    EPUB import — the user can edit it before committing."""
    m = re.search(r'<dc:title\b[^>]*>(.*?)</dc:title>', opf, re.IGNORECASE | re.DOTALL)
    if not m:
        # Rare: default-namespace <title> inside <metadata>.
        meta = re.search(r'<metadata\b[^>]*>(.*?)</metadata>', opf, re.IGNORECASE | re.DOTALL)
        scope = meta.group(1) if meta else ""
        m = re.search(r'<title\b[^>]*>(.*?)</title>', scope, re.IGNORECASE | re.DOTALL)
    if not m:
        return None
    text = html.unescape(re.sub(r'<[^>]+>', '', m.group(1)))
    text = re.sub(r'\s+', ' ', text).strip()
    return text or None


def _epub_resolve(base_dir, href):
    """Zip path of `href` (relative to `base_dir`), fragment stripped + %xx-decoded."""
    href = unquote(href.split("#")[0])
    if not href:
        return ""
    joined = posixpath.join(base_dir, href) if base_dir else href
    return posixpath.normpath(joined).lstrip("/")


def _first_img_src(doc):
    """src/href of the first <img> or <svg><image> in an XHTML document."""
    m = re.search(r'<img\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']', doc, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r'<image\b[^>]*?(?:xlink:href|href)\s*=\s*["\']([^"\']+)["\']',
                  doc, re.IGNORECASE)
    return m.group(1) if m else None


def _find_epub_cover(zf, names, opf, manifest, spine, opf_dir):
    """Zip path of the cover image, or None. Priority: the image on the first
    spine page ("first page every time"), then EPUB cover metadata, then any
    manifest image."""
    # (a) first image referenced by the first spine document
    if spine:
        href, mtype = manifest[spine[0]]
        if "html" in mtype or href.lower().endswith((".xhtml", ".html", ".htm")):
            path = _epub_resolve(opf_dir, href)
            if path in names:
                try:
                    src = _first_img_src(zf.read(path).decode("utf-8", "replace"))
                except Exception:
                    src = None
                if src:
                    p = _epub_resolve(posixpath.dirname(path), src)
                    if p in names:
                        return p
    # (b) <meta name="cover" content="ITEM_ID">
    for meta in re.finditer(r'<meta\b[^>]*>', opf, re.IGNORECASE):
        if (_epub_attr(meta.group(0), "name") or "").lower() == "cover":
            cid = _epub_attr(meta.group(0), "content")
            if cid and cid in manifest:
                p = _epub_resolve(opf_dir, manifest[cid][0])
                if p in names:
                    return p
            break
    # (c) EPUB3 manifest item flagged properties="cover-image"
    for item in re.finditer(r'<item\b[^>]*>', opf, re.IGNORECASE):
        if "cover-image" in (_epub_attr(item.group(0), "properties") or ""):
            href = _epub_attr(item.group(0), "href")
            p = _epub_resolve(opf_dir, href) if href else ""
            if p in names:
                return p
    # (d) first image in the manifest
    for href, mtype in manifest.values():
        if mtype.startswith("image/") or href.lower().endswith(
                (".jpg", ".jpeg", ".png", ".gif", ".webp")):
            p = _epub_resolve(opf_dir, href)
            if p in names:
                return p
    return None


def _epub_text(s):
    """Entity-decode + tag-strip + whitespace-collapse a TOC label."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s or ""))).strip()


# EPUB2 NCX: each navPoint carries one navLabel/text + one content src, in
# reading order. This pairs them directly, so nesting (parts→chapters) flattens
# to document order without tracking navPoint boundaries.
_NCX_ENTRY_RE = re.compile(
    r'<navLabel\b[^>]*>\s*<text\b[^>]*>(.*?)</text>\s*</navLabel>\s*'
    r'<content\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE | re.DOTALL)


def _epub_toc_entries(zf, names, manifest, opf, opf_dir):
    """Return [(label, doc_path)] for the EPUB's table of contents, in reading
    order. `doc_path` is the fragment-stripped zip path of each entry's target.
    Prefers the NCX (EPUB2 — most robust to parse); falls back to the EPUB3 nav
    document. Entries whose target isn't a real spine document are filtered by
    the caller (via `cum_by_doc`)."""
    # (a) EPUB2 NCX — manifest item with the dtbncx media-type.
    ncx_href = next((href for href, mtype in manifest.values()
                     if mtype == "application/x-dtbncx+xml"), None)
    entries = []
    if ncx_href:
        ncx_path = _epub_resolve(opf_dir, ncx_href)
        ncx_dir = posixpath.dirname(ncx_path)
        if ncx_path in names:
            try:
                ncx = zf.read(ncx_path).decode("utf-8", "replace")
            except Exception:
                ncx = ""
            for m in _NCX_ENTRY_RE.finditer(ncx):
                label, doc = _epub_text(m.group(1)), _epub_resolve(ncx_dir, m.group(2))
                if label and doc:
                    entries.append((label, doc))
    if entries:
        return entries

    # (b) EPUB3 nav document — manifest item flagged properties="nav".
    nav_href = None
    for item in re.finditer(r'<item\b[^>]*>', opf, re.IGNORECASE):
        if "nav" in (_epub_attr(item.group(0), "properties") or "").lower().split():
            nav_href = _epub_attr(item.group(0), "href")
            break
    if nav_href:
        nav_path = _epub_resolve(opf_dir, nav_href)
        nav_dir = posixpath.dirname(nav_path)
        if nav_path in names:
            try:
                nav = zf.read(nav_path).decode("utf-8", "replace")
            except Exception:
                nav = ""
            toc = re.search(
                r'<nav\b[^>]*epub:type\s*=\s*["\'][^"\']*\btoc\b[^"\']*["\'][^>]*>(.*?)</nav>',
                nav, re.IGNORECASE | re.DOTALL)
            scope = toc.group(1) if toc else nav
            for m in re.finditer(
                    r'<a\b[^>]*\bhref\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                    scope, re.IGNORECASE | re.DOTALL):
                label, doc = _epub_text(m.group(2)), _epub_resolve(nav_dir, m.group(1))
                if label and doc:
                    entries.append((label, doc))
    return entries


# Junk trim: a chapter is dropped when its char span is below this fraction of
# the REFERENCE span — a high percentile of chapter spans (not the median, which
# gets dragged into the junk pile when a book has many tiny files). Applied to
# every chapter, so junk between real chapters is caught too.
_EPUB_TRIM_FRAC = 0.15
_EPUB_REF_PCTL  = 0.75


def _percentile(xs, q):
    """Linear-interpolated q-quantile (q in [0, 1]) of xs; 0.0 if empty."""
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    if n == 1:
        return float(s[0])
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    return float(s[lo] + (s[hi] - s[lo]) * (pos - lo))


# Name hints for the pre-check: size alone can't tell a short prologue from a
# same-size character-list, so recognizable section names override the size vote.
# KEEP forces a suggestion even when small; DROP forces off even when large. The
# user's checklist can override either — these just aim the default.
_EPUB_KEEP_RE = re.compile(
    r'^\s*(?:プロローグ|エピローグ|序章|終章|序幕|終幕|幕間|間章|プレリュード|'
    r'prologue|epilogue|interlude|prelude)', re.IGNORECASE)
_EPUB_DROP_RE = re.compile(
    r'^\s*(?:目次|表紙|奥付|挿絵|口絵|扉|カバー|著作権|版権|'
    # Author/translator back matter. Distinct from エピローグ (in KEEP above):
    # an あとがき is commentary about the book, not part of it, and leaving it in
    # holds the progress bar short of 100% for every book that has one.
    r'あとがき|後書き|後書|訳者あとがき|解説|'
    r'cover|contents|table of contents|copyright|colophon|index|acknowledg|'
    r'afterword|about the author|translator)',
    re.IGNORECASE)


def _epub_default_state(name, span, thr):
    """Default state for a candidate: name hints win, else size >= thr.

    Only ever proposes 'chapter' or 'skip'. The third state, 'merge', expresses
    a user intent ("I read this, just don't list it") that no signal in the file
    can distinguish from 'skip' — and both signals we do have (a front/back-matter
    name, a junk-sized span) mean "this isn't part of the text". See
    _epub_finalize for what each state does to the axis."""
    n = (name or "").strip()
    if _EPUB_DROP_RE.match(n):
        return "skip"
    if _EPUB_KEEP_RE.match(n):
        return "chapter"
    return "chapter" if span >= thr else "skip"


def _epub_candidates(toc_entries, cum_by_doc, total):
    """Full ordered candidate list for the import checklist:
    [{name, start_chars, span, default_state}]. `cum_by_doc` maps each counted
    spine-doc path to the cumulative char count at its start; `total` is the
    book's counted char total.

    Candidates are keyed by the *document* a TOC entry targets (first label wins),
    so a multi-chapter file collapses to one entry and an empty cover/TOC page —
    which shares its start offset with the next real chapter — can't steal that
    chapter's name. Each candidate spans from its document to the next candidate's
    (the section it introduces); empty spans (cover images, dup fragments) are
    dropped entirely. `default_state` is the row's starting state: junk is removed
    by size relative to a high percentile of spans (`_EPUB_REF_PCTL`/
    `_EPUB_TRIM_FRAC`, robust to many tiny files), with name hints overriding."""
    first_label = {}
    for label, doc in toc_entries:
        if doc in cum_by_doc and doc not in first_label:
            first_label[doc] = label
    if not first_label:
        return []

    starts = sorted(first_label, key=lambda d: cum_by_doc[d])
    cand = []
    for i, doc in enumerate(starts):
        s = float(cum_by_doc[doc])
        e = float(cum_by_doc[starts[i + 1]]) if i + 1 < len(starts) else float(total)
        if e > s:
            cand.append({"name": first_label[doc], "start_chars": s, "span": e - s})
    if not cand:
        return []

    thr = (_EPUB_TRIM_FRAC * _percentile([c["span"] for c in cand], _EPUB_REF_PCTL)
           if len(cand) >= 3 else 0.0)
    for c in cand:
        c["default_state"] = _epub_default_state(c["name"], c["span"], thr)
    return cand


def _epub_finalize(sections, total):
    """Turn the user's per-section decisions into contiguous milestones over a
    COMPACTED char axis. Returns (milestones, adj_total), where milestones are
    [{name, start_chars, end_chars}] and adj_total is the book's length with the
    skipped text removed.

    `sections` is the full ordered candidate list, each {name, start_chars,
    state}; spans are re-derived from neighbours so callers needn't send them.
    State is one of:

      'chapter' — becomes a milestone
      'merge'   — read, but folded into the preceding chapter (no milestone)
      'skip'    — NOT read: its chars leave the axis and the book length entirely

    Skipping is what keeps chapter boundaries lined up with the reader. A
    skipped section's chars are subtracted from every boundary after it, so
    front matter (目次/表紙/奥付, plus any pre-TOC head gap) no longer displaces
    chapter 1 and everything behind it by a constant, and back matter no longer
    inflates the final chapter and holds the progress bar short of 100%.

    Merged sections keep their chars — they just don't get their own milestone —
    which is why the two end-snaps below are still correct: leading/trailing
    merges genuinely belong to the first/last chapter, and skips have already
    left the axis by the time we get here. Order-independent: sorts by start."""
    secs = sorted(sections or [],
                  key=lambda s: float(s.get("start_chars") or 0))
    if not secs:
        return [], float(total or 0)

    # Walk the sections in order, laying the non-skipped ones down end-to-end on
    # a fresh axis. Chars before the first section belong to no TOC entry (a
    # cover page the TOC never names) and are dropped with the skips — `pos`
    # starts at 0 rather than at secs[0]'s offset.
    pos = 0.0
    placed = []
    for i, c in enumerate(secs):
        start = float(c.get("start_chars") or 0)
        end   = (float(secs[i + 1].get("start_chars") or 0)
                 if i + 1 < len(secs) else float(total or 0))
        span  = max(0.0, end - start)
        state = c.get("state") or "chapter"
        if state == "skip":
            continue
        placed.append({"name": (c.get("name") or "").strip(), "state": state,
                       "start": pos, "end": pos + span})
        pos += span
    adj_total = pos

    chapters = [p for p in placed if p["state"] == "chapter"]
    if not chapters:
        return [], adj_total

    out = []
    for i, p in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else adj_total
        out.append({"name": p["name"], "start_chars": p["start"], "end_chars": end})
    out[0]["start_chars"] = 0.0        # absorb any leading merges
    out[-1]["end_chars"]  = adj_total  # ...and any trailing ones
    return out, adj_total


def extract_epub(zip_bytes):
    """Pull a title + cover image + total Japanese char count out of an EPUB.

    Returns {ok, char_count, title, cover_b64, cover_mime, cover_found} on
    success or {ok: False, error}. Performs NO DB writes — the caller decides
    what to persist and whether to overwrite existing values."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        return {"ok": False, "error": f"Not a valid EPUB (bad zip): {e}"}

    with zf:
        names = set(zf.namelist())
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", "replace")
        except KeyError:
            return {"ok": False, "error": "Not an EPUB (no META-INF/container.xml)."}
        m = re.search(r'<rootfile\b[^>]*\bfull-path\s*=\s*["\']([^"\']+)["\']',
                      container, re.IGNORECASE)
        if not m:
            return {"ok": False, "error": "EPUB container names no OPF rootfile."}
        opf_path = _epub_resolve("", m.group(1))
        opf_dir = posixpath.dirname(opf_path)
        try:
            opf = zf.read(opf_path).decode("utf-8", "replace")
        except KeyError:
            return {"ok": False, "error": f"EPUB OPF missing: {opf_path}"}

        # manifest: id -> (href, media-type)
        manifest = {}
        for item in re.finditer(r'<item\b[^>]*>', opf, re.IGNORECASE):
            tag = item.group(0)
            iid, href = _epub_attr(tag, "id"), _epub_attr(tag, "href")
            if iid and href:
                manifest[iid] = (href, (_epub_attr(tag, "media-type") or "").lower())

        # spine: reading order, restricted to real manifest items
        spine = [_epub_attr(t.group(0), "idref")
                 for t in re.finditer(r'<itemref\b[^>]*>', opf, re.IGNORECASE)]
        spine = [s for s in spine if s in manifest]

        # char count over the spine's content documents. cum_by_doc records the
        # cumulative char total at each document's START, so the TOC can map a
        # chapter's target document to a media-cumulative char position.
        total = 0
        cum_by_doc = {}
        for sid in spine:
            href, mtype = manifest[sid]
            is_doc = ("html" in mtype or "xml" in mtype
                      or href.lower().endswith((".xhtml", ".html", ".htm")))
            if not is_doc:
                continue
            path = _epub_resolve(opf_dir, href)
            if path not in names:
                continue
            cum_by_doc.setdefault(path, total)
            try:
                total += _ttsu_char_count(zf.read(path).decode("utf-8", "replace"))
            except Exception:
                continue

        candidates = _epub_candidates(
            _epub_toc_entries(zf, names, manifest, opf, opf_dir), cum_by_doc, total)

        cover_b64 = cover_mime = None
        cover_path = _find_epub_cover(zf, names, opf, manifest, spine, opf_dir)
        if cover_path and cover_path in names:
            try:
                raw = zf.read(cover_path)
                ext = cover_path.rsplit(".", 1)[-1].lower() if "." in cover_path else ""
                cover_mime = _IMG_MIME.get(ext, "image/jpeg")
                cover_b64 = base64.b64encode(raw).decode("ascii")
            except Exception:
                cover_b64 = cover_mime = None

        return {"ok": True, "char_count": total, "title": _epub_title(opf),
                "cover_b64": cover_b64, "cover_mime": cover_mime,
                "cover_found": cover_b64 is not None,
                "chapter_candidates": candidates}


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
