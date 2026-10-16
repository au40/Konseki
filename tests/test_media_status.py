"""Media status — In progress / On hold / Completed / Dropped.

In progress is the absence of any status row, Completed is the existing
`media_completions` flag, and On hold / Dropped live in `media_status`. The
classes pin the rules that are easy to break: one status at a time, the
read-time auto-resume of On hold (and only On hold), and that the grid, the
detail pane and the shelf all report the same status.
"""
import sqlite3


def _status(db, title):
    return next(m["status"] for m in db.get_media_stats() if m["title"] == title)


# ── S1: the default and the one-status-at-a-time rule ────────────────────────
class TestSetting:
    def test_new_titles_are_in_progress_with_nothing_written(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        assert _status(db, "Book") == "in_progress"
        con = sqlite3.connect(db.DB_PATH)
        n = con.execute("SELECT COUNT(*) FROM media_status").fetchone()[0]
        con.close()
        assert n == 0, "in progress is the absence of a row"

    def test_each_status_round_trips(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        for s in ("on_hold", "completed", "dropped", "in_progress"):
            assert db.db_set_media_status("Book", s) == {"ok": True, "status": s}
            assert _status(db, "Book") == s
            assert db.db_get_title_detail("Book")["status"] == s

    def test_completed_is_the_existing_completion_flag(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        db.db_set_media_status("Book", "completed")
        detail = db.db_get_title_detail("Book")
        assert detail["completed"] is True, "the bar and the catalog still read this"
        db.db_set_media_status("Book", "on_hold")
        assert db.db_get_title_detail("Book")["completed"] is False, \
            "leaving Completed un-pins the bar, like Mark incomplete did"

    def test_completing_clears_on_hold(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        db.db_set_media_status("Book", "on_hold")
        db.db_set_media_complete("Book", True)
        assert _status(db, "Book") == "completed"
        db.db_set_media_complete("Book", False)
        assert _status(db, "Book") == "in_progress", "no stale on_hold underneath"

    def test_recompleting_keeps_the_original_date(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        db.db_set_media_status("Book", "completed")
        first = db.db_get_title_detail("Book")["completed_at"]
        db.db_set_media_status("Book", "completed")
        assert db.db_get_title_detail("Book")["completed_at"] == first

    def test_unknown_status_is_rejected(self, seed, db):
        seed.session(seed.day(1), chars=1_000, secs=600, source="ttsureader", title="Book")
        r = db.db_set_media_status("Book", "abandoned")
        assert r["ok"] is False
        assert _status(db, "Book") == "in_progress"


# ── S2: new reading resumes On hold, never Dropped ───────────────────────────
class TestAutoResume:
    def test_new_chars_resume_on_hold(self, seed, db):
        seed.gsm(seed.day(3), chars=5_000, secs=3600, game_id="g1", title="Game")
        db.db_set_media_status("Game", "on_hold")
        assert _status(db, "Game") == "on_hold"
        seed.gsm(seed.day(1), chars=200, secs=300, game_id="g1", title="Game")
        assert _status(db, "Game") == "in_progress"
        assert db.db_get_title_detail("Game")["status"] == "in_progress"

    def test_time_alone_does_not_resume_a_chars_title(self, seed, db):
        """A GSM row's time can grow from a tail/AFK flush after you stop."""
        seed.gsm(seed.day(3), chars=5_000, secs=3600, game_id="g1", title="Game")
        db.db_set_media_status("Game", "on_hold")
        con = sqlite3.connect(db.DB_PATH)
        con.execute("UPDATE sessions SET time_seconds = time_seconds + 900 WHERE title='Game'")
        con.commit(); con.close()
        assert _status(db, "Game") == "on_hold"

    def test_charsless_media_resumes_on_time(self, seed, db):
        seed.session(seed.day(3), chars=0, secs=1800, source="mangawari", title="巻一")
        db.db_set_media_status("巻一", "on_hold")
        assert _status(db, "巻一") == "on_hold"
        seed.session(seed.day(1), chars=0, secs=600, source="mangawari", title="巻一")
        assert _status(db, "巻一") == "in_progress"

    def test_a_manual_shave_does_not_resume(self, seed, db):
        """The snapshot is on raw sums; a shave is an overlay, not reading."""
        seed.gsm(seed.day(3), chars=0, secs=3600, game_id="g1", title="Game")
        db.db_set_media_status("Game", "on_hold")
        seed.shave(seed.day(3), "g1", +600)
        assert _status(db, "Game") == "on_hold"

    def test_dropped_stays_dropped(self, seed, db):
        seed.gsm(seed.day(3), chars=5_000, secs=3600, game_id="g1", title="Game")
        db.db_set_media_status("Game", "dropped")
        seed.gsm(seed.day(1), chars=200, secs=300, game_id="g1", title="Game")
        assert _status(db, "Game") == "dropped"


# ── S3: the shelf lists In progress only ──────────────────────────────────────
class TestShelf:
    def _book(self, seed, db):
        seed.session(seed.day(2), chars=4_000, secs=3600, source="ttsureader", title="Book")
        db.db_set_media_char_count("Book", 10_000)

    def test_on_hold_and_dropped_leave_the_shelf(self, seed, db):
        self._book(seed, db)
        assert len(db.get_media_shelf()) == 1
        for s in ("on_hold", "dropped", "completed"):
            db.db_set_media_status("Book", s)
            assert db.get_media_shelf() == [], s
        db.db_set_media_status("Book", "in_progress")
        assert len(db.get_media_shelf()) == 1

    def test_resumed_title_returns_to_the_shelf(self, seed, db):
        self._book(seed, db)
        db.db_set_media_status("Book", "on_hold")
        assert db.get_media_shelf() == []
        seed.session(seed.day(1), chars=500, secs=600, source="ttsureader", title="Book")
        assert len(db.get_media_shelf()) == 1


# ── S4: a series pick rewrites its volumes ────────────────────────────────────
class TestSeriesStatus:
    def _series(self, seed):
        for i, t in enumerate(("巻一", "巻二", "巻三")):
            seed.session(seed.day(5 - i), chars=0, secs=1800, source="mangawari", title=t)
        return seed.series("シリーズ", "巻一", "巻二", "巻三")

    def test_dropping_spares_finished_volumes(self, seed, db):
        sid = self._series(seed)
        db.db_set_media_status("巻一", "completed")
        r = db.db_set_series_status(sid, "dropped")
        assert r == {"ok": True, "status": "dropped", "changed": 2}
        assert [_status(db, t) for t in ("巻一", "巻二", "巻三")] == \
            ["completed", "dropped", "dropped"], "what you finished stays finished"

    def test_completing_marks_every_volume(self, seed, db):
        sid = self._series(seed)
        db.db_set_media_status("巻二", "on_hold")
        db.db_set_series_status(sid, "completed")
        assert {_status(db, t) for t in ("巻一", "巻二", "巻三")} == {"completed"}

    def test_in_progress_clears_marks_but_not_completion(self, seed, db):
        sid = self._series(seed)
        db.db_set_media_status("巻一", "completed")
        db.db_set_media_status("巻二", "on_hold")
        db.db_set_media_status("巻三", "dropped")
        db.db_set_series_status(sid, "in_progress")
        assert [_status(db, t) for t in ("巻一", "巻二", "巻三")] == \
            ["completed", "in_progress", "in_progress"]

    def test_series_volumes_snapshot_for_auto_resume(self, seed, db):
        sid = self._series(seed)
        db.db_set_series_status(sid, "on_hold")
        seed.session(seed.day(0), chars=0, secs=600, source="mangawari", title="巻三")
        assert [_status(db, t) for t in ("巻一", "巻二", "巻三")] == \
            ["on_hold", "on_hold", "in_progress"], "only the volume you read resumes"

    def test_unknown_series_and_status_are_rejected(self, seed, db):
        sid = self._series(seed)
        assert db.db_set_series_status(9999, "dropped")["ok"] is False
        assert db.db_set_series_status(sid, "abandoned")["ok"] is False
        assert {_status(db, t) for t in ("巻一", "巻二", "巻三")} == {"in_progress"}


# ── S5: the grid carries the length its edge line draws against ──────────────
class TestGridLength:
    def test_length_matches_the_shelf(self, seed, db):
        seed.gsm(seed.day(2), chars=4_000, secs=3600, game_id="g1", title="Book")
        con = sqlite3.connect(db.DB_PATH)
        con.execute("INSERT INTO gsm_games (game_id, game_name, char_count, last_updated) "
                    "VALUES ('g1','Book',99999,datetime('now'))")
        con.commit(); con.close()
        grid = next(m for m in db.get_media_stats() if m["title"] == "Book")
        assert grid["length"] == db.get_media_shelf()[0]["length"] == 99999
        db.db_set_media_char_count("Book", 8_000)
        grid = next(m for m in db.get_media_stats() if m["title"] == "Book")
        assert grid["length"] == 8_000, "user length wins, as on the shelf"

    def test_unknown_length_is_zero(self, seed, db):
        seed.session(seed.day(1), chars=0, secs=600, source="mangawari", title="巻一")
        assert next(m for m in db.get_media_stats() if m["title"] == "巻一")["length"] == 0
