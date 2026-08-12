"""Passive YouTube listening tracker — the ingest contract.

The extension accrues a cumulative total per LOGICAL day and re-posts that whole
total every couple of minutes. Two properties fall out of that and are what
these tests pin:

  * **Replay-safe by construction.** The natural key (source='youtube',
    session_date) makes a re-applied payload a rewrite, not a second row. This
    is why the source needs no `client_id` — the property `log_manual_session`
    had to buy with one, this gets for free.
  * **No monotonic guard.** A lower total must be accepted, because that is
    exactly what the user's correction control sends.

Plus the CLAUDE.md rail: these rows carry no `game_id`, which is what keeps them
outside GSM rollover attribution and the manual_time_adjust overlay.
"""
import sqlite3

import pytest

import imports as im


def _rows(db, date=None):
    con = sqlite3.connect(db.DB_PATH)
    if date:
        r = con.execute(
            "SELECT source,title,activity_type,time_seconds,game_id,time_excluded "
            "FROM sessions WHERE source='youtube' AND session_date=?", (date,)
        ).fetchall()
    else:
        r = con.execute(
            "SELECT source,title,activity_type,time_seconds,game_id,time_excluded "
            "FROM sessions WHERE source='youtube'").fetchall()
    con.close()
    return r


class TestShape:
    def test_creates_one_pooled_listening_row(self, seed, db):
        d = seed.day(1)
        assert im.import_youtube_day(d, 3600) == {
            "logged": True, "session_date": d, "time_seconds": 3600.0
        }

        rows = _rows(db, d)
        assert len(rows) == 1
        source, title, atype, secs, game_id, excluded = rows[0]
        assert (source, title, atype) == ("youtube", "YouTube", "Listening")
        assert secs == 3600.0
        assert excluded == 0

    def test_carries_no_game_id(self, seed, db):
        """game_id is what makes a row eligible for the GSM attribution and
        manual_time_adjust rails. Leaving it NULL is what keeps this source
        outside those cross-cutting concerns."""
        d = seed.day(1)
        im.import_youtube_day(d, 1800)
        assert _rows(db, d)[0][4] is None

    def test_time_lands_in_the_day_total(self, seed, db):
        d = seed.day(2)
        im.import_youtube_day(d, 1200)
        assert seed.raw_secs(d) == 1200


class TestIdempotence:
    def test_reposting_updates_rather_than_duplicates(self, seed, db):
        """The cumulative-total contract: every post carries the full figure, so
        a growing day rewrites one row instead of appending."""
        d = seed.day(1)
        im.import_youtube_day(d, 600)
        im.import_youtube_day(d, 1200)
        im.import_youtube_day(d, 1800)

        rows = _rows(db, d)
        assert len(rows) == 1
        assert rows[0][3] == 1800.0

    def test_replayed_payload_is_a_no_op(self, seed, db):
        """A drain replaying an inbox row must not double-count. Same total,
        same row, same result — no client_id required."""
        d = seed.day(1)
        im.import_youtube_day(d, 900)
        before = seed.raw_secs(d)
        im.import_youtube_day(d, 900)      # the replay
        assert seed.raw_secs(d) == before
        assert len(_rows(db, d)) == 1

    def test_separate_dates_get_separate_rows(self, seed, db):
        d1, d2 = seed.day(1), seed.day(2)
        im.import_youtube_day(d1, 600)
        im.import_youtube_day(d2, 900)
        assert len(_rows(db)) == 2
        assert seed.raw_secs(d1) == 600
        assert seed.raw_secs(d2) == 900

    def test_a_lower_total_is_accepted(self, seed, db):
        """NO monotonic guard. ttsu skips when the incoming figure is lower;
        this source must not, because the correction control lowers it on
        purpose. Reintroducing a guard breaks that feature silently."""
        d = seed.day(1)
        im.import_youtube_day(d, 3600)
        im.import_youtube_day(d, 1200)     # user shaved 40 minutes
        assert _rows(db, d)[0][3] == 1200.0


class TestValidation:
    @pytest.mark.parametrize("bad", ["", "   ", "2026-8-1", "10-08-2026", "not-a-date", "2026-08-10T00:00"])
    def test_rejects_malformed_dates(self, seed, db, bad):
        """The capturer decides the date, so a malformed one is a bug upstream —
        reject it rather than silently defaulting to today, which is how a
        payload lands on the wrong logical day."""
        assert "error" in im.import_youtube_day(bad, 600)
        assert _rows(db) == []

    @pytest.mark.parametrize("secs", [0, -1, None, ""])
    def test_rejects_non_positive_time(self, seed, db, secs):
        assert "error" in im.import_youtube_day(seed.day(1), secs)
        assert _rows(db) == []

    def test_a_rejected_payload_leaves_an_existing_row_alone(self, seed, db):
        d = seed.day(1)
        im.import_youtube_day(d, 1500)
        im.import_youtube_day(d, 0)        # rejected
        assert _rows(db, d)[0][3] == 1500.0


class TestCoexistence:
    def test_does_not_disturb_other_sources_on_the_same_day(self, seed, db):
        """YouTube rows sit alongside GSM/manual rows for the same date; the
        natural key is scoped to source='youtube' so nothing else is touched."""
        d = seed.day(1)
        seed.gsm(d, chars=5000, secs=1800, game_id="g1")
        im.import_youtube_day(d, 600)
        im.import_youtube_day(d, 900)      # update, must not touch the GSM row

        con = sqlite3.connect(db.DB_PATH)
        gsm = con.execute(
            "SELECT time_seconds, chars_read FROM sessions "
            "WHERE source='gsm' AND session_date=?", (d,)).fetchone()
        con.close()
        assert gsm == (1800, 5000)
        assert seed.raw_secs(d) == 1800 + 900
