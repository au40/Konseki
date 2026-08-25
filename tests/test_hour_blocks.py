"""get_hour_blocks — "how long did each 100 hours take", the Lifetime pace chart.

The chart's credibility rests on two sums: the bars' calendar days must add up
to the elapsed span, and their active days to the lifetime active-day count. A
boundary day carries time on both sides of a crossing, so it has to be assigned
to exactly one block — these pin that it goes to the earlier one and that both
sums stay exact.

It reads _adjusted_day_totals(), so GSM rollover attribution and the manual time
overlay come along for free; the tests at the end prove that rather than assume
it, because a future refactor onto raw sessions would pass every other test here.
"""
from datetime import date

import pytest


HOUR = 3600.0


def span_days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days + 1


def test_even_blocks_land_one_per_day(seed, db):
    for off in (3, 2, 1, 0):
        seed.gsm(seed.day(off), chars=1000, secs=10 * HOUR)

    blocks = db.get_hour_blocks(10)

    assert [b["index"] for b in blocks] == [1, 2, 3, 4]
    assert all(b["complete"] for b in blocks)
    # 40h landing exactly on the 4th boundary leaves nothing in progress.
    assert [b["hours"] for b in blocks] == [10, 10, 10, 10]


def test_days_and_active_days_sum_exactly(seed, db):
    for off in (9, 8, 5, 4, 1, 0):          # gaps on purpose
        seed.gsm(seed.day(off), chars=1000, secs=7 * HOUR)

    blocks = db.get_hour_blocks(10)

    # The boundary day belongs to the earlier block, so neither sum double-counts.
    assert sum(b["days"] for b in blocks) == span_days(seed.day(9), seed.day(0))
    assert sum(b["active_days"] for b in blocks) == 6


def test_trailing_partial_runs_to_logical_today(seed, db):
    for off in (3, 2, 1, 0):
        seed.gsm(seed.day(off), chars=1000, secs=10 * HOUR)

    blocks = db.get_hour_blocks(15)
    last = blocks[-1]

    assert [b["complete"] for b in blocks] == [True, True, False]
    # An in-progress block reports what has accumulated, not the block size —
    # drawn as a full one it would read as a very slow block instead of a live one.
    assert last["hours"] == pytest.approx(10.0)
    assert last["end_date"] == seed.day(0)


def test_first_block_is_inclusive_of_its_own_start(seed, db):
    seed.gsm(seed.day(2), chars=1000, secs=10 * HOUR)
    seed.gsm(seed.day(0), chars=1000, secs=10 * HOUR)

    b1 = db.get_hour_blocks(10)[0]

    # No earlier block exists to own day(2), so block 1 counts it: day(2)..day(2).
    assert b1["start_date"] == b1["end_date"] == seed.day(2)
    assert b1["days"] == 1


def test_several_blocks_closing_on_one_day_still_sum(seed, db):
    seed.gsm(seed.day(0), chars=9000, secs=30 * HOUR)

    blocks = db.get_hour_blocks(10)

    assert len(blocks) == 3
    # Only the first can own the day under the boundary rule; the rest took no
    # additional calendar time, which is the honest reading.
    assert [b["days"] for b in blocks] == [1, 0, 0]
    assert sum(b["active_days"] for b in blocks) == 1


def test_time_excluded_rows_do_not_move_the_walk(seed, db):
    seed.gsm(seed.day(1), chars=1000, secs=10 * HOUR)
    seed.session(seed.day(1), chars=0, secs=500 * HOUR, source="ttsu",
                 title="Backfill", time_excluded=1)
    seed.gsm(seed.day(0), chars=1000, secs=10 * HOUR)

    blocks = db.get_hour_blocks(10)

    # 500 excluded hours would otherwise blow through 50 blocks.
    assert len(blocks) == 2


def _total_hours(blocks):
    return sum(b["hours"] for b in blocks)


def test_rollover_attribution_is_already_folded_in(seed, db):
    """A displacement moves time between days, so it can move a crossing date."""
    seed.gsm(seed.day(1), chars=2000, secs=12 * HOUR, game_id="g1")
    seed.gsm(seed.day(0), chars=2000, secs=12 * HOUR, game_id="g1")
    seed.displace(seed.day(2), seed.day(1), "g1", chars=500, secs=6 * HOUR)

    blocks = db.get_hour_blocks(10)
    tot = db._adjusted_day_totals()

    # Displaced time lands on day(2), which now opens the walk.
    assert blocks[0]["start_date"] == seed.day(2)
    assert _total_hours(blocks) == pytest.approx(sum(s for _c, s in tot.values()) / 3600)


def test_manual_overlay_is_already_folded_in(seed, db):
    seed.gsm(seed.day(1), chars=2000, secs=12 * HOUR, game_id="g1")
    seed.gsm(seed.day(0), chars=2000, secs=12 * HOUR, game_id="g1")
    before = _total_hours(db.get_hour_blocks(10))

    seed.shave(seed.day(1), "g1", -6 * HOUR)
    after = _total_hours(db.get_hour_blocks(10))

    assert before - after == pytest.approx(6.0)


def test_totals_agree_with_the_all_time_card(seed, db):
    """The chart must not tell a different story from the number above it."""
    seed.gsm(seed.day(3), chars=2000, secs=9 * HOUR, game_id="g1")
    seed.gsm(seed.day(2), chars=2000, secs=9 * HOUR, game_id="g1")
    seed.gsm(seed.day(0), chars=2000, secs=9 * HOUR, game_id="g1")
    seed.displace(seed.day(3), seed.day(2), "g1", chars=400, secs=2 * HOUR)
    seed.shave(seed.day(0), "g1", -1 * HOUR)

    _chars, _lines, secs, _days = db.get_all_time_totals()

    assert _total_hours(db.get_hour_blocks(10)) == pytest.approx(secs / 3600)


@pytest.mark.parametrize("size", [0, -5, None])
def test_a_nonsense_block_size_yields_nothing(seed, db, size):
    seed.gsm(seed.day(0), chars=1000, secs=10 * HOUR)
    assert db.get_hour_blocks(size) == []


def test_no_sessions_yields_nothing(seed, db):
    assert db.get_hour_blocks(100) == []


def test_chars_only_history_yields_nothing(seed, db):
    """Chars with no time can't advance an hours walk, and mustn't fake a block."""
    seed.session(seed.day(0), chars=5000, secs=0, source="ttsu", title="T")
    assert db.get_hour_blocks(100) == []
