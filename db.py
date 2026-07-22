"""
db.py  —  Database layer for Konseki
All schema setup, settings helpers, ingestion, and query functions.
"""

import sqlite3
import json
import csv
import math
import os
import re
from datetime import datetime, date, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME     = "Konseki"
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

    # Private baselines for the "Total time log" box (Log entry page). These store
    # the user's last-entered external cumulative total so the next entry can log
    # the *difference*. They are NOT stats and no read path consults them — only
    # the computed delta is inserted as a normal manual session. media_key='' is
    # the global bucket; a non-empty key is a per-media baseline.
    con.execute("""
        CREATE TABLE IF NOT EXISTS total_log_baselines (
            media_key  TEXT PRIMARY KEY,
            base_secs  REAL    NOT NULL DEFAULT 0,
            base_chars INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT
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
    # track_chars: for time_seconds goals, also tally chars_read in the same
    # window as a passive companion stat (graded on time, chars shown only).
    if "track_chars" not in goal_cols:
        con.execute("ALTER TABLE goals ADD COLUMN track_chars INTEGER NOT NULL DEFAULT 0")

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
        ("char_count",    "INTEGER NOT NULL DEFAULT 0"),
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
    # the rollover_date instead of source_date. Keyed PER GAME (game_id in the PK):
    # a displacement belongs to the specific game that was being read at pull time,
    # so a *different* game read later on the same real date can't inherit or clobber
    # it. Without game_id, reading game A pre-rollover then game B post-rollover
    # deducted A's displacement off B's row (zeroing B) and stranded A — see the
    # multi-game section of CLAUDE.md.
    con.execute("""
        CREATE TABLE IF NOT EXISTS gsm_rollover_attributions (
            rollover_date TEXT NOT NULL,
            source_date   TEXT NOT NULL,
            game_id       TEXT NOT NULL DEFAULT '',
            chars         INTEGER NOT NULL DEFAULT 0,
            time_seconds  REAL    NOT NULL DEFAULT 0,
            cards         INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT    NOT NULL,
            PRIMARY KEY (rollover_date, source_date, game_id)
        )
    """)

    # Migrate the pre-game_id shape (PK was (rollover_date, source_date)). Rebuild
    # with game_id in the PK, backfilling each old row's game_id from the GSM
    # session row that lived on its source_date. Under the old model there was one
    # GSM row per real date (the pull path delete-then-inserted by date alone), so
    # that lookup is unambiguous for historical data; rows with no surviving source
    # row backfill to '' and behave exactly as before (game-agnostic net-per-day
    # math is unchanged by the added column).
    attr_cols = [r[1] for r in con.execute("PRAGMA table_info(gsm_rollover_attributions)").fetchall()]
    if "game_id" not in attr_cols:
        con.execute("""
            CREATE TABLE gsm_rollover_attributions_new (
                rollover_date TEXT NOT NULL,
                source_date   TEXT NOT NULL,
                game_id       TEXT NOT NULL DEFAULT '',
                chars         INTEGER NOT NULL DEFAULT 0,
                time_seconds  REAL    NOT NULL DEFAULT 0,
                cards         INTEGER NOT NULL DEFAULT 0,
                updated_at    TEXT    NOT NULL,
                PRIMARY KEY (rollover_date, source_date, game_id)
            )
        """)
        con.execute("""
            INSERT INTO gsm_rollover_attributions_new
              (rollover_date, source_date, game_id, chars, time_seconds, cards, updated_at)
            SELECT a.rollover_date, a.source_date,
                   COALESCE((SELECT s.game_id FROM sessions s
                             WHERE s.source='gsm' AND s.session_date=a.source_date
                               AND s.game_id IS NOT NULL AND s.game_id<>''
                             ORDER BY s.ingested_at DESC LIMIT 1), ''),
                   a.chars, a.time_seconds, a.cards, a.updated_at
            FROM gsm_rollover_attributions a
        """)
        con.execute("DROP TABLE gsm_rollover_attributions")
        con.execute("ALTER TABLE gsm_rollover_attributions_new "
                    "RENAME TO gsm_rollover_attributions")

    # Manual time correction overlay, keyed by (DISPLAY date, game_id). secs_delta
    # is signed; negative shaves dead/AFK time GSM stranded on a specific game that
    # day. Applied at read time alongside GSM rollover attribution (see CLAUDE.md),
    # so it survives GSM re-ingests that rewrite the underlying session rows. The
    # first cut of this table was day-level (PRIMARY KEY (date), no game_id); drop
    # that obsolete shape so the per-game schema below takes effect (the feature is
    # new — any early test value is simply re-entered via the per-game UI).
    if con.execute("SELECT name FROM sqlite_master WHERE type='table' "
                   "AND name='manual_time_adjust'").fetchone():
        mta_cols = [r[1] for r in con.execute("PRAGMA table_info(manual_time_adjust)")]
        if "game_id" not in mta_cols:
            con.execute("DROP TABLE manual_time_adjust")
    con.execute("""
        CREATE TABLE IF NOT EXISTS manual_time_adjust (
            date        TEXT NOT NULL,
            game_id     TEXT NOT NULL,
            secs_delta  REAL NOT NULL DEFAULT 0,
            note        TEXT,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (date, game_id)
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
        CREATE TABLE IF NOT EXISTS dev_notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            body       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 0
        )
    """)
    dev_cols = [r[1] for r in con.execute("PRAGMA table_info(dev_notes)").fetchall()]
    if "importance" not in dev_cols:
        con.execute("ALTER TABLE dev_notes ADD COLUMN importance INTEGER NOT NULL DEFAULT 0")

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

    # Per-milestone display color (hex). Added late; backfilled from the palette
    # by position so existing milestones get distinct defaults on next list.
    milestone_cols = [r[1] for r in con.execute("PRAGMA table_info(milestones)").fetchall()]
    if "color" not in milestone_cols:
        con.execute("ALTER TABLE milestones ADD COLUMN color TEXT")

    # Manual ordering of media-grid cards. key = "t:<title>" for individual
    # titles, "s:<series_id>" for series stacks. Items not present fall back
    # to the default sort (series first, then titles by total_secs DESC).
    con.execute("""
        CREATE TABLE IF NOT EXISTS media_card_order (
            key        TEXT PRIMARY KEY,
            position   INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Media entries the user has declared finished ("Complete game"): presence
    # of a row = complete. Keyed by title like title_aliases/book_covers so it
    # survives GSM re-ingests (which churn session rows but keep titles). It is
    # a display-only flag — the completion bar's denominator becomes the chars
    # actually read instead of GSM's game length, pinning the bar at 100%.
    con.execute("""
        CREATE TABLE IF NOT EXISTS media_completions (
            title        TEXT PRIMARY KEY,
            completed_at TEXT NOT NULL
        )
    """)

    # User-entered total length in characters, for media GSM has no length for
    # (books, manual media) — powers the same completion bar as gsm_games
    # .char_count. When both exist the user's value wins (it's their
    # correction). Same title-keyed, display-only pattern as media_completions.
    con.execute("""
        CREATE TABLE IF NOT EXISTS media_char_counts (
            title      TEXT PRIMARY KEY,
            char_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    # Enforce the GSM invariant at the DB level: exactly one GSM session row per
    # (game_id, session_date). The pull path is delete-then-insert and assumes
    # this, but pull_gsm_now() has callers outside the WAL handler's _pull_lock
    # (startup pull, tray "Pull GSM Now", JS Api.pull_gsm), so two pulls can race
    # — both DELETE today's row, then both INSERT — and leave a duplicate. This
    # partial unique index makes the second insert collide instead, so a race
    # silently keeps one row rather than double-counting the day. Partial (WHERE
    # source='gsm') so manual/ttsu rows with NULL game_id are unaffected.
    con.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_gsm_one_row_per_day
            ON sessions(game_id, session_date) WHERE source='gsm'
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

# ── Total-time-log baselines ──────────────────────────────────────────────────
# Private logging aid for the "Total time log" box; see init_db. Never read by a
# stats query — only used to diff the user's externally-entered cumulative total.
def get_total_log_baseline(media_key=""):
    r = _q1(
        "SELECT base_secs, base_chars, updated_at FROM total_log_baselines WHERE media_key=?",
        media_key or "",
    ) if Path(DB_PATH).exists() else None
    if not r:
        return None
    return {"base_secs": r[0], "base_chars": int(r[1] or 0), "updated_at": r[2]}

def set_total_log_baseline(media_key, base_secs, base_chars):
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT OR REPLACE INTO total_log_baselines (media_key, base_secs, base_chars, updated_at) "
        "VALUES (?,?,?,?)",
        (media_key or "", float(base_secs or 0), int(base_chars or 0), datetime.now().isoformat()),
    )
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


def upsert_gsm_attribution(rollover_date, source_date, game_id, chars, time_seconds, cards):
    """Record (or refresh) chars/time/cards from GSM source_date that should display under rollover_date.
    Keyed per game so a later pull of a *different* game on the same source_date can't
    overwrite this displacement. Called only when pulling during the rollover window."""
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO gsm_rollover_attributions
          (rollover_date, source_date, game_id, chars, time_seconds, cards, updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(rollover_date, source_date, game_id) DO UPDATE SET
          chars=excluded.chars,
          time_seconds=excluded.time_seconds,
          cards=excluded.cards,
          updated_at=excluded.updated_at
    """, (rollover_date, source_date, game_id or '', int(chars), float(time_seconds),
          int(cards), datetime.now().isoformat()))
    con.commit()
    con.close()


def refresh_gsm_attribution_tail(rollover_date, source_date, game_id, chars, time_seconds, cards):
    """Tail-settle refresh of an EXISTING attribution row, used when a post-rollover
    settle pull finds GSM has flushed additional tail time for pre-rollover reading.

    Matched per game: only the row for THIS game_id is refreshed. A post-rollover
    pull of a different game finds no matching row and no-ops (its reading correctly
    stays on today), so it can't graft the prior game's displacement onto itself.

    Guard: chars must not exceed what's already stored. If they grew, real new
    reading has happened post-rollover and the snapshot must not absorb it.
    Returns True if the row was refreshed, False otherwise."""
    con = sqlite3.connect(DB_PATH)
    row = con.execute(
        "SELECT chars, time_seconds, cards FROM gsm_rollover_attributions "
        "WHERE rollover_date=? AND source_date=? AND game_id=?",
        (rollover_date, source_date, game_id or ''),
    ).fetchone()
    if row is None:
        con.close()
        return False
    if int(chars) > row[0]:
        con.close()
        return False
    con.execute(
        "UPDATE gsm_rollover_attributions SET time_seconds=?, cards=?, updated_at=? "
        "WHERE rollover_date=? AND source_date=? AND game_id=?",
        (float(time_seconds), int(cards), datetime.now().isoformat(),
         rollover_date, source_date, game_id or ''),
    )
    con.commit()
    con.close()
    return True


def get_rollover_attribution(game_id, source_date):
    """Current rollover displacement moving this GSM game's reading from source_date
    to the previous logical day (source_date - 1). Returns {chars, minutes} — the
    amount currently shown on the previous day (0/0 if none). Backs the per-row
    rollover-edit control."""
    roll = (date.fromisoformat(source_date) - timedelta(days=1)).isoformat()
    r = _q1("SELECT chars, time_seconds FROM gsm_rollover_attributions "
            "WHERE rollover_date=? AND source_date=? AND game_id=?",
            roll, source_date, game_id or '')
    if not r:
        return {"chars": 0, "minutes": 0}
    return {"chars": int(r[0] or 0), "minutes": round(float(r[1] or 0) / 60.0, 2)}


def set_rollover_attribution(game_id, source_date, chars, minutes):
    """Manually set how much of a GSM game's reading on source_date belongs to the
    previous logical day (source_date - 1) — the rollover displacement. This is the
    same row the live pull captures automatically during the rollover window; the
    control exists for cases it missed (app closed at the rollover hour, or data
    corrected after the fact).

    Clamped to the row's own raw totals so a displacement never exceeds what was
    read (mirrors the _sync_rollover_attribution_to invariant). Setting both to 0
    clears the displacement (deletes the row). Returns the applied {chars, minutes}."""
    gid   = game_id or ''
    roll  = (date.fromisoformat(source_date) - timedelta(days=1)).isoformat()
    chars = max(0, int(chars or 0))
    secs  = max(0.0, float(minutes or 0) * 60.0)
    # Clamp to the raw session totals when the source row exists (the attribution is
    # an overlay and never mutates sessions, so chars_read is the true ceiling).
    row = _q1("SELECT chars_read, time_seconds FROM sessions "
              "WHERE source='gsm' AND game_id=? AND session_date=?", gid, source_date)
    if row:
        chars = min(chars, int(row[0] or 0))
        secs  = min(secs, float(row[1] or 0))
    con = sqlite3.connect(DB_PATH)
    if chars <= 0 and secs <= 0:
        con.execute("DELETE FROM gsm_rollover_attributions "
                    "WHERE rollover_date=? AND source_date=? AND game_id=?",
                    (roll, source_date, gid))
    else:
        con.execute("""
            INSERT INTO gsm_rollover_attributions
              (rollover_date, source_date, game_id, chars, time_seconds, cards, updated_at)
            VALUES (?,?,?,?,?,0,?)
            ON CONFLICT(rollover_date, source_date, game_id) DO UPDATE SET
              chars=excluded.chars, time_seconds=excluded.time_seconds,
              cards=excluded.cards, updated_at=excluded.updated_at
        """, (roll, source_date, gid, chars, secs, datetime.now().isoformat()))
    con.commit()
    con.close()
    return {"chars": chars, "minutes": round(secs / 60.0, 2)}


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
    man = con.execute(
        "SELECT COALESCE(SUM(secs_delta),0) FROM manual_time_adjust WHERE date=?", (d,)
    ).fetchone()
    con.close()
    man_secs = float(man[0]) if man else 0.0
    return (add[0] - sub[0], add[1] - sub[1] + man_secs, add[2] - sub[2])


def get_gsm_day_adjustments():
    """Batch form of get_gsm_day_adjustment: {date: (chars, time_seconds, cards)}
    net adjustment for every date a GSM rollover displacement touches.

    One table scan instead of two queries per day. The per-day form opens a
    fresh SQLite connection on each call, so any loop over a date range (the
    Stats "All" range loops over every calendar day of history, several times
    over) churned thousands of connections — the dominant cost there. The math
    is identical: each displacement row (rollover_date<>source_date) ADDS its
    chars/time/cards to rollover_date and SUBTRACTS them from source_date,
    exactly mirroring get_gsm_day_adjustment's add/sub split. Dates absent from
    the returned dict have a zero adjustment; callers default with
    `adj.get(d, (0, 0, 0))`."""
    con  = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT rollover_date, source_date, chars, time_seconds, cards "
        "FROM gsm_rollover_attributions WHERE rollover_date<>source_date"
    ).fetchall()
    con.close()
    adj = {}
    for rd, sd, ch, sec, cd in rows:
        c, s, k = adj.get(rd, (0, 0, 0))
        adj[rd] = (c + ch, s + sec, k + cd)
        c, s, k = adj.get(sd, (0, 0, 0))
        adj[sd] = (c - ch, s - sec, k - cd)
    # Fold in the manual overlay (summed across games per date) so every
    # net-per-day consumer picks it up for free (this helper is the chokepoint —
    # see CLAUDE.md). Manual edits only touch time, never chars/cards.
    for d, secs in get_manual_time_adjusts_by_day().items():
        c, s, k = adj.get(d, (0, 0, 0))
        adj[d] = (c, s + secs, k)
    return adj


def get_manual_time_adjusts_by_day():
    """{date: summed secs_delta} across all games — the day-level rollup used by
    net-per-day consumers (aggregates don't care which game was shaved)."""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT date, COALESCE(SUM(secs_delta),0) FROM manual_time_adjust "
        "WHERE secs_delta <> 0 GROUP BY date"
    ).fetchall()
    con.close()
    return {d: s for d, s in rows}


def get_manual_time_adjusts_all():
    """{(date, game_id): secs_delta} for every live override — used by the per-row
    paths to shave the specific game's row rather than draining in order."""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT date, game_id, secs_delta FROM manual_time_adjust WHERE secs_delta <> 0"
    ).fetchall()
    con.close()
    return {(d, g): s for d, g, s in rows}


def get_manual_time_adjusts_for_date(d):
    """{game_id: secs_delta} for one display date (for the dashboard row indicator)."""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT game_id, secs_delta FROM manual_time_adjust WHERE date=? AND secs_delta<>0",
        (d,)
    ).fetchall()
    con.close()
    return {g: s for g, s in rows}


def get_manual_time_adjust(d, game_id):
    """Signed secs_delta for one (date, game_id) (0 if none)."""
    con = sqlite3.connect(DB_PATH)
    row = con.execute(
        "SELECT secs_delta FROM manual_time_adjust WHERE date=? AND game_id=?",
        (d, game_id)
    ).fetchone()
    con.close()
    return float(row[0]) if row else 0.0


def set_manual_time_adjust(d, game_id, secs_delta, note=None):
    """Upsert a manual per-game time adjustment. secs_delta is signed seconds.
    A zero delta deletes the row so the table only holds live overrides."""
    con = sqlite3.connect(DB_PATH)
    if not secs_delta:
        con.execute("DELETE FROM manual_time_adjust WHERE date=? AND game_id=?",
                    (d, game_id))
    else:
        con.execute("""
            INSERT INTO manual_time_adjust (date, game_id, secs_delta, note, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(date, game_id) DO UPDATE SET
              secs_delta=excluded.secs_delta,
              note=excluded.note,
              updated_at=excluded.updated_at
        """, (d, game_id, float(secs_delta), note, datetime.now().isoformat()))
    con.commit()
    con.close()


def _manual_secs_sum(since=None):
    """Total signed manual time delta over [since, ∞) (all-time if since is None).
    Used to keep reading-speed denominators and the all-time total consistent with
    the per-day overlay applied everywhere else."""
    con = sqlite3.connect(DB_PATH)
    if since:
        row = con.execute(
            "SELECT COALESCE(SUM(secs_delta),0) FROM manual_time_adjust WHERE date>=?",
            (since,)).fetchone()
    else:
        row = con.execute(
            "SELECT COALESCE(SUM(secs_delta),0) FROM manual_time_adjust").fetchone()
    con.close()
    return float(row[0]) if row else 0.0


def get_manual_secs_by_title():
    """{title: summed secs_delta} for per-title TOTALS (media grid, top titles).

    Only the manual overlay matters for an all-time title total: GSM rollover
    attribution merely relabels which day a game's time displays on — both ends of
    a displacement belong to the same title, so it nets to zero across the title's
    own days. A manual shave is a true reduction, so it must be subtracted. Maps
    each shave's game_id to its title via the game's sessions (one title per game)."""
    rows = _q(
        "SELECT s.title, COALESCE(SUM(m.secs_delta),0) "
        "FROM manual_time_adjust m "
        "JOIN (SELECT game_id, MAX(title) AS title FROM sessions "
        "      WHERE source='gsm' AND game_id IS NOT NULL GROUP BY game_id) s "
        "  ON s.game_id = m.game_id "
        "WHERE m.secs_delta <> 0 GROUP BY s.title"
    )
    return {t: s for t, s in rows}


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

def create_manual_media(title, atype, minutes, session_date, chars=0):
    """Create a hand-added media entry. Same shape as insert_manual_session but with
    source='manual_media' so the title surfaces on the media grid — quick-log
    source='manual' rows are deliberately hidden there (see get_media_stats and the
    grid filter in ui.js). A title is required (an untitled media card is meaningless)."""
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        INSERT INTO sessions
          (source,title,activity_type,session_date,chars_read,lines_read,time_seconds,ingested_at)
        VALUES (?,?,?,?,?,?,?,?)
    """, ("manual_media", title, atype, session_date, int(chars or 0), 0,
          minutes * 60, datetime.now().isoformat()))
    con.commit()
    con.close()

def update_manual_session(session_id, atype, minutes, title, session_date, chars=0):
    """Edit an existing hand-entered row in place. Guarded to the manual sources so
    GSM/ttsu/anki rows (which are re-ingested, not hand-edited) can't be clobbered.
    'manual_media' is included so an Add Media seed row stays editable via the pencil.
    Returns the number of rows changed (0 = id missing or not a manual entry)."""
    con = sqlite3.connect(DB_PATH)
    cur = con.execute("""
        UPDATE sessions
        SET activity_type=?, title=?, session_date=?, chars_read=?, time_seconds=?
        WHERE id=? AND source IN ('manual','manual_media')
    """, (atype, title or "", session_date, int(chars or 0), float(minutes) * 60, int(session_id)))
    con.commit()
    changed = cur.rowcount
    con.close()
    return changed

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
        SELECT id,source,title,activity_type,chars_read,lines_read,time_seconds,session_date,game_id
        FROM sessions WHERE session_date IN ({placeholders})
          AND (time_excluded IS NULL OR time_excluded=0)
        ORDER BY session_date DESC, ingested_at DESC
    """, *bucket)

    # Outgoing attributions per (source_date, game_id): chars leaving a bucket date
    # toward a date outside. Keyed per game so each displacement is deducted from
    # the SAME game's row on its OWN source_date — a different game read on that
    # date (e.g. post-rollover) keeps its full total instead of eating this shave.
    out_rows = _q(
        f"SELECT source_date, game_id, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE source_date IN ({placeholders}) "
        f"AND rollover_date NOT IN ({placeholders}) GROUP BY source_date, game_id",
        *bucket, *bucket
    )
    out_by = {(sd, gid): (c, s) for sd, gid, c, s in out_rows}
    deducted_for = set()   # (source_date, game_id) already deducted

    result = []
    for r in rows:
        rid, src, title, atype, chars, lines, secs, sd, gid = r
        key = (sd, gid)
        if src == 'gsm' and key not in deducted_for and key in out_by:
            oc, os_ = out_by[key]
            if oc or os_:
                chars = max(0, chars - int(oc))
                secs  = max(0, secs - float(os_))
                deducted_for.add(key)
        # Drop sessions whose displayed values are all zero (e.g. fully attributed-away GSM rows)
        if chars == 0 and secs == 0 and (lines or 0) == 0:
            continue
        result.append((rid, src, title, atype, chars, lines, secs, gid, sd))

    # Incoming attributions: chars coming from outside the bucket → add phantom rows,
    # per (source_date, game_id) so each phantom borrows the title of the SPECIFIC
    # game it displaced (not whichever game happens to sort first on that date).
    in_rows = _q(
        f"SELECT source_date, game_id, SUM(chars), SUM(time_seconds) "
        f"FROM gsm_rollover_attributions WHERE rollover_date IN ({placeholders}) "
        f"AND source_date NOT IN ({placeholders}) GROUP BY source_date, game_id",
        *bucket, *bucket
    )
    for sd, gid, ch, sec in in_rows:
        if (ch or 0) > 0 or (sec or 0) > 0:
            game_row = _q1(
                "SELECT title FROM sessions WHERE source='gsm' AND session_date=? AND game_id=? "
                "ORDER BY ingested_at DESC LIMIT 1", sd, gid
            )
            game_name = (game_row[0] if game_row and game_row[0] else 'GSM')
            # sd=None: phantom rows aren't a logical-day-native row, so they're
            # lowest priority for the manual shave below.
            result.append((None, 'gsm', game_name, 'Reading', int(ch or 0), 0, float(sec or 0), gid, None))

    # Manual overlay: shave secs off the SPECIFIC game's row(s) for this display
    # date, so the right game absorbs the dead time (the user picks which). Tracked
    # per game so multiple rows of one game across the rollover bucket share its
    # budget; max(0,…) floors over-subtraction.
    #
    # Priority: shave the row whose session_date IS the logical day (today) first,
    # so a shave set on day D lands on D's own row — not on a post-midnight session
    # that merged into D's bucket during the rollover window. This mirrors
    # get_recent_sessions (History), keeping the dashboard and History consistent.
    rem_by_game = {g: -s for g, s in get_manual_time_adjusts_for_date(today).items() if s < 0}
    if rem_by_game:
        for i in sorted(range(len(result)), key=lambda i: 0 if result[i][8] == today else 1):
            rid, src, title, atype, chars, lines, secs, gid, sd = result[i]
            rem = rem_by_game.get(gid, 0)
            if src == 'gsm' and rem > 0 and secs > 0:
                take = min(secs, rem)
                secs -= take
                rem_by_game[gid] = rem - take
                result[i] = (rid, src, title, atype, chars, lines, secs, gid, sd)

    # Keep session_date as the trailing element: the dashboard needs each real
    # row's true source_date to target the rollover-edit control (phantom rows carry
    # sd=None and get no control). Drop rows zeroed by the shave.
    return [(rid, src, title, atype, chars, lines, secs, gid, sd)
            for (rid, src, title, atype, chars, lines, secs, gid, sd) in result
            if not (chars == 0 and secs == 0 and (lines or 0) == 0)]

def get_weekly_summary():
    days = [(get_today_date() - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    con  = sqlite3.connect(DB_PATH)
    adj  = get_gsm_day_adjustments()
    out  = []
    for d in days:
        chars, secs = con.execute(
            "SELECT COALESCE(SUM(chars_read),0), "
            "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0) "
            "FROM sessions WHERE session_date=?", (d,)).fetchone()
        adj_c, adj_t, _ = adj.get(d, (0, 0, 0))
        out.append((d, max(0, chars + adj_c), max(0, secs + adj_t)))
    con.close()
    return out

def get_all_time_totals():
    chars, lines, secs, days = _q1("""
        SELECT COALESCE(SUM(chars_read),0), COALESCE(SUM(lines_read),0),
               COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0),
               COUNT(DISTINCT CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN session_date END)
        FROM sessions
    """)
    # GSM rollover attribution nets to zero over all-time (both endpoints are in
    # range), so it's ignored here — but the manual overlay is a TRUE reduction
    # and must be applied or the dashboard all-time total drifts from the daily
    # views (see CLAUDE.md). chars/days are unaffected (only time is shaved).
    return (chars, lines, max(0, secs + _manual_secs_sum()), days)

def get_range_totals(n):
    """(chars, secs, active_days) over the range, GSM-attribution-adjusted.
    Raw per-date sums mis-count at the window's lower edge (time displaced
    across the `since` boundary) and leak rollover-window future-dated rows;
    _adjusted_day_totals reconciles both and clamps to logical today."""
    since = None if n is None else (get_today_date() - timedelta(days=n - 1)).isoformat()
    tot = _adjusted_day_totals(since)
    chars = sum(c for c, s in tot.values())
    secs  = sum(s for c, s in tot.values())
    active = sum(1 for c, s in tot.values() if s > 0 or c > 0)
    return (chars, secs, active)

def get_recent_sessions(limit=30):
    # Mirrors get_today_stats attribution handling, but generalized across every date
    # in the history window: deduct outgoing attributions from the first GSM row on
    # each date, drop fully-zeroed rows, and synthesize phantom rows for incoming
    # attributions. Over-fetch raw to absorb drops before slicing to `limit`.
    raw = _q("""
        SELECT id,session_date,source,title,activity_type,chars_read,lines_read,time_seconds,game_id
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
        f"SELECT source_date, game_id, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE source_date IN ({placeholders}) "
        f"AND rollover_date <> source_date GROUP BY source_date, game_id",
        *dates
    )
    out_by = {(sd, gid): (c, s) for sd, gid, c, s in out_rows}

    # Pull incoming attributions that touch our window from either side, so phantom-only
    # rollover dates (where the source row was fully attributed away) still appear.
    # Keyed per (source_date, game_id) so each phantom carries its own game's title.
    in_rows = _q(
        f"SELECT rollover_date, source_date, game_id, COALESCE(SUM(chars),0), COALESCE(SUM(time_seconds),0) "
        f"FROM gsm_rollover_attributions WHERE rollover_date <> source_date "
        f"AND (source_date IN ({placeholders}) OR rollover_date IN ({placeholders})) "
        f"GROUP BY rollover_date, source_date, game_id",
        *dates, *dates
    )
    in_by_date = {}
    for rd, sd, gid, ch, sec in in_rows:
        in_by_date.setdefault(rd, []).append((sd, gid, ch, sec))

    all_dates = sorted(set(by_date.keys()) | set(in_by_date.keys()), reverse=True)
    manual = get_manual_time_adjusts_all()   # {(date, game_id): secs_delta}

    result = []
    for d in all_dates:
        deducted = set()   # game_ids already deducted on this date
        day_rows = []
        for r in by_date.get(d, []):
            rid, sd, src, title, atype, chars, lines, secs, gid = r
            key = (sd, gid)
            if src == 'gsm' and gid not in deducted and key in out_by:
                oc, os_ = out_by[key]
                if oc or os_:
                    chars = max(0, chars - int(oc))
                    secs  = max(0, secs  - float(os_))
                    deducted.add(gid)
            if chars == 0 and secs == 0 and (lines or 0) == 0:
                continue
            day_rows.append((rid, sd, src, title, atype, chars, lines, secs, gid))

        for sd2, gid, ch, sec in in_by_date.get(d, []):
            if (ch or 0) <= 0 and (sec or 0) <= 0:
                continue
            game_row = _q1(
                "SELECT title FROM sessions WHERE source='gsm' AND session_date=? AND game_id=? "
                "ORDER BY ingested_at DESC LIMIT 1", sd2, gid
            )
            game_name = (game_row[0] if game_row and game_row[0] else 'GSM')
            day_rows.append((None, d, 'gsm', game_name, 'Reading', int(ch or 0), 0, float(sec or 0), gid))

        # Manual overlay for display date d — shave secs off the SPECIFIC game's
        # row(s), keeping History consistent with the per-game dashboard edit.
        rem_by_game = {g: -s for (dd, g), s in manual.items() if dd == d and s < 0}
        if rem_by_game:
            shaved = []
            for rid, sd, src, title, atype, chars, lines, secs, gid in day_rows:
                rem = rem_by_game.get(gid, 0)
                if src == 'gsm' and rem > 0 and secs > 0:
                    take = min(secs, rem)
                    secs -= take
                    rem_by_game[gid] = rem - take
                if chars == 0 and secs == 0 and (lines or 0) == 0:
                    continue
                shaved.append((rid, sd, src, title, atype, chars, lines, secs, gid))
            day_rows = shaved

        result.extend(day_rows)

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
    adj   = get_gsm_day_adjustments()
    out = []
    for i in range(total_days):
        d = (earliest + timedelta(days=i)).isoformat()
        adj_c, adj_t, _ = adj.get(d, (0, 0, 0))
        out.append((d,
                    max(0, secs.get(d, 0) + adj_t),
                    max(0, chars.get(d, 0) + adj_c)))
    return out

def get_daily_activity_series(days):
    """Per-day time_seconds split by activity_type, GSM-adjustment-aware.

    Parallel to get_daily_time_series (same window, same dense date range, same
    clamping-by-loop-bound) but keeps the activity dimension so the Stats bars
    can stack by type. GSM rows are always activity_type='Reading', so the net
    per-day overlay (rollover attribution + manual shave) folds entirely into the
    Reading slice — identical rule to get_activity_breakdown (see CLAUDE.md).
    Returns a list of (date, {activity_type: secs}); days with no activity carry
    an empty dict so the series stays dense and aligned with get_daily_time_series.
    """
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
        "SELECT session_date, COALESCE(activity_type,'Other'), "
        "COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0) "
        "FROM sessions WHERE session_date>=? GROUP BY session_date, COALESCE(activity_type,'Other')",
        earliest.isoformat()
    )
    by_day = {}
    for d, t, s in rows:
        by_day.setdefault(d, {})[t] = s
    adj = get_gsm_day_adjustments()
    out = []
    for i in range(total_days):
        d     = (earliest + timedelta(days=i)).isoformat()
        types = dict(by_day.get(d, {}))
        adj_t = adj.get(d, (0, 0, 0))[1]
        if adj_t:
            types["Reading"] = max(0, types.get("Reading", 0) + adj_t)
        out.append((d, {k: v for k, v in types.items() if v > 0}))
    return out

def get_daily_reading_speed_basis(days):
    """Per-day (chars, secs) for reading speed, on the *exact* basis the backend
    cph uses (get_extra_stats / get_range_extra_stats): Reading sessions with a
    tracked char count (`chars_read>0 AND time_seconds>0`), with the manual time
    overlay folded into secs. The Stats-page brush recomputes cph client-side
    over a sub-window; summing these per-day values and dividing makes it agree
    with the preset ranges by construction (full span == 'All'), instead of
    reconstructing it from the daily activity slice — which counts chars-less
    reading and time_excluded rows on a different basis than the backend and so
    drifts. Keyed by session_date over the same dense window as
    get_daily_time_series; returns {date: (chars, secs)}."""
    if days is None:
        row = _q1("SELECT MIN(session_date) FROM sessions")
        if not row or not row[0]:
            return {}
        earliest = datetime.strptime(row[0], "%Y-%m-%d").date()
    else:
        earliest = get_today_date() - timedelta(days=days - 1)
    since = earliest.isoformat()
    rows = _q(
        "SELECT session_date, COALESCE(SUM(chars_read),0), COALESCE(SUM(time_seconds),0) "
        "FROM sessions WHERE session_date>=? AND activity_type='Reading' "
        "AND time_seconds>0 AND chars_read>0 GROUP BY session_date",
        since
    )
    out = {d: [c, s] for d, c, s in rows}
    # Fold the manual time overlay into secs — same as the backend cph denominator
    # (_manual_secs_sum). Keyed by display date; over the full span it sums to the
    # same total the preset uses, so the brush stays exact.
    for d, secs in get_manual_time_adjusts_by_day().items():
        if d >= since:
            out.setdefault(d, [0, 0])[1] += secs
    return {d: (c, s) for d, (c, s) in out.items()}

def get_activity_breakdown(n=None):
    """Time per activity_type over the range, GSM-attribution-adjusted.

    Windowed and clamped to logical today (see window_bounds). GSM rows are
    always activity_type='Reading', so the net rollover time displacement that
    crosses the window edges folds entirely into the Reading slice — keeping
    the donut consistent with the windowed totals (see CLAUDE.md)."""
    since, today = window_bounds(n)
    where  = "WHERE (time_excluded IS NULL OR time_excluded=0) AND session_date<=?"
    params = [today]
    if since:
        where += " AND session_date>=?"
        params.append(since)
    rows = _q(f"""
        SELECT COALESCE(activity_type,'Other'), COALESCE(SUM(time_seconds),0)
        FROM sessions {where}
        GROUP BY COALESCE(activity_type,'Other')
    """, *params)
    totals = {r[0]: r[1] for r in rows}

    # Net GSM rollover time displacement across the window, applied to 'Reading'.
    # Candidate dates = every rollover_date and source_date inside the window;
    # internal displacements (both ends in-window) net to zero, edge crossings
    # add/subtract — mirrors the per-day pattern in _adjusted_day_totals.
    # Candidate dates = every displacement endpoint AND every manual-overlay date
    # (a manual shave on a day with no displacement still has to fold into the
    # Reading slice). adj.get(d)[1] already bundles attribution + manual, so a
    # deduped candidate set counts each date once with no double-count.
    att = _q(
        "SELECT rollover_date AS d FROM gsm_rollover_attributions WHERE rollover_date<>source_date "
        "UNION SELECT source_date FROM gsm_rollover_attributions WHERE rollover_date<>source_date "
        "UNION SELECT date FROM manual_time_adjust WHERE secs_delta<>0"
    )
    adj = get_gsm_day_adjustments()
    gsm_delta = 0.0
    for (d,) in att:
        if d > today or (since and d < since):
            continue
        gsm_delta += adj.get(d, (0, 0, 0))[1]
    if gsm_delta:
        totals["Reading"] = max(0, totals.get("Reading", 0) + gsm_delta)

    return sorted(((k, v) for k, v in totals.items() if v > 0),
                  key=lambda kv: kv[1], reverse=True)

def get_streak():
    # Active day = a logical day with non-excluded time after GSM attribution.
    # Raw DISTINCT session_date misses a day whose only activity is GSM time
    # that landed on a different calendar date during the rollover window.
    active = [d for d, s in _adjusted_day_secs().items() if s > 0]
    if not active:
        return 0, 0
    active_set = set(active)
    sd  = sorted(datetime.strptime(d, "%Y-%m-%d").date() for d in active)
    cur = 0
    chk = get_today_date()
    # Grace for an unlogged "today": today isn't a broken day until it's over, so
    # don't reset the streak just because nothing's been logged yet — start the
    # trailing count from yesterday. (Once today is logged it extends normally.)
    if chk.isoformat() not in active_set:
        chk -= timedelta(days=1)
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
    man = get_manual_secs_by_title()
    # Fetch all titles (not LIMIT-ed in SQL): the manual shave can reorder the top
    # set, so apply it, then sort and slice. Hours derived from adjusted secs.
    rows = _q(
        "SELECT COALESCE(NULLIF(title,''),activity_type,'Untitled') t, "
        "COALESCE(SUM(time_seconds),0) FROM sessions GROUP BY t"
    )
    adjusted = []
    for t, secs in rows:
        secs = max(0, secs + man.get(t, 0))
        if secs > 0:
            adjusted.append((aliases.get(t, t), secs / 3600.0))
    adjusted.sort(key=lambda kv: kv[1], reverse=True)
    return adjusted[:limit]


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
    # Net per-day overlay (attribution + manual) from the shared chokepoint, so
    # this path can never drift from the daily/weekly views (see CLAUDE.md).
    adj = get_gsm_day_adjustments()
    out = {}
    for d in set(base) | set(adj):
        if d < earliest:
            continue
        secs = max(0, base.get(d, 0) + adj.get(d, (0, 0, 0))[1])
        if secs > 0:
            out[d] = secs
    return out


# ── Media stats ───────────────────────────────────────────────────────────────
def get_media_titles():
    """Lightweight title list for the manual-log media dropdown (no cover images).
    Ordered most-used first. Manual entries logged against an existing title merge
    into that media's card by `title`, so the dropdown stores the original title and
    only labels with the alias."""
    rows = _q("""
        SELECT s.title, COALESCE(SUM(s.time_seconds), 0) AS secs
        FROM sessions s
        WHERE s.title IS NOT NULL AND s.title != ''
        GROUP BY s.title
        ORDER BY secs DESC
    """)
    aliases = _get_aliases()
    return [{"title": r[0], "display_title": aliases.get(r[0], r[0])} for r in rows]

def get_media_stats():
    rows = _q("""
        SELECT
            s.title                          AS t,
            -- Prefer a real media source over 'manual': a title is only treated as
            -- manual (and hidden from the media grid) if EVERY row is manual. Without
            -- this, MAX() picks 'manual' over 'gsm' alphabetically, so logging a manual
            -- entry against an existing game/book would hide its card.
            COALESCE(MAX(CASE WHEN s.source <> 'manual' THEN s.source END), 'manual') AS source,
            MAX(s.activity_type)             AS activity_type,
            COALESCE(SUM(s.time_seconds), 0) AS total_secs,
            COALESCE(SUM(s.chars_read),  0)  AS total_chars,
            COUNT(*)                         AS session_count,
            MAX(s.session_date)              AS last_date,
            MIN(s.session_date)              AS first_date,
            COALESCE(MAX(b.image_data), MAX(g.image_data)) AS image_data,
            MAX(mc.completed_at)             AS completed_at
        FROM sessions s
        LEFT JOIN gsm_games   g ON s.title = g.game_name
        LEFT JOIN book_covers b ON s.title = b.title
        LEFT JOIN media_completions mc ON s.title = mc.title
        WHERE s.title IS NOT NULL AND s.title != ''
        GROUP BY s.title
        ORDER BY total_secs DESC
    """)
    aliases = _get_aliases()
    man = get_manual_secs_by_title()   # true reduction; attribution nets to zero per title
    return [
        {
            "title":         r[0],
            "display_title": aliases.get(r[0], r[0]),
            "source":        r[1],
            "activity_type": r[2],
            "total_secs":    max(0, r[3] + man.get(r[0], 0)),
            "total_chars":   r[4],
            "session_count": r[5],
            "last_date":     r[6],
            "first_date":    r[7],
            "image":         r[8] or "",
            "completed":     bool(r[9]),
        }
        for r in rows
    ]

def db_get_media_card_order():
    rows = _q("SELECT key, position FROM media_card_order ORDER BY position ASC")
    return {r[0]: r[1] for r in rows}

def db_set_media_card_order(ordered_keys):
    now = datetime.now().isoformat()
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM media_card_order")
    con.executemany(
        "INSERT INTO media_card_order (key, position, updated_at) VALUES (?, ?, ?)",
        [(k, i, now) for i, k in enumerate(ordered_keys)],
    )
    con.commit()
    con.close()

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
def _adjusted_day_totals(since=None):
    """{date: (adj_chars, adj_secs)} applying GSM rollover attribution.

    Net-adjustment-per-day pattern (see CLAUDE.md): a logical day's GSM
    chars/time are split across two calendar session_dates during the rollover
    window, so the raw per-day sum is wrong. Mirrors get_daily_time_series:
    secs exclude time_excluded rows, chars include all rows (time_excluded
    suppresses overlap time, not chars). Candidate dates include attribution
    rollover_dates so a fully-displaced day still appears; clamped to logical
    today so rollover-window future-dated rows don't leak."""
    _, today = window_bounds()
    where, params = "", []
    if since:
        where = "WHERE session_date>=?"
        params.append(since)
    rows = _q(
        f"SELECT session_date, "
        f"COALESCE(SUM(CASE WHEN time_excluded=0 OR time_excluded IS NULL THEN time_seconds ELSE 0 END),0), "
        f"COALESCE(SUM(chars_read),0) "
        f"FROM sessions {where} GROUP BY session_date", *params
    )
    raw = {r[0]: (r[2], r[1]) for r in rows}  # date -> (chars, secs)
    att = _q(
        "SELECT DISTINCT rollover_date FROM gsm_rollover_attributions "
        "WHERE rollover_date<>source_date" + (" AND rollover_date>=?" if since else ""),
        *([since] if since else [])
    )
    adj = get_gsm_day_adjustments()
    out = {}
    for d in set(raw) | {r[0] for r in att}:
        if d > today:
            continue
        rc, rs = raw.get(d, (0, 0))
        adj_c, adj_t, _ = adj.get(d, (0, 0, 0))
        out[d] = (max(0, rc + adj_c), max(0, rs + adj_t))
    return out


def _adjusted_day_secs(since=None):
    return {d: s for d, (c, s) in _adjusted_day_totals(since).items()}


def _best_day(secs):
    """(date, secs) of the max day, given a {date: adjusted_secs} map."""
    best = None
    for d, s in secs.items():
        if best is None or s > best[1]:
            best = (d, s)
    return best


def _best_week(secs):
    """(week_start_str, secs) of the best Mon-anchored ISO week, given a
    {date: adjusted_secs} map. Mirrors get_weekly_summary's attribution
    handling; the raw GROUP BY session_date version under-counts/misattributes
    during the rollover window exactly like _best_day did."""
    week_totals = {}
    for d, s in secs.items():
        dt = datetime.strptime(d, "%Y-%m-%d").date()
        wk = dt - timedelta(days=dt.weekday())
        week_totals[wk] = week_totals.get(wk, 0) + s
    if not week_totals:
        return None, 0
    best_wk = max(week_totals, key=week_totals.get)
    return str(best_wk), week_totals[best_wk]


def get_extra_stats():
    secs = _adjusted_day_secs()
    best_day = _best_day(secs)
    reading = _q1(
        "SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
        "WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0"
    )
    # cph denominator uses manual-adjusted reading time so it matches the page's
    # adjusted "Total time" and the dashboard's cph (see CLAUDE.md, reading-speed).
    chars_per_hour = 0
    if reading and reading[1] and reading[1] > 0:
        r_secs = max(0, reading[1] + _manual_secs_sum())
        chars_per_hour = int((reading[0] or 0) / r_secs * 3600) if r_secs > 0 else 0

    unique_titles = (_q1(
        "SELECT COUNT(DISTINCT NULLIF(title,'')) FROM sessions"
    ) or (0,))[0] or 0

    first = (_q1("SELECT MIN(session_date) FROM sessions") or (None,))[0]
    consistency = 0
    total_tracked_days = 0
    if first:
        total_tracked_days = (get_today_date() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1
        active_days = sum(1 for s in secs.values() if s > 0)
        # Don't count an unlogged "today" against consistency: it's an in-progress
        # day, not a missed one, so drop it from the denominator until it's logged.
        denom = total_tracked_days
        if secs.get(get_today_date().isoformat(), 0) <= 0 and denom > 1:
            denom -= 1
        consistency = round(active_days / denom * 100, 1) if denom > 0 else 0

    longest_session = (_q1(
        "SELECT MAX(time_seconds) FROM sessions WHERE (time_excluded IS NULL OR time_excluded=0)"
    ) or (0,))[0] or 0
    _, longest_streak = get_streak()

    total_chars = (_q1("SELECT COALESCE(SUM(chars_read),0) FROM sessions") or (0,))[0]

    best_week_start, best_week_secs = _best_week(secs)

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
    secs = _adjusted_day_secs(since)
    best_day = _best_day(secs)
    best_week_start, best_week_secs = _best_week(secs)
    active_days = sum(1 for s in secs.values() if s > 0)

    if since:
        reading = _q1(
            f"SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
            f"WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0 "
            f"AND session_date>=?", since
        )
        window = n
    else:
        reading = _q1(
            f"SELECT SUM(chars_read), SUM(time_seconds) FROM sessions "
            f"WHERE activity_type='Reading' AND time_seconds>0 AND chars_read>0"
        )
        first = (_q1("SELECT MIN(session_date) FROM sessions") or (None,))[0]
        window = (get_today_date() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1 if first else 1

    chars_per_hour = 0
    if reading and reading[1] and reading[1] > 0:
        r_secs = max(0, reading[1] + _manual_secs_sum(since))
        chars_per_hour = int((reading[0] or 0) / r_secs * 3600) if r_secs > 0 else 0

    # The window always ends at logical today (window_bounds); an unlogged today is
    # in-progress, not a missed day, so drop it from the consistency denominator
    # until it's logged. window_days follows so the "N/Md active" sub-label matches.
    if secs.get(today, 0) <= 0 and window > 1:
        window -= 1
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
        "SELECT id,label,metric,target_value,deadline,chunk_period,activity_type,start_date,user_finished,track_chars "
        "FROM goals ORDER BY deadline"
    )
    return [
        {"id": r[0], "label": r[1], "metric": r[2], "target": r[3],
         "deadline": r[4], "chunk_period": r[5], "activity_type": r[6], "start_date": r[7],
         "user_finished": bool(r[8]), "track_chars": bool(r[9])}
        for r in rows
    ]

def _valid_goal_start(start_date, deadline):
    """Normalize an optional backdated start: empty → today, else validate
    YYYY-MM-DD and require it not after the deadline (ISO strings compare)."""
    start = (start_date or "").strip()
    if not start:
        return get_today()
    datetime.strptime(start, "%Y-%m-%d")
    if start > deadline:
        raise ValueError("Start date must be on or before the deadline")
    return start

def db_add_goal(label, metric, target, deadline, chunk_period="daily", activity_type=None, track_chars=False, start_date=None):
    if metric not in SAFE_METRICS:
        raise ValueError(f"Invalid metric: {metric}")
    start = _valid_goal_start(start_date, deadline)
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT INTO goals "
        "(label,metric,target_value,deadline,chunk_period,activity_type,start_date,created_at,track_chars) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (label, metric, float(target), deadline, chunk_period,
         activity_type or None, start, datetime.now().isoformat(),
         1 if track_chars else 0)
    )
    con.commit()
    con.close()

def db_update_goal(goal_id, label, target, deadline, activity_type, track_chars=False, start_date=None):
    sets   = "label=?, target_value=?, deadline=?, activity_type=?, track_chars=?"
    params = [label, float(target), deadline, activity_type or None, 1 if track_chars else 0]
    if start_date:
        sets += ", start_date=?"
        params.append(_valid_goal_start(start_date, deadline))
    params.append(int(goal_id))
    con = sqlite3.connect(DB_PATH)
    con.execute(f"UPDATE goals SET {sets} WHERE id=?", params)
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
    adj       = get_gsm_day_adjustments()

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

        # GSM rollover attribution applies to Reading goals (and untyped goals,
        # since GSM is always 'Reading'). Net per-day adjustment summed over a
        # date range; mirrors the daily/weekly series pattern in CLAUDE.md.
        apply_attr = (not g["activity_type"]) or g["activity_type"] == "Reading"
        metric_key = g["metric"]
        def _sum_adj(start_d_, end_d_, mkey=None):
            mk = mkey or metric_key
            if not apply_attr:
                return 0.0
            total = 0.0
            cur = start_d_
            while cur <= end_d_:
                ac, at, ak = adj.get(cur.strftime("%Y-%m-%d"), (0, 0, 0))
                total += {"chars_read": ac, "time_seconds": at, "cards_mined": ak}.get(mk, 0)
                cur += timedelta(days=1)
            return total

        # Companion chars: passive char tally for time-graded goals (track_chars).
        # Same date window/activity filter as the goal; never affects pacing.
        want_chars = (g["metric"] == "time_seconds" and g.get("track_chars"))

        where_parts = ["session_date >= ?", "session_date <= ?"]
        params      = [g["start_date"], count_up_to]
        if g["activity_type"]:
            where_parts.append("activity_type=?")
            params.append(g["activity_type"])

        sql       = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(where_parts)}"
        completed = (_q1(sql, *params) or (0,))[0] or 0.0
        count_up_to_d = min(today_d, deadline_d)
        if start_d <= count_up_to_d:
            completed = max(0.0, completed + _sum_adj(start_d, count_up_to_d))

        today_where  = ["session_date=?"] + (["activity_type=?"] if g["activity_type"] else [])
        today_params = [today_str] + ([g["activity_type"]] if g["activity_type"] else [])
        today_sql    = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(today_where)}"
        today_completed = (_q1(today_sql, *today_params) or (0,))[0] or 0.0

        # Apply GSM rollover attribution to today's number (GSM is always 'Reading')
        if (not g["activity_type"]) or g["activity_type"] == "Reading":
            adj_c, adj_t, adj_cards = adj.get(today_str, (0, 0, 0))
            metric_adj = {"chars_read": adj_c, "time_seconds": adj_t, "cards_mined": adj_cards}.get(g["metric"], 0)
            today_completed = max(0.0, today_completed + metric_adj)

        # Weekly period: clamp start to goal start, end to min(sunday, deadline)
        week_cal_start = today_d - timedelta(days=today_d.weekday())
        week_cal_end   = week_cal_start + timedelta(days=6)
        week_start_d   = max(week_cal_start, start_d)
        week_end_d     = min(week_cal_end, deadline_d)
        week_period_days = max(1, (week_end_d - week_start_d).days + 1)
        week_day_index   = max(1, min(week_period_days, (today_d - week_start_d).days + 1))
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
        month_day_index   = max(1, min(month_period_days, (today_d - month_start_d).days + 1))
        month_sum_end_d   = min(month_end_d, today_d)
        month_start_str   = month_start_d.strftime("%Y-%m-%d")
        month_sum_end_str = month_sum_end_d.strftime("%Y-%m-%d")
        month_where       = ["session_date>=?", "session_date<=?"] + (["activity_type=?"] if g["activity_type"] else [])
        month_params      = [month_start_str, month_sum_end_str] + ([g["activity_type"]] if g["activity_type"] else [])
        month_sql         = f"SELECT COALESCE(SUM({g['metric']}),0) FROM sessions WHERE {' AND '.join(month_where)}"
        month_completed   = (_q1(month_sql, *month_params) or (0,))[0] or 0.0

        # GSM rollover attribution: per-day deltas for Reading goals (and untyped goals)
        if week_start_d <= week_sum_end_d:
            week_completed = max(0.0, week_completed + _sum_adj(week_start_d, week_sum_end_d))
        if month_start_d <= month_sum_end_d:
            month_completed = max(0.0, month_completed + _sum_adj(month_start_d, month_sum_end_d))

        # Companion chars: reuse each period's WHERE clause but SUM(chars_read),
        # and apply the chars component of the rollover adjustment. Passive only.
        chars_completed = chars_today = chars_week = chars_month = 0.0
        if want_chars:
            def _chars_sum(where, prms):
                sql = f"SELECT COALESCE(SUM(chars_read),0) FROM sessions WHERE {' AND '.join(where)}"
                return (_q1(sql, *prms) or (0,))[0] or 0.0
            chars_completed = _chars_sum(where_parts, params)
            chars_today     = _chars_sum(today_where, today_params)
            chars_week      = _chars_sum(week_where, week_params)
            chars_month     = _chars_sum(month_where, month_params)
            if start_d <= count_up_to_d:
                chars_completed = max(0.0, chars_completed + _sum_adj(start_d, count_up_to_d, "chars_read"))
            adj_c, _, _ = adj.get(today_str, (0, 0, 0)) if apply_attr else (0, 0, 0)
            chars_today = max(0.0, chars_today + (adj_c if apply_attr else 0))
            if week_start_d <= week_sum_end_d:
                chars_week = max(0.0, chars_week + _sum_adj(week_start_d, week_sum_end_d, "chars_read"))
            if month_start_d <= month_sum_end_d:
                chars_month = max(0.0, chars_month + _sum_adj(month_start_d, month_sum_end_d, "chars_read"))

        remaining = max(0.0, g["target"] - completed)
        # Unclamped so overshoot (>100%) is visible in the displayed number;
        # the UI clamps the bar fill width separately to keep it inside the track.
        pct       = round(completed / g["target"] * 100, 1) if g["target"] > 0 else 0.0

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

        # Projected finish date at the observed average pace (completed ÷ days
        # elapsed since start, today inclusive). ceil(target/pace) is the
        # 1-based day index on which the cumulative total reaches the target,
        # so start + (that − 1) days is the projected date. Only meaningful
        # while the goal is live (past-deadline goals stop counting) and has
        # any progress to extrapolate from.
        projected_end        = None
        projected_days_delta = None
        if remaining > 0 and completed > 0 and start_d <= today_d <= deadline_d:
            pace = completed / max(1, (today_d - start_d).days + 1)
            if pace > 0:
                proj_d = start_d + timedelta(days=math.ceil(g["target"] / pace) - 1)
                projected_end        = proj_d.strftime("%Y-%m-%d")
                projected_days_delta = (proj_d - deadline_d).days

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
            "week_day_index":    week_day_index,
            "month_day_index":   month_day_index,
            "chars_completed":   chars_completed,
            "chars_today":       chars_today,
            "chars_week":        chars_week,
            "chars_month":       chars_month,
            "projected_end":        projected_end,
            "projected_days_delta": projected_days_delta,
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


# ── Dev notes ─────────────────────────────────────────────────────────────────
# importance: 0 = none (grey), 1 = medium (yellow), 2 = high (red)
def db_get_dev_notes():
    rows = _q("SELECT id, body, created_at, importance FROM dev_notes ORDER BY id DESC")
    return [{"id": r[0], "body": r[1], "created_at": r[2], "importance": r[3]} for r in rows]

def db_add_dev_note(body):
    body = (body or "").strip()
    if not body:
        return
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "INSERT INTO dev_notes (body, created_at) VALUES (?,?)",
        (body, datetime.now().isoformat())
    )
    con.commit()
    con.close()

def db_set_dev_note_importance(note_id, importance):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE dev_notes SET importance=? WHERE id=?",
                (max(0, min(2, int(importance))), int(note_id)))
    con.commit()
    con.close()

def db_delete_dev_note(note_id):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM dev_notes WHERE id=?", (int(note_id),))
    con.commit()
    con.close()


# ── Media completion ──────────────────────────────────────────────────────────
def db_set_media_complete(title, complete):
    """Mark a media entry finished, or clear the mark. Display-only flag: the
    completion bar pins at 100% (its denominator becomes the chars actually
    read, so milestone percentages re-derive against the finished total). No
    session data is touched, so toggling is always safe to undo."""
    con = sqlite3.connect(DB_PATH)
    if complete:
        con.execute(
            "INSERT OR REPLACE INTO media_completions (title, completed_at) VALUES (?, ?)",
            (title, datetime.now().isoformat()),
        )
    else:
        con.execute("DELETE FROM media_completions WHERE title=?", (title,))
    con.commit()
    con.close()
    return {"ok": True, "completed": bool(complete)}


def db_set_media_char_count(title, char_count):
    """Set the user-entered total length (chars) powering a media entry's
    completion bar; <= 0 clears it (removing the bar for non-GSM media).
    Display-only, like the completion flag — no session data involved."""
    n = int(char_count or 0)
    con = sqlite3.connect(DB_PATH)
    if n > 0:
        con.execute(
            "INSERT OR REPLACE INTO media_char_counts (title, char_count, updated_at) VALUES (?, ?, ?)",
            (title, n, datetime.now().isoformat()),
        )
    else:
        con.execute("DELETE FROM media_char_counts WHERE title=?", (title,))
    con.commit()
    con.close()
    return {"ok": True, "char_count": n}


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
            "SELECT game_id, description, image_data, genres, first_date, char_count "
            "FROM gsm_games WHERE game_name=?", title
        )
        if gm:
            game_meta = {
                "game_id":    gm[0],
                "desc":       gm[1] or "",
                "image":      gm[2] or "",
                "genres":     json.loads(gm[3]) if gm[3] else [],
                "first_date": gm[4] or "",
                "char_count": int(gm[5] or 0),
            }

    book_cover = _q1("SELECT image_data FROM book_covers WHERE title=?", title)
    if book_cover and book_cover[0]:
        if game_meta:
            game_meta["image"] = book_cover[0]
        else:
            game_meta = {"game_id": None, "desc": "", "image": book_cover[0], "genres": [], "first_date": "", "char_count": 0}

    # Attribution deduction is keyed per (source_date, game_id): only THIS title's
    # own games can displace its rows, and only onto/off the matching game's row.
    # (A different game read on the same real date carries its own attribution row,
    # which must not be deducted from this title.)
    title_games = {s[10] for s in sessions if s[2] == 'gsm' and s[10]}
    out_by = {}   # (source_date, game_id) -> [chars, secs, cards]
    in_by_rd  = {}
    gsm_sds = [s[1] for s in sessions if s[2] == 'gsm']
    if gsm_sds and title_games:
        ph  = ",".join("?" * len(gsm_sds))
        gph = ",".join("?" * len(title_games))
        attr_rows = _q(
            f"SELECT rollover_date, source_date, game_id, chars, time_seconds, cards "
            f"FROM gsm_rollover_attributions "
            f"WHERE source_date IN ({ph}) AND game_id IN ({gph}) "
            f"AND rollover_date <> source_date",
            *gsm_sds, *title_games
        )
        for rd, sd, gid, c, t, cards in attr_rows:
            k = (sd, gid)
            out_by.setdefault(k, [0, 0, 0])
            out_by[k][0] += c; out_by[k][1] += t; out_by[k][2] += cards
            in_by_rd.setdefault(rd, []).append((sd, gid, c, t, cards))

    daily_map = {}
    def _bump(d, chars, secs, cards, sentences):
        v = daily_map.setdefault(d, {"chars": 0, "secs": 0, "cards": 0, "sentences": 0})
        v["chars"]     += chars
        v["secs"]      += secs
        v["cards"]     += cards
        v["sentences"] += sentences

    for s in sessions:
        sd = s[1]
        chars, secs = s[4], s[6]
        cards = s[8] or 0
        sentences = s[9] or 0
        k = (sd, s[10])
        if s[2] == 'gsm' and k in out_by:
            oc, ot, ocards = out_by[k]
            chars = max(0, chars - oc)
            secs  = max(0.0, secs - ot)
            cards = max(0, cards - ocards)
        if chars > 0 or secs > 0 or cards > 0:
            _bump(sd, chars, secs, cards, sentences)

    for rd, attrs in in_by_rd.items():
        for sd, gid, c, t, cards in attrs:
            if c <= 0 and t <= 0 and cards <= 0:
                continue
            _bump(rd, int(c), float(t), int(cards), 0)

    # Manual per-game time overlay: shave dead/AFK time off this title's games on
    # the same chars/time the rest of the app uses, so the media-panel reading-speed
    # graph (and avg) recompute correctly. Keyed by (display date, game_id); deduct
    # secs only — chars stay, so speed rises. Rides the same rails as the attribution
    # deduction above (daily_map is keyed by display date, matching the manual key).
    # title_games computed above (shared with the attribution filter).
    if title_games:
        for (d, g), delta in get_manual_time_adjusts_all().items():
            if g in title_games and delta < 0 and d in daily_map:
                daily_map[d]["secs"] = max(0.0, daily_map[d]["secs"] + delta)

    # Total cards counts EVERY day's cards, even fully-displaced days that get
    # dropped below — the cards were mined reading this title, so they belong in
    # the title total regardless of which logical day the chars landed on.
    total_cards = sum(int(v["cards"]) for v in daily_map.values())

    # Per-day speed derived from post-attribution chars/time (Method A).
    # Using stored `reading_speed` directly would lie any time the attribution
    # deduction had different chars/time ratios than the row it modified — the
    # row's reading_speed describes the pre-deduction blend, not the remainder.
    #
    # Drop days fully displaced by rollover attribution (0 chars AND ~0 secs):
    # all their reading moved to another logical day, so emitting a 0/0 point
    # would leave an empty gap on the reading graphs. This can happen when the
    # attribution moved a day's whole chars/time but not its mined cards (cards
    # stay on the original date), leaving a cards-only husk. Mirrors
    # get_today_stats' all-zero-row drop.
    daily = []
    for d in sorted(daily_map.keys()):
        v = daily_map[d]
        if v["chars"] == 0 and v["secs"] < 1.0:
            continue
        spd = (v["chars"] / (v["secs"] / 3600)) if v["secs"] > 0 and v["chars"] > 0 else 0
        daily.append({
            "date":      d,
            "chars":     int(v["chars"]),
            "seconds":   v["secs"],
            "speed":     spd,
            "cards":     int(v["cards"]),
            "sentences": int(v["sentences"]),
        })

    completion = _q1("SELECT completed_at FROM media_completions WHERE title=?", title)
    user_cc    = _q1("SELECT char_count FROM media_char_counts WHERE title=?", title)

    total_chars = sum(d["chars"]   for d in daily)
    total_secs  = sum(d["seconds"] for d in daily)
    avg_speed   = (total_chars / (total_secs / 3600)) if total_secs > 0 and total_chars > 0 else 0
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
        "game_char_count": game_meta.get("char_count", 0) if game_meta else 0,
        "user_char_count": int(user_cc[0]) if user_cc else 0,
        "completed":     bool(completion),
        "completed_at":  completion[0] if completion else "",
    }


def _attach_daily_milestone_split(daily, milestones):
    """Annotate each day in `daily` with a per-milestone split of its chars and
    seconds: d['by_milestone'] = {str(id)|'_uncovered': {'chars': float, 'secs':
    float}}.

    TIME is attributed on the cumulative-minute axis (start_min/end_min) — the
    same axis db_get_milestone_detail slices on — so a day's secs split matches
    the milestone view. CHARS on timed days follow that time split (scaled by the
    minute-overlap fraction, exactly like the milestone view); a day with chars
    but no time is placed whole by its cumulative-char position (start_chars/
    end_chars) so its chars don't vanish from the stacked chars bar. Each metric's
    segments sum to that day's flat total. '_uncovered' holds the remainder
    outside every milestone — the title's accent region on the progress bar.

    Milestone minute-intervals are disjoint (enforced on add/edit), so a session
    minute maps to at most one milestone. Mutates `daily` in place; no-op when
    there are no milestones (the stacked toggle is hidden in that case)."""
    if not milestones:
        return
    mins = [(str(m["id"]), m["start_min"], m["end_min"]) for m in milestones
            if m.get("start_min") is not None and m.get("end_min") is not None]
    chrs = [(str(m["id"]), m["start_chars"], m["end_chars"]) for m in milestones
            if m.get("start_chars") is not None and m.get("end_chars") is not None]

    cum_min, cum_chars = 0.0, 0
    for d in daily:
        smin       = (d["seconds"] or 0) / 60.0
        bmin, amin = cum_min, cum_min + smin
        cum_min    = amin
        dchars     = d["chars"] or 0
        bch, ach   = cum_chars, cum_chars + dchars
        cum_chars  = ach

        by = {}
        def _add(k, chars=0.0, secs=0.0):
            v = by.setdefault(k, {"chars": 0.0, "secs": 0.0})
            v["chars"] += chars
            v["secs"]  += secs

        if smin > 0:
            covered = 0.0
            for mid, sm, em in mins:
                ov = max(0.0, min(em, amin) - max(sm, bmin))
                if ov > 0:
                    _add(mid, chars=dchars * (ov / smin), secs=ov * 60.0)
                    covered += ov
            unc = max(0.0, smin - covered)
            if unc > 1e-9:
                _add("_uncovered", chars=dchars * (unc / smin), secs=unc * 60.0)
        elif dchars > 0:
            mid_pos = (bch + ach) / 2.0
            placed  = next((mid for mid, sc, ec in chrs if sc <= mid_pos < ec), None)
            _add(placed if placed is not None else "_uncovered", chars=float(dchars))

        d["by_milestone"] = by


def db_get_title_detail(title):
    """Public: title detail including milestone summaries."""
    core = _compute_title_core(title)
    if core is None:
        return None
    core["milestones"] = db_list_milestones(title)
    _attach_daily_milestone_split(core["daily"], core["milestones"])
    return core


# Server-side cap on RAW TITLES per compare request. The client caps *selections*
# at 8 (PORTAL_MAX in ui.js), but one selection can be a series that expands into
# many member titles — so this ceiling is much higher than the selection cap.
PORTAL_MAX_TITLES = 60


def db_get_compare_data(titles):
    """Trimmed multi-title payload for the Media stat portal. Reuses
    _compute_title_core so attribution + manual shaves apply; per-day speed is
    intentionally NOT included — the client derives it from chars/seconds."""
    out = []
    for t in list(titles)[:PORTAL_MAX_TITLES]:
        core = _compute_title_core(t)
        if core is None:
            continue
        out.append({
            "title":         core["title"],
            "display_title": core["display_title"],
            "source":        core["source"],
            "activity_type": core["activity_type"],
            "total_chars":   core["total_chars"],
            "total_secs":    core["total_secs"],
            "avg_speed":     core["avg_speed"],
            "session_count": core["session_count"],
            "days_count":    core["days_count"],
            "first_date":    core["first_date"],
            "last_date":     core["last_date"],
            "daily": [{"date": d["date"], "chars": d["chars"], "seconds": d["seconds"]}
                      for d in core["daily"]],
        })
    return out


# ── Milestones ────────────────────────────────────────────────────────────────
# A milestone subdivides a single media item (e.g. trilogy parts within one
# game). Bounds are stored in native unit ('hours' or 'chars'); empties resolve
# at query time. The canonical-minute axis lets us slice and disjoint-check
# milestones whose bounds use different units.

# Default palette for milestone colors, assigned by position when none is set.
# Source of truth for the progress-bar ticks/section tints (Steps 3–4); mirror
# in ui.js (MILESTONE_PALETTE) so the add modal pre-fills the same next color.
MILESTONE_PALETTE = [
    "#6E92E0", "#5FB98C", "#E0935A", "#B07FD6",
    "#DB82A6", "#4FB3B0", "#DAD06A", "#8487D6",
]


def _norm_milestone_color(color, position=0):
    """Normalize a milestone color to '#RRGGBB'. Falls back to the palette
    entry for `position` when color is missing or malformed."""
    if isinstance(color, str):
        c = color.strip()
        if re.fullmatch(r"#[0-9a-fA-F]{6}", c):
            return c.upper()
    return MILESTONE_PALETTE[position % len(MILESTONE_PALETTE)]

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
        mid, _name, unit, sv, ev, _pos = m[:6]
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


def _minutes_to_chars(M, walk, total_min, total_chars):
    """Inverse of _chars_bound_to_minutes: convert a minutes-axis position M to a
    media-cumulative chars position. Used to place milestone boundaries on the
    chars-denominated completion bar (hours-unit milestones have no native chars
    bound, so we read the cumulative char count at that point in the walk)."""
    if M is None or M <= 0:
        return 0.0
    if M >= total_min:
        return float(total_chars)
    for s in walk:
        if s["before_min"] <= M < s["after_min"]:
            if s["minutes"] <= 0:
                return float(s["before_chars"])
            frac = (M - s["before_min"]) / s["minutes"]
            return s["before_chars"] + frac * s["chars"]
    return float(total_chars)


def _resolve_milestone_bounds_chars(milestones_rows, walk, total_min, total_chars):
    """Mirror of _resolve_milestone_bounds on the chars axis. Returns
    {milestone_id: (start_chars, end_chars)} — media-cumulative char positions
    for placing ticks/section tints on the completion bar. chars-unit bounds are
    used directly (clamped); hours-unit bounds map through the session walk."""
    result = {}
    prev_end = 0.0
    for m in milestones_rows:
        mid, _name, unit, sv, ev, _pos = m[:6]
        if sv is None:
            start_c = prev_end
        elif unit == "chars":
            start_c = max(0.0, min(float(total_chars), float(sv)))
        else:  # hours
            start_c = _minutes_to_chars(float(sv) * 60.0, walk, total_min, total_chars)

        if ev is None:
            end_c = float(total_chars)
        elif unit == "chars":
            end_c = max(0.0, min(float(total_chars), float(ev)))
        else:
            end_c = _minutes_to_chars(float(ev) * 60.0, walk, total_min, total_chars)

        if end_c < start_c:
            end_c = start_c
        result[mid] = (start_c, end_c)
        prev_end = end_c
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
        SELECT id, name, unit, start_val, end_val, position, color
        FROM milestones WHERE title=? ORDER BY position ASC, id ASC
    """, title)
    if not rows:
        return []
    walk, total_min, total_chars = _build_session_walk(title)
    bounds = _resolve_milestone_bounds(rows, walk, total_min, total_chars)
    bounds_chars = _resolve_milestone_bounds_chars(rows, walk, total_min, total_chars)
    out = []
    for r in rows:
        mid, name, unit, sv, ev, pos, color = r
        sm, em = bounds.get(mid, (0.0, 0.0))
        sc, ec = bounds_chars.get(mid, (0.0, 0.0))
        tc, ts = _slice_totals(walk, sm, em)
        out.append({
            "id":          mid,
            "title":       title,
            "name":        name,
            "unit":        unit,
            "start_val":   sv,
            "end_val":     ev,
            "position":    pos,
            "color":       _norm_milestone_color(color, pos),
            "start_chars": sc,
            "end_chars":   ec,
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
    r = _q1("""SELECT id, title, name, unit, start_val, end_val, position, color
               FROM milestones WHERE id=?""", int(milestone_id))
    if not r:
        return None
    mid, title, name, unit, sv, ev, pos, color = r
    walk, total_min, total_chars = _build_session_walk(title)
    all_rows = _q("""SELECT id, name, unit, start_val, end_val, position
                     FROM milestones WHERE title=? ORDER BY position ASC, id ASC""", title)
    bounds = _resolve_milestone_bounds(all_rows, walk, total_min, total_chars)
    sm, em = bounds.get(mid, (0.0, 0.0))
    return {
        "id": mid, "title": title, "name": name, "unit": unit,
        "start_val": sv, "end_val": ev, "position": pos,
        "start_min": sm, "end_min": em,
        "color": _norm_milestone_color(color, pos),
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
    # Method A (chars/time) for consistency with _compute_title_core and the
    # milestone chart's per-day speed line — see _compute_title_core comment.
    avg_speed = (total_chars / (total_secs / 3600)) if total_secs > 0 and total_chars > 0 else 0
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
        "color":         base.get("color"),
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


def db_add_milestone(title, name, unit, start_val, end_val, color=None):
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

    col = _norm_milestone_color(color, new_pos)
    con = sqlite3.connect(DB_PATH)
    cur = con.execute(
        "INSERT INTO milestones (title, name, unit, start_val, end_val, position, color, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (title, name, unit, sv, ev, new_pos, col, datetime.now().isoformat())
    )
    new_id = cur.lastrowid
    con.commit()
    con.close()
    return {"ok": True, "id": new_id}


def db_update_milestone(milestone_id, name, unit, start_val, end_val, color=None):
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

    col = _norm_milestone_color(color, pos)
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "UPDATE milestones SET name=?, unit=?, start_val=?, end_val=?, color=? WHERE id=?",
        (name, unit, sv, ev, col, mid)
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
