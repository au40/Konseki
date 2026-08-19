"""
backup.py  —  Daily rolling backups of tracker.db

Creates one .zip per calendar day in <data_dir>/backups/, keeping the 7 most
recent. Uses the SQLite online backup API so it's safe to run while the app
has the DB open. Run ensure_backup() on startup; schedule_backups() arms a
timer that re-checks every POLL_SECONDS whether today's backup exists yet,
creating it if not, so a backup gets made for every calendar day the app is
running.

The same timer also pushes the day's zip to the always-on inbox when one is
configured, so the copies don't all live on the drive they're protecting
against.
"""

import hashlib
import os
import re
import sqlite3
import threading
import zipfile
from datetime import datetime
from pathlib import Path

import requests

from db import DB_PATH, DATA_DIR, get_setting, set_setting

BACKUP_DIR   = DATA_DIR / "backups"
KEEP_COUNT   = 7
POLL_SECONDS = 30 * 60  # how often to re-check that today's backup exists

# First tick after launch. Short, so a session that only lasts an hour still
# gets its backup offsite, rather than waiting a full POLL_SECONDS.
FIRST_TICK_SECONDS = 90
PUSH_TIMEOUT       = (5, 60)   # (connect, read) — a couple of MB over wifi

# Surfaced in Settings, never popped up. An inbox that's switched off or
# unreachable is the ordinary case here, exactly as it is for the drain.
_last_push_error = ""


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


# ── Offsite copy ──────────────────────────────────────────────────────────────
def _today_str():
    return datetime.now().strftime("%Y-%m-%d")


def _inbox_base():
    """Read the inbox URL straight from settings rather than importing drain.py.

    backup.py imports only db; pulling in drain would drag ext_server and
    imports behind it for what is a two-line accessor.
    """
    return get_setting("inbox_url", "").strip().rstrip("/")


def _local_backups():
    """This machine's dated zips as [(date, path)], oldest first."""
    if not BACKUP_DIR.exists():
        return []
    out = []
    for p in BACKUP_DIR.glob("immersion_*.zip"):
        d = p.name[len("immersion_"):-len(".zip")]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            out.append((d, p))
    return sorted(out)


def _remote_dates(base, token):
    """Dates the inbox already holds, or None if it can't be reached.

    None and empty-set mean very different things — "don't know" must never be
    read as "has nothing", or an unreachable inbox would look like a rebuilt one
    and trigger a pointless full re-upload every tick.
    """
    try:
        r = requests.get(f"{base}/backups",
                         headers={"X-Tracker-Token": token}, timeout=(4, 15))
        r.raise_for_status()
        rows = (r.json() or {}).get("backups", [])
    except (requests.exceptions.RequestException, ValueError):
        return None
    dates = set()
    for row in rows:
        m = re.fullmatch(r"konseki_(\d{4}-\d{2}-\d{2})\.zip", row.get("name", ""))
        if m:
            dates.add(m.group(1))
    return dates


def _push_one(base, token, date, path):
    """POST one dated zip. True if stored, False if the inbox already had that
    date (a 409 — ordinary, not a failure). Raises on anything real."""
    data = path.read_bytes()
    r = requests.post(
        f"{base}/backup",
        data=data,
        headers={
            "X-Tracker-Token":  token,
            "Content-Type":     "application/zip",
            # Verified by the inbox before it renames the upload into place.
            # It matters more than it would elsewhere: nothing can read the
            # stored copy back over HTTP to check it, so this is the only
            # integrity signal the design has.
            "X-Backup-Sha256":  hashlib.sha256(data).hexdigest(),
            # A date, not a filename — the inbox validates it and builds the
            # name itself. See BackupStore._validated_date.
            "X-Backup-Date":    date,
        },
        timeout=PUSH_TIMEOUT,
    )
    if r.status_code == 409:
        return False                      # slot already filled; nothing to do
    r.raise_for_status()
    body = r.json() or {}
    if not body.get("ok"):
        # A 200 carrying an error is still a failure — don't count it as sent.
        raise ValueError(body.get("error") or "rejected by inbox")
    return True


def push_backups_if_due():
    """Reconcile the inbox's dated copies against this machine's backups/ folder,
    pushing whatever it's missing, oldest first. Returns how many were sent.

    ── WHY RECONCILE RATHER THAN JUST SEND TODAY'S ──────────────────────────
    A fresh inbox starts empty and would take a week to catch up, while seven
    perfectly good zips sit here already — so for that week the offsite copy
    holds *less* history than the drive it's insuring. That matters most after
    the inbox is rebuilt, which is exactly the event this feature exists for: a
    dead SD card would otherwise silently reset the offsite history to nothing
    and nobody would notice for seven days. Reconciling also self-heals ordinary
    gaps, like the box being down for three days.

    The inbox only accepts a date whose slot is empty, or today's, so this can
    fill holes but can never overwrite an existing generation.

    ── WHY IT'S DRIVEN BY THE POLL, NOT BY make_backup() ────────────────────
    ensure_backup() returns early the moment the day's zip exists, so a push
    wired into the creation path would fire exactly once and never again — if
    the inbox happened to be down at that moment, that day's backup would never
    leave this machine. Asking the inbox what it holds on every tick means one
    that comes back at noon still gets that morning's copy.

    Failure is quiet and recorded, never surfaced: the inbox being switched off
    or unreachable is the ordinary case, and a popup every half hour would train
    you to ignore it. Settings is where a persistently failing push becomes
    visible — see push_status().
    """
    global _last_push_error

    base = _inbox_base()
    if not base:
        return 0
    token  = get_setting("ext_token", "")
    remote = _remote_dates(base, token)
    if remote is None:
        _last_push_error = "could not reach the inbox"
        return 0

    local   = _local_backups()
    missing = [(d, p) for d, p in local if d not in remote]

    sent = 0
    for date, path in missing:
        try:
            if _push_one(base, token, date, path):
                sent += 1
            remote.add(date)
        except Exception as e:
            # Stop rather than hammer a box that's gone away mid-run. Whatever
            # already landed stays landed; the next tick picks up the rest.
            _last_push_error = str(e)[:160]
            break
    else:
        _last_push_error = ""

    today = _today_str()
    if today in remote:
        # Purely a readout convenience — the inbox's own listing is the source
        # of truth, and it's re-read every tick.
        set_setting("last_backup_pushed_date", today)

    if sent:
        print(f"[backup] pushed {sent} backup(s) to {base}")
    return sent


def push_status():
    """Readout for Settings. The staleness of `last_pushed` is the actual safety
    mechanism here: two copies quietly become one the moment the push stops
    working and nothing says so."""
    base = _inbox_base()
    if not base:
        return {"enabled": False}
    out = {
        "enabled":     True,
        "last_pushed": get_setting("last_backup_pushed_date", ""),
        "last_error":  _last_push_error,
    }
    try:
        r = requests.get(f"{base}/backups",
                         headers={"X-Tracker-Token": get_setting("ext_token", "")},
                         timeout=(3, 8))
        r.raise_for_status()
        body = r.json() or {}
        rows = body.get("backups", [])
        out.update(reachable=True,
                   count=body.get("count", len(rows)),
                   newest=rows[0]["name"] if rows else None,
                   newest_bytes=rows[0]["bytes"] if rows else None)
    except requests.exceptions.RequestException:
        out.update(reachable=False, count=None, newest=None, newest_bytes=None)
    return out


def schedule_backups(delay=None):
    """Arm a self-rescheduling timer: make today's backup if missing, then get
    it offsite if an inbox is configured.

    Polling rather than a one-shot daily timer means a missed wake-up — e.g.
    the machine sleeping across a scheduled time — only delays the day's backup
    until the next tick instead of skipping that calendar day entirely. The push
    rides the same tick for the same reason, and because retrying is what makes
    it robust to the inbox being down (see push_backup_if_due).

    The network call lives here, on the timer thread, and deliberately not in
    the startup path beside ensure_backup() — a few seconds of connect timeout
    to an unreachable Pi must never delay the window coming up.
    """
    def _fire():
        try:
            ensure_backup()
            push_backups_if_due()
        except Exception as e:                     # never kill the timer chain
            print(f"[backup] tick failed: {e}")
        finally:
            schedule_backups()

    t = threading.Timer(POLL_SECONDS if delay is None else delay, _fire)
    t.daemon = True
    t.start()
