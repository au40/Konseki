"""GSM /api/today-stats per-sitting evidence — shadow phase.

See plans/GSM-TODAY-PLAN.md. These cover the layer that turns GSM's per-sitting
timestamps into the rollover split, WITHOUT any of it reaching a display path
yet. test_attribution.py is the regression signal for the display paths and must
keep passing untouched.

Dates here are fixed rather than offsets from logical today. parse_today_stats
depends only on the timestamps it's handed and the rollover_hour setting — never
on "now" — so pinning them keeps the expectations hand-checkable.
"""
import sqlite3
from datetime import date, datetime

import pytest

import imports


# 2026-05-13 is a plain Wednesday, far from any DST boundary in either
# hemisphere, so wall-clock hours here are unambiguous.
def ts(day, hour, minute=0):
    """Local epoch seconds for 2026-05-<day> at the given time."""
    return datetime(2026, 5, day, hour, minute).timestamp()


def sitting(day, hour, minute=0, chars=100, secs=600.0, game="g1",
            end_hour=None, lines=3):
    """One entry in the shape /api/today-stats returns."""
    return {
        "startTime":  ts(day, hour, minute),
        "endTime":    ts(day, end_hour if end_hour is not None else hour + 1),
        "totalChars": chars,
        "totalSeconds": secs,
        "lines":      ["u"] * lines,
        "gameMetadata": {"game_id": game},
    }


def payload(*sittings):
    return {"sessions": list(sittings)}


def _evidence_rows(db):
    con = sqlite3.connect(db.DB_PATH)
    rows = con.execute(
        "SELECT game_id, start_ts, real_date, logical_date, chars, secs, lines "
        "FROM gsm_session_evidence ORDER BY start_ts"
    ).fetchall()
    con.close()
    return rows


# ── Parsing: when did this sitting happen, and whose day is it? ───────────────

class TestParse:

    def test_post_midnight_belongs_to_previous_logical_day(self, seed, db):
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(
            sitting(13, 20),          # evening of the 13th
            sitting(14, 1),           # 01:00 — still the 13th to the user
        ))
        assert [(r["real_date"], r["logical_date"]) for r in rows] == [
            ("2026-05-13", "2026-05-13"),
            ("2026-05-14", "2026-05-13"),
        ]

    def test_rollover_zero_never_displaces(self, seed, db):
        seed.setting("rollover_hour", 0)
        rows = imports.parse_today_stats(payload(sitting(14, 1)))
        assert rows[0]["real_date"] == rows[0]["logical_date"] == "2026-05-14"

    def test_after_rollover_hour_is_its_own_day(self, seed, db):
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(sitting(14, 5)))
        assert rows[0]["real_date"] == rows[0]["logical_date"] == "2026-05-14"

    def test_straddling_sitting_assigned_wholly_by_start(self, seed, db):
        """03:30-04:30 with rollover 4 counts entirely to the 13th. Documented
        approximation — splitting it would need per-line timestamps."""
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(
            sitting(14, 3, 30, end_hour=4)
        ))
        assert rows[0]["logical_date"] == "2026-05-13"

    def test_carries_measured_seconds_and_line_count(self, seed, db):
        seed.setting("rollover_hour", 0)
        rows = imports.parse_today_stats(payload(
            sitting(13, 20, chars=2977, secs=1457.0274408976184, lines=128)
        ))
        assert rows[0]["chars"] == 2977
        assert rows[0]["secs"] == pytest.approx(1457.0274408976184)
        assert rows[0]["lines"] == 128

    def test_keeps_two_sittings_of_the_same_game(self, seed, db):
        """today-stats returns one entry per sitting and the same game can appear
        twice in a window — the date alone is not a key."""
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(
            sitting(14, 1, chars=100),
            sitting(14, 6, chars=200),
        ))
        assert len(rows) == 2
        assert [r["logical_date"] for r in rows] == ["2026-05-13", "2026-05-14"]

    def test_keeps_games_apart(self, seed, db):
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(
            sitting(14, 1, game="g1"),
            sitting(14, 6, game="g2"),
        ))
        assert {r["game_id"] for r in rows} == {"g1", "g2"}

    def test_skips_entries_without_a_usable_start(self, seed, db):
        seed.setting("rollover_hour", 0)
        rows = imports.parse_today_stats({"sessions": [
            {"totalChars": 50},                                  # no startTime
            {"startTime": 0, "totalChars": 50},                  # zero
            {"startTime": "nonsense", "totalChars": 50},         # unparseable
            sitting(13, 20),
        ]})
        assert len(rows) == 1

    def test_missing_game_id_falls_back_to_empty_string(self, seed, db):
        """Matches the '' convention gsm_rollover_attributions already uses."""
        seed.setting("rollover_hour", 0)
        rows = imports.parse_today_stats({"sessions": [
            {"startTime": ts(13, 20), "totalChars": 10, "totalSeconds": 60}
        ]})
        assert rows[0]["game_id"] == ""

    def test_duplicate_entry_collapses(self, seed, db):
        seed.setting("rollover_hour", 0)
        rows = imports.parse_today_stats(payload(
            sitting(13, 20, chars=100),
            sitting(13, 20, chars=100),
        ))
        assert len(rows) == 1

    def test_empty_and_missing_payloads(self, seed, db):
        assert imports.parse_today_stats({}) == []
        assert imports.parse_today_stats(None) == []
        assert imports.parse_today_stats({"sessions": []}) == []


class TestUrlDerivation:

    def test_derives_from_configured_stats_url(self):
        assert imports._today_stats_url("http://localhost:7275/api/stats") == \
            "http://localhost:7275/api/today-stats"

    def test_derives_from_non_default_host(self):
        assert imports._today_stats_url("http://192.168.1.9:9000/api/stats") == \
            "http://192.168.1.9:9000/api/today-stats"

    def test_falls_back_when_shape_is_unexpected(self):
        assert imports._today_stats_url("http://elsewhere/custom") == \
            imports.GSM_TODAY_API


# ── Storage: the replacement floor ───────────────────────────────────────────

class TestReplacement:

    def test_replaces_only_from_the_payloads_own_earliest_sitting(self, seed, db):
        """Evidence older than the window GSM is reporting on must survive —
        that's what lets us ignore GSM's own rollover-hour setting."""
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(12, 20, chars=500),
        )))
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(13, 20, chars=100),
            sitting(14, 1,  chars=200),
        )))
        rows = _evidence_rows(db)
        assert len(rows) == 3
        assert [r[4] for r in rows] == [500, 100, 200]

    def test_rewrites_a_sitting_whose_total_grew(self, seed, db):
        """GSM flushes tail/AFK time after the last character. A later pull must
        overwrite the sitting, not append beside it — this is what removes the
        need for the old chars guard."""
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
        )))
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=980.0),
        )))
        rows = _evidence_rows(db)
        assert len(rows) == 1
        assert rows[0][5] == pytest.approx(980.0)

    def test_empty_payload_deletes_nothing(self, seed, db):
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(sitting(14, 1))))
        assert db.replace_gsm_evidence([]) == 0
        assert len(_evidence_rows(db)) == 1

    def test_repeated_identical_pull_is_idempotent(self, seed, db):
        seed.setting("rollover_hour", 4)
        rows = imports.parse_today_stats(payload(
            sitting(13, 20, chars=100), sitting(14, 1, chars=200),
        ))
        db.replace_gsm_evidence(rows)
        first = _evidence_rows(db)
        db.replace_gsm_evidence(rows)
        assert _evidence_rows(db) == first


# ── The derived split ────────────────────────────────────────────────────────

class TestImpliedAttributions:

    def test_only_displaced_sittings_produce_a_row(self, seed, db):
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(13, 20, chars=100),   # no displacement
            sitting(14, 1,  chars=200),   # displaced
        )))
        attr = db.get_gsm_evidence_attributions()
        assert attr == {("2026-05-13", "2026-05-14", "g1"): (200, 600.0)}

    def test_two_sittings_before_rollover_sum_into_one_row(self, seed, db):
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
            sitting(14, 2, chars=300, secs=900.0),
        )))
        assert db.get_gsm_evidence_attributions() == {
            ("2026-05-13", "2026-05-14", "g1"): (500, 1500.0)
        }

    def test_two_games_on_one_real_date_stay_separate(self, seed, db):
        """The multi-game failure CLAUDE.md documents: game A read pre-rollover
        and game B post-rollover must not share a displacement."""
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, game="g1"),   # belongs to the 13th
            sitting(14, 9, chars=700, game="g2"),   # belongs to the 14th
        )))
        attr = db.get_gsm_evidence_attributions()
        assert attr == {("2026-05-13", "2026-05-14", "g1"): (200, 600.0)}

    def test_both_games_displaced_get_their_own_rows(self, seed, db):
        seed.setting("rollover_hour", 4)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, game="g1"),
            sitting(14, 2, chars=300, game="g2"),
        )))
        assert db.get_gsm_evidence_attributions() == {
            ("2026-05-13", "2026-05-14", "g1"): (200, 600.0),
            ("2026-05-13", "2026-05-14", "g2"): (300, 600.0),
        }

    def test_no_evidence_means_no_implied_split(self, seed, db):
        assert db.get_gsm_evidence_attributions() == {}


# ── The completeness check ───────────────────────────────────────────────────

class TestReport:

    def test_matching_chars_marks_the_day_complete(self, seed, db):
        """Characters are reported unambiguously by both sources, so equality
        means evidence saw the whole day and its seconds can be trusted."""
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=500, secs=1400.0, game_id="g1")
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
            sitting(14, 9, chars=300, secs=900.0),
        )))
        r = next(x for x in db.get_gsm_evidence_report()
                 if x["real_date"] == "2026-05-14")
        assert r["complete"] is True
        assert r["ev_chars"] == 500
        assert r["sittings"] == 2
        # measured 1500 vs the row's derived 1400
        assert r["secs_delta"] == pytest.approx(100.0)

    def test_partial_evidence_is_flagged_and_reports_no_delta(self, seed, db):
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=900, secs=2000.0, game_id="g1")
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
        )))
        r = next(x for x in db.get_gsm_evidence_report()
                 if x["real_date"] == "2026-05-14")
        assert r["complete"] is False
        assert r["secs_delta"] is None

    def test_partial_evidence_under_attributes_never_over(self, seed, db):
        """The safety property: a day we only half-saw displaces less than the
        truth, which is today's behaviour — not a new failure mode."""
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=900, secs=2000.0, game_id="g1")
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
        )))
        implied = db.get_gsm_evidence_attributions()[("2026-05-13", "2026-05-14", "g1")]
        assert implied[0] < 900

    def test_agreement_with_the_snapshot_writer(self, seed, db):
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=200, secs=600.0, game_id="g1")
        seed.displace("2026-05-13", "2026-05-14", "g1", 200, 600.0)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
        )))
        r = next(x for x in db.get_gsm_evidence_report()
                 if x["real_date"] == "2026-05-14")
        assert r["agrees"] is True
        assert r["attr_chars_stored"] == r["attr_chars_implied"] == 200

    def test_disagreement_is_surfaced(self, seed, db):
        """The case the shadow phase exists to catch: the snapshot recorded the
        whole day as displaced, but only part of it happened before rollover."""
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=900, secs=2700.0, game_id="g1")
        seed.displace("2026-05-13", "2026-05-14", "g1", 900, 2700.0)
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
            sitting(14, 9, chars=700, secs=2100.0),
        )))
        r = next(x for x in db.get_gsm_evidence_report()
                 if x["real_date"] == "2026-05-14")
        assert r["agrees"] is False
        assert r["attr_chars_stored"] == 900
        assert r["attr_chars_implied"] == 200

    def test_empty_without_evidence(self, seed, db):
        seed.gsm("2026-05-14", chars=500, secs=1400.0, game_id="g1")
        assert db.get_gsm_evidence_report() == []


# ── The shadow guarantee ─────────────────────────────────────────────────────

class TestShadowIsInert:

    def test_recording_evidence_writes_no_attribution(self, seed, db):
        """The whole promise of Phase 1: nothing displayed changes."""
        seed.setting("rollover_hour", 4)
        seed.gsm("2026-05-14", chars=500, secs=1500.0, game_id="g1")
        before = db.get_today_stats()
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 1, chars=200, secs=600.0),
        )))
        con = sqlite3.connect(db.DB_PATH)
        n = con.execute("SELECT COUNT(*) FROM gsm_rollover_attributions").fetchone()[0]
        con.close()
        assert n == 0
        assert db.get_today_stats() == before

    def test_mode_defaults_to_off(self, seed, db):
        assert imports.today_stats_mode() == "off"


# ── Measured time (Phase 2, change 1) ────────────────────────────────────────

class TestMeasuredTime:
    """resolve_gsm_time_seconds swaps the chars ÷ speed derivation for GSM's
    real measured seconds — but ONLY where evidence provably covers the whole
    day. Every other path must fall through unchanged, so the failure mode is
    "no improvement", never "under-reported time"."""

    def _record(self, seed, db, *sittings):
        seed.setting("rollover_hour", 4)
        seed.setting("gsm_today_stats", "live")
        db.replace_gsm_evidence(imports.parse_today_stats(payload(*sittings)))

    def test_uses_measured_when_characters_match(self, seed, db):
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0))
        secs, src = imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 1491.0)
        assert src == "measured"
        assert secs == pytest.approx(1800.0)

    def test_recovers_the_gap_that_started_this(self, seed, db):
        """The real case: 309 seconds the derivation lost."""
        self._record(seed, db, sitting(14, 9, chars=2977, secs=1766.0))
        secs, src = imports.resolve_gsm_time_seconds("g1", "2026-05-14", 2977, 1457.0)
        assert src == "measured"
        assert secs - 1457.0 == pytest.approx(309.0)

    def test_declines_when_evidence_is_partial(self, seed, db):
        """Row says 900 chars, evidence only saw 500 — a sitting is missing, so
        its seconds are missing too. Using them would UNDER-report."""
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0))
        secs, src = imports.resolve_gsm_time_seconds("g1", "2026-05-14", 900, 2700.0)
        assert src == "derived"
        assert secs == 2700.0

    def test_declines_when_row_holds_two_games_worth_of_chars(self, seed, db):
        """The multi-game case. If the day's character count is an all-games
        total, one game's evidence can never match it and this must decline
        rather than store one game's time against both games' characters."""
        self._record(seed, db,
                     sitting(14, 9, chars=500, secs=1800.0, game="g1"),
                     sitting(14, 11, chars=400, secs=1200.0, game="g2"))
        secs, src = imports.resolve_gsm_time_seconds("g1", "2026-05-14", 900, 2700.0)
        assert src == "derived"

    def test_still_works_per_game_when_chars_are_per_game(self, seed, db):
        """Same two-game day, but asked with that game's own character count —
        which is what happens if characterActivityData turns out to be per-game."""
        self._record(seed, db,
                     sitting(14, 9, chars=500, secs=1800.0, game="g1"),
                     sitting(14, 11, chars=400, secs=1200.0, game="g2"))
        assert imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 9.0)[1] == "measured"
        assert imports.resolve_gsm_time_seconds("g2", "2026-05-14", 400, 9.0)[1] == "measured"

    def test_declines_with_no_evidence_at_all(self, seed, db):
        seed.setting("gsm_today_stats", "live")
        secs, src = imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 1491.0)
        assert (secs, src) == (1491.0, "derived")

    def test_declines_for_a_different_date(self, seed, db):
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0))
        assert imports.resolve_gsm_time_seconds("g1", "2026-05-15", 500, 1491.0)[1] == "derived"

    def test_declines_for_a_different_game(self, seed, db):
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0, game="g1"))
        assert imports.resolve_gsm_time_seconds("g2", "2026-05-14", 500, 1491.0)[1] == "derived"

    def test_shadow_mode_records_but_never_applies(self, seed, db):
        """Shadow must stay inert even with perfect evidence — that's its promise."""
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0))
        seed.setting("gsm_today_stats", "shadow")
        assert imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 1491.0)[1] == "derived"

    def test_off_mode_never_applies(self, seed, db):
        self._record(seed, db, sitting(14, 9, chars=500, secs=1800.0))
        seed.setting("gsm_today_stats", "off")
        assert imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 1491.0)[1] == "derived"

    def test_declines_on_zero_measured_seconds(self, seed, db):
        """A zero-second sitting would wipe the row's time; keep the derivation."""
        self._record(seed, db, sitting(14, 9, chars=500, secs=0.0))
        assert imports.resolve_gsm_time_seconds("g1", "2026-05-14", 500, 1491.0)[1] == "derived"

    def test_report_marks_which_days_it_applied_to(self, seed, db):
        seed.setting("rollover_hour", 4)
        seed.setting("gsm_today_stats", "live")
        seed.gsm("2026-05-14", chars=500, secs=1800.0, game_id="g1")   # measured
        seed.gsm("2026-05-15", chars=500, secs=1491.0, game_id="g1")   # derived
        db.replace_gsm_evidence(imports.parse_today_stats(payload(
            sitting(14, 9, chars=500, secs=1800.0),
            sitting(15, 9, chars=500, secs=1800.0),
        )))
        by_date = {r["real_date"]: r["time_source"]
                   for r in db.get_gsm_evidence_report()}
        assert by_date["2026-05-14"] == "measured"
        assert by_date["2026-05-15"] == "derived"


# ── The pull, wired end to end ───────────────────────────────────────────────

class _FakeResp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


class TestPullIntegration:
    """The resolver tests above are unit-level. These drive pull_gsm_api_only
    itself with both endpoints stubbed, because the ordering matters: evidence
    has to be captured BEFORE the session row is written or the row can never
    see it."""

    CHARS, SPEED, MEASURED = 2977, 7356, 1766.0
    # 2977 ÷ 7356 × 3600 — what the old path would have stored.
    DERIVED = 2977 / 7356 * 3600

    def _wire(self, monkeypatch, sittings, chars=None):
        today = date.today().isoformat()
        stats = {
            "currentGameStats": {"game_name": "Higurashi", "game_id": "g1"},
            "characterActivityData": {today[:4]: {today: chars or self.CHARS}},
            "readingSpeedHeatmapData": {today[:4]: {today: self.SPEED}},
        }
        def fake_get(url, timeout=None):
            return _FakeResp(stats if url.endswith("/api/stats")
                             else {"sessions": sittings})
        monkeypatch.setattr(imports.requests, "get", fake_get)
        return today

    def _noon(self, chars, secs, game="g1"):
        t = datetime.combine(date.today(), datetime.min.time()).replace(hour=12)
        return {"startTime": t.timestamp(), "endTime": t.timestamp() + secs,
                "totalChars": chars, "totalSeconds": secs, "lines": ["u"],
                "gameMetadata": {"game_id": game}}

    def _row_secs(self, db, today):
        con = sqlite3.connect(db.DB_PATH)
        r = con.execute("SELECT time_seconds FROM sessions WHERE source='gsm' "
                        "AND session_date=? AND game_id='g1'", (today,)).fetchone()
        con.close()
        return r[0] if r else None

    def test_live_mode_stores_measured_time(self, seed, db, monkeypatch):
        seed.setting("rollover_hour", 0)
        seed.setting("gsm_today_stats", "live")
        today = self._wire(monkeypatch, [self._noon(self.CHARS, self.MEASURED)])
        s = imports.pull_gsm_api_only("http://x/api/stats")
        assert s["time_source"] == "measured"
        assert self._row_secs(db, today) == pytest.approx(self.MEASURED)

    def test_shadow_mode_stores_derived_time_but_still_records(self, seed, db, monkeypatch):
        seed.setting("rollover_hour", 0)
        seed.setting("gsm_today_stats", "shadow")
        today = self._wire(monkeypatch, [self._noon(self.CHARS, self.MEASURED)])
        s = imports.pull_gsm_api_only("http://x/api/stats")
        assert s["time_source"] == "derived"
        assert self._row_secs(db, today) == pytest.approx(self.DERIVED)
        assert len(_evidence_rows(db)) == 1, "shadow still records"

    def test_off_mode_never_calls_the_endpoint(self, seed, db, monkeypatch):
        seed.setting("rollover_hour", 0)
        seed.setting("gsm_today_stats", "off")
        called = []
        today = date.today().isoformat()
        stats = {
            "currentGameStats": {"game_name": "Higurashi", "game_id": "g1"},
            "characterActivityData": {today[:4]: {today: self.CHARS}},
            "readingSpeedHeatmapData": {today[:4]: {today: self.SPEED}},
        }
        def fake_get(url, timeout=None):
            called.append(url)
            return _FakeResp(stats)
        monkeypatch.setattr(imports.requests, "get", fake_get)
        imports.pull_gsm_api_only("http://x/api/stats")
        assert all(u.endswith("/api/stats") for u in called)
        assert _evidence_rows(db) == []

    def test_an_unreachable_endpoint_leaves_the_pull_intact(self, seed, db, monkeypatch):
        """A GSM too old to serve today-stats must still get a normal pull."""
        seed.setting("rollover_hour", 0)
        seed.setting("gsm_today_stats", "live")
        today = date.today().isoformat()
        stats = {
            "currentGameStats": {"game_name": "Higurashi", "game_id": "g1"},
            "characterActivityData": {today[:4]: {today: self.CHARS}},
            "readingSpeedHeatmapData": {today[:4]: {today: self.SPEED}},
        }
        def fake_get(url, timeout=None):
            if url.endswith("/api/today-stats"):
                raise imports.requests.exceptions.ConnectionError("nope")
            return _FakeResp(stats)
        monkeypatch.setattr(imports.requests, "get", fake_get)
        s = imports.pull_gsm_api_only("http://x/api/stats")
        assert s is not None and s["time_source"] == "derived"
        assert self._row_secs(db, today) == pytest.approx(self.DERIVED)

    def test_partial_evidence_keeps_the_derived_time(self, seed, db, monkeypatch):
        """Evidence saw 1000 of 2977 characters — one sitting is missing, so its
        seconds are too. The row must keep the derivation."""
        seed.setting("rollover_hour", 0)
        seed.setting("gsm_today_stats", "live")
        today = self._wire(monkeypatch, [self._noon(1000, 600.0)])
        s = imports.pull_gsm_api_only("http://x/api/stats")
        assert s["time_source"] == "derived"
        assert self._row_secs(db, today) == pytest.approx(self.DERIVED)
