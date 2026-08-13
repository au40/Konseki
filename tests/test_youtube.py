"""Passive YouTube listening tracker — the ingest contract.

The extension accrues a cumulative total per LOGICAL day and re-posts that whole
total every couple of minutes. Two properties fall out of that and are what
these tests pin:

  * **Replay-safe by construction.** The key makes a re-applied payload a
    rewrite, not a second row — per device once `client_id` is in play, on
    (source='youtube', session_date) for a build that sends none.
  * **No monotonic guard.** A lower total must be accepted, because that is
    exactly what the user's correction control sends.

Plus the CLAUDE.md rail: these rows carry no `game_id`, which is what keeps them
outside GSM rollover attribution and the manual_time_adjust overlay.
"""
import sqlite3

import pytest

import imports as im


def _keys(db, date):
    con = sqlite3.connect(db.DB_PATH)
    r = [row[0] for row in con.execute(
        "SELECT client_id FROM sessions WHERE source='youtube' AND session_date=? "
        "ORDER BY rowid", (date,))]
    con.close()
    return r


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


class TestMultiDevice:
    """`client_id` = `youtube:<device>:<date>`. One row per device per logical
    day; the day's total is their sum, which every aggregate downstream already
    computes by summing rows."""

    def test_two_devices_sum_rather_than_overwrite(self, seed, db):
        """The whole reason the key exists. Keyed on the date alone, the second
        post would replace the first's total and look like a quiet day."""
        d = seed.day(1)
        im.import_youtube_day(d, 3600, f"youtube:desktop:{d}")
        im.import_youtube_day(d, 1800, f"youtube:laptop:{d}")

        assert len(_rows(db, d)) == 2
        assert seed.raw_secs(d) == 5400

    def test_each_device_replays_onto_its_own_row(self, seed, db):
        """A drain replaying an inbox row rewrites that device's total. The
        other device's row must not move."""
        d = seed.day(1)
        im.import_youtube_day(d, 3600, f"youtube:desktop:{d}")
        im.import_youtube_day(d, 1800, f"youtube:laptop:{d}")
        im.import_youtube_day(d, 3600, f"youtube:desktop:{d}")   # replay
        im.import_youtube_day(d, 2400, f"youtube:laptop:{d}")    # laptop grew

        assert len(_rows(db, d)) == 2
        assert seed.raw_secs(d) == 6000

    def test_first_keyed_post_adopts_the_keyless_row(self, seed, db):
        """The changeover day. A machine that posted keyless and now sends a key
        must claim its existing row, not insert a second one beside it — that
        would double-count the day it was named on."""
        d = seed.day(1)
        im.import_youtube_day(d, 600)                            # older build
        im.import_youtube_day(d, 900, f"youtube:desktop:{d}")    # now named

        assert len(_rows(db, d)) == 1
        assert seed.raw_secs(d) == 900
        assert _keys(db, d) == [f"youtube:desktop:{d}"]

    def test_adoption_claims_only_one_row(self, seed, db):
        """A second device naming itself on the same changeover day finds the
        keyless row already claimed, so it gets its own."""
        d = seed.day(1)
        im.import_youtube_day(d, 600)
        im.import_youtube_day(d, 900, f"youtube:desktop:{d}")
        im.import_youtube_day(d, 300, f"youtube:laptop:{d}")

        assert len(_rows(db, d)) == 2
        assert seed.raw_secs(d) == 1200

    def test_a_keyless_post_never_lands_on_a_keyed_row(self, seed, db):
        """A keyed row belongs to a device that keeps rewriting it. Letting an
        unkeyed post overwrite it would hand one machine's total to another."""
        d = seed.day(1)
        im.import_youtube_day(d, 3600, f"youtube:desktop:{d}")
        im.import_youtube_day(d, 600)                            # older build

        assert _keys(db, d) == [f"youtube:desktop:{d}", None]
        assert seed.raw_secs(d) == 4200

    def test_the_same_device_keeps_one_row_across_days(self, seed, db):
        """The key carries the date, so consecutive days are separate rows —
        the same shape a single-device build produces."""
        d1, d2 = seed.day(1), seed.day(2)
        im.import_youtube_day(d1, 3600, f"youtube:desktop:{d1}")
        im.import_youtube_day(d2, 1800, f"youtube:desktop:{d2}")

        assert len(_rows(db, d1)) == 1
        assert len(_rows(db, d2)) == 1
        assert seed.raw_secs(d1) == 3600
        assert seed.raw_secs(d2) == 1800

    def test_a_blank_key_behaves_like_no_key(self, seed, db):
        """The extension sends null when no device name is set; an empty string
        from a hand-rolled client must not become a distinct key."""
        d = seed.day(1)
        im.import_youtube_day(d, 600, "")
        im.import_youtube_day(d, 900, "   ")

        assert len(_rows(db, d)) == 1
        assert _keys(db, d) == [None]
        assert seed.raw_secs(d) == 900


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
