"""Test fixtures for the GSM rollover attribution / manual overlay suite.

db.py resolves DATA_DIR and DB_PATH at *import* time from
IMMERSION_TRACKER_DATA_DIR, so the env var is set here at module scope, before
the import below. Doing it in a fixture would be too late and would point the
whole suite at the real ~/immersion-tracker/tracker.db.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="konseki-tests-"))
os.environ["IMMERSION_TRACKER_DATA_DIR"] = str(_TMP)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest                      # noqa: E402
import db as dbm                   # noqa: E402

# Hard guard. If anything ever resolves DB_PATH outside the temp dir, fail the
# whole run rather than mutate real data.
assert str(dbm.DB_PATH).startswith(str(_TMP)), (
    f"tests must never touch a real tracker.db (got {dbm.DB_PATH})"
)

# Tables the suite seeds. Wiped between tests so each one starts from empty.
_WIPE = (
    "sessions",
    "gsm_rollover_attributions",
    "manual_time_adjust",
    "gsm_games",
    "settings",
    "ingested_files",
    "milestones",
    "title_aliases",
    "media_char_counts",
    "media_completions",
    "series",
    "series_members",
    "goals",
)


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)


class Seed:
    """Thin seeding helper. Dates are expressed as offsets from logical today so
    the suite doesn't drift with the calendar."""

    def __init__(self, db):
        self.db = db

    # -- dates -------------------------------------------------------------
    def day(self, offset):
        """ISO date `offset` days before logical today (offset >= 0)."""
        return (self.db.get_today_date() - timedelta(days=offset)).isoformat()

    # -- rows --------------------------------------------------------------
    def session(self, date, chars=0, secs=0.0, source="gsm", title="Title",
                game_id=None, atype="Reading", time_excluded=0):
        con = sqlite3.connect(self.db.DB_PATH)
        con.execute(
            "INSERT INTO sessions (source,title,activity_type,session_date,"
            "chars_read,lines_read,time_seconds,reading_speed,cards_mined,"
            "game_id,time_excluded,ingested_at) "
            "VALUES (?,?,?,?,?,0,?,?,0,?,?,datetime('now'))",
            (source, title, atype, date, chars, secs,
             (chars / (secs / 3600)) if secs else 0, game_id, time_excluded),
        )
        con.commit()
        con.close()

    def gsm(self, date, chars, secs, game_id="g1", title="Game One"):
        """A GSM session — the only source attribution applies to."""
        self.session(date, chars=chars, secs=secs, source="gsm",
                     title=title, game_id=game_id)

    def displace(self, rollover_date, source_date, game_id, chars, secs, cards=0):
        """Record that part of `source_date`'s reading belongs to `rollover_date`."""
        self.db.upsert_gsm_attribution(rollover_date, source_date, game_id,
                                       chars, secs, cards)

    def shave(self, date, game_id, secs_delta, note=None):
        """Manual time overlay. The UI only ever writes negative deltas."""
        self.db.set_manual_time_adjust(date, game_id, secs_delta, note)

    def series(self, name, *titles):
        """Group titles into a series, as the media page's drag-to-group does."""
        con = sqlite3.connect(self.db.DB_PATH)
        cur = con.execute("INSERT INTO series (name, created_at) VALUES (?, datetime('now'))",
                          (name,))
        sid = cur.lastrowid
        for i, t in enumerate(titles):
            con.execute("INSERT INTO series_members (series_id, title, position, added_at) "
                        "VALUES (?,?,?,datetime('now'))", (sid, t, i))
        con.commit()
        con.close()
        return sid

    def setting(self, key, value):
        self.db.set_setting(key, str(value))

    # -- convenience -------------------------------------------------------
    def raw_secs(self, date):
        con = sqlite3.connect(self.db.DB_PATH)
        row = con.execute(
            "SELECT COALESCE(SUM(time_seconds),0) FROM sessions WHERE session_date=?",
            (date,)).fetchone()
        con.close()
        return row[0]


@pytest.fixture
def seed():
    """Empty DB + a seeding helper, per test."""
    dbm.init_db()
    con = sqlite3.connect(dbm.DB_PATH)
    for t in _WIPE:
        try:
            con.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            pass          # table not present in this schema version
    con.commit()
    con.close()
    # rollover_hour 0 keeps logical today == calendar today, so seeded offsets
    # mean what they say. Scenarios that care set it explicitly.
    dbm.set_setting("rollover_hour", "0")
    return Seed(dbm)


@pytest.fixture
def db():
    return dbm
