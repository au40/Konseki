"""GSM rollover attribution + manual time overlay.

The load-bearing rule from CLAUDE.md: any query surfacing session-level
chars/time must apply both overlays. The suite is built around that rule rather
than around individual functions —

  * `test_agreement.py`-style cross-surface checks (below, class CrossSurface)
    assert the read paths agree WITH EACH OTHER. Two surfaces disagreeing is the
    drift class the History page hit; a per-function test wouldn't catch it.
  * The scenario classes pin the documented edge cases: per-(source_date,
    game_id) keying, the max(0, ...) floor, no double-applied manual overlay,
    and speed derived from totals rather than sessions.reading_speed.
"""
import sqlite3

import pytest


# ── S1: baseline, no overlays ──────────────────────────────────────────────
class TestBaseline:
    def test_plain_day_passes_through(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(7))
        assert series[d] == (3600, 10_000)

        chars, secs, active = db.get_range_totals(7)
        assert (chars, secs, active) == (10_000, 3600, 1)

    def test_no_attribution_rows_means_no_adjustment(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=500, secs=600)
        assert db.get_gsm_day_adjustment(d) == (0, 0, 0)


# ── S2: a rollover displacement ────────────────────────────────────────────
class TestDisplacement:
    """A GSM pull at 01:00 with rollover_hour=4 writes rows under the real
    calendar date, but those chars belong to the previous logical day."""

    def test_chars_move_to_the_rollover_date(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600)
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[src] == (3600 - 1200, 10_000 - 4_000)
        assert series[roll] == (1200, 4_000)

    def test_displacement_conserves_totals(self, seed, db):
        """A displacement RELABELS which day owns the reading. It must never
        create or destroy any."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600)
        before = db.get_range_totals(10)
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        after = db.get_range_totals(10)
        assert before[0] == after[0], "chars must be conserved"
        assert before[1] == after[1], "seconds must be conserved"

    def test_fully_displaced_day_still_appears(self, seed, db):
        """If everything rolled out, the source day is empty but the rollover
        day must still show up — it has no session row of its own."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=8_000, secs=3600)
        seed.displace(roll, src, "g1", chars=8_000, secs=3600)

        tot = db._adjusted_day_totals()
        assert tot[roll] == (8_000, 3600)
        assert tot.get(src, (0, 0)) == (0, 0)

    def test_over_displacement_floors_at_zero(self, seed, db):
        """max(0, raw + delta): a displacement larger than the row can never
        drive a day negative."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=1_000, secs=600)
        seed.displace(roll, src, "g1", chars=5_000, secs=3000)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[src] == (0, 0)
        assert all(s >= 0 and c >= 0 for _, s, c in db.get_daily_time_series(10))


# ── S3: two games sharing one source_date ──────────────────────────────────
class TestPerGameKeying:
    """The bug CLAUDE.md documents: two different games read on the same real
    date, one displaced and one not. Keying the deduction on date alone let the
    second game's row absorb the first's shave."""

    def test_deduction_hits_only_the_displaced_game(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=6_000, secs=1800, game_id="g1", title="Pre-rollover")
        seed.gsm(src, chars=9_000, secs=2700, game_id="g2", title="Post-rollover")
        seed.displace(roll, src, "g1", chars=6_000, secs=1800)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        # g1 fully displaced; g2 untouched.
        assert series[src] == (2700, 9_000)
        assert series[roll] == (1800, 6_000)

    def test_net_per_day_is_game_agnostic(self, seed, db):
        """get_gsm_day_adjustment sums across games by design — the extra column
        must not change its math."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=6_000, secs=1800, game_id="g1")
        seed.gsm(src, chars=9_000, secs=2700, game_id="g2")
        seed.displace(roll, src, "g1", chars=1_000, secs=300)
        seed.displace(roll, src, "g2", chars=2_000, secs=600)

        assert db.get_gsm_day_adjustment(src) == (-3_000, -900, 0)
        assert db.get_gsm_day_adjustment(roll) == (3_000, 900, 0)


# ── S4/S5: the manual time overlay ─────────────────────────────────────────
class TestManualOverlay:
    def test_shave_reduces_that_day(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", -600)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(7))
        assert series[d] == (3000, 10_000), "time shaved, chars untouched"

    def test_shave_is_not_applied_twice(self, seed, db):
        """get_gsm_day_adjustment folds the manual overlay into secs_delta, so a
        caller that re-applied it on top would double-count."""
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", -600)

        _, secs_delta, _ = db.get_gsm_day_adjustment(d)
        assert secs_delta == -600
        series = dict((x[0], x[1]) for x in db.get_daily_time_series(7))
        assert series[d] == 3000, "3600 - 600 once, not twice"

    def test_all_time_total_includes_the_shave(self, seed, db):
        """Attribution nets to zero all-time, but a manual shave is a TRUE
        reduction — if all-time skipped it, the dashboard would drift from the
        daily views."""
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        assert db.get_all_time_totals()[2] == 3600
        seed.shave(d, "g1", -600)
        assert db.get_all_time_totals()[2] == 3000

    def test_zero_delta_deletes_the_row(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", -600)
        seed.shave(d, "g1", 0)
        assert db.get_manual_time_adjust(d, "g1") in (0, 0.0, None)
        assert db.get_gsm_day_adjustment(d)[1] == 0

    def test_displacement_and_shave_together(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.shave(src, "g1", -600)

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[src] == (3600 - 1200 - 600, 6_000)
        assert series[roll] == (1200, 4_000)

    def test_shave_never_drives_a_day_negative(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=600, game_id="g1")
        seed.shave(d, "g1", -99_999)
        series = dict((x[0], x[1]) for x in db.get_daily_time_series(7))
        assert series[d] == 0
        assert db.get_all_time_totals()[2] == 0


# ── The cross-surface invariant ────────────────────────────────────────────
def _scenarios(seed):
    """Every overlay combination, as (name, builder). Each builder seeds rows and
    returns nothing; the assertions are generic."""
    return {
        "plain": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
        ),
        "displacement": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
            seed.displace(seed.day(4), seed.day(3), "g1", 4_000, 1200),
        ),
        "two_games_one_date": lambda: (
            seed.gsm(seed.day(3), 6_000, 1800, game_id="g1", title="A"),
            seed.gsm(seed.day(3), 9_000, 2700, game_id="g2", title="B"),
            seed.displace(seed.day(4), seed.day(3), "g1", 6_000, 1800),
        ),
        "manual_only": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
            seed.shave(seed.day(3), "g1", -900),
        ),
        "both_overlays": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
            seed.displace(seed.day(4), seed.day(3), "g1", 4_000, 1200),
            seed.shave(seed.day(3), "g1", -600),
        ),
        "mixed_sources": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
            seed.session(seed.day(3), chars=0, secs=1800, source="manual",
                         title="Podcast", atype="Listening"),
            seed.displace(seed.day(4), seed.day(3), "g1", 4_000, 1200),
        ),
    }


class TestCrossSurface:
    """Each read path must agree with the others. This is the check that makes
    adding a new query safe — a path that forgets an overlay disagrees with the
    ones that didn't."""

    @pytest.mark.parametrize("name", ["plain", "displacement", "two_games_one_date",
                                      "manual_only", "both_overlays", "mixed_sources"])
    def test_daily_series_matches_adjusted_day_totals(self, seed, db, name):
        _scenarios(seed)[name]()
        series = {d: (c, s) for d, s, c in db.get_daily_time_series(14)}
        totals = db._adjusted_day_totals(seed.day(13))
        for d, (chars, secs) in totals.items():
            assert series[d] == (chars, secs), f"{name}: {d} disagrees"

    @pytest.mark.parametrize("name", ["plain", "displacement", "two_games_one_date",
                                      "manual_only", "both_overlays", "mixed_sources"])
    def test_daily_series_sums_to_range_totals(self, seed, db, name):
        _scenarios(seed)[name]()
        series = db.get_daily_time_series(14)
        chars, secs, _ = db.get_range_totals(14)
        assert sum(c for _, _, c in series) == chars, f"{name}: chars disagree"
        assert sum(s for _, s, _ in series) == secs, f"{name}: secs disagree"

    @pytest.mark.parametrize("name", ["plain", "displacement", "two_games_one_date",
                                      "manual_only", "both_overlays", "mixed_sources"])
    def test_heatmap_matches_daily_series(self, seed, db, name):
        _scenarios(seed)[name]()
        series = {d: s for d, s, _ in db.get_daily_time_series(14)}
        heat = db.get_heatmap_data(14)
        for d, secs in heat.items():
            assert series.get(d) == secs, f"{name}: heatmap disagrees on {d}"
        # every non-zero day in the series must be in the heatmap
        for d, s in series.items():
            if s > 0:
                assert d in heat, f"{name}: heatmap missing {d}"

    @pytest.mark.parametrize("name", ["plain", "displacement", "two_games_one_date",
                                      "manual_only", "both_overlays", "mixed_sources"])
    def test_recent_sessions_time_matches_the_daily_series(self, seed, db, name):
        """The per-row path (History) must total to the same per-day number as
        the net-per-day path. This is exactly where History drifted before."""
        _scenarios(seed)[name]()
        series = {d: s for d, s, _ in db.get_daily_time_series(14)}
        per_day = {}
        for row in db.get_recent_sessions(50):
            d, secs = row[1], row[7]
            per_day[d] = per_day.get(d, 0) + secs
        for d, secs in per_day.items():
            assert abs(series.get(d, 0) - secs) < 0.01, \
                f"{name}: History says {secs} on {d}, daily series says {series.get(d)}"

    @pytest.mark.parametrize("name", ["displacement", "both_overlays"])
    def test_all_time_equals_the_sum_of_days(self, seed, db, name):
        """Attribution nets to zero all-time; the manual shave doesn't. Both
        surfaces must land on the same number regardless."""
        _scenarios(seed)[name]()
        series_secs = sum(s for _, s, _ in db.get_daily_time_series(30))
        assert db.get_all_time_totals()[2] == series_secs


# ── The reading-speed invariant ────────────────────────────────────────────
class TestReadingSpeed:
    def test_stored_speed_is_wrong_after_a_deduction(self, seed, db):
        """sessions.reading_speed describes the PRE-deduction blend. After an
        attribution takes chars and time out by independent amounts, the stored
        column no longer matches any displayed number — which is why no read
        path may consult it."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")   # stored 10000/h
        seed.displace(roll, src, "g1", chars=8_000, secs=1200)

        con = sqlite3.connect(db.DB_PATH)
        stored = con.execute(
            "SELECT reading_speed FROM sessions WHERE session_date=?", (src,)
        ).fetchone()[0]
        con.close()

        series = {d: (c, s) for d, s, c in db.get_daily_time_series(10)}
        chars, secs = series[src]
        derived = chars / (secs / 3600)

        assert round(stored) == 10_000
        assert round(derived) == 3_000, "2000 chars over 2400s"
        assert round(derived) != round(stored), \
            "if these matched, the scenario isn't exercising the bug"

    def test_speed_derives_from_summed_totals(self, seed, db):
        """Aggregate speed is sum(chars)/sum(secs), never a mean of per-day
        speeds. The durations differ deliberately — with equal durations the two
        formulas coincide and the assertion would prove nothing."""
        seed.gsm(seed.day(3), chars=10_000, secs=3_600, game_id="g1")   # 10000/h in 1h
        seed.gsm(seed.day(2), chars=1_000, secs=36_000, game_id="g1")   #   100/h in 10h

        chars, secs, _ = db.get_range_totals(7)
        derived = chars / (secs / 3600)
        assert round(derived) == 1_000, "11000 chars over 11h"
        mean_of_daily = (10_000 + 100) / 2
        assert round(derived) != round(mean_of_daily), "must not be the mean (5050/h)"


# ── window_bounds clamping ─────────────────────────────────────────────────
class TestWindowClamp:
    def test_future_dated_rows_do_not_leak(self, seed, db):
        """During the rollover window GSM writes session_date values beyond
        logical today. Any aggregate must clamp them out."""
        seed.setting("rollover_hour", "0")
        today = seed.day(0)
        future = seed.day(-2)          # two days ahead of logical today
        seed.gsm(today, chars=1_000, secs=600, game_id="g1")
        seed.gsm(future, chars=99_999, secs=99_999, game_id="g1")

        tot = db._adjusted_day_totals()
        assert future not in tot, "future-dated row leaked past the clamp"

        chars, secs, _ = db.get_range_totals(7)
        assert chars == 1_000 and secs == 600

    def test_window_bounds_upper_edge_is_logical_today(self, seed, db):
        since, today = db.window_bounds(7)
        assert today == db.get_today()
        assert since == seed.day(6)


# ── M3 #8: the previous-period comparison ──────────────────────────────────
class TestPrevRange:
    """A new backend query, so it runs the standing checklist: it must apply
    both overlays and clamp, and it must agree with the current-period number
    it will be displayed next to."""

    def test_window_is_the_period_immediately_before(self, seed, db):
        # current 7d window is days 0..6; the prior one is days 7..13
        seed.gsm(seed.day(2), chars=1_000, secs=600, game_id="g1")     # current
        seed.gsm(seed.day(9), chars=5_000, secs=3000, game_id="g1")    # prior
        seed.gsm(seed.day(20), chars=9_999, secs=9_999, game_id="g1")  # older still

        assert db.get_range_totals(7)[:2] == (1_000, 600)
        assert db.get_prev_range_totals(7)[:2] == (5_000, 3000)

    def test_boundaries_are_inclusive_and_do_not_overlap(self, seed, db):
        seed.gsm(seed.day(6), chars=1, secs=1, game_id="g1")    # last day of current
        seed.gsm(seed.day(7), chars=2, secs=2, game_id="g1")    # first day of prior
        seed.gsm(seed.day(13), chars=4, secs=4, game_id="g1")   # last day of prior
        seed.gsm(seed.day(14), chars=8, secs=8, game_id="g1")   # just outside

        assert db.get_range_totals(7)[0] == 1
        assert db.get_prev_range_totals(7)[0] == 2 + 4

    def test_applies_the_manual_overlay(self, seed, db):
        seed.gsm(seed.day(9), chars=5_000, secs=3000, game_id="g1")
        assert db.get_prev_range_totals(7)[1] == 3000
        seed.shave(seed.day(9), "g1", -600)
        assert db.get_prev_range_totals(7)[1] == 2400

    def test_applies_rollover_attribution(self, seed, db):
        """A displacement inside the prior window relabels days but conserves
        the window total."""
        seed.gsm(seed.day(9), chars=5_000, secs=3000, game_id="g1")
        before = db.get_prev_range_totals(7)
        seed.displace(seed.day(10), seed.day(9), "g1", 2_000, 1200)
        assert db.get_prev_range_totals(7)[:2] == before[:2]

    def test_displacement_across_the_boundary_moves_between_windows(self, seed, db):
        """Reading on day 7 (prior window) displaced to day 6 (current window)
        must leave one and land in the other — no double count, no loss."""
        seed.gsm(seed.day(7), chars=4_000, secs=2400, game_id="g1")
        cur_before = db.get_range_totals(7)[0]
        prev_before = db.get_prev_range_totals(7)[0]
        seed.displace(seed.day(6), seed.day(7), "g1", 4_000, 2400)
        assert db.get_range_totals(7)[0] == cur_before + 4_000
        assert db.get_prev_range_totals(7)[0] == prev_before - 4_000

    def test_all_range_has_no_previous_period(self, seed, db):
        seed.gsm(seed.day(2), chars=1_000, secs=600, game_id="g1")
        assert db.get_prev_range_totals(None) == (0, 0.0, 0)
        assert db.get_prev_range_speed_basis(None) == (0, 0.0)

    def test_speed_basis_divides_like_the_displayed_figure(self, seed, db):
        """cph delta must come from summed chars over summed secs."""
        seed.gsm(seed.day(9), chars=10_000, secs=3_600, game_id="g1")
        seed.gsm(seed.day(10), chars=1_000, secs=36_000, game_id="g1")
        c, s = db.get_prev_range_speed_basis(7)
        assert round(c / (s / 3600)) == 1_000, "11000 chars over 11h"

    def test_until_clamp_never_widens_past_logical_today(self, seed, db):
        """_adjusted_day_totals gained an `until` argument for this; it must only
        ever narrow the window, never reach past the clamp."""
        seed.gsm(seed.day(0), chars=1_000, secs=600, game_id="g1")
        seed.gsm(seed.day(-3), chars=9_999, secs=9_999, game_id="g1")   # future
        tot = db._adjusted_day_totals(seed.day(10), seed.day(-5))
        assert seed.day(-3) not in tot


# ── M4: per-title daily series + shelf ─────────────────────────────────────
class TestTitleDaily:
    """_title_daily powers the shelf's activity strip and ETA. It's a per-DAY
    per-title view, so unlike a per-title total it must apply attribution —
    a displacement relabels which of the title's own days owns the reading."""

    def test_attribution_moves_a_titles_reading_between_its_own_days(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Book")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)

        dm = db._title_daily(30)["Book"]
        assert dm[src] == [6_000, 2400]
        assert dm[roll] == [4_000, 1200]

    def test_displacement_conserves_the_titles_window_total(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Book")
        before = sum(s for c, s in db._title_daily(30)["Book"].values())
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        after = sum(s for c, s in db._title_daily(30)["Book"].values())
        assert before == after

    def test_manual_shave_applies_and_touches_time_only(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Book")
        seed.shave(d, "g1", -600)
        assert db._title_daily(30)["Book"][d] == [10_000, 3000]

    def test_future_dated_rows_are_clamped(self, seed, db):
        seed.gsm(seed.day(1), chars=100, secs=60, game_id="g1", title="Book")
        seed.gsm(seed.day(-3), chars=9_999, secs=9_999, game_id="g1", title="Book")
        assert seed.day(-3) not in db._title_daily(30)["Book"]

    def test_agrees_with_the_per_title_total(self, seed, db):
        """Cross-surface: with every day inside the window and a displacement
        whose endpoints are both in range, the per-day series must sum to the
        same number the media grid shows as the title's total."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Book")
        seed.gsm(seed.day(8), chars=5_000, secs=1800, game_id="g1", title="Book")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.shave(src, "g1", -300)

        per_day = sum(s for c, s in db._title_daily(30)["Book"].values())
        total = next(m["total_secs"] for m in db.get_media_stats() if m["title"] == "Book")
        assert per_day == total

    def test_spark_is_dense_and_ends_today(self, seed, db):
        seed.gsm(seed.day(0), chars=1, secs=600, game_id="g1", title="Book")
        seed.gsm(seed.day(29), chars=1, secs=300, game_id="g1", title="Book")
        spark = db._title_spark(db._title_daily(30)["Book"], 30)
        assert len(spark) == 30
        assert spark[-1] == 600, "last cell is today"
        assert spark[0] == 300, "first cell is 29 days ago"
        assert sum(1 for v in spark if v) == 2

    def test_recent_speed_is_totals_first_then_divide(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3_600, game_id="g1", title="Book")
        seed.gsm(seed.day(4), chars=1_000, secs=36_000, game_id="g1", title="Book")
        spd = db._title_recent_speed(db._title_daily(30)["Book"])
        assert round(spd) == 1_000, "11000 chars over 11h"
        assert round(spd) != round((10_000 + 100) / 2), "not the mean of daily speeds"

    def test_recent_speed_ignores_days_with_no_reading(self, seed, db):
        seed.gsm(seed.day(20), chars=10_000, secs=3600, game_id="g1", title="Book")
        # a long gap must not dilute the trailing speed
        assert round(db._title_recent_speed(db._title_daily(90)["Book"])) == 10_000


class TestMediaShelf:
    def _book(self, seed, db, chars=4_000, length=10_000):
        seed.gsm(seed.day(2), chars=chars, secs=3600, game_id="g1", title="Book")
        db.db_set_media_char_count("Book", length)

    def test_in_progress_title_appears_with_pct_and_eta(self, seed, db):
        self._book(seed, db)
        row = db.get_media_shelf()[0]
        assert len(row["spark"]) == 30, "activity strip rides on the shelf row"
        assert row["title"] == "Book"
        assert round(row["pct"]) == 40
        assert row["remaining"] == 6_000
        assert round(row["speed"]) == 4_000          # 4000 chars in 1h
        assert round(row["eta_hours"], 1) == 1.5     # 6000 / 4000
        assert row["length_source"] == "user"

    def test_completed_titles_are_excluded(self, seed, db):
        self._book(seed, db)
        assert len(db.get_media_shelf()) == 1
        db.db_set_media_complete("Book", True)
        assert db.get_media_shelf() == []

    def test_titles_without_a_known_length_are_excluded(self, seed, db):
        seed.gsm(seed.day(2), chars=4_000, secs=3600, game_id="g1", title="Book")
        assert db.get_media_shelf() == []

    def test_user_length_wins_over_gsm(self, seed, db):
        seed.gsm(seed.day(2), chars=4_000, secs=3600, game_id="g1", title="Book")
        con = sqlite3.connect(db.DB_PATH)
        con.execute("INSERT INTO gsm_games (game_id, game_name, char_count, last_updated) "
                    "VALUES ('g1','Book',99999,datetime('now'))")
        con.commit(); con.close()
        assert db.get_media_shelf()[0]["length"] == 99999
        db.db_set_media_char_count("Book", 8_000)
        row = db.get_media_shelf()[0]
        assert row["length"] == 8_000 and row["length_source"] == "user"

    def test_shelf_total_matches_the_media_grid(self, seed, db):
        """Both surfaces describe the same title; a shave must land on both."""
        self._book(seed, db)
        seed.shave(seed.day(2), "g1", -600)
        shelf = db.get_media_shelf()[0]
        grid = next(m for m in db.get_media_stats() if m["title"] == "Book")
        assert shelf["total_secs"] == grid["total_secs"] == 3000
        assert shelf["total_chars"] == grid["total_chars"]

    def test_pct_never_exceeds_100(self, seed, db):
        self._book(seed, db, chars=20_000, length=10_000)
        row = db.get_media_shelf()[0]
        assert row["pct"] == 100.0
        assert row["remaining"] == 0
        assert row["eta_hours"] == 0
