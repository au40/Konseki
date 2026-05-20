"""
imports.py  —  External data import integrations
Handles GSM (GameSentenceMiner) pulls and ッツ Reader zip imports.
"""

import os
import sqlite3
import json
import zipfile
import io
import requests
from pathlib import Path
from datetime import datetime, date, timedelta
from db import (DB_PATH, SESSIONS_DIR, get_today, get_today_date, _q1,
                ingest_session_file, in_rollover_window, upsert_gsm_attribution,
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
    rows = con.execute(
        "SELECT rollover_date, chars, time_seconds, cards "
        "FROM gsm_rollover_attributions WHERE source_date=?",
        (session_date,)
    ).fetchall()
    for rollover_date, ac, at, acards in rows:
        ac = int(ac or 0); at = float(at or 0); acards = int(acards or 0)
        cc, ct, ccards = min(ac, new_c), min(at, new_t), min(acards, new_cards)
        if cc == ac and abs(ct - at) <= 1e-9 and ccards == acards:
            continue  # already within bounds — don't churn updated_at
        con.execute(
            "UPDATE gsm_rollover_attributions "
            "SET chars=?, time_seconds=?, cards=?, updated_at=? "
            "WHERE rollover_date=? AND source_date=?",
            (cc, ct, ccards, datetime.now().isoformat(), rollover_date, session_date)
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
               description, image, genres
        FROM games WHERE id=?
    """, (game_id,)).fetchone()
    if not row:
        return
    name, desc, image, genres = row
    fd_row = gsm.execute(
        "SELECT MIN(date) FROM game_daily_rollup WHERE game_id=?", (game_id,)
    ).fetchone()
    first_date = fd_row[0] if fd_row else None
    con.execute("""
        INSERT INTO gsm_games
          (game_id, game_name, description, image_data, genres, first_date, last_updated)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(game_id) DO UPDATE SET
          game_name    = excluded.game_name,
          description  = excluded.description,
          image_data   = excluded.image_data,
          genres       = excluded.genres,
          first_date   = excluded.first_date,
          last_updated = excluded.last_updated
    """, (game_id, name or game_id, desc or '', image or '', genres or '[]',
          first_date, datetime.now().isoformat()))


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
          (game_id, game_name, description, image_data, genres, first_date, last_updated)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(game_id) DO UPDATE SET
          game_name    = excluded.game_name,
          description  = excluded.description,
          image_data   = excluded.image_data,
          genres       = excluded.genres,
          first_date   = excluded.first_date,
          last_updated = excluded.last_updated
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

        out = SESSIONS_DIR / f"gsm_{real_date}.json"
        json.dump(s, open(out, "w", encoding="utf-8"), indent=2)

        # Clear old entry so re-pulls always refresh with latest data
        con = sqlite3.connect(DB_PATH)
        con.execute("DELETE FROM ingested_files WHERE filepath=?", (str(out),))
        con.execute(
            "DELETE FROM sessions WHERE source='gsm' AND session_date=?",
            (real_date,)
        )
        con.commit()
        con.close()

        ingest_session_file(str(out))

        # If we're in the rollover window, snapshot today's GSM totals for attribution to
        # yesterday's bucket. Once the rollover hour passes, future pulls fall through to
        # a guarded tail-settle refresh that can only grow time (not chars) on an existing
        # snapshot — this catches GSM's AFK/tail accumulator updates that flush after the
        # last char arrived, without ever absorbing genuinely new post-rollover reading.
        if in_rollover_window():
            upsert_gsm_attribution(
                rollover_date=get_today(),
                source_date=real_date,
                chars=int(today_chars),
                time_seconds=float(time_seconds),
                cards=int(today_cards),
            )
        else:
            refresh_gsm_attribution_tail(
                rollover_date=(get_today_date() - timedelta(days=1)).isoformat(),
                source_date=real_date,
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
