"""
backup.py  —  Daily rolling backups of tracker.db

Creates one .zip per calendar day in <data_dir>/backups/, keeping the 7 most
recent. Uses the SQLite online backup API so it's safe to run while the app
has the DB open. Run ensure_backup() on startup; schedule_daily() arms a
timer that fires at ~3am to create the next day's backup if the app stays
open across midnight.
"""

import os
import sqlite3
import threading
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from db import DB_PATH, DATA_DIR

BACKUP_DIR  = DATA_DIR / "backups"
KEEP_COUNT  = 7
DAILY_HOUR  = 3  # local time when scheduled backup fires


def _backup_path(d: datetime) -> Path:
    return BACKUP_DIR / f"immersion_{d.strftime('%Y-%m-%d')}.zip"


def _today_backup_exists() -> bool:
    return _backup_path(datetime.now()).exists()


def _prune_old():
    files = sorted(
        BACKUP_DIR.glob("immersion_*.zip"),
        key=lambda p: p.name,
        reverse=True,
    )
    for old in files[KEEP_COUNT:]:
        try:
            old.unlink()
        except OSError as e:
            print(f"[backup] could not delete {old}: {e}")


def make_backup() -> Path | None:
    """Create today's backup zip (overwrites if it already exists). Returns the path."""
    BACKUP_DIR.mkdir(exist_ok=True)
    zip_path = _backup_path(datetime.now())
    tmp_db   = zip_path.with_suffix(".db.tmp")

    try:
        src = sqlite3.connect(str(DB_PATH))
        dst = sqlite3.connect(str(tmp_db))
        with dst:
            src.backup(dst)
        dst.close()
        src.close()

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(tmp_db, arcname="tracker.db")
    finally:
        if tmp_db.exists():
            try:
                tmp_db.unlink()
            except OSError:
                pass

    _prune_old()
    print(f"[backup] wrote {zip_path.name}")
    return zip_path


def ensure_backup() -> Path | None:
    """Make today's backup if it doesn't exist yet."""
    if _today_backup_exists():
        return None
    try:
        return make_backup()
    except Exception as e:
        print(f"[backup] failed: {e}")
        return None


def _seconds_until_next(hour: int) -> float:
    now    = datetime.now()
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def schedule_daily():
    """Arm a self-rescheduling timer that runs ensure_backup() at DAILY_HOUR each day."""
    def _fire():
        ensure_backup()
        schedule_daily()

    delay = _seconds_until_next(DAILY_HOUR)
    t = threading.Timer(delay, _fire)
    t.daemon = True
    t.start()
