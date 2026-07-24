"""
backup.py  —  Daily rolling backups of tracker.db

Creates one .zip per calendar day in <data_dir>/backups/, keeping the 7 most
recent. Uses the SQLite online backup API so it's safe to run while the app
has the DB open. Run ensure_backup() on startup; schedule_backups() arms a
timer that re-checks every POLL_SECONDS whether today's backup exists yet,
creating it if not, so a backup gets made for every calendar day the app is
running.
"""

import os
import sqlite3
import threading
import zipfile
from datetime import datetime
from pathlib import Path

from db import DB_PATH, DATA_DIR

BACKUP_DIR   = DATA_DIR / "backups"
KEEP_COUNT   = 7
POLL_SECONDS = 30 * 60  # how often to re-check that today's backup exists


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
            # The Catalog ledger lives in its own file — fold it into the same
            # daily zip so it's covered by the existing rolling backup.
            catalog_db = DATA_DIR / "catalog.db"
            if catalog_db.exists():
                zf.write(catalog_db, arcname="catalog.db")
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


def schedule_backups():
    """Arm a self-rescheduling timer that runs ensure_backup() every POLL_SECONDS.

    Polling rather than a one-shot daily timer means a missed wake-up — e.g.
    the machine sleeping across a scheduled time — only delays the day's backup
    until the next tick instead of skipping that calendar day entirely.
    """
    def _fire():
        try:
            ensure_backup()
        finally:
            schedule_backups()

    t = threading.Timer(POLL_SECONDS, _fire)
    t.daemon = True
    t.start()
