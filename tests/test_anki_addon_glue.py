"""The add-on's scheduling: debounce, sync trigger, and retry-after-failure.

`__init__.py` needs Anki to import, so `aqt` is stubbed the same way
`verify_ui.js` stubs browser globals — enough of a shim to load the module and
drive it. What is under test is the trigger logic, which is where the bug was:
the old polling timer cleared the dirty flag before the request and never
restored it on failure, so the retry its own comment promised never happened.
"""
import sys
import types
from datetime import datetime, timedelta
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


class _Future:
    def __init__(self, value=None, exc=None):
        self._value, self._exc = value, exc

    def result(self):
        if self._exc:
            raise self._exc
        return self._value


def _install_aqt_stub():
    """Minimum surface of aqt for the add-on to import and run."""
    armed = []          # (delay_ms, callable) queued by progress.single_shot

    class _Q:
        """Stands in for every Qt widget class the module names."""
        def __init__(self, *a, **k):
            self.triggered = types.SimpleNamespace()

        def __getattr__(self, _name):
            return lambda *a, **k: None

    class _DBB(_Q):
        StandardButton = types.SimpleNamespace(Ok=1, Cancel=2)

    taskman = types.SimpleNamespace()

    def run_in_background(work, on_done=None, *a, **k):
        try:
            fut = _Future(value=work())
        except Exception as e:                       # noqa: BLE001
            fut = _Future(exc=e)
        if on_done:
            on_done(fut)
    taskman.run_in_background = run_in_background
    taskman.run_on_main = lambda fn: fn()

    mw = types.SimpleNamespace(
        addonManager=types.SimpleNamespace(getConfig=lambda _m: dict(CONFIG)),
        col=types.SimpleNamespace(db=types.SimpleNamespace(
            all=lambda sql, *a: list(NOTES if "FROM notes" in sql else REVLOG))),
        taskman=taskman,
        progress=types.SimpleNamespace(
            single_shot=lambda ms, fn, req=True: armed.append((ms, fn))),
        form=types.SimpleNamespace(
            menuTools=types.SimpleNamespace(addAction=lambda _a: None)),
    )

    aqt = types.ModuleType("aqt")
    aqt.mw = mw
    aqt.gui_hooks = types.SimpleNamespace(
        profile_did_open=[], profile_will_close=[],
        reviewer_did_answer_card=[], sync_did_finish=[])

    qt = types.ModuleType("aqt.qt")
    for name in ("QAction", "QCheckBox", "QDialog", "QLabel",
                 "QProgressBar", "QVBoxLayout"):
        setattr(qt, name, _Q)
    qt.QDialogButtonBox = _DBB
    qt.qconnect = lambda *a, **k: None

    utils = types.ModuleType("aqt.utils")
    utils.showWarning = lambda *a, **k: None
    utils.tooltip = lambda *a, **k: None

    aqt.qt, aqt.utils = qt, utils

    anki = types.ModuleType("anki")
    anki.hooks = types.SimpleNamespace(note_will_be_added=[])

    sys.modules.update({"aqt": aqt, "aqt.qt": qt, "aqt.utils": utils,
                        "anki": anki, "anki.hooks": anki.hooks})
    return mw, armed


CONFIG = {"host": "127.0.0.1", "port": 18463, "token": "t0ken",
          "collection_tag": "", "idle_push_mins": 5}
REVLOG = []
NOTES = []


class FakeTracker:
    """Records posts; fails on demand."""

    def __init__(self, fail=False):
        self.fail, self.posts = fail, []

    def client_id(self, d):
        return f"anki:{d}"

    def post_days(self, days, skip_vocab_days=None):
        self.posts.append(list(days))
        if self.fail:
            raise RuntimeError("konseki down")
        return {"logged": True, "days": len(days)}


@pytest.fixture
def addon(tmp_path):
    """A freshly imported add-on module with aqt stubbed and state isolated."""
    global REVLOG, NOTES
    mw, armed = _install_aqt_stub()
    for mod in [m for m in sys.modules if m.startswith("konseki_anki")]:
        del sys.modules[mod]
    sys.path.insert(0, str(REPO / "anki"))
    import konseki_anki as k

    k.STATE_PATH = str(tmp_path / "state.json")
    k._state = {"posted": {}, "rollover": 0, "rollover_seen": True}
    k._dirty, k._arm_gen, k._retry = True, 0, 0

    # One review today, so there is always something to send.
    now = datetime.now()
    REVLOG = [(int((now - timedelta(minutes=5)).timestamp() * 1000), 30_000)]
    NOTES = []

    k._armed = armed
    yield k
    armed.clear()


def _fire_last(addon):
    """Run the most recently armed timer callback."""
    addon._armed[-1][1]()


class TestDebounce:
    def test_answering_a_card_arms_a_timer_rather_than_pushing(self, addon):
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        assert addon._armed, "no timer was armed"
        assert addon._armed[-1][0] == 5 * 60_000
        assert tk.posts == [], "pushed immediately instead of debouncing"

    def test_each_card_pushes_the_deadline_back(self, addon):
        """Re-arming supersedes: the earlier closure must become a no-op, or a
        long study session fires one push per card answered."""
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        first = addon._armed[-1][1]
        addon.mark_dirty()
        second = addon._armed[-1][1]

        first()
        assert tk.posts == [], "a superseded timer still pushed"
        second()
        assert len(tk.posts) == 1

    def test_the_delay_follows_the_config(self, addon):
        CONFIG["idle_push_mins"] = 2
        try:
            addon.mark_dirty()
            assert addon._armed[-1][0] == 2 * 60_000
        finally:
            CONFIG["idle_push_mins"] = 5


class TestNoteTrigger:
    """Adding a note (Yomitan via AnkiConnect, or the Add window) must reach
    Konseki on its own — a day of mining with no reviews has no other trigger."""

    def test_the_hook_is_registered(self, addon):
        assert addon.on_note_added in sys.modules["anki"].hooks.note_will_be_added

    def test_adding_a_note_arms_the_debounce_rather_than_pushing(self, addon):
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.on_note_added(object(), object(), 1)
        assert addon._armed[-1][0] == 5 * 60_000
        assert tk.posts == []

    def test_the_hook_never_raises(self, addon, monkeypatch):
        """An exception here propagates into Collection.add_note and the note
        is never added — every Yomitan mine would fail."""
        def boom(_fn):
            raise RuntimeError("no main thread")
        monkeypatch.setattr(addon.mw.taskman, "run_on_main", boom)
        addon.on_note_added(object(), object(), 1)      # must not raise

    def test_a_push_carries_the_days_notes(self, addon):
        global NOTES
        tk = FakeTracker()
        addon.tracker = lambda: tk
        NOTES = [(int(datetime.now().timestamp() * 1000),)] * 3
        addon.mark_dirty()
        _fire_last(addon)
        today = tk.posts[0][-1]
        assert today["notes_added"] == 3
        assert all("notes_added" in d for d in tk.posts[0])

    def test_a_new_note_alone_resends_its_day(self, addon):
        global NOTES
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)

        NOTES = NOTES + [(int(datetime.now().timestamp() * 1000),)]
        addon.on_note_added(object(), object(), 1)
        _fire_last(addon)
        assert len(tk.posts) == 2
        assert [d["notes_added"] for d in tk.posts[1]] == [1]

    def test_a_pre_upgrade_confirmed_map_resends_once(self, addon):
        """Two-number entries from before notes never match, so the week is
        re-sent once and its note counts fill in."""
        import konseki_anki.revlog as rl
        tk = FakeTracker()
        addon.tracker = lambda: tk
        today = rl.today_logical(0)
        addon._state["posted"] = {today: [30.0, 1]}
        addon.mark_dirty()
        _fire_last(addon)
        assert today in [d["session_date"] for d in tk.posts[0]]


class TestSyncTrigger:
    def test_a_finished_sync_pushes_at_once(self, addon):
        """A sync is the one event that can introduce reviews from another
        device, so it does not wait out the debounce."""
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.on_sync_done()
        assert len(tk.posts) == 1


class TestRetry:
    def test_a_failed_push_restores_dirty_and_arms_a_retry(self, addon):
        """The bug the polling timer only claimed to cover. Without restoring
        the flag, every later trigger short-circuits on `not _dirty` and the
        day is never sent again."""
        tk = FakeTracker(fail=True)
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)

        assert len(tk.posts) == 1
        assert addon._dirty is True, "dirty flag was not restored"
        assert addon._armed[-1][0] == addon.RETRY_MS[0]

    def test_the_retry_backs_off_and_is_capped(self, addon):
        tk = FakeTracker(fail=True)
        addon.tracker = lambda: tk
        delays = []
        for _ in range(5):
            addon.mark_dirty()
            _fire_last(addon)
            delays.append(addon._armed[-1][0])
        assert delays[:3] == list(addon.RETRY_MS)
        assert delays[3:] == [addon.RETRY_MS[-1]] * 2

    def test_a_success_clears_the_backoff(self, addon):
        failing = FakeTracker(fail=True)
        addon.tracker = lambda: failing
        addon.mark_dirty()
        _fire_last(addon)
        assert addon._retry == 1

        ok = FakeTracker()
        addon.tracker = lambda: ok
        addon.mark_dirty()
        _fire_last(addon)
        assert addon._retry == 0

    def test_a_failed_push_does_not_mark_the_day_confirmed(self, addon):
        tk = FakeTracker(fail=True)
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)
        assert addon._state["posted"] == {}


class TestWindow:
    def test_the_push_covers_seven_days(self, addon):
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)
        assert addon.PUSH_WINDOW_DAYS == 7
        assert len(tk.posts[0]) == 7

    def test_days_are_contiguous_and_end_today(self, addon):
        import konseki_anki.revlog as rl
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)
        dates = [d["session_date"] for d in tk.posts[0]]
        assert dates == sorted(dates)
        assert dates[-1] == rl.today_logical(0)
        assert dates == rl.recent_days(dates[-1], 7)

    def test_an_unchanged_day_is_not_resent(self, addon):
        """What makes a seven-day window as cheap as a two-day one."""
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)
        assert len(tk.posts) == 1

        addon.mark_dirty()
        _fire_last(addon)
        assert len(tk.posts) == 1, "re-sent days that had not moved"

    def test_a_day_that_moves_is_resent(self, addon):
        global REVLOG
        tk = FakeTracker()
        addon.tracker = lambda: tk
        addon.mark_dirty()
        _fire_last(addon)

        now = datetime.now()
        REVLOG = REVLOG + [(int(now.timestamp() * 1000), 12_000)]
        addon.mark_dirty()
        _fire_last(addon)
        assert len(tk.posts) == 2
        assert len(tk.posts[1]) == 1, "resent the whole window, not just the change"
