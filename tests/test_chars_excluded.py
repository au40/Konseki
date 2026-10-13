"""Per-title chars exclusion (`media_chars_excluded`).

The user can mark a title's character counts unrepresentative — a game whose
text hooks catch a fraction of what is actually read. Its chars then drop out of
every GLOBAL figure while every per-title surface keeps showing them in full.
Time is never affected.

Same suite shape as test_attribution.py: the cross-surface class asserts the
read paths agree WITH EACH OTHER (drift between two surfaces is the failure mode
that matters), and the scenario classes pin the documented edges — the both-
sides reading-speed rule, the attribution-delta leak, and the per-title spare.
"""
import sqlite3


# ── S1: global figures withhold the chars ─────────────────────────────────────
class TestGlobalFigures:
    def test_daily_series_drops_the_chars_but_keeps_the_time(self, seed, db):
        d = seed.day(3)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(7))
        assert series[d] == (3600, 0), "time stays, chars go"

    def test_range_totals_withhold_the_chars(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.gsm(d, chars=5_000, secs=1800, game_id="g2", title="Good Game")
        seed.exclude_chars("Hooky Game")

        chars, secs, active = db.get_range_totals(7)
        assert chars == 5_000
        assert secs == 5400, "every second still counts"
        assert active == 1

    def test_all_time_totals_withhold_the_chars(self, seed, db):
        seed.gsm(seed.day(5), chars=10_000, secs=3600, title="Hooky Game")
        seed.gsm(seed.day(4), chars=2_000, secs=900, game_id="g2", title="Good Game")
        seed.exclude_chars("Hooky Game")

        chars, _lines, secs, days = db.get_all_time_totals()
        assert chars == 2_000
        assert secs == 4500
        assert days == 2, "an excluded day is still an active day"

    def test_weekly_summary_withholds_the_chars(self, seed, db):
        d = seed.day(1)
        seed.gsm(d, chars=8_000, secs=3600, title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        weekly = {r[0]: (r[1], r[2]) for r in db.get_weekly_summary()}
        assert weekly[d] == (0, 3600)

    def test_the_all_range_stats_card_withholds_them(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, title="Hooky Game")
        seed.gsm(seed.day(3), chars=1_000, secs=600, game_id="g2", title="Good Game")
        seed.exclude_chars("Hooky Game")

        assert db.get_range_totals(None)[0] == 1_000

    def test_toggling_back_restores_every_figure(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, title="Hooky Game")
        before = db.get_range_totals(7)

        seed.exclude_chars("Hooky Game")
        assert db.get_range_totals(7)[0] == 0

        seed.exclude_chars("Hooky Game", False)
        assert db.get_range_totals(7) == before, "the overlay is fully reversible"

    def test_it_survives_a_re_ingest_of_the_underlying_rows(self, seed, db):
        """The whole reason it is title-keyed rather than a sessions column: a
        GSM re-ingest DELETEs and re-inserts the row, which would wipe any edit
        made to the row itself."""
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        con = sqlite3.connect(db.DB_PATH)
        con.execute("DELETE FROM sessions WHERE title='Hooky Game'")
        con.commit()
        con.close()
        seed.gsm(d, chars=12_000, secs=4000, game_id="g1", title="Hooky Game")

        assert db.get_range_totals(7)[0] == 0, "still excluded after re-ingest"


# ── S2: reading speed — dropped from BOTH sides ───────────────────────────────
class TestReadingSpeed:
    """Zeroing the chars but leaving the time would put an excluded title's
    hours in the denominator with nothing above them and collapse cph — the same
    failure a chars-less Reading session causes. So the row leaves both sides."""

    def test_excluded_title_leaves_both_sides(self, seed, db):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Good Game")
        seed.gsm(d, chars=1_000, secs=3600, game_id="g2", title="Hooky Game")

        # Both counted: the slow title drags the rate down.
        assert db.get_extra_stats()["chars_per_hour"] == 5_500

        seed.exclude_chars("Hooky Game")
        assert db.get_extra_stats()["chars_per_hour"] == 10_000, (
            "the excluded title's time must leave the denominator too"
        )

    def test_the_rest_of_a_mixed_day_survives(self, seed, db):
        """The filter is per row, not per day: a day that mixes an excluded
        title with normal reading keeps the normal reading."""
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Good Game")
        seed.gsm(d, chars=99_999, secs=60, game_id="g2", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        basis = db.get_daily_reading_speed_basis(7)
        assert basis[d] == (10_000, 3600)

    def test_the_dashboard_agrees_with_the_stats_page(self, seed, db):
        """get_today_stats feeds a client-side cph; the Stats card comes from
        the shared basis. They must land on the same number."""
        d = db.get_today()
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Good Game")
        seed.gsm(d, chars=1_000, secs=3600, game_id="g2", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        excluded = db.get_chars_excluded_titles()
        rows = [r for r in db.get_today_stats()
                if r[3] == "Reading" and r[4] > 0 and r[2] not in excluded]
        chars = sum(r[4] for r in rows)
        secs = sum(r[6] for r in rows)
        assert round(chars / (secs / 3600)) == db.get_extra_stats()["chars_per_hour"]


# ── S3: the attribution-delta leak ────────────────────────────────────────────
class TestRolloverInteraction:
    """The per-day adjustment dict is game-agnostic by design. If it kept
    handing back an excluded game's displaced chars, they would land back in
    every figure the raw sum had just zeroed."""

    def test_a_displacement_does_not_smuggle_the_chars_back(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.exclude_chars("Hooky Game")

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[src] == (3600 - 1200, 0)
        assert series[roll] == (1200, 0), "displaced chars stay excluded"
        assert db.get_range_totals(10)[0] == 0

    def test_the_displaced_time_still_moves(self, seed, db):
        """Only chars are withheld. The displacement must still relabel which
        day owns the seconds, or the time series goes wrong."""
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.exclude_chars("Hooky Game")

        _c, secs, _a = db.get_range_totals(10)
        assert secs == 3600, "seconds conserved across the displacement"

    def test_another_games_displacement_is_untouched(self, seed, db):
        src, roll = seed.day(3), seed.day(4)
        seed.gsm(src, chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.gsm(src, chars=6_000, secs=1800, game_id="g2", title="Good Game")
        seed.displace(roll, src, "g1", chars=4_000, secs=1200)
        seed.displace(roll, src, "g2", chars=2_000, secs=600)
        seed.exclude_chars("Hooky Game")

        series = dict((x[0], (x[1], x[2])) for x in db.get_daily_time_series(10))
        assert series[roll][1] == 2_000, "the counted game keeps its displacement"
        assert series[src][1] == 4_000

    def test_a_shave_on_an_excluded_game_stays_out_of_the_speed_basis(self, seed, db):
        """The manual overlay is summed across games per date. For the speed
        basis the excluded game's rows never entered the denominator, so its
        shave must not come off one — that would subtract time twice over."""
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Good Game")
        seed.gsm(d, chars=1_000, secs=3600, game_id="g2", title="Hooky Game")
        seed.shave(d, "g2", -1800)
        seed.exclude_chars("Hooky Game")

        assert db.get_daily_reading_speed_basis(7)[d] == (10_000, 3600)

    def test_a_shave_on_an_excluded_game_still_reduces_total_time(self, seed, db):
        """...but everywhere else it must: the time IS counted there."""
        d = seed.day(2)
        seed.gsm(d, chars=1_000, secs=3600, game_id="g2", title="Hooky Game")
        seed.shave(d, "g2", -1800)
        seed.exclude_chars("Hooky Game")

        assert db.get_range_totals(7)[1] == 1800


# ── S4: per-title surfaces keep the chars ─────────────────────────────────────
class TestPerTitleSpared:
    def test_the_detail_pane_keeps_the_full_count(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        d = db.db_get_title_detail("Hooky Game")
        assert d["total_chars"] == 10_000
        assert d["chars_excluded"] is True
        assert d["daily"][0]["chars"] == 10_000

    def test_the_titles_own_speed_is_unchanged(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        before = db.db_get_title_detail("Hooky Game")["avg_speed"]
        seed.exclude_chars("Hooky Game")
        assert db.db_get_title_detail("Hooky Game")["avg_speed"] == before

    def test_the_media_grid_card_keeps_the_full_count(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        card = next(m for m in db.get_media_stats() if m["title"] == "Hooky Game")
        assert card["total_chars"] == 10_000
        assert card["chars_excluded"] is True

    def test_an_uncounted_title_reports_the_flag_as_false(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Good Game")
        assert db.db_get_title_detail("Good Game")["chars_excluded"] is False


# ── S5: goals ─────────────────────────────────────────────────────────────────
class TestGoals:
    def _chars_goal(self, seed, db, target=100_000):
        db.db_add_goal("Chars", "chars_read", target,
                       seed.day(-30), start_date=seed.day(10))
        return db.db_get_goal_progress()[0]

    def test_a_chars_goal_withholds_them(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.gsm(seed.day(3), chars=4_000, secs=1800, game_id="g2", title="Good Game")
        seed.exclude_chars("Hooky Game")

        assert self._chars_goal(seed, db)["completed"] == 4_000

    def test_a_time_goal_is_untouched(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.exclude_chars("Hooky Game")

        db.db_add_goal("Time", "time_seconds", 100_000,
                       seed.day(-30), start_date=seed.day(10))
        assert db.db_get_goal_progress()[0]["completed"] == 3600

    def test_the_burnup_line_matches_the_card(self, seed, db):
        seed.gsm(seed.day(3), chars=10_000, secs=3600, game_id="g1", title="Hooky Game")
        seed.gsm(seed.day(3), chars=4_000, secs=1800, game_id="g2", title="Good Game")
        seed.exclude_chars("Hooky Game")

        g = self._chars_goal(seed, db)
        burnup = db.db_get_goal_burnup(g["id"])
        assert burnup["actual"][-1] == g["completed"]


# ── S6: cross-surface agreement ───────────────────────────────────────────────
class TestCrossSurface:
    """Two surfaces disagreeing is the drift class that matters; a per-function
    test would not catch it."""

    def _scenario(self, seed):
        d = seed.day(2)
        seed.gsm(d, chars=10_000, secs=3600, game_id="g1", title="Good Game")
        seed.gsm(d, chars=99_000, secs=1800, game_id="g2", title="Hooky Game")
        seed.exclude_chars("Hooky Game")
        return d

    def test_daily_series_and_range_totals_agree(self, seed, db):
        self._scenario(seed)
        series_chars = sum(x[2] for x in db.get_daily_time_series(7))
        assert series_chars == db.get_range_totals(7)[0] == 10_000

    def test_weekly_summary_agrees_with_the_daily_series(self, seed, db):
        d = self._scenario(seed)
        weekly = {r[0]: r[1] for r in db.get_weekly_summary()}
        series = {x[0]: x[2] for x in db.get_daily_time_series(7)}
        assert weekly[d] == series[d]

    def test_all_time_agrees_with_the_unbounded_range(self, seed, db):
        self._scenario(seed)
        assert db.get_all_time_totals()[0] == db.get_range_totals(None)[0] == 10_000

    def test_time_is_identical_across_every_surface(self, seed, db):
        """The one thing exclusion must never move."""
        d = self._scenario(seed)
        series = {x[0]: x[1] for x in db.get_daily_time_series(7)}
        weekly = {r[0]: r[2] for r in db.get_weekly_summary()}
        assert series[d] == weekly[d] == 5400
        assert db.get_range_totals(7)[1] == 5400
        assert db.get_all_time_totals()[2] == 5400
