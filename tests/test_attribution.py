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


class TestPositiveOverlay:
    """The overlay is signed. A POSITIVE delta credits time GSM under-measured —
    the live pull derives time as chars ÷ speed rather than measuring it, so a
    slightly high speed figure silently loses real minutes.

    Every one of these has a negative twin above; the point is that both signs
    reach the same surfaces, because the per-row paths used to filter for
    negatives only while the per-day paths did not."""

    def test_credit_increases_that_day(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(7))
        assert series[d] == (3909, 10_000), "time added, chars untouched"

    def test_credit_reaches_the_all_time_total(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        assert db.get_all_time_totals()[2] == 3909

    def test_credit_lands_on_the_dashboard_row(self, seed, db):
        """The regression this class exists for: the per-row path filtered for
        negative deltas, so a credit moved the day total but not the row — the
        dashboard and its own total would disagree."""
        d = seed.day(0)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        rows = [r for r in db.get_today_stats() if r[7] == "g1"]
        assert len(rows) == 1
        assert rows[0][6] == 3909

    def test_credit_lands_on_the_history_row(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        rows = [r for r in db.get_recent_sessions(50) if r[8] == "g1"]
        assert len(rows) == 1
        assert rows[0][7] == 3909

    def test_dashboard_row_total_matches_the_day_total(self, seed, db):
        """The cross-surface invariant, stated directly for a credit."""
        d = seed.day(0)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        row_secs = sum(r[6] for r in db.get_today_stats())
        series   = dict((x[0], x[1]) for x in db.get_daily_time_series(7))
        assert row_secs == series[d] == 3909

    def test_credit_targets_only_its_own_game(self, seed, db):
        d = seed.day(0)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1", title="One")
        seed.gsm(d, chars=2_000, secs=1800, game_id="g2", title="Two")
        seed.shave(d, "g1", 309)
        by_game = {r[7]: r[6] for r in db.get_today_stats()}
        assert by_game["g1"] == 3909
        assert by_game["g2"] == 1800

    def test_credit_lands_once_across_a_games_rows(self, seed, db):
        """A game can hold two rows in today's bucket — its own, plus a phantom
        synthesized from reading displaced in from another date. A credit needs
        no budget-spreading, so it must land WHOLE on one row, not on each.

        Built from a displacement rather than the rollover window so it doesn't
        depend on the clock: one GSM row per (game, date) is enforced by
        idx_gsm_one_row_per_day, so a second row for one game can only be a
        phantom."""
        today, prev = seed.day(0), seed.day(1)
        seed.gsm(today, chars=1_000, secs=1800, game_id="g1")
        seed.gsm(prev,  chars=500,   secs=900,  game_id="g1")
        seed.displace(today, prev, "g1", chars=500, secs=900)
        seed.shave(today, "g1", 300)

        rows = [r for r in db.get_today_stats() if r[7] == "g1"]
        assert len(rows) == 2, "own row plus the phantom"
        # The credit lands once, on the row that is natively today's.
        assert sorted(r[6] for r in rows) == [900, 2100]
        assert sum(r[6] for r in rows) == 3000

    def test_credit_affects_per_title_speed(self, seed, db):
        """Chars stay, time grows, so reading speed FALLS — the mirror of a shave
        raising it. Derived from the displayed chars/time, never the stored
        reading_speed column."""
        d = seed.day(2)
        seed.gsm(d, chars=7200, secs=3600, game_id="g1", title="One")
        core = db._compute_title_core("One")
        assert core["daily"][-1]["speed"] == pytest.approx(7200)
        seed.shave(d, "g1", 3600)
        core = db._compute_title_core("One")
        assert core["daily"][-1]["speed"] == pytest.approx(3600)

    def test_credit_and_displacement_together(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.shave(src, "g1", 309)
        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[src] == (3600 - 1200 + 309, 6_000)
        assert series[roll] == (1200, 4_000)

    def test_zero_still_clears(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", 309)
        seed.shave(d, "g1", 0)
        assert db.get_manual_time_adjust(d, "g1") in (0, 0.0, None)
        assert db.get_gsm_day_adjustment(d)[1] == 0


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
        # Anki carries no game_id, so neither overlay can reach it — but its time
        # still has to agree across every surface, and sit on the same day as a
        # displacement that moved GSM's time off that date.
        "with_anki": lambda: (
            seed.gsm(seed.day(3), 10_000, 3600, game_id="g1"),
            seed.session(seed.day(3), secs=1800, source="anki", title="Anki",
                         atype="Vocabulary", cards=210),
            seed.displace(seed.day(4), seed.day(3), "g1", 4_000, 1200),
        ),
        # A suppressed Anki day: its cards count everywhere, its time nowhere.
        "anki_suppressed": lambda: (
            seed.session(seed.day(3), secs=900, source="manual", title=None,
                         atype="Vocabulary"),
            seed.session(seed.day(3), secs=1800, source="anki", title="Anki",
                         atype="Vocabulary", cards=210, time_excluded=1),
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


# ── M5: the lifetime showcase views ────────────────────────────────────────
class TestTitleStreams:
    def test_weekly_buckets_and_dense_axis(self, seed, db):
        seed.gsm(seed.day(21), chars=1_000, secs=600, game_id="g1", title="A")
        seed.gsm(seed.day(0),  chars=2_000, secs=600, game_id="g1", title="A")
        s = db.get_title_streams(None, 8)
        # Gaps must be present as zero weeks, not skipped, or a hiatus silently
        # compresses and the area chart lies about the timeline.
        assert len(s["dates"]) >= 3
        gaps = [v for v in s["series"][0]["values"] if v == 0]
        assert gaps, "the quiet weeks between should render as zero"
        assert sum(s["series"][0]["values"]) == 3_000

    def test_dates_are_mondays_in_order(self, seed, db):
        seed.gsm(seed.day(10), chars=100, secs=60, game_id="g1", title="A")
        seed.gsm(seed.day(0), chars=100, secs=60, game_id="g1", title="A")
        from datetime import datetime as _dt
        dates = db.get_title_streams(None, 8)["dates"]
        assert dates == sorted(dates)
        assert all(_dt.strptime(d, "%Y-%m-%d").weekday() == 0 for d in dates)

    def test_only_true_dust_collapses_into_other(self, seed, db):
        """Inclusion is by share, not a top-N cap — a title you spent real time
        on must get its own band however many titles exist."""
        for i in range(6):
            seed.gsm(seed.day(3), chars=10_000, secs=600, game_id=f"g{i}", title=f"Big{i}")
        seed.gsm(seed.day(3), chars=5, secs=60, game_id="gd", title="Dust")

        s = db.get_title_streams(None)
        names = [x["title"] for x in s["series"]]
        assert len([n for n in names if n.startswith("Big")]) == 6,             "every substantial title keeps its own band"
        assert "Other" in names and "Dust" not in names
        assert next(x for x in s["series"] if x["title"] == "Other")["other_count"] == 1
        # Nothing may be lost to the residual bucket.
        assert sum(sum(x["values"]) for x in s["series"]) == 6 * 10_000 + 5

    def test_a_single_dusty_title_still_renders(self, seed, db):
        seed.gsm(seed.day(3), chars=5, secs=60, game_id="g1", title="Only")
        assert [x["title"] for x in db.get_title_streams(None)["series"]] == ["Only"]

    def test_applies_attribution(self, seed, db):
        src, roll = seed.day(10), seed.day(11)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="A")
        before = sum(sum(x["values"]) for x in db.get_title_streams(None, 8)["series"])
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        after = sum(sum(x["values"]) for x in db.get_title_streams(None, 8)["series"])
        assert before == after, "a displacement relabels, never creates or destroys"

    def test_empty_db(self, seed, db):
        assert db.get_title_streams(None, 8) == {"dates": [], "series": []}


class TestSpeedDistributions:
    def test_quantiles_on_a_known_set(self, seed, db):
        # speeds 1000..5000/h on five days (1h each, chars = the speed)
        for i, c in enumerate([1000, 2000, 3000, 4000, 5000]):
            seed.gsm(seed.day(10 + i), chars=c, secs=3600, game_id="g1", title="A")
        r = db.get_title_speed_distributions(min_days=5)[0]
        assert r["days"] == 5
        assert round(r["min"]) == 1000
        assert round(r["q1"]) == 2000
        assert round(r["median"]) == 3000
        assert round(r["q3"]) == 4000
        assert round(r["max"]) == 5000

    def test_mean_is_totals_not_the_average_of_daily_speeds(self, seed, db):
        """The distinction that matters: with unequal durations these differ."""
        seed.gsm(seed.day(10), chars=10_000, secs=3_600, game_id="g1", title="A")
        for i in range(4):
            seed.gsm(seed.day(11 + i), chars=1_000, secs=36_000, game_id="g1", title="A")
        r = db.get_title_speed_distributions(min_days=5)[0]
        overall = 14_000 / ((3_600 + 4 * 36_000) / 3600)
        assert round(r["mean"]) == round(overall)
        assert round(r["mean"]) != round(sum([10_000, 100, 100, 100, 100]) / 5)

    def test_every_qualifying_title_is_returned(self, seed, db):
        """No top-N cap: the chart grows instead of hiding titles."""
        for g in range(15):
            for i in range(5):
                seed.gsm(seed.day(10 + i), chars=1_000 + g, secs=3600,
                         game_id=f"g{g}", title=f"T{g}")
        assert len(db.get_title_speed_distributions(min_days=5)) == 15

    def test_thin_titles_are_excluded(self, seed, db):
        for i in range(3):
            seed.gsm(seed.day(10 + i), chars=1_000, secs=3600, game_id="g1", title="A")
        assert db.get_title_speed_distributions(min_days=5) == []
        assert len(db.get_title_speed_distributions(min_days=3)) == 1

    def test_sorted_slowest_median_first(self, seed, db):
        for i in range(5):
            seed.gsm(seed.day(10 + i), chars=9_000, secs=3600, game_id="g1", title="Fast")
            seed.gsm(seed.day(10 + i), chars=1_000, secs=3600, game_id="g2", title="Slow")
        rows = db.get_title_speed_distributions(min_days=5)
        assert [r["title"] for r in rows] == ["Slow", "Fast"]

    def test_chars_less_days_do_not_enter_the_distribution(self, seed, db):
        for i in range(5):
            seed.gsm(seed.day(10 + i), chars=2_000, secs=3600, game_id="g1", title="A")
        seed.gsm(seed.day(20), chars=0, secs=7200, game_id="g1", title="A")
        r = db.get_title_speed_distributions(min_days=5)[0]
        assert r["days"] == 5, "a chars-less day has no speed and must not count"

    def test_quantile_helper_edges(self, seed, db):
        assert db._quantile([], 0.5) == 0.0
        assert db._quantile([7], 0.5) == 7.0
        assert db._quantile([0, 10], 0.5) == 5.0


class TestActivityTrend:
    def test_starts_at_the_first_session_not_a_fixed_window(self, seed, db):
        """It sits under a "Lifetime" heading. An earlier cut capped at 24
        months via `31 * (months-1)` days, which truncated long histories and
        started on an arbitrary month because 31-day months overshoot."""
        seed.gsm(seed.day(1200), chars=1, secs=60, game_id="g1", title="Old")
        seed.gsm(seed.day(1), chars=1, secs=60, game_id="g1", title="New")
        rows = db.get_activity_trend(None)
        assert rows[0]["month"] == seed.day(1200)[:7], "starts at the first session"
        assert rows[-1]["month"] == seed.day(1)[:7]

    def test_month_axis_is_dense(self, seed, db):
        seed.gsm(seed.day(200), chars=1, secs=60, game_id="g1", title="A")
        seed.gsm(seed.day(1), chars=1, secs=60, game_id="g1", title="A")
        rows = db.get_activity_trend(None)
        assert any(not r["types"] for r in rows), "quiet months are empty columns, not gaps"
        months = [r["month"] for r in rows]
        assert months == sorted(months) and len(set(months)) == len(months)

    def test_explicit_month_cap_still_works(self, seed, db):
        seed.gsm(seed.day(400), chars=1, secs=60, game_id="g1", title="A")
        seed.gsm(seed.day(1), chars=1, secs=60, game_id="g1", title="A")
        assert len(db.get_activity_trend(3)) <= 3

    def test_groups_by_month_and_keeps_types(self, seed, db):
        seed.gsm(seed.day(1), chars=1_000, secs=3600, game_id="g1", title="A")
        seed.session(seed.day(1), chars=0, secs=1800, source="manual",
                     title="Pod", atype="Listening")
        rows = db.get_activity_trend(24)
        assert rows, "should produce at least this month"
        last = rows[-1]["types"]
        assert last.get("Reading") == 3600
        assert last.get("Listening") == 1800

    def test_manual_shave_reaches_the_reading_slice(self, seed, db):
        seed.gsm(seed.day(1), chars=1_000, secs=3600, game_id="g1", title="A")
        seed.shave(seed.day(1), "g1", -600)
        assert db.get_activity_trend(24)[-1]["types"]["Reading"] == 3000

    def test_months_are_ordered_oldest_first(self, seed, db):
        seed.gsm(seed.day(1), chars=1, secs=60, game_id="g1", title="A")
        seed.gsm(seed.day(80), chars=1, secs=60, game_id="g1", title="A")
        months = [r["month"] for r in db.get_activity_trend(24)]
        assert months == sorted(months)

    def test_empty_db(self, seed, db):
        assert db.get_activity_trend(24) == []


# ── M5 follow-up: series are one entity in the lifetime views ──────────────
class TestSeriesGrouping:
    """A series is one work split across volumes. Keeping members separate
    fragmented it into near-identical slivers and let a long series dominate the
    legend, so the lifetime charts merge them."""

    def _two_volumes(self, seed):
        seed.gsm(seed.day(10), chars=6_000, secs=3600, game_id="g1", title="Vol 1")
        seed.gsm(seed.day(9),  chars=4_000, secs=3600, game_id="g2", title="Vol 2")

    def test_streams_show_one_band_per_series(self, seed, db):
        self._two_volumes(seed)
        assert len(db.get_title_streams(None)["series"]) == 2   # ungrouped
        seed.series("My Series", "Vol 1", "Vol 2")
        s = db.get_title_streams(None)["series"]
        assert len(s) == 1
        assert s[0]["display_title"] == "My Series"
        assert sum(s[0]["values"]) == 10_000, "both volumes, nothing lost"

    def test_grouping_does_not_change_the_total(self, seed, db):
        self._two_volumes(seed)
        before = sum(sum(x["values"]) for x in db.get_title_streams(None)["series"])
        seed.series("My Series", "Vol 1", "Vol 2")
        after = sum(sum(x["values"]) for x in db.get_title_streams(None)["series"])
        assert before == after

    def test_ungrouped_titles_are_untouched(self, seed, db):
        self._two_volumes(seed)
        seed.gsm(seed.day(8), chars=5_000, secs=3600, game_id="g3", title="Standalone")
        seed.series("My Series", "Vol 1", "Vol 2")
        names = {x["display_title"] for x in db.get_title_streams(None)["series"]}
        assert names == {"My Series", "Standalone"}

    def test_same_day_volumes_merge_before_speed_is_derived(self, seed, db):
        """The reason merging happens at the DAY level: a day spent on two
        volumes must yield ONE day whose speed is combined chars over combined
        secs, not two days averaged."""
        # Durations differ deliberately: with equal ones the combined speed and
        # the mean of the two coincide and the assertion proves nothing.
        #   Vol 1  9000 chars /  1h  -> 9000/h
        #   Vol 2  1000 chars / 10h  ->  100/h
        #   combined 10000 / 11h     ->  909/h   <- the only correct answer
        #   mean of the two          -> 4550/h   <- what splitting would give
        d = seed.day(10)
        seed.gsm(d, chars=9_000, secs=3_600, game_id="g1", title="Vol 1")
        seed.gsm(d, chars=1_000, secs=36_000, game_id="g2", title="Vol 2")
        for i in range(1, 5):                       # pad to clear min_days
            seed.gsm(seed.day(10 + i), chars=5_000, secs=3600, game_id="g1", title="Vol 1")
        seed.series("My Series", "Vol 1", "Vol 2")

        r = db.get_title_speed_distributions(min_days=5)[0]
        assert r["days"] == 5, "the shared day counts once, not twice"
        assert round(r["min"]) == 909, "combined chars over combined secs"
        assert round(r["min"]) != 4_550, "not the mean of the two volumes' speeds"

    def test_speed_rows_use_the_series_name(self, seed, db):
        for i in range(5):
            seed.gsm(seed.day(10 + i), chars=2_000, secs=3600, game_id="g1", title="Vol 1")
        seed.series("My Series", "Vol 1")
        assert db.get_title_speed_distributions(min_days=5)[0]["display_title"] == "My Series"

    def test_unnamed_series_takes_its_first_member_name(self, seed, db):
        """Dragging one card onto another creates a series with name=NULL, and
        the rest of the app names those after their first member (see
        get_series_data). The lifetime views must match, not invent a
        placeholder."""
        self._two_volumes(seed)
        seed.series(None, "Vol 1", "Vol 2")
        s = db.get_title_streams(None)["series"]
        assert s[0]["display_title"] == "Vol 1"
        assert "Untitled" not in s[0]["display_title"]

    def test_first_member_is_by_position_not_insertion(self, seed, db):
        seed.gsm(seed.day(10), chars=1_000, secs=600, game_id="g1", title="Zeta")
        seed.gsm(seed.day(10), chars=1_000, secs=600, game_id="g2", title="Alpha")
        seed.series(None, "Zeta", "Alpha")          # position 0 is Zeta
        assert db.get_title_streams(None)["series"][0]["display_title"] == "Zeta"

    def test_an_explicit_name_still_wins(self, seed, db):
        self._two_volumes(seed)
        seed.series("Proper Name", "Vol 1", "Vol 2")
        assert db.get_title_streams(None)["series"][0]["display_title"] == "Proper Name"

    def test_group_keys_cannot_collide_with_a_real_title(self, seed, db):
        seed.gsm(seed.day(10), chars=1_000, secs=600, game_id="g1", title="Vol 1")
        sid = seed.series("My Series", "Vol 1")
        keys = [x["title"] for x in db.get_title_streams(None)["series"]]
        assert keys == [f"series:{sid}"]


# ── Sessions-folder pipeline removal ───────────────────────────────────────
class TestIngestedFilesDropped:
    """The sessions/ drop-folder is gone: the GSM pull used to write a JSON and
    read it straight back one line later, and nothing else used the folder.
    `ingested_files` only ever de-duplicated those files, so init_db drops it."""

    def test_init_db_drops_a_pre_existing_table(self, seed, db):
        con = sqlite3.connect(db.DB_PATH)
        con.execute("CREATE TABLE IF NOT EXISTS ingested_files "
                    "(filepath TEXT PRIMARY KEY, ingested_at TEXT NOT NULL)")
        con.execute("INSERT INTO ingested_files VALUES ('old.json', 'x')")
        con.commit()
        con.close()

        db.init_db()

        con = sqlite3.connect(db.DB_PATH)
        rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ingested_files'"
        ).fetchall()
        con.close()
        assert rows == [], "the obsolete table should be dropped on sight"

    def test_init_db_is_idempotent_without_it(self, seed, db):
        db.init_db()
        db.init_db()
        con = sqlite3.connect(db.DB_PATH)
        n = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        con.close()
        assert n == 0

    def test_the_file_helpers_are_gone(self, seed, db):
        for name in ("ingest_session_file", "scan_existing_files",
                     "already_ingested", "mark_ingested", "SESSIONS_DIR"):
            assert not hasattr(db, name), f"{name} should have been removed"

    def test_sessions_folder_is_no_longer_created(self, seed, db):
        import os
        db.init_db()
        assert not os.path.isdir(os.path.join(str(db.DATA_DIR), "sessions"))


# ── M6: the goals burn-up ──────────────────────────────────────────────────
_ALL_SCENARIOS = ["plain", "displacement", "two_games_one_date",
                  "manual_only", "both_overlays", "mixed_sources"]


def _add_goal(seed, db, metric="chars_read", target=100_000,
              start=10, deadline=-10, atype=None):
    """A goal whose window brackets every date the shared scenarios seed."""
    db.db_add_goal("G", metric, float(target), seed.day(deadline), "daily",
                   atype, False, seed.day(start))
    return db.db_get_goals()[-1]["id"]


def _card(db, gid):
    return next(g for g in db.db_get_goal_progress() if g["id"] == gid)


class TestGoalBurnup:
    """db_get_goal_burnup plots the goal card's `completed` day by day, so the
    last point IS that number — not a second formula that happens to agree.
    That is the whole reason the running total is floored rather than each day:
    per-day floors would let one over-displaced day inflate the sum above the
    card."""

    @pytest.mark.parametrize("name", _ALL_SCENARIOS)
    @pytest.mark.parametrize("metric", ["chars_read", "time_seconds"])
    def test_last_point_equals_the_card(self, seed, db, name, metric):
        _scenarios(seed)[name]()
        gid = _add_goal(seed, db, metric=metric)
        burn = db.db_get_goal_burnup(gid)
        assert burn["actual"][-1] == pytest.approx(_card(db, gid)["completed"]), \
            f"{name}/{metric}: the chart and the card disagree"

    @pytest.mark.parametrize("name", _ALL_SCENARIOS)
    def test_series_never_goes_backwards(self, seed, db, name):
        """It is a cumulative line. A day whose net adjustment is negative
        shrinks the increment, never the running total below its last value —
        except through the zero floor, which can only apply while it is at 0."""
        _scenarios(seed)[name]()
        vals = db.db_get_goal_burnup(_add_goal(seed, db))["actual"]
        assert all(b >= a for a, b in zip(vals, vals[1:])), f"{name}: {vals}"

    def test_axis_is_dense(self, seed, db):
        """One point per day from the start, including days with no reading —
        a sparse axis would compress a hiatus and flatter the pace."""
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1")
        burn = db.db_get_goal_burnup(_add_goal(seed, db, start=5))
        assert burn["dates"] == [seed.day(i) for i in range(5, -1, -1)]
        assert burn["actual"][:2] == [0.0, 0.0], "quiet days are zeros, not gaps"

    def test_stops_at_logical_today(self, seed, db):
        """window_bounds clamp: GSM writes session_date at the real calendar
        date, which runs ahead of logical today inside the rollover window."""
        seed.gsm(seed.day(1), chars=1_000, secs=600, game_id="g1")
        seed.gsm(seed.day(-2), chars=99_999, secs=99_999, game_id="g1")
        burn = db.db_get_goal_burnup(_add_goal(seed, db))
        assert burn["dates"][-1] == seed.day(0)
        assert burn["actual"][-1] == 1_000, "future-dated row leaked past the clamp"

    def test_stops_at_the_deadline_once_it_has_passed(self, seed, db):
        """Past-deadline goals stop counting, so the line must stop too."""
        seed.gsm(seed.day(6), chars=1_000, secs=600, game_id="g1")
        seed.gsm(seed.day(2), chars=5_000, secs=600, game_id="g1")   # after deadline
        burn = db.db_get_goal_burnup(_add_goal(seed, db, start=10, deadline=4))
        assert burn["dates"][-1] == seed.day(4)
        assert burn["actual"][-1] == 1_000

    def test_a_displacement_inside_the_window_only_moves_a_day(self, seed, db):
        """Both endpoints in range, so the total is untouched and only the shape
        of the climb changes."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")
        gid = _add_goal(seed, db)
        before = db.db_get_goal_burnup(gid)["actual"][-1]
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        after = db.db_get_goal_burnup(gid)
        i_roll = after["dates"].index(roll)
        assert after["actual"][-1] == before, "a displacement conserves the total"
        assert after["actual"][i_roll] == 4_000, "the climb starts a day earlier"

    def test_a_displacement_out_of_the_window_lowers_the_total(self, seed, db):
        """Chars pushed to a rollover_date before the goal started have left the
        goal. The card must lose them too — this is the check that would catch
        the burn-up applying attribution the card doesn't, or vice versa."""
        gid = _add_goal(seed, db, start=5)
        src, roll = seed.day(5), seed.day(6)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        burn = db.db_get_goal_burnup(gid)
        assert burn["actual"][-1] == 6_000
        assert burn["actual"][-1] == pytest.approx(_card(db, gid)["completed"])

    def test_manual_shave_reaches_a_time_goal(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", -600)
        assert db.db_get_goal_burnup(
            _add_goal(seed, db, metric="time_seconds", target=360_000))["actual"][-1] == 3000

    def test_manual_shave_is_not_double_applied(self, seed, db):
        """get_gsm_day_adjustments already folds the manual overlay into
        secs_delta; re-applying it here would shave twice."""
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        full = db.db_get_goal_burnup(gid)["actual"][-1]
        seed.shave(d, "g1", -600)
        assert db.db_get_goal_burnup(gid)["actual"][-1] == full - 600

    def test_manual_shave_leaves_a_chars_goal_alone(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.shave(d, "g1", -600)
        assert db.db_get_goal_burnup(_add_goal(seed, db))["actual"][-1] == 10_000

    def test_activity_filter_excludes_other_types(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.session(d, chars=0, secs=1800, source="manual",
                     title="Podcast", atype="Listening")
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000,
                        atype="Reading")
        assert db.db_get_goal_burnup(gid)["actual"][-1] == 3600

    def test_a_non_reading_goal_ignores_gsm_attribution(self, seed, db):
        """GSM is always 'Reading', so a Listening goal must not pick up the
        adjustment — mirrors db_get_goal_progress's apply_attr."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1")
        seed.session(src, chars=0, secs=1800, source="manual",
                     title="Podcast", atype="Listening")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000,
                        atype="Listening")
        burn = db.db_get_goal_burnup(gid)
        assert burn["actual"][-1] == 1800
        # roll (day 4) precedes src (day 3), so an incoming GSM displacement
        # would show up as a climb before the Listening session even happened.
        assert burn["actual"][burn["dates"].index(roll)] == 0, "phantom climb"

    def test_the_running_total_floors_at_zero(self, seed, db):
        seed.gsm(seed.day(3), chars=1_000, secs=600, game_id="g1")
        seed.shave(seed.day(3), "g1", -99_999)
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        burn = db.db_get_goal_burnup(gid)
        assert all(v >= 0 for v in burn["actual"])
        assert burn["actual"][-1] == pytest.approx(_card(db, gid)["completed"])

    def test_the_floor_is_on_the_running_total_not_on_each_day(self, seed, db):
        """The card floors the summed window once. Flooring each day instead
        would discard the overhang of an over-shaved day and let later days
        climb from an inflated base — 1200s of "progress" the card says is 0.
        Two days are needed to tell the two rules apart; one day cannot."""
        seed.gsm(seed.day(4), chars=1_000, secs=600, game_id="g1")
        seed.shave(seed.day(4), "g1", -99_999)          # drives day 4 far negative
        seed.gsm(seed.day(3), chars=2_000, secs=1_200, game_id="g1")
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        burn = db.db_get_goal_burnup(gid)
        assert burn["actual"][-1] == 0, "the overhang must still be owed"
        assert burn["actual"][-1] != 1_200, "that is what a per-day floor gives"
        assert burn["actual"][-1] == pytest.approx(_card(db, gid)["completed"])

    def test_a_start_in_the_future_yields_an_empty_series(self, seed, db):
        gid = _add_goal(seed, db, start=-3, deadline=-10)
        burn = db.db_get_goal_burnup(gid)
        assert burn["dates"] == [] and burn["actual"] == []
        assert burn["target"] == 100_000, "the axis metadata still comes back"

    def test_an_unknown_goal_returns_none(self, seed, db):
        assert db.db_get_goal_burnup(9999) is None


class TestGoalLengthAndBanked:
    """A goal's start date and deadline are both reading days, and days banked
    is reading above that plan line in days of its daily amount. The card used
    to mix deadline − start with the inclusive count, which marked the
    deadline day Overdue and showed a fresh short goal as already ahead."""

    def _read(self, seed, offset, chars):
        seed.session(seed.day(offset), chars=chars, secs=600, source="manual")

    def test_length_counts_both_ends(self, seed, db):
        gid = _add_goal(seed, db, start=4, deadline=-5)     # 10 calendar days
        card = _card(db, gid)
        assert card["total_days"] == 10
        assert card["original_chunk"] == pytest.approx(10_000)

    def test_the_deadline_day_is_not_overdue(self, seed, db):
        gid = _add_goal(seed, db, start=9, deadline=0)
        card = _card(db, gid)
        assert card["days_left"] == 0
        assert card["is_overdue"] is False
        assert card["chunk_needed"] == pytest.approx(100_000), "the whole rest is due today"

    def test_the_day_after_the_deadline_is(self, seed, db):
        assert _card(db, _add_goal(seed, db, start=9, deadline=1))["is_overdue"] is True

    def test_on_plan_through_yesterday_reads_zero_before_today_is_read(self, seed, db):
        gid = _add_goal(seed, db, start=4, deadline=-5)     # 10k/day plan, day 5
        for d in (4, 3, 2, 1):
            self._read(seed, d, 10_000)
        assert _card(db, gid)["banked_days"] == pytest.approx(0), \
            "today's unread share must not count against you yet"
        self._read(seed, 0, 4_000)
        assert _card(db, gid)["banked_days"] == pytest.approx(0), \
            "reading less than today's share leaves the figure where it was"

    def test_reading_past_todays_share_banks_it(self, seed, db):
        gid = _add_goal(seed, db, start=4, deadline=-5)
        for d in (4, 3, 2, 1):
            self._read(seed, d, 10_000)
        self._read(seed, 0, 15_000)
        card = _card(db, gid)
        assert card["banked_amount"] == pytest.approx(5_000)
        assert card["banked_days"] == pytest.approx(0.5)

    def test_closed_short_days_are_owed(self, seed, db):
        gid = _add_goal(seed, db, start=4, deadline=-5)
        self._read(seed, 4, 10_000)
        self._read(seed, 3, 10_000)
        assert _card(db, gid)["banked_days"] == pytest.approx(-2)

    def test_one_big_first_day_is_not_extrapolated(self, seed, db):
        """The example the old figure got wrong: 3 days' worth on day one of a
        two-week goal banks 2 days. The projection still says 9 days early —
        that's what it's for, but it isn't slack."""
        gid = _add_goal(seed, db, target=140_000, start=0, deadline=-13)
        self._read(seed, 0, 30_000)
        card = _card(db, gid)
        assert card["banked_days"] == pytest.approx(2)
        assert card["projected_days_delta"] == -9

    def test_no_figure_once_complete_or_overdue(self, seed, db):
        done = _add_goal(seed, db, target=5_000, start=4, deadline=-5)
        self._read(seed, 2, 6_000)
        late = _add_goal(seed, db, start=9, deadline=1)
        assert _card(db, done)["banked_days"] is None
        assert _card(db, late)["banked_days"] is None


class TestGoalTimeExcluded:
    """A time goal counts time on the same basis as the Stats page: rows
    flagged time_excluded (overlap, chars-only backfill, an Anki day already
    hand-logged) add nothing. Summing the bare column put a year's time goal
    tens of hours above the Stats total for the same span."""

    def _seed_overlap(self, seed):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.session(d, chars=2_000, secs=1800, source="gsm_history",
                     title="Backfill", time_excluded=1)
        return d

    def test_a_time_goal_skips_excluded_time(self, seed, db):
        self._seed_overlap(seed)
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        assert _card(db, gid)["completed"] == 3600

    def test_a_time_goal_agrees_with_the_stats_total(self, seed, db):
        self._seed_overlap(seed)
        seed.session(seed.day(2), secs=900, source="manual",
                     title="Podcast", atype="Listening")
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        _, stats_secs, _ = db.get_range_totals(11)      # same span as the goal
        assert _card(db, gid)["completed"] == pytest.approx(stats_secs)

    def test_the_period_figures_skip_it_too(self, seed, db):
        d = seed.day(0)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1")
        seed.session(d, secs=1800, source="gsm_history",
                     title="Backfill", time_excluded=1)
        g = _card(db, _add_goal(seed, db, metric="time_seconds", target=360_000))
        assert g["today_completed"] == 3600
        assert g["week_completed"] == 3600
        assert g["month_completed"] == 3600

    def test_the_burnup_lands_on_the_card(self, seed, db):
        self._seed_overlap(seed)
        gid = _add_goal(seed, db, metric="time_seconds", target=360_000)
        assert db.db_get_goal_burnup(gid)["actual"][-1] == 3600

    def test_a_chars_goal_keeps_their_chars(self, seed, db):
        """time_excluded suppresses time, never chars."""
        self._seed_overlap(seed)
        gid = _add_goal(seed, db)
        assert _card(db, gid)["completed"] == 12_000
        assert db.db_get_goal_burnup(gid)["actual"][-1] == 12_000


class TestGoalAutoRaise:
    """raise_cap_days: reading past `cap` days ahead of the plan line is added
    onto the target when its day closes. Derived on read from the same
    closed-day series the burn-up plots; the base plan's daily amount never
    changes, so the plan line steps up by each raise instead of steepening."""

    def _goal(self, seed, db, cap, target=100_000, start=4, deadline=-5, cap_from=None):
        db.db_add_goal("G", "chars_read", float(target), seed.day(deadline), "daily",
                       None, False, seed.day(start), cap)
        gid = db.db_get_goals()[-1]["id"]
        # Switching the cap on stamps today, which leaves no closed day to raise
        # on; tests that need history backdate the stamp, by default to the start.
        con = sqlite3.connect(db.DB_PATH)
        con.execute("UPDATE goals SET raise_cap_from=? WHERE id=?",
                    (seed.day(start if cap_from is None else cap_from), gid))
        con.commit()
        con.close()
        return gid

    def _read(self, seed, offset, chars):
        seed.session(seed.day(offset), chars=chars, secs=600, source="manual")

    def test_off_changes_nothing(self, seed, db):
        self._read(seed, 3, 40_000)
        gid = _add_goal(seed, db, start=4, deadline=-5)
        card = _card(db, gid)
        assert card["target"] == card["base_target"] == 100_000
        assert card["raised_by"] == 0
        assert set(db.db_get_goal_burnup(gid)["raised"]) == {0.0}

    def test_surplus_past_the_cap_is_added_to_the_target(self, seed, db):
        # 10k/day plan over 10 days, cap 2. Day 2 ends 3 days ahead: one day's
        # worth (10k) goes onto the target and the day closes exactly 2 ahead.
        gid = self._goal(seed, db, cap=2)
        for d, c in ((4, 10_000), (3, 40_000), (2, 10_000), (1, 10_000)):
            self._read(seed, d, c)
        card = _card(db, gid)
        assert card["base_target"] == 100_000
        assert card["raised_by"] == pytest.approx(10_000)
        assert card["target"] == pytest.approx(110_000)
        assert card["original_chunk"] == pytest.approx(10_000), "the plan's day stays the base's"
        assert card["plan_expected"] == pytest.approx(60_000), "5 days of plan + the raise"
        assert card["banked_days"] == pytest.approx(2), "back at the cap, today unread"

    def test_the_plan_steps_rather_than_steepens(self, seed, db):
        """One good day early in a long goal raises it by what was read past
        the cap. Re-planning the whole line would have added ~66k here: 4 days
        ahead on day 9 read as a pace 44% over plan for the rest of the year."""
        gid = self._goal(seed, db, cap=2, target=365_000, start=9, deadline=-355)
        for d in range(9, 1, -1):
            self._read(seed, d, 1_000)
        self._read(seed, 1, 5_000)                       # 4 days ahead at day 9
        assert _card(db, gid)["target"] == pytest.approx(367_000)

    def test_today_never_raises(self, seed, db):
        """Raises land when a day closes, so today's bar can't run away from
        you while you read — the chip just shows you over the cap for now."""
        gid = self._goal(seed, db, cap=2, start=0, deadline=-9)
        self._read(seed, 0, 40_000)
        card = _card(db, gid)
        assert card["raised_by"] == 0
        assert card["banked_days"] == pytest.approx(3)

    def test_switching_on_caps_from_then_not_from_the_peak(self, seed, db):
        """9 days ahead on day 1, then nothing for a week: 1 day ahead by
        yesterday. Switching the cap on then must leave that alone — deriving
        from the start would raise by the old peak and put you 6 days behind."""
        self._read(seed, 9, 100_000)
        late_on = self._goal(seed, db, cap=2, target=200_000, start=9, deadline=-10, cap_from=1)
        assert _card(db, late_on)["raised_by"] == 0
        from_start = self._goal(seed, db, cap=2, target=200_000, start=9, deadline=-10)
        assert _card(db, from_start)["raised_by"] == pytest.approx(70_000)
        assert _card(db, from_start)["banked_days"] == pytest.approx(-6)

    def test_a_goal_that_reaches_its_target_stops_raising(self, seed, db):
        """Finishing early would otherwise close the day by raising the target
        past what was read, and a Complete goal would un-complete overnight."""
        gid = self._goal(seed, db, cap=1)
        for d, c in ((4, 10_000), (3, 10_000), (2, 100_000)):
            self._read(seed, d, c)
        card = _card(db, gid)
        assert card["is_complete"] is True
        assert card["raised_by"] == 0 and card["target"] == 100_000

    def test_period_bars_hold_this_periods_raise_back(self, seed, db):
        """week_raise/month_raise are what was raised since the period began,
        which the card takes back out so the bar's target holds until the next
        boundary. The raise here lands on yesterday."""
        gid = self._goal(seed, db, cap=1)
        self._read(seed, 4, 10_000)
        self._read(seed, 1, 50_000)                      # day 4 ends 2 ahead
        card  = _card(db, gid)
        today = db.get_today_date()
        assert card["raised_by"] == pytest.approx(10_000)
        assert card["week_raise"] == pytest.approx(0 if today.weekday() == 0 else 10_000)
        assert card["month_raise"] == pytest.approx(0 if today.day == 1 else 10_000)

    def test_the_burnup_steps_with_the_card(self, seed, db):
        gid = self._goal(seed, db, cap=2)
        for d, c in ((4, 10_000), (3, 40_000), (2, 10_000), (1, 10_000)):
            self._read(seed, d, c)
        burn, card = db.db_get_goal_burnup(gid), _card(db, gid)
        assert burn["target"] == pytest.approx(card["target"])
        assert burn["base_target"] == card["base_target"]
        assert len(burn["raised"]) == len(burn["dates"])
        assert burn["raised"] == pytest.approx([0, 10_000, 10_000, 10_000, 10_000]),             "steps on the day it landed; today carries yesterday's"

    def test_cap_edits_keep_the_stamp_and_off_clears_it(self, seed, db):
        gid = self._goal(seed, db, cap=2, cap_from=3)
        args = (gid, "G", 100_000.0, seed.day(-5), None)
        db.db_update_goal(*args, raise_cap_days=3)
        g = db.db_get_goals()[-1]
        assert (g["raise_cap_days"], g["raise_cap_from"]) == (3, seed.day(3)),             "a new cap re-derives over the same days"
        db.db_update_goal(*args)
        assert db.db_get_goals()[-1]["raise_cap_days"] == 3, "left out means leave it"
        db.db_update_goal(*args, raise_cap_days=None)
        g = db.db_get_goals()[-1]
        assert (g["raise_cap_days"], g["raise_cap_from"]) == (None, None)
        db.db_update_goal(*args, raise_cap_days=1)
        assert db.db_get_goals()[-1]["raise_cap_from"] == seed.day(0), "back on: from today"

    def test_a_negative_cap_is_rejected(self, seed, db):
        with pytest.raises(ValueError):
            db.db_add_goal("G", "chars_read", 1.0, seed.day(-5), "daily",
                           None, False, seed.day(0), -1)
