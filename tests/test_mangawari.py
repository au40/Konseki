"""Mangawari e-reader ingest — the contract that ttsu could not carry.

The reader posts a **cumulative total per (title, logical day)** when you tap
pause on its reading timer, and re-posts a growing total as the day goes on.
Three properties fall out of that, and they are what these tests pin:

  * **No monotonic guard.** This is the whole reason the source exists.
    `import_ttsu_entries` only updates a row when the *character count* grows,
    and manga has no character count to grow — so posing as ttsu meant the
    second sitting of any day was skipped and its time silently dropped.
  * **Replay-safe by construction.** A re-applied payload — a drain replaying an
    inbox row, the reader retrying after a failed post — rewrites one row rather
    than appending a second.
  * **Chars-less on purpose.** `chars_read` stays 0 so manga hours never enter a
    chars/hour denominator (every one of them filters `chars_read>0`), while
    `time_excluded=0` keeps the time itself in every total.

Plus the CLAUDE.md rail: no `game_id`, which is what keeps these rows outside
GSM rollover attribution and the manual_time_adjust overlay.
"""
import sqlite3

import imports as im


def _rows(db, date=None):
    con = sqlite3.connect(db.DB_PATH)
    sql = ("SELECT source,title,activity_type,chars_read,time_seconds,game_id,"
           "time_excluded,client_id FROM sessions WHERE source='mangawari'")
    args = ()
    if date:
        sql += " AND session_date=?"
        args = (date,)
    r = con.execute(sql + " ORDER BY rowid", args).fetchall()
    con.close()
    return r


class TestShape:
    def test_creates_one_reading_row_for_the_title(self, seed, db):
        d = seed.day(1)
        assert im.import_mangawari_day("極夜行", d, 3600) == {
            "logged": True, "title": "極夜行",
            "session_date": d, "time_seconds": 3600.0,
        }

        rows = _rows(db, d)
        assert len(rows) == 1
        source, title, atype, chars, secs, game_id, excluded, key = rows[0]
        assert (source, title, atype) == ("mangawari", "極夜行", "Reading")
        assert (chars, secs, excluded) == (0, 3600.0, 0)
        assert game_id is None
        assert key is None

    def test_time_lands_in_the_day_total(self, seed, db):
        d = seed.day(2)
        im.import_mangawari_day("極夜行", d, 1200)
        assert seed.raw_secs(d) == 1200

    def test_chars_less_time_stays_out_of_reading_speed(self, seed, db):
        """Every chars/hour denominator filters on chars_read>0. A manga row
        must add hours to the totals without dragging the speed down."""
        d = seed.day(1)
        seed.session(d, chars=10_000, secs=3600, source="ttsureader",
                     title="本", atype="Reading")
        im.import_mangawari_day("極夜行", d, 3600)

        con = sqlite3.connect(db.DB_PATH)
        chars, secs = con.execute(
            "SELECT COALESCE(SUM(chars_read),0), COALESCE(SUM(time_seconds),0) "
            "FROM sessions WHERE activity_type='Reading' "
            "AND time_seconds>0 AND chars_read>0").fetchone()
        con.close()
        assert (chars, secs) == (10_000, 3600.0)   # the manga hour is not in there
        assert seed.raw_secs(d) == 7200            # but it is in the day's time

    def test_a_title_is_required(self, seed):
        d = seed.day(1)
        assert "error" in im.import_mangawari_day("", d, 600)
        assert "error" in im.import_mangawari_day("   ", d, 600)

    def test_a_valid_date_and_positive_time_are_required(self, seed):
        d = seed.day(1)
        assert "error" in im.import_mangawari_day("極夜行", "12/08/2026", 600)
        assert "error" in im.import_mangawari_day("極夜行", "", 600)
        assert "error" in im.import_mangawari_day("極夜行", d, 0)
        assert "error" in im.import_mangawari_day("極夜行", d, -60)


class TestCumulativeTotals:
    def test_the_second_sitting_of_a_day_lands(self, seed, db):
        """The bug that made this source necessary. Under the ttsu shape this
        post was skipped — chars 0 is not greater than chars 0 — and an hour of
        reading disappeared with a `skipped: 1` and no other trace."""
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 3600)     # after dinner
        im.import_mangawari_day("極夜行", d, 7200)     # and again later

        rows = _rows(db, d)
        assert len(rows) == 1
        assert rows[0][4] == 7200.0

    def test_a_lower_total_is_accepted(self, seed, db):
        """No monotonic guard, deliberately: a correction must be able to go
        down. Reintroducing one breaks the same thing it broke for ttsu."""
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 3600)
        im.import_mangawari_day("極夜行", d, 1200)
        assert _rows(db, d)[0][4] == 1200.0

    def test_replayed_payload_is_a_no_op(self, seed, db):
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 900)
        before = seed.raw_secs(d)
        im.import_mangawari_day("極夜行", d, 900)      # the drain replaying
        assert seed.raw_secs(d) == before
        assert len(_rows(db, d)) == 1

    def test_titles_and_dates_are_separate_rows(self, seed, db):
        d1, d2 = seed.day(1), seed.day(2)
        im.import_mangawari_day("極夜行", d1, 600)
        im.import_mangawari_day("よつばと！1", d1, 900)
        im.import_mangawari_day("極夜行", d2, 1200)

        assert len(_rows(db)) == 3
        assert seed.raw_secs(d1) == 1500

    def test_it_does_not_collide_with_a_ttsu_row_for_the_same_title(self, seed, db):
        """Different sources, different rows — an epub and a manga volume can
        share a title without one rewriting the other."""
        d = seed.day(1)
        seed.session(d, chars=5000, secs=1800, source="ttsureader", title="極夜行")
        im.import_mangawari_day("極夜行", d, 600)

        assert len(_rows(db, d)) == 1
        assert seed.raw_secs(d) == 2400


class TestClientId:
    def test_a_key_makes_the_post_idempotent(self, seed, db):
        d = seed.day(1)
        key = f"mangawari:Go 7:極夜行:{d}"
        im.import_mangawari_day("極夜行", d, 600, key)
        im.import_mangawari_day("極夜行", d, 1800, key)

        rows = _rows(db, d)
        assert len(rows) == 1
        assert rows[0][4] == 1800.0
        assert rows[0][7] == key

    def test_two_devices_sum_rather_than_overwrite(self, seed, db):
        """The entire reason the device name is in the key. Keyed on title and
        date alone, the second reader's post would replace the first's total
        and look exactly like a short day."""
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 600, f"mangawari:Go 7:極夜行:{d}")
        im.import_mangawari_day("極夜行", d, 900, f"mangawari:Tab X:極夜行:{d}")

        assert len(_rows(db, d)) == 2
        assert seed.raw_secs(d) == 1500

    def test_the_first_keyed_post_adopts_a_keyless_row(self, seed, db):
        """A reader that posted before it sent keys must not end the changeover
        day with two rows counting the same reading twice."""
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 600)
        im.import_mangawari_day("極夜行", d, 1200, f"mangawari:Go 7:極夜行:{d}")

        rows = _rows(db, d)
        assert len(rows) == 1
        assert rows[0][4] == 1200.0
        assert rows[0][7] == f"mangawari:Go 7:極夜行:{d}"

    def test_a_keyless_post_never_lands_on_a_keyed_row(self, seed, db):
        """A keyed row belongs to a device that will keep rewriting it."""
        d = seed.day(1)
        im.import_mangawari_day("極夜行", d, 600, f"mangawari:Go 7:極夜行:{d}")
        im.import_mangawari_day("極夜行", d, 900)

        rows = _rows(db, d)
        assert len(rows) == 2
        assert [r[7] for r in rows] == [f"mangawari:Go 7:極夜行:{d}", None]
