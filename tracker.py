"""
tracker.py  —  Konseki entry point
Serves ui.html via pywebview. The Api class exposes all JS-callable methods,
delegating to db.py (data layer) and imports.py (external integrations).
"""

import base64
import os
import subprocess
import sys
import threading
import time
import webview
import sqlite3
import json
import requests
from datetime import datetime, date
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

try:
    import pystray
    from PIL import Image, ImageDraw
    _TRAY_AVAILABLE = True
except ImportError:
    _TRAY_AVAILABLE = False

import db
import imports
import backup
import catalog
import devlog
from db import (
    APP_NAME, DB_PATH, SESSIONS_DIR,
    init_db, scan_existing_files,
    get_setting, set_setting, get_today,
    get_today_stats, get_weekly_summary, get_all_time_totals, get_range_totals,
    get_recent_sessions, get_daily_time_series, get_daily_activity_series,
    get_daily_reading_speed_basis,
    get_activity_breakdown,
    get_streak, get_top_titles, get_heatmap_data,
    get_manual_time_adjust, set_manual_time_adjust, get_manual_time_adjusts_for_date,
    get_manual_time_adjusts_all,
    get_media_stats, get_media_titles, get_series_data, get_extra_stats, get_range_extra_stats,
    db_get_goal_progress, db_add_goal, db_update_goal, db_delete_goal, db_finish_goal,
    db_get_custom_categories, db_add_custom_category, db_delete_custom_category,
    db_get_dev_notes, db_add_dev_note, db_delete_dev_note, db_set_dev_note_importance,
    _get_aliases, _q, _q1,
    insert_manual_session, create_manual_media, import_csv_file,
    get_total_log_baseline, set_total_log_baseline,
)
from imports import (pull_gsm_now, import_ttsu_zip_data,
                     list_gsm_db_games, import_gsm_history_preview,
                     import_gsm_history_apply, get_gsm_db_path,
                     list_gsm_sync_anomalies, acknowledge_gsm_sync_anomaly)
from ext_server import ExtServer


# ── Tray icon ─────────────────────────────────────────────────────────────────
def _make_tray_image():
    tray_png = Path(__file__).parent / "assets" / "tray.png"
    if tray_png.exists():
        return Image.open(tray_png)
    # fallback if assets are missing
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([4, 4, 60, 60], fill="#5B8CFF")
    return img


# ── File watchers ─────────────────────────────────────────────────────────────
class SessionHandler(FileSystemEventHandler):
    def __init__(self, cb, debounce_secs=1.0):
        self.cb = cb
        self._debounce_secs = debounce_secs
        self._timer = None
        self._lock = threading.Lock()
        self._pending = set()

    def _schedule(self, path):
        with self._lock:
            self._pending.add(path)
            if self._timer:
                self._timer.cancel()
            t = threading.Timer(self._debounce_secs, self._flush)
            t.daemon = True
            t.start()
            self._timer = t

    def _flush(self):
        with self._lock:
            paths = list(self._pending)
            self._pending.clear()
        notified = False
        for path in paths:
            if db.ingest_session_file(path):
                notified = True
        if notified:
            self.cb()

    def on_created(self, e):
        if not e.is_directory and e.src_path.endswith(".json"):
            self._schedule(e.src_path)

    def on_modified(self, e):
        if not e.is_directory and e.src_path.endswith(".json"):
            self._schedule(e.src_path)


class GsmWalHandler(FileSystemEventHandler):
    """Watches GSM's WAL file; triggers a GSM pull after writes settle.

    Three pull triggers:
      1. Debounced pull at +debounce_secs once writes settle (steady state).
      2. A 'settle' pull at +settle_secs after the debounced pull, to catch
         GSM's tail-time/AFK accumulator updates that flush to disk after the
         last char-arrival WAL write. New WAL activity cancels the settle.
      3. An immediate 'GSM opened' pull when a WAL write arrives after a long
         idle gap (>open_gap_secs). On reopen GSM tends to flush the previous
         session's pending tail time before the first new line arrives; pulling
         in that quiet window lets refresh_gsm_attribution_tail grow the prior
         day's attribution while its char count is still unchanged. The chars
         guard in that function keeps this safe — if new reading has already
         bumped the count, the update no-ops instead of misattributing it.
         Set open_gap_secs=0 to disable this trigger.

    All pulls run through _pull_lock so concurrent triggers never write
    tracker.db at the same time."""

    _WATCHED = {"gsm.db-wal", "gsm.db"}

    def __init__(self, cb, debounce_secs=60, settle_secs=180, open_gap_secs=0):
        self._cb_raw = cb
        self._debounce_secs = debounce_secs
        self._settle_secs = settle_secs
        self._open_gap_secs = open_gap_secs
        self._timer = None
        self._settle_timer = None
        self._lock = threading.Lock()
        self._pull_lock = threading.Lock()
        self._last_event = None

    def _cb(self):
        # Serialize: debounce / settle / open-gap triggers must not overlap.
        with self._pull_lock:
            self._cb_raw()

    def _fire(self):
        self._cb()
        with self._lock:
            if self._settle_timer:
                self._settle_timer.cancel()
            t = threading.Timer(self._settle_secs, self._cb)
            t.daemon = True
            t.start()
            self._settle_timer = t

    def _schedule(self):
        now = time.monotonic()
        with self._lock:
            reopened = self._open_gap_secs > 0 and (
                self._last_event is None
                or (now - self._last_event) > self._open_gap_secs
            )
            self._last_event = now
            if self._timer:
                self._timer.cancel()
            if self._settle_timer:
                self._settle_timer.cancel()
            t = threading.Timer(self._debounce_secs, self._fire)
            t.daemon = True
            t.start()
            self._timer = t
        if reopened:
            # GSM likely just (re)opened — pull now, before the first new line
            # inflates today's char count, to catch the prior session's tail.
            threading.Thread(target=self._cb, daemon=True).start()

    def on_modified(self, e):
        if not e.is_directory and os.path.basename(e.src_path) in self._WATCHED:
            self._schedule()

    def on_created(self, e):
        if not e.is_directory and os.path.basename(e.src_path) in self._WATCHED:
            self._schedule()


# ── JS-callable API ───────────────────────────────────────────────────────────
class Api:
    """All public methods are callable from JS via window.pywebview.api.*"""

    def __init__(self):
        self._window    = None
        self._ext_server = None

    # ── Dashboard ─────────────────────────────────────────────────────────────
    def get_dashboard(self):
        today  = get_today_stats()
        weekly = get_weekly_summary()
        totals = get_all_time_totals()
        aliases = _get_aliases()
        cs, _  = get_streak()
        today_date = get_today()
        # Per-game shave active today, so each row can show a "−Nm" indicator.
        adj = get_manual_time_adjusts_for_date(today_date)
        return {
            "today": [
                {"id": r[0], "source": r[1], "title": aliases.get(r[2], r[2]),
                 "raw_title": r[2],
                 "activity_type": r[3], "chars": r[4], "lines": r[5], "seconds": r[6],
                 "game_id": r[7], "date": today_date, "session_date": r[8],
                 "adjust_secs": adj.get(r[7], 0)}
                for r in today
            ],
            "weekly": [
                {"date": r[0], "chars": r[1], "seconds": r[2]}
                for r in weekly
            ],
            "totals": {
                "chars": totals[0], "lines": totals[1],
                "seconds": totals[2], "days": totals[3]
            },
            "cur_streak": cs,
        }

    # ── History ───────────────────────────────────────────────────────────────
    def get_history(self):
        aliases = _get_aliases()
        manual  = get_manual_time_adjusts_all()   # {(date, game_id): secs_delta}
        # Indicator on the real GSM row that absorbed the shave (one per date+game);
        # phantom rows (id=None) don't carry it, to avoid double-display.
        return [
            {"id": r[0], "date": r[1], "source": r[2], "title": aliases.get(r[3], r[3]),
             "raw_title": r[3],
             "activity_type": r[4], "chars": r[5], "lines": r[6], "seconds": r[7],
             "game_id": r[8], "session_date": r[1],
             "adjust_secs": (manual.get((r[1], r[8]), 0) if r[0] is not None else 0)}
            for r in get_recent_sessions(30)
        ]

    # ── Stats ─────────────────────────────────────────────────────────────────
    def get_stats(self, range_val):
        n           = {"30d": 30, "90d": 90, "6m": 182, "1y": 365, "All": None}.get(range_val, 30)
        rc, rs, _   = get_range_totals(n)
        cs, _       = get_streak()
        daily       = get_daily_time_series(n)
        daily_act   = dict(get_daily_activity_series(n))  # date -> {activity_type: secs}
        daily_spd   = get_daily_reading_speed_basis(n)    # date -> (speed chars, speed secs)
        activity    = get_activity_breakdown(n)
        titles      = get_top_titles(8)
        extra       = get_range_extra_stats(n)

        if n is None:
            first = _q1("SELECT MIN(session_date) FROM sessions")[0]
            w = (date.today() - datetime.strptime(first, "%Y-%m-%d").date()).days + 1 if first else 1
        else:
            w = n

        return {
            "range_val":       range_val,
            "r_chars":         rc,
            "r_secs":          rs,
            "cur_streak":      cs,
            "avg_secs":        rs / max(w, 1),
            "chars_per_hour":  extra["chars_per_hour"],
            "best_day_secs":   extra["best_day_secs"],
            "best_day_date":   extra["best_day_date"],
            "best_week_secs":  extra["best_week_secs"],
            "best_week_start": extra["best_week_start"],
            "consistency_pct": extra["consistency_pct"],
            "active_days":     extra["active_days"],
            "window_days":     extra["window_days"],
            "daily":           [{"date": d, "seconds": s, "chars": c, "by_type": daily_act.get(d, {}),
                                 "spd_chars": daily_spd.get(d, (0, 0))[0],
                                 "spd_secs":  daily_spd.get(d, (0, 0))[1]}
                                for d, s, c in daily],
            "activity":        [{"type": a[0], "seconds": a[1]} for a in activity],
            "titles":          [{"title": t[0], "hours": t[1]} for t in titles],
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
            base = {r[0]: r[1] for r in rows}
            # Net per-day overlay (attribution + manual) from the shared chokepoint,
            # clamped to the year window — no inline re-derivation (see CLAUDE.md).
            adj = db.get_gsm_day_adjustments()
            out = {}
            for d in set(base) | set(adj):
                if d < start or d > end:
                    continue
                secs = max(0, base.get(d, 0) + adj.get(d, (0, 0, 0))[1])
                if secs > 0:
                    out[d] = secs
            return out
        return get_heatmap_data(int(days) if days else 371)

    # ── Media ─────────────────────────────────────────────────────────────────
    def get_media(self):
        return get_media_stats()

    def get_media_titles(self):
        return get_media_titles()

    def get_title_detail(self, title):
        return db.db_get_title_detail(title)

    def get_compare_data(self, titles):
        return db.db_get_compare_data(list(titles or []))

    def get_media_order(self):
        return db.db_get_media_card_order()

    def set_media_order(self, ordered_keys):
        try:
            db.db_set_media_card_order(list(ordered_keys))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Catalog ───────────────────────────────────────────────────────────────
    # Read-only reading ledger in its own catalog.db. Never writes tracker.db.
    def get_catalog(self):
        return catalog.get_catalog()

    def add_catalog_entry(self, name, reading_type="book", chars=0, volumes=0):
        try:
            catalog.add_catalog_entry(name, reading_type, chars, volumes)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def update_catalog_entry(self, entry_id, fields):
        try:
            f = fields or {}
            catalog.update_catalog_entry(
                entry_id,
                name=f.get("name"), reading_type=f.get("reading_type"),
                chars=f.get("chars"), volumes=f.get("volumes"),
            )
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_catalog_entry(self, entry_id):
        try:
            catalog.delete_catalog_entry(entry_id)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Goals ─────────────────────────────────────────────────────────────────
    def get_goals(self):
        return db_get_goal_progress()

    def add_goal(self, label, metric, target, deadline, chunk_period="daily", activity_type=None, track_chars=False, start_date=None):
        try:
            db_add_goal(label, metric, float(target), deadline, chunk_period, activity_type, track_chars, start_date)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def update_goal(self, goal_id, label, target, deadline, activity_type=None, track_chars=False, start_date=None):
        try:
            db_update_goal(goal_id, label, float(target), deadline, activity_type, track_chars, start_date)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_goal(self, goal_id):
        try:
            db_delete_goal(goal_id)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def finish_goal(self, goal_id):
        try:
            db_finish_goal(goal_id)
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

    # ── Dev tab ─────────────────────────────────────────────────────────────────
    def get_dev_logs(self, after_seq=0):
        return devlog.get_entries(after_seq)

    def clear_dev_logs(self):
        devlog.clear()
        return {"ok": True}

    def get_dev_notes(self):
        return db_get_dev_notes()

    def add_dev_note(self, body):
        try:
            db_add_dev_note(body)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_dev_note_importance(self, note_id, importance):
        try:
            db_set_dev_note_importance(note_id, importance)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_dev_note(self, note_id):
        try:
            db_delete_dev_note(note_id)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Log ───────────────────────────────────────────────────────────────────
    def log_session(self, atype, minutes, title, session_date, chars=0):
        try:
            datetime.strptime(session_date, "%Y-%m-%d")
            insert_manual_session(atype, float(minutes), title, session_date, chars)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def add_media(self, title, atype, minutes, session_date, chars=0):
        try:
            title = (title or "").strip()
            if not title:
                return {"ok": False, "error": "Enter a title."}
            if float(minutes) <= 0:
                return {"ok": False, "error": "Enter a positive number of minutes."}
            datetime.strptime(session_date, "%Y-%m-%d")
            create_manual_media(title, atype, float(minutes), session_date, chars)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def update_manual_session(self, session_id, atype, minutes, title, session_date, chars=0):
        try:
            datetime.strptime(session_date, "%Y-%m-%d")
            changed = db.update_manual_session(int(session_id), atype, float(minutes),
                                               title, session_date, chars)
            if not changed:
                return {"ok": False, "error": "Only manual entries can be edited."}
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Total time log ──────────────────────────────────────────────────────────
    # A logging aid: the user enters their reading app's running cumulative total
    # and we log the *difference* since their last entry as a normal manual
    # session. The cumulative totals themselves live in `total_log_baselines`
    # (private; never counted as stats) so the next diff works. media_key='' is the
    # global bucket; a non-empty key is a per-media baseline.
    def get_total_log_state(self, media_key=""):
        b = get_total_log_baseline(media_key or "")
        return {
            "mode":         get_setting("total_log_mode", "global"),
            "has_baseline": b is not None,
            "base_secs":    b["base_secs"]  if b else 0,
            "base_chars":   b["base_chars"] if b else 0,
        }

    def set_total_log_mode(self, mode):
        set_setting("total_log_mode", "per_media" if mode == "per_media" else "global")
        return {"ok": True}

    def save_total_log_baseline(self, media_key, secs, chars=0):
        try:
            set_total_log_baseline(media_key or "", float(secs), int(chars or 0))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def submit_total_log(self, media_key, title, new_secs, new_chars, cph, session_date):
        try:
            datetime.strptime(session_date, "%Y-%m-%d")
            base = get_total_log_baseline(media_key or "")
            if base is None:
                return {"ok": False, "error": "Set a baseline before logging a difference."}

            new_secs   = float(new_secs)
            base_secs  = float(base["base_secs"])
            delta_secs = new_secs - base_secs
            if delta_secs <= 0:
                return {"ok": False, "error": "New total must be greater than the last recorded total."}
            delta_hours = delta_secs / 3600.0

            has_chars = new_chars not in (None, "", 0, "0")
            base_chars = int(base["base_chars"])
            if has_chars:
                delta_chars = max(0, int(float(new_chars)) - base_chars)
            elif cph not in (None, "", 0, "0"):
                delta_chars = int(round(float(cph) * delta_hours))
            else:
                delta_chars = 0

            insert_manual_session("Reading", delta_secs / 60.0, title or "", session_date, delta_chars)

            # Advance the baseline: time always, chars only if a new total was given.
            new_base_chars = int(float(new_chars)) if has_chars else base_chars
            set_total_log_baseline(media_key or "", new_secs, new_base_chars)

            return {
                "ok": True,
                "logged_secs":  delta_secs,
                "logged_chars": delta_chars,
                "base_secs":    new_secs,
                "base_chars":   new_base_chars,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Manual per-game time adjustment ─────────────────────────────────────────
    def get_game_time_adjust(self, game_id, session_date=None):
        """Current manual subtraction (in minutes) for one game on a display date."""
        d = session_date or get_today()
        return {"date": d, "game_id": game_id,
                "subtract_minutes": round(-get_manual_time_adjust(d, game_id) / 60, 1)}

    def set_game_time_adjust(self, game_id, subtract_minutes, session_date=None):
        """Subtract `subtract_minutes` of dead/AFK time from one game on a display
        date. 0 clears it. Survives GSM re-ingests (separate overlay table)."""
        try:
            if not game_id:
                return {"ok": False, "error": "no game_id (only GSM games can be adjusted)"}
            d = session_date or get_today()
            datetime.strptime(d, "%Y-%m-%d")
            mins = max(0.0, float(subtract_minutes))
            set_manual_time_adjust(d, game_id, -mins * 60 if mins else 0)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Manual rollover displacement ────────────────────────────────────────────
    def get_rollover_attribution(self, game_id, source_date):
        """Chars/minutes of this GSM game's source_date reading currently assigned to
        the previous logical day. Backs the per-row rollover-edit prompt."""
        return {"ok": True, **db.get_rollover_attribution(game_id, source_date)}

    def set_rollover_attribution(self, game_id, source_date, chars, minutes):
        """Assign `chars`/`minutes` of a GSM game's source_date reading to the previous
        logical day (rollover displacement). Clamped to the row's totals; 0/0 clears."""
        try:
            if not game_id:
                return {"ok": False, "error": "no game_id (only GSM rows can be rolled over)"}
            datetime.strptime(source_date, "%Y-%m-%d")
            res = db.set_rollover_attribution(game_id, source_date, chars, minutes)
            self._notify()
            return {"ok": True, **res}
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
        if url:
            imports.GSM_API = url
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

    # ── GSM history import (reads GSM's local SQLite) ─────────────────────────
    def gsm_list_games(self):
        """Enumerate games found in GSM's local DB along with current tracker
        prefs. Used by the GSM history import UI."""
        return {"ok": True, "path": get_gsm_db_path(), "games": list_gsm_db_games()}

    def gsm_set_game_prefs(self, game_id, track, count_as_time):
        """Update per-game track / count_as_time. Creates a metadata row if
        the game hasn't been seen by the API yet."""
        if not game_id:
            return {"ok": False, "error": "game_id required"}
        con = sqlite3.connect(DB_PATH)
        try:
            con.execute("""
                INSERT INTO gsm_games (game_id, game_name, last_updated, track, count_as_time)
                VALUES (?, '', ?, ?, ?)
                ON CONFLICT(game_id) DO UPDATE SET
                  track         = excluded.track,
                  count_as_time = excluded.count_as_time
            """, (game_id, datetime.now().isoformat(),
                  1 if track else 0, 1 if count_as_time else 0))
            con.commit()
        finally:
            con.close()
        return {"ok": True}

    def gsm_preview_import(self):
        return {"ok": True, "games": import_gsm_history_preview()}

    def gsm_apply_import(self):
        result = import_gsm_history_apply()
        self._notify()
        return {"ok": True, "games": result}

    def gsm_list_anomalies(self):
        return {"ok": True, "anomalies": list_gsm_sync_anomalies()}

    def gsm_resolve_anomaly(self, anomaly_id, apply_change):
        r = acknowledge_gsm_sync_anomaly(int(anomaly_id), bool(apply_change))
        if r.get("ok"):
            self._notify()
        return r

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

    # ── Milestones ────────────────────────────────────────────────────────────
    def list_milestones(self, title):
        try:
            return db.db_list_milestones(title)
        except Exception as e:
            print(f"[milestones] list: {e}")
            return []

    def get_milestone_detail(self, milestone_id):
        try:
            return db.db_get_milestone_detail(milestone_id)
        except Exception as e:
            print(f"[milestones] detail: {e}")
            return None

    def add_milestone(self, title, name, unit, start_val, end_val, color=None):
        try:
            return db.db_add_milestone(title, name, unit, start_val, end_val, color)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def update_milestone(self, milestone_id, name, unit, start_val, end_val, color=None):
        try:
            return db.db_update_milestone(milestone_id, name, unit, start_val, end_val, color)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_milestone(self, milestone_id):
        try:
            return db.db_delete_milestone(milestone_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def end_milestone(self, milestone_id):
        try:
            return db.db_end_milestone(milestone_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def reorder_milestones(self, title, ordered_ids):
        try:
            return db.db_reorder_milestones(title, ordered_ids)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── Media completion ──────────────────────────────────────────────────────
    def set_media_complete(self, title, complete):
        """Mark a media entry finished (or clear the mark). Display-only flag."""
        try:
            return db.db_set_media_complete(title, bool(complete))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_media_char_count(self, title, char_count):
        """Set (or clear, with 0) the user-entered total length in characters
        that powers a media entry's completion bar."""
        try:
            return db.db_set_media_char_count(title, char_count)
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
        from ext_server import _get_or_create_token, _get_port
        return {
            "rollover_hour":    int(get_setting("rollover_hour", "0")),
            "gsm_url":          get_setting("gsm_url", imports.GSM_API),
            "theme":            get_setting("theme", "dark"),
            "ext_port":         _get_port(),
            "ext_token":        _get_or_create_token(),
            "gsm_debounce_secs": int(get_setting("gsm_debounce_secs", "60")),
            "gsm_settle_secs":  int(get_setting("gsm_settle_secs", "180")),
            "gsm_open_gap_secs": int(get_setting("gsm_open_gap_secs", "0")),
            "first_run_complete":         get_setting("first_run_complete", "0") == "1",
            "gsm_history_include_time":   get_setting("gsm_history_include_time", "0") == "1",
            "ttsu_history_include_time":  get_setting("ttsu_history_include_time", "0") == "1",
        }

    def complete_first_run(self):
        set_setting("first_run_complete", "1")
        return {"ok": True}

    def reroll_ext_token(self):
        if self._ext_server:
            new_token = self._ext_server.reroll_token()
            return {"ok": True, "token": new_token}
        return {"ok": False}

    def save_settings(self, data):
        for key, value in data.items():
            if isinstance(value, bool):
                value = "1" if value else "0"
            set_setting(key, str(value))
        if "gsm_url" in data:
            imports.GSM_API = data["gsm_url"]
        if "gsm_debounce_secs" in data and gsm_wal_handler is not None:
            gsm_wal_handler._debounce_secs = int(data["gsm_debounce_secs"])
        if "gsm_settle_secs" in data and gsm_wal_handler is not None:
            gsm_wal_handler._settle_secs = int(data["gsm_settle_secs"])
        if "gsm_open_gap_secs" in data and gsm_wal_handler is not None:
            gsm_wal_handler._open_gap_secs = int(data["gsm_open_gap_secs"])
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


gsm_wal_handler = None  # set in main(); read by Api.save_settings


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    global gsm_wal_handler

    devlog.install()  # before anything prints — captures stdout/stderr for the Dev tab

    # Give Windows an explicit AppUserModelID so the taskbar button is treated
    # as its own app (and uses the window's Konseki icon) instead of being
    # grouped under pythonw.exe and borrowing Python's icon.
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Konseki")
        except Exception:
            pass

    init_db()
    catalog.init_catalog_db()
    scan_existing_files()
    backup.ensure_backup()
    backup.schedule_backups()

    # Auto-mark existing users as having completed first-run setup so they don't see the prompt
    if get_setting("first_run_complete", "") == "":
        has_data = (_q1("SELECT 1 FROM sessions LIMIT 1") is not None)
        set_setting("first_run_complete", "1" if has_data else "0")

    api              = Api()
    ext_server       = ExtServer(on_import=api._notify)
    api._ext_server  = ext_server
    ext_server.start()

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

    # Sessions directory watcher (existing)
    handler  = SessionHandler(api._notify)
    observer = Observer()
    observer.schedule(handler, str(SESSIONS_DIR), recursive=False)
    observer.start()

    # GSM WAL watcher — fires pull when GSM writes to its database
    appdata     = os.getenv("APPDATA") or os.path.expanduser("~/.config")
    gsm_dir     = os.path.join(appdata, "GameSentenceMiner")
    gsm_observer = None
    gsm_wal_handler = None
    if os.path.isdir(gsm_dir):
        def _on_gsm_change():
            result = pull_gsm_now()
            if result:
                print(f"[gsm-watch] Auto-pulled: {result.get('chars_read', 0)} chars  "
                      f"| {result.get('title', '')}")
                api._notify()
        debounce = int(get_setting("gsm_debounce_secs", "60"))
        settle   = int(get_setting("gsm_settle_secs", "180"))
        open_gap = int(get_setting("gsm_open_gap_secs", "0"))
        gsm_wal_handler = GsmWalHandler(_on_gsm_change, debounce_secs=debounce,
                                        settle_secs=settle, open_gap_secs=open_gap)
        gsm_observer = Observer()
        gsm_observer.schedule(gsm_wal_handler, gsm_dir, recursive=False)
        gsm_observer.start()
        print(f"[gsm-watch] Watching {gsm_dir} (debounce={debounce}s, "
              f"settle={settle}s, open_gap={open_gap}s)")
    else:
        print(f"[gsm-watch] {gsm_dir} not found — watcher disabled")

    # System tray (requires pystray + Pillow)
    tray_icon = None
    if _TRAY_AVAILABLE:
        _state = {"quitting": False, "restarting": False}

        def _show(icon, item):
            win.show()

        def _pull_gsm(icon, item):
            result = pull_gsm_now()
            if result:
                api._notify()

        def _restart(icon, item):
            _state["quitting"] = True
            _state["restarting"] = True
            icon.stop()
            win.destroy()

        def _quit(icon, item):
            _state["quitting"] = True
            icon.stop()
            win.destroy()

        def _on_closing():
            if _state["quitting"]:
                return True  # allow the destroy from _quit to proceed
            win.hide()
            return False     # cancel user-initiated close; hide instead

        tray_icon = pystray.Icon(
            APP_NAME,
            _make_tray_image(),
            APP_NAME,
            menu=pystray.Menu(
                pystray.MenuItem("Open", _show, default=True),
                pystray.MenuItem("Pull GSM Now", _pull_gsm),
                pystray.MenuItem("Restart", _restart),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Quit", _quit),
            ),
        )
        tray_icon.run_detached()
        win.events.closing += _on_closing

    try:
        app_icon = Path(__file__).parent / "assets" / "icon.ico"
        webview.start(
            debug=bool(os.environ.get("IMMERSION_TRACKER_DATA_DIR")),
            icon=str(app_icon) if app_icon.exists() else None,
        )
    finally:
        observer.stop()
        observer.join()
        if gsm_observer:
            gsm_observer.stop()
            gsm_observer.join()
        if tray_icon:
            tray_icon.stop()
        ext_server.stop()
        if _TRAY_AVAILABLE and _state.get("restarting"):
            args = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, *sys.argv]
            subprocess.Popen(args, close_fds=True)


if __name__ == "__main__":
    main()
