"""Anki review time and card counts — the ingest contract.

The addon reads Anki's `revlog`, buckets it into Konseki's logical days, and
re-posts each day's cumulative total. Two properties fall out of that:

  * **Replay-safe by construction.** A re-applied payload rewrites its rows
    rather than adding more, keyed `anki:<date>` — collection-scoped, NOT
    device-scoped. An Anki collection is synced, so every device computes the
    same day totals; a per-device key would make two desktops double-count.
  * **No monotonic guard.** A lower total must land, because undoing reviews is
    exactly what sends one.

Plus the backfill's don't-double-count rule: a day that already carries counted
Vocabulary time from somewhere else keeps it, and Anki's row for that day is
imported with its time suppressed but its cards intact.

And the CLAUDE.md rail: these rows carry no `game_id`, which is what keeps them
outside GSM rollover attribution and the manual_time_adjust overlay.
"""
import sqlite3

import pytest

import ext_server
import imports as im


def _rows(db, date=None):
    con = sqlite3.connect(db.DB_PATH)
    sql = ("SELECT source,title,activity_type,session_date,chars_read,"
           "time_seconds,cards_done,game_id,time_excluded,client_id "
           "FROM sessions WHERE source='anki'")
    r = (con.execute(sql + " AND session_date=? ORDER BY rowid", (date,))
         if date else con.execute(sql + " ORDER BY rowid")).fetchall()
    con.close()
    return r


def _one(db, date):
    rows = _rows(db, date)
    assert len(rows) == 1, rows
    return rows[0]


def _day(date, secs, cards, key=None):
    e = {"session_date": date, "time_seconds": secs, "cards": cards}
    if key is not None:
        e["client_id"] = key
    return e


def _series_secs(db, days=7):
    """date -> counted seconds, off the canonical daily series (d, secs, chars)."""
    return {r[0]: r[1] for r in db.get_daily_time_series(days)}


def _push(date, secs, cards, **kw):
    """One day, keyed the way the addon keys it."""
    return im.import_anki_days([_day(date, secs, cards, f"anki:{date}")], **kw)


class TestShape:
    def test_creates_one_pooled_vocabulary_row(self, seed, db):
        d = seed.day(1)
        out = _push(d, 1800, 210)
        assert out["logged"] is True
        assert (out["days"], out["inserted"], out["updated"], out["deleted"]) == (1, 1, 0, 0)

        src, title, atype, date, chars, secs, cards, game_id, excl, key = _one(db, d)
        assert (src, title, atype) == ("anki", "Anki", "Vocabulary")
        assert (date, secs, cards) == (d, 1800.0, 210)
        assert chars == 0          # no characters — stays out of every cph figure
        assert excl == 0
        assert key == f"anki:{d}"

    def test_carries_no_game_id(self, seed, db):
        """The rail that keeps this source out of attribution and the shave overlay."""
        d = seed.day(1)
        _push(d, 1800, 210)
        assert _one(db, d)[7] is None

    def test_time_lands_in_the_day_total(self, seed, db):
        d = seed.day(1)
        _push(d, 1800, 210)
        assert seed.raw_secs(d) == 1800.0
        assert _series_secs(db, 3).get(d) == 1800.0

    def test_counts_as_vocabulary_in_the_activity_breakdown(self, seed, db):
        d = seed.day(1)
        seed.session(d, secs=600, source="manual", title=None, atype="Listening")
        _push(d, 1800, 210)
        assert dict(db.get_activity_breakdown(7))["Vocabulary"] == 1800.0

    def test_a_batch_writes_every_day(self, seed, db):
        days = [_day(seed.day(i), 600 * i, 10 * i, f"anki:{seed.day(i)}")
                for i in (1, 2, 3)]
        out = im.import_anki_days(days)
        assert (out["days"], out["inserted"]) == (3, 3)
        assert len(_rows(db)) == 3


class TestIdempotence:
    def test_replay_rewrites_rather_than_duplicating(self, seed, db):
        d = seed.day(1)
        _push(d, 1800, 210)
        out = _push(d, 1800, 210)
        assert (out["inserted"], out["updated"]) == (0, 1)
        assert len(_rows(db, d)) == 1

    def test_a_growing_day_is_rewritten_whole(self, seed, db):
        d = seed.day(1)
        _push(d, 1800, 210)
        _push(d, 2400, 260)
        _, _, _, _, _, secs, cards, _, _, _ = _one(db, d)
        assert (secs, cards) == (2400.0, 260)

    def test_no_monotonic_guard(self, seed, db):
        """A correction lowering the day must land — the one thing a guard would break."""
        d = seed.day(1)
        _push(d, 2400, 260)
        _push(d, 900, 100)
        _, _, _, _, _, secs, cards, _, _, _ = _one(db, d)
        assert (secs, cards) == (900.0, 100)

    def test_a_second_desktop_rewrites_rather_than_adding(self, seed, db):
        """The collection is synced, so both machines compute the same total and
        must land on the SAME row. A device-scoped key would double-count."""
        d = seed.day(1)
        _push(d, 1800, 210)
        _push(d, 1800, 210)
        assert len(_rows(db, d)) == 1
        assert seed.raw_secs(d) == 1800.0

    def test_a_keyless_post_never_touches_a_keyed_row(self, seed, db):
        d = seed.day(1)
        _push(d, 1800, 210)
        im.import_anki_days([_day(d, 600, 60)])
        assert len(_rows(db, d)) == 2


class TestValidation:
    def test_days_must_be_a_list(self, seed, db):
        assert "error" in im.import_anki_days(None)
        assert "error" in im.import_anki_days({"session_date": "2026-01-01"})
        assert "error" in im.import_anki_days([])

    def test_missing_time_seconds_is_rejected_not_defaulted(self, seed, db):
        """A `, 0` default here would turn every malformed body into a deletion."""
        d = seed.day(1)
        out = im.import_anki_days([{"session_date": d, "cards": 10}])
        assert "time_seconds" in out["error"]
        assert _rows(db) == []

    def test_missing_cards_is_rejected(self, seed, db):
        d = seed.day(1)
        out = im.import_anki_days([{"session_date": d, "time_seconds": 60}])
        assert "cards" in out["error"]

    @pytest.mark.parametrize("bad", ["", "2026-1-1", "not-a-date", "2026-13-45"])
    def test_bad_dates_are_rejected(self, seed, db, bad):
        assert "error" in im.import_anki_days([_day(bad, 60, 10)])

    @pytest.mark.parametrize("secs", [-1, float("nan"), float("inf"), "abc"])
    def test_bad_time_is_rejected(self, seed, db, secs):
        assert "error" in im.import_anki_days([_day(seed.day(1), secs, 10)])

    def test_negative_cards_rejected(self, seed, db):
        assert "error" in im.import_anki_days([_day(seed.day(1), 60, -1)])

    def test_one_bad_entry_rejects_the_whole_batch(self, seed, db):
        """No half-application: the retry has to be a clean replay."""
        good, bad = seed.day(1), seed.day(2)
        out = im.import_anki_days([
            _day(good, 600, 60, f"anki:{good}"),
            {"session_date": bad, "cards": 10},          # no time_seconds
        ])
        assert "error" in out
        assert _rows(db) == []

    def test_duplicate_dates_in_one_batch_rejected(self, seed, db):
        d = seed.day(1)
        out = im.import_anki_days([_day(d, 600, 60), _day(d, 700, 70)])
        assert "duplicate" in out["error"]

    def test_oversized_batch_rejected(self, seed, db):
        days = [_day(f"2020-01-{i:02d}", 60, 1) for i in range(1, 32)] * 20
        assert "error" in im.import_anki_days(days)


class TestZeroDeletes:
    def test_both_counters_zero_deletes_the_row(self, seed, db):
        d = seed.day(1)
        _push(d, 1800, 210)
        out = _push(d, 0, 0)
        assert out["deleted"] == 1
        assert _rows(db, d) == []

    def test_deleting_an_absent_row_is_success(self, seed, db):
        """A 200 carrying `error` makes the addon retry forever and stalls the
        Pi drain's high-water mark."""
        out = _push(seed.day(1), 0, 0)
        assert out["logged"] is True
        assert "error" not in out
        assert out["deleted"] == 0

    def test_zero_time_with_cards_still_stores(self, seed, db):
        d = seed.day(1)
        _push(d, 0, 5)
        assert _one(db, d)[6] == 5


class TestConditionalExclusion:
    """The backfill's don't-double-count rule."""

    def test_a_day_with_hand_logged_vocabulary_is_suppressed(self, seed, db):
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        out = _push(d, 1800, 210, skip_vocab_days=True)

        assert out["skipped_days"] == [d]
        assert _one(db, d)[8] == 1                 # time_excluded
        assert _one(db, d)[6] == 210               # cards survive
        assert _series_secs(db).get(d) == 900.0   # unchanged

    def test_a_day_with_nothing_logged_counts(self, seed, db):
        d = seed.day(5)
        out = _push(d, 1800, 210, skip_vocab_days=True)
        assert out["skipped_days"] == []
        assert _one(db, d)[8] == 0
        assert _series_secs(db).get(d) == 1800.0

    def test_csv_imported_vocabulary_blocks_too(self, seed, db):
        """No source allowlist — hand-logged, stopwatch and CSV history all block."""
        d = seed.day(5)
        seed.session(d, secs=900, source="csv", title="Anki", atype="Vocabulary")
        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 1

    def test_an_already_excluded_vocabulary_row_does_not_block(self, seed, db):
        """'Already tracked' means already COUNTING. An excluded row contributes
        nothing to any total, so Anki should fill that day rather than defer."""
        d = seed.day(5)
        seed.session(d, secs=900, source="csv", title="Anki",
                     atype="Vocabulary", time_excluded=1)
        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 0

    def test_reading_time_does_not_block(self, seed, db):
        """A day of reading must not suppress Anki time logged nowhere else."""
        d = seed.day(5)
        seed.session(d, chars=5000, secs=3600, source="gsm", game_id="g1")
        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 0

    def test_running_the_backfill_twice_changes_nothing(self, seed, db):
        """`source<>'anki'` is what this pins: without it the second run sees the
        row the first wrote and flips the day to excluded."""
        d1, d2 = seed.day(5), seed.day(6)
        seed.session(d1, secs=900, source="manual", title=None, atype="Vocabulary")
        days = [_day(d1, 1800, 210, f"anki:{d1}"), _day(d2, 1200, 150, f"anki:{d2}")]

        im.import_anki_days(days, skip_vocab_days=True)
        first = _rows(db)
        im.import_anki_days(days, skip_vocab_days=True)
        second = _rows(db)

        assert [r[8] for r in first] == [1, 0]
        assert [(r[3], r[5], r[6], r[8]) for r in first] == \
               [(r[3], r[5], r[6], r[8]) for r in second]

    def test_deleting_the_hand_logged_row_and_rerunning_counts_the_day(self, seed, db):
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 1

        con = sqlite3.connect(db.DB_PATH)
        con.execute("DELETE FROM sessions WHERE source='manual' AND session_date=?", (d,))
        con.commit(); con.close()

        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 0

    def test_flag_false_undoes_a_previous_skip(self, seed, db):
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        _push(d, 1800, 210, skip_vocab_days=True)
        assert _one(db, d)[8] == 1

        _push(d, 1800, 210, skip_vocab_days=False)
        assert _one(db, d)[8] == 0

    def test_the_periodic_push_leaves_a_suppressed_day_alone(self, seed, db):
        """The flag is absent on the nightly push. Coercing it to a bool would
        let every push un-suppress what the backfill decided."""
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        _push(d, 1800, 210, skip_vocab_days=True)

        _push(d, 2000, 240)                    # no flag
        src, _, _, _, _, secs, cards, _, excl, _ = _one(db, d)
        assert excl == 1                       # still suppressed
        assert (secs, cards) == (2000.0, 240)  # but the totals did update


class TestReadingSpeed:
    def test_anki_time_stays_out_of_reading_speed(self, seed, db):
        """Chars-less time in the denominator with nothing in the numerator
        would drag every chars/hour figure down."""
        d = seed.day(1)
        seed.session(d, chars=36000, secs=3600, source="gsm", game_id="g1")
        before = db.get_extra_stats()["chars_per_hour"]

        _push(d, 3600, 400)
        assert db.get_extra_stats()["chars_per_hour"] == before


class TestDispatch:
    def _post(self, body):
        return ext_server.apply_payload("/import", body)

    def test_dispatches_on_source(self, seed, db):
        d = seed.day(1)
        out, status = self._post({
            "source": "anki",
            "days": [_day(d, 1800, 210, f"anki:{d}")],
        })
        assert status == 200 and out["logged"] is True
        assert len(_rows(db, d)) == 1

    def test_missing_days_is_rejected_not_defaulted(self, seed, db):
        out, status = self._post({"source": "anki"})
        assert status == 200 and "error" in out

    def test_the_skip_flag_rides_through(self, seed, db):
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        out, _ = self._post({
            "source": "anki",
            "days": [_day(d, 1800, 210, f"anki:{d}")],
            "skip_days_with_vocabulary_time": True,
        })
        assert out["skipped_days"] == [d]
        assert _one(db, d)[8] == 1

    def test_an_absent_flag_stays_absent(self, seed, db):
        """`.get` returning None IS the third state — it must not become False."""
        d = seed.day(5)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        self._post({"source": "anki", "days": [_day(d, 1800, 210, f"anki:{d}")],
                    "skip_days_with_vocabulary_time": True})
        self._post({"source": "anki", "days": [_day(d, 2000, 240, f"anki:{d}")]})
        assert _one(db, d)[8] == 1


class TestCardsReadPaths:
    """The two bases are deliberately different, and this is where that is pinned."""

    def test_totals_count_a_suppressed_day_but_the_rate_does_not(self, seed, db):
        live, dead = seed.day(1), seed.day(2)
        seed.session(live, secs=1800, source="anki", title="Anki",
                     atype="Vocabulary", cards=200)
        seed.session(dead, secs=3600, source="anki", title="Anki",
                     atype="Vocabulary", cards=400, time_excluded=1)

        cards = db.get_daily_cards(7)
        assert cards[live] == 200
        assert cards[dead] == 400          # suppressed time, cards still counted

        basis = db.get_card_speed_basis(7)
        assert live in basis
        assert dead not in basis           # no usable time to divide by

    def test_cards_per_hour_is_derived_from_the_totals(self, seed, db):
        d = seed.day(1)
        seed.session(d, secs=1800, source="anki", title="Anki",
                     atype="Vocabulary", cards=210)
        assert db._basis_cardsph(db.get_card_speed_basis(7)) == 420

    def test_rate_sums_both_sides_before_dividing(self, seed, db):
        """Method A — never a mean of per-day rates."""
        seed.session(seed.day(1), secs=3600, source="anki", title="Anki",
                     atype="Vocabulary", cards=100)
        seed.session(seed.day(2), secs=3600, source="anki", title="Anki",
                     atype="Vocabulary", cards=500)
        # mean of per-day rates would be 300; the correct answer is 600/2h.
        assert db._basis_cardsph(db.get_card_speed_basis(7)) == 300
        seed.session(seed.day(3), secs=7200, source="anki", title="Anki",
                     atype="Vocabulary", cards=0)
        assert db._basis_cardsph(db.get_card_speed_basis(7)) == 300

    def test_extra_stats_expose_both(self, seed, db):
        d = seed.day(1)
        seed.session(d, secs=1800, source="anki", title="Anki",
                     atype="Vocabulary", cards=210)
        e = db.get_extra_stats()
        assert e["total_cards"] == 210
        assert e["cards_per_hour"] == 420
        r = db.get_range_extra_stats(7)
        assert (r["total_cards"], r["cards_per_hour"]) == (210, 420)

    def test_no_anki_data_reads_as_zero_not_an_error(self, seed, db):
        seed.gsm(seed.day(1), 10_000, 3600)
        e = db.get_extra_stats()
        assert (e["total_cards"], e["cards_per_hour"]) == (0, 0)

    def test_cards_reach_the_dashboard_and_history_rows(self, seed, db):
        d = seed.day(0)
        _push(d, 1800, 210)
        row = [r for r in db.get_today_stats() if r[1] == "anki"][0]
        assert row[9] == 210
        hrow = [r for r in db.get_recent_sessions(30) if r[2] == "anki"][0]
        assert hrow[9] == 210

    def test_a_cards_only_row_is_not_dropped_as_empty(self, seed, db):
        """The liveness filter drops all-zero rows; cards make a row real."""
        d = seed.day(0)
        _push(d, 0, 5)
        assert [r for r in db.get_today_stats() if r[1] == "anki"]
        assert [r for r in db.get_recent_sessions(30) if r[2] == "anki"]


# ── notes added ───────────────────────────────────────────────────────────────
def _pushn(date, secs, cards, notes):
    e = _day(date, secs, cards, f"anki:{date}")
    e["notes_added"] = notes
    return im.import_anki_days([e])


def _notes(db, date):
    con = sqlite3.connect(db.DB_PATH)
    r = con.execute("SELECT notes_added FROM sessions WHERE source='anki' "
                    "AND session_date=?", (date,)).fetchall()
    con.close()
    return [n for (n,) in r]


class TestNotesAdded:
    def test_stored_on_the_pooled_row(self, seed, db):
        d = seed.day(1)
        _pushn(d, 1800, 210, 12)
        assert _notes(db, d) == [12]
        assert len(_rows(db, d)) == 1

    def test_rewritten_including_downward(self, seed, db):
        """Deleting a mined note lowers its day — no monotonic guard."""
        d = seed.day(1)
        _pushn(d, 1800, 210, 12)
        _pushn(d, 1800, 210, 9)
        assert _notes(db, d) == [9]

    def test_an_absent_count_leaves_the_stored_one_alone(self, seed, db):
        """An addon that predates notes must not wipe them."""
        d = seed.day(1)
        _pushn(d, 1800, 210, 12)
        _push(d, 2000, 240)                    # no notes_added key at all
        assert _notes(db, d) == [12]
        assert _one(db, d)[5] == 2000          # the rest still updated

    def test_a_mining_only_day_keeps_its_row(self, seed, db):
        """0 time / 0 cards used to mean delete. With notes it is a real day."""
        d = seed.day(1)
        out = _pushn(d, 0, 0, 5)
        assert out["inserted"] == 1
        assert _notes(db, d) == [5]

    def test_an_older_addons_zero_does_not_delete_a_day_with_notes(self, seed, db):
        d = seed.day(1)
        _pushn(d, 600, 40, 5)
        out = _push(d, 0, 0)                   # reviews undone, notes unknown
        assert out["deleted"] == 0
        assert _notes(db, d) == [5]
        assert _one(db, d)[5] == 0

    def test_all_three_zero_deletes(self, seed, db):
        d = seed.day(1)
        _pushn(d, 600, 40, 5)
        out = _pushn(d, 0, 0, 0)
        assert out["deleted"] == 1
        assert _rows(db, d) == []

    @pytest.mark.parametrize("bad", [-1, "x", "", 1.5j])
    def test_a_bad_count_rejects_the_batch(self, seed, db, bad):
        d = seed.day(1)
        e = _day(d, 60, 1, f"anki:{d}")
        e["notes_added"] = bad
        assert "error" in im.import_anki_days([e])
        assert _rows(db, d) == []

    def test_rides_through_the_dispatch(self, seed, db):
        d = seed.day(1)
        e = _day(d, 0, 0, f"anki:{d}")
        e["notes_added"] = 4
        out, status = ext_server.apply_payload("/import", {"source": "anki", "days": [e]})
        assert status == 200 and out["logged"] is True
        assert _notes(db, d) == [4]

    def test_a_mining_only_day_is_not_an_active_day(self, seed, db):
        """Streak/consistency count days with time; the all-time day count
        must agree, or mining alone would read as a day of immersion."""
        seed.gsm(seed.day(2), 10_000, 3600)
        _pushn(seed.day(1), 0, 0, 5)
        assert db.get_all_time_totals()[3] == 1

    def test_a_mining_only_day_stays_out_of_dashboard_and_history(self, seed, db):
        _pushn(seed.day(0), 0, 0, 5)
        assert not [r for r in db.get_today_stats() if r[1] == "anki"]
        assert not [r for r in db.get_recent_sessions(30) if r[2] == "anki"]


class TestNotesGoal:
    def _goal(self, seed, db, target=300, activity=None):
        db.db_add_goal("Mining", "notes_added", target, seed.day(-30),
                       activity_type=activity, start_date=seed.day(10))
        return db.db_get_goal_progress()[0]

    def test_sums_notes_across_days(self, seed, db):
        _pushn(seed.day(3), 1800, 200, 10)
        _pushn(seed.day(1), 0, 0, 5)           # mining-only day counts too
        assert self._goal(seed, db)["completed"] == 15

    def test_today_counts_toward_the_day(self, seed, db):
        _pushn(seed.day(0), 600, 40, 7)
        assert self._goal(seed, db)["today_completed"] == 7

    def test_a_suppressed_day_still_counts_its_notes(self, seed, db):
        """time_excluded is about TIME logged elsewhere; the notes weren't."""
        d = seed.day(3)
        seed.session(d, secs=900, source="manual", title=None, atype="Vocabulary")
        e = _day(d, 1800, 210, f"anki:{d}")
        e["notes_added"] = 8
        im.import_anki_days([e], skip_vocab_days=True)
        assert _one(db, d)[8] == 1
        assert self._goal(seed, db)["completed"] == 8

    def test_ignores_everything_that_is_not_a_note(self, seed, db):
        seed.gsm(seed.day(2), 10_000, 3600)
        _pushn(seed.day(2), 1800, 210, 0)
        assert self._goal(seed, db)["completed"] == 0

    def test_the_burnup_line_matches_the_card(self, seed, db):
        _pushn(seed.day(3), 1800, 200, 10)
        _pushn(seed.day(1), 0, 0, 5)
        g = self._goal(seed, db)
        assert db.db_get_goal_burnup(g["id"])["actual"][-1] == g["completed"] == 15

    def test_is_an_allowed_goal_metric(self, seed, db):
        assert "notes_added" in db.SAFE_METRICS
