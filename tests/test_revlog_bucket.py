"""The Anki addon's revlog bucketing — pure, so it runs without Anki installed.

Everything here is timezone-agnostic on purpose: the suite has to pass on the
machine it runs on, whatever that machine's zone and DST rules are. So the
assertions are round-trips against `logical_day_start_ms` rather than hardcoded
instants, which exercises whatever the local rules actually are — including a
DST shift, where the day is 23 or 25 hours long.
"""
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anki" / "konseki_anki"))

import revlog as rl


def _ms(y, m, d, hh=0, mm=0):
    return int(datetime(y, m, d, hh, mm).timestamp() * 1000)


class TestLogicalDate:
    def test_rollover_zero_is_the_calendar_date(self):
        assert rl.logical_date(_ms(2026, 5, 13, 1, 0), 0) == "2026-05-13"
        assert rl.logical_date(_ms(2026, 5, 13, 23, 59), 0) == "2026-05-13"

    def test_before_the_rollover_hour_belongs_to_the_previous_day(self):
        assert rl.logical_date(_ms(2026, 5, 14, 1, 0), 4) == "2026-05-13"

    def test_on_the_rollover_hour_the_new_day_has_started(self):
        assert rl.logical_date(_ms(2026, 5, 14, 4, 0), 4) == "2026-05-14"

    @pytest.mark.parametrize("rollover", [0, 3, 4, 6])
    def test_matches_the_backend_rule_exactly(self, seed, db, rollover):
        """The same rule as `logical_date_for` in src/db.py, hour by hour. If
        these two ever drift, Anki rows land on a different calendar than every
        other source in the app, and nothing errors to say so.

        The old shape of this test read `assert X == Y if rollover == 0 else
        True`, which Python parses as `assert (X == Y if ... else True)` — three
        of the four cases asserted the literal True and checked nothing."""
        seed.setting("rollover_hour", rollover)
        for hh in range(24):
            when = datetime(2026, 5, 14, hh, 30)
            assert (rl.logical_date(int(when.timestamp() * 1000), rollover)
                    == db.logical_date_for(when)), (rollover, hh)

    @pytest.mark.parametrize("rollover", [0, 1, 4, 6])
    @pytest.mark.parametrize("day", ["2026-01-15", "2026-03-29", "2026-10-25", "2026-07-04"])
    def test_day_start_round_trips(self, rollover, day):
        """A review at the day's first instant belongs to it; one millisecond
        earlier belongs to the day before. Covers DST both directions."""
        start = rl.logical_day_start_ms(day, rollover)
        assert rl.logical_date(start, rollover) == day
        assert rl.logical_date(start - 1, rollover) == rl.prev_day(day)

    @pytest.mark.parametrize("rollover", [0, 4])
    def test_a_day_is_contiguous(self, rollover):
        """No hour of a day falls outside it — the check a naive
        'subtract N hours then take the date' would fail across DST."""
        day = "2026-03-29"
        start = rl.logical_day_start_ms(day, rollover)
        nxt   = rl.logical_day_start_ms(rl.next_day(day), rollover)
        step = 15 * 60 * 1000
        t = start
        while t < nxt:
            assert rl.logical_date(t, rollover) == day, t
            t += step


class TestBucketReviews:
    def test_sums_seconds_and_counts_cards(self):
        rows = [
            (_ms(2026, 5, 13, 10, 0), 5000),
            (_ms(2026, 5, 13, 10, 1), 7000),
            (_ms(2026, 5, 14, 10, 0), 3000),
        ]
        out = rl.bucket_reviews(rows, 0)
        assert out["2026-05-13"] == (12.0, 2)
        assert out["2026-05-14"] == (3.0, 1)

    def test_a_post_midnight_review_lands_on_the_previous_day(self):
        rows = [
            (_ms(2026, 5, 13, 22, 0), 6000),
            (_ms(2026, 5, 14, 1, 0), 4000),
        ]
        assert rl.bucket_reviews(rows, 4) == {"2026-05-13": (10.0, 2)}
        assert rl.bucket_reviews(rows, 0) == {
            "2026-05-13": (6.0, 1), "2026-05-14": (4.0, 1)
        }

    @pytest.mark.parametrize("bad", [0, None, -1])
    def test_rows_with_no_usable_time_are_skipped_entirely(self, bad):
        """Not counted as a zero-second card — that would inflate cards/hour."""
        rows = [(_ms(2026, 5, 13, 10, 0), 5000), (_ms(2026, 5, 13, 11, 0), bad)]
        assert rl.bucket_reviews(rows, 0) == {"2026-05-13": (5.0, 1)}

    def test_a_corrupt_row_is_capped_not_trusted(self):
        rows = [(_ms(2026, 5, 13, 10, 0), 99_999_999)]
        secs, cards = rl.bucket_reviews(rows, 0)["2026-05-13"]
        assert secs == rl.MAX_ANSWER_SECS and cards == 1

    def test_empty_input(self):
        assert rl.bucket_reviews([], 4) == {}

    def test_the_sql_counts_the_same_types_the_constant_names(self):
        listed = ",".join(str(t) for t in rl.COUNTED_TYPES)
        assert f"type IN ({listed})" in rl.REVLOG_SQL
        assert "time > 0" in rl.REVLOG_SQL


class TestDaysPayload:
    def test_a_date_with_no_reviews_is_still_sent_as_zero(self):
        """This is what deletes the row of a day the user emptied out. Sending
        only the dates found would leave it frozen at its old total."""
        days = rl.days_payload({"2026-05-13": (60.0, 4)},
                               ["2026-05-13", "2026-05-14"],
                               lambda d: f"anki:{d}")
        assert days[0] == {"session_date": "2026-05-13", "time_seconds": 60.0,
                           "cards": 4, "client_id": "anki:2026-05-13"}
        assert days[1] == {"session_date": "2026-05-14", "time_seconds": 0.0,
                           "cards": 0, "client_id": "anki:2026-05-14"}

    def test_reports_only_the_dates_asked_for(self):
        days = rl.days_payload({"2026-05-01": (60.0, 4), "2026-05-13": (30.0, 2)},
                               ["2026-05-13"], lambda d: None)
        assert [d["session_date"] for d in days] == ["2026-05-13"]


class TestDateRange:
    """The backfill reports on a dense range, not just the days it found."""

    def test_includes_the_empty_days_between(self):
        assert rl.date_range("2026-05-11", "2026-05-14") == [
            "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14"]

    def test_a_single_day(self):
        assert rl.date_range("2026-05-11", "2026-05-11") == ["2026-05-11"]

    def test_crosses_a_month_and_a_year(self):
        assert rl.date_range("2025-12-30", "2026-01-02") == [
            "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]

    def test_a_gap_day_is_sent_as_zero_so_a_stale_row_is_deleted(self):
        """The whole point: a re-run must be able to REMOVE a row a previous
        run put on a date that no longer has reviews."""
        buckets = {"2026-05-11": (60.0, 4), "2026-05-13": (30.0, 2)}
        days = rl.days_payload(buckets, rl.date_range("2026-05-11", "2026-05-13"),
                               lambda d: f"anki:{d}")
        gap = [d for d in days if d["session_date"] == "2026-05-12"][0]
        assert (gap["time_seconds"], gap["cards"]) == (0.0, 0)


class TestRecentDays:
    """The push window."""

    def test_returns_n_days_ending_at_the_given_date(self):
        assert rl.recent_days("2026-05-14", 3) == [
            "2026-05-12", "2026-05-13", "2026-05-14"]

    def test_oldest_first_so_it_can_bound_the_revlog_query(self):
        days = rl.recent_days("2026-05-14", 7)
        assert days == sorted(days)
        assert len(days) == 7

    def test_one_day(self):
        assert rl.recent_days("2026-05-14", 1) == ["2026-05-14"]

    def test_crosses_a_month_boundary(self):
        assert rl.recent_days("2026-03-02", 4) == [
            "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]

    def test_degenerate_counts_do_not_explode(self):
        assert rl.recent_days("2026-05-14", 0) == ["2026-05-14"]


class TestBucketNotes:
    """Notes added, bucketed by the note id — which IS its creation time."""

    def test_counts_notes_per_logical_day(self):
        rows = [(_ms(2026, 5, 13, 10),), (_ms(2026, 5, 13, 22),), (_ms(2026, 5, 14, 9),)]
        assert rl.bucket_notes(rows, 0) == {"2026-05-13": 2, "2026-05-14": 1}

    def test_a_post_midnight_mine_lands_on_the_previous_day(self):
        """Same calendar as the reviews, by the same function."""
        rows = [(_ms(2026, 5, 14, 1, 30),)]
        assert rl.bucket_notes(rows, 4) == {"2026-05-13": 1}
        assert rl.bucket_notes(rows, 0) == {"2026-05-14": 1}

    @pytest.mark.parametrize("bad", [0, None, -5])
    def test_a_nonsense_id_is_skipped(self, bad):
        assert rl.bucket_notes([(bad,)], 0) == {}

    def test_empty_input(self):
        assert rl.bucket_notes([], 0) == {}


class TestBackfillRange:
    def test_starts_at_the_first_review_and_drops_older_notes(self):
        """A shared deck keeps its author's note ids; those must not drag
        Konseki's earliest date back years."""
        reviews = {"2026-05-10": (60.0, 4), "2026-05-12": (30.0, 2)}
        notes   = {"2012-03-01": 900, "2026-05-10": 3, "2026-05-11": 5}
        dates, kept = rl.backfill_range(reviews, notes)
        assert dates == ["2026-05-10", "2026-05-11", "2026-05-12"]
        assert kept == {"2026-05-10": 3, "2026-05-11": 5}

    def test_extends_to_a_last_day_of_mining_without_reviews(self):
        reviews = {"2026-05-10": (60.0, 4)}
        dates, kept = rl.backfill_range(reviews, {"2026-05-12": 2})
        assert dates == ["2026-05-10", "2026-05-11", "2026-05-12"]
        assert kept == {"2026-05-12": 2}

    def test_no_reviews_sends_nothing(self):
        assert rl.backfill_range({}, {"2026-05-12": 2}) == ([], {})


class TestDaysPayloadNotes:
    def test_every_day_carries_a_count_zero_included(self):
        """Zero must be sent, or a day whose notes were all deleted can't fall."""
        days = rl.days_payload({"2026-05-13": (60.0, 4)},
                               ["2026-05-13", "2026-05-14"],
                               lambda d: f"anki:{d}",
                               {"2026-05-13": 7})
        assert [d["notes_added"] for d in days] == [7, 0]

    def test_a_mining_only_day_is_sent_with_zero_time(self):
        days = rl.days_payload({}, ["2026-05-14"], lambda d: None, {"2026-05-14": 3})
        assert days[0]["time_seconds"] == 0.0 and days[0]["cards"] == 0
        assert days[0]["notes_added"] == 3

    def test_without_notes_the_field_is_absent_not_zero(self):
        """Absent tells the server to leave the stored count alone."""
        days = rl.days_payload({"2026-05-13": (60.0, 4)}, ["2026-05-13"], lambda d: None)
        assert "notes_added" not in days[0]

    def test_the_notes_sql_is_bounded_like_the_revlog_one(self):
        assert "id >= ?" in rl.NOTES_SQL and "FROM notes" in rl.NOTES_SQL
