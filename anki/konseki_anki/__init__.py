"""Konseki — Anki review time and card counts.

Glue only. The logic lives in `revlog.py` (pure, unit-tested in the Konseki
repo's pytest suite) and `net.py` (the wire contract). Keep it that way: nothing
in this file should be worth testing.

Two things it is responsible for:

  * Pushing recent days' cumulative totals, on the triggers below.
  * A one-shot history backfill, from the Tools menu.

**The collection is read on the main thread, the network is not.** `mw.col.db`
is not safe to touch from a worker, and the read is a single indexed scan —
milliseconds even for a large collection. The POST is what can block for
seconds, so that is what goes to `taskman`.

## When it pushes, and why there is no polling timer

Nothing here runs on a fixed cadence. A repeating timer would wake up every few
minutes forever to discover that nothing had changed, and — the reason it was
removed — the *only* job it uniquely had was retrying a failed push, which it
did not actually do: `push_now` cleared the dirty flag before the request, and
the failure path never set it back, so the next tick returned early. A push that
failed was not retried until the next answered card, sync, or restart.

What replaces it:

  * **Answering a card** re-arms a one-shot timer `idle_push_mins` out. Each
    card pushes the deadline back, so a study session produces ONE push, when
    you stop, rather than one every few minutes while you work.
  * **Adding a note** does the same, so a mining session with no reviews still
    reaches Konseki. It hangs off Anki's `note_will_be_added` hook, which
    `Collection.add_note(s)` fires for every caller — the Add window and
    AnkiConnect (Yomitan) alike — and which a shared-deck import, going
    through the backend importer instead, does not.
  * **A finished sync** pushes immediately — a sync is a natural checkpoint and
    is the one event that can introduce reviews done elsewhere.
  * **Opening a profile** pushes shortly after load; **closing one** pushes
    immediately.
  * **A failed push** restores the dirty flag and arms a backing-off retry,
    which stops itself once the post lands.

Net effect: no wakeups at all while idle and healthy, and a retry path that
works, which is the part the old timer only claimed to have.
"""
import json
import os
import time

from anki import hooks as anki_hooks
from aqt import gui_hooks, mw
from aqt.qt import (QAction, QCheckBox, QDialog, QDialogButtonBox, QLabel,
                    QProgressBar, QVBoxLayout, qconnect)
from aqt.utils import showWarning, tooltip

from . import revlog as rl
from .net import Tracker, TrackerError

ADDON_DIR   = os.path.dirname(__file__)
STATE_PATH  = os.path.join(ADDON_DIR, "user_files", "state.json")
DEFAULT_CFG = {
    "host": "127.0.0.1", "port": 18463, "token": "",
    "collection_tag": "", "idle_push_mins": 5,
}

# How many logical days each push re-states. Wider than today+yesterday because
# a sync can bring in phone reviews from several days back, and because Anki may
# not have been opened since. Every day in the window is keyed and idempotent,
# and the confirmed-map filter means an unchanged day costs nothing to include —
# so the window is bounded by taste, not by cost. Days older than this are only
# corrected by re-running the backfill.
PUSH_WINDOW_DAYS = 7

# Backoff for a push that failed. Capped, and abandoned entirely once one lands.
RETRY_MS   = (60_000, 300_000, 900_000)
STARTUP_MS = 5_000        # let the profile finish loading before the first push

# Module state. `rollover` is cached across restarts on purpose — a failed
# /config fetch must keep the last known value, and "restart Anki" is a failed
# fetch like any other. Defaulting to 0 here would file every late-night review
# under the wrong logical day, silently.
_state    = {"posted": {}, "rollover": 0, "rollover_seen": False}
_dirty    = True
_arm_gen  = 0             # supersession counter for the one-shot timer
_retry    = 0             # index into RETRY_MS


# ── config + state ────────────────────────────────────────────────────────────
def cfg():
    stored = mw.addonManager.getConfig(__name__) or {}
    return {**DEFAULT_CFG, **stored}


def idle_delay_ms():
    return max(1, int(cfg().get("idle_push_mins") or 5)) * 60_000


def tracker():
    c = cfg()
    return Tracker(c["host"], c["port"], c["token"], c["collection_tag"])


def load_state():
    global _state
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            _state.update(loaded)
    except (OSError, ValueError):
        pass          # first run, or a truncated write — start clean


def save_state():
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_state, fh)
        os.replace(tmp, STATE_PATH)     # atomic; a crash mid-write can't truncate
    except OSError:
        pass


# ── reading the collection (main thread only) ─────────────────────────────────
def read_days(dates):
    """`(reviews, notes)` buckets covering `dates` (contiguous, oldest first)."""
    return _read(rl.logical_day_start_ms(dates[0], _state["rollover"]))


def read_all():
    return _read(0)


def _read(since):
    roll = _state["rollover"]
    return (rl.bucket_reviews(mw.col.db.all(rl.REVLOG_SQL, since), roll),
            rl.bucket_notes(mw.col.db.all(rl.NOTES_SQL, since), roll))


# ── scheduling ────────────────────────────────────────────────────────────────
def arm(delay_ms):
    """(Re)arm a one-shot push, superseding any already pending.

    Anki's `single_shot` cannot be cancelled, so supersession is done with a
    generation counter: a closure that fires after a later re-arm sees its
    generation is stale and does nothing. That is what makes this a debounce —
    each answered card pushes the deadline back instead of queuing another push.

    `requires_collection=False` deliberately: Anki's own guard prints a line to
    stdout when it drops a timer, and `push_now` already returns early with no
    collection.
    """
    global _arm_gen
    _arm_gen += 1
    gen = _arm_gen

    def fire():
        if gen != _arm_gen:
            return                    # a later re-arm won
        try:
            push_now()
        except Exception:
            pass                      # never let a timer callback escape
    mw.progress.single_shot(delay_ms, fire, False)


def mark_dirty(*args, **kwargs):
    """A card was answered. Debounce: push once the session goes quiet."""
    global _dirty
    _dirty = True
    arm(idle_delay_ms())


def on_note_added(*args, **kwargs):
    """A note is about to be added (`note_will_be_added`). Same debounce as an
    answered card, so a mining session produces one push when it goes quiet.

    The hook fires BEFORE the note is written, which is fine: the push is at
    least a minute out, by which time it is in the table.

    Two things here are load-bearing:

    - **Nothing may escape.** An exception raised from this hook propagates
      into `Collection.add_note` and the note is never added — every Yomitan
      mine would fail, for the sake of a statistic.
    - **It is handed to the main thread.** The Add window adds its note from a
      background op, and `arm` starts a Qt timer, which only works from the
      main thread. `run_on_main` is safe to call from either.
    """
    try:
        mw.taskman.run_on_main(mark_dirty)
    except Exception:
        pass


def on_sync_done(*args, **kwargs):
    """A sync is a checkpoint, and the one event that can introduce reviews
    done on another device. No debounce — push straight away."""
    global _dirty
    _dirty = True
    try:
        push_now()
    except Exception:
        pass


# ── the push ──────────────────────────────────────────────────────────────────
def push_now(force=False):
    """Re-state the recent window's cumulative totals, if any of them moved."""
    global _dirty
    c = cfg()
    if not c["token"]:
        return
    if not (_dirty or force) or mw.col is None:
        return
    _dirty = False

    tk    = tracker()
    today = rl.today_logical(_state["rollover"])
    dates = rl.recent_days(today, PUSH_WINDOW_DAYS)
    reviews, notes = read_days(dates)
    days  = rl.days_payload(reviews, dates, tk.client_id, notes)

    # Only what actually moved. A day is re-sent whenever its numbers differ from
    # the last CONFIRMED post — including downward, which is how an undo lands.
    # In steady state this is empty and nothing goes over the wire, which is what
    # makes a seven-day window as cheap as a two-day one. A confirmed entry from
    # before notes were counted has two numbers, not three, so it never matches:
    # every day is re-sent once after the upgrade, which is what fills in the
    # week's note counts.
    pending = [d for d in days
               if _state["posted"].get(d["session_date"]) != _confirmed(d)]
    if not pending:
        return

    def work():
        # No skip flag: this is the periodic push, and the absent key is what
        # tells the server to leave an existing row's time_excluded alone.
        return tk.post_days(pending)

    def done(future):
        global _dirty, _retry
        try:
            future.result()
        except Exception:
            # The local collection is still the only confirmed copy. Put the
            # dirty flag BACK — without this the retry never happens, because
            # every later trigger short-circuits on `not _dirty`.
            _dirty = True
            arm(RETRY_MS[min(_retry, len(RETRY_MS) - 1)])
            _retry += 1
            return
        _retry = 0
        for d in pending:
            _state["posted"][d["session_date"]] = _confirmed(d)
        prune_posted()
        save_state()

    mw.taskman.run_in_background(work, done)


def _confirmed(day):
    """What the confirmed map remembers of a sent day — every number in it."""
    return [day["time_seconds"], day["cards"], day.get("notes_added")]


def prune_posted():
    """Keep the confirmed map to the push window; older entries can't be used."""
    keep = set(rl.recent_days(rl.today_logical(_state["rollover"]), PUSH_WINDOW_DAYS))
    _state["posted"] = {k: v for k, v in _state["posted"].items() if k in keep}


# ── backfill ──────────────────────────────────────────────────────────────────
class BackfillDialog(QDialog):
    def __init__(self, parent, buckets, note_buckets):
        super().__init__(parent)
        self.buckets = buckets
        # Range and notes decided once, here, so what the dialog reports is
        # exactly what `send` posts.
        self.dates, self.notes = rl.backfill_range(buckets, note_buckets)
        self.setWindowTitle("Send Anki history to Konseki")

        dates = sorted(buckets)
        secs  = sum(s for s, _ in buckets.values())
        cards = sum(c for _, c in buckets.values())
        added = sum(self.notes.values())

        lay = QVBoxLayout(self)
        lay.addWidget(QLabel(
            f"<b>{len(dates)}</b> days with reviews<br>"
            f"{dates[0] if dates else '—'} to {dates[-1] if dates else '—'}<br><br>"
            f"<b>{secs / 3600:,.0f}</b> hours &nbsp;·&nbsp; <b>{cards:,}</b> cards"
            f" &nbsp;·&nbsp; <b>{added:,}</b> notes added"
        ))

        # Checked by default. The addon makes no judgement of its own here and
        # cannot: it has no view of what is already logged in Konseki. It sends
        # the flag; the server decides day by day and reports back.
        self.skip = QCheckBox("Don't count time on days I already logged Vocabulary time")
        self.skip.setChecked(True)
        lay.addWidget(self.skip)
        lay.addWidget(QLabel(
            "<i>Those days keep the time you logged by hand. Their card counts "
            "are still imported.</i>"))

        self.bar = QProgressBar()
        self.bar.setVisible(False)
        lay.addWidget(self.bar)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        qconnect(self.buttons.accepted, self.send)
        qconnect(self.buttons.rejected, self.reject)
        lay.addWidget(self.buttons)

    def send(self):
        tk   = tracker()
        skip = self.skip.isChecked()
        # The dense range, not just the days with reviews. An empty day sends
        # 0/0/0, which DELETES a row a previous run put there wrongly - the same
        # rule the periodic push already follows. Sending only the days found
        # would leave such a row stranded at its old total forever.
        days = rl.days_payload(self.buckets, self.dates, tk.client_id, self.notes)
        self.buttons.setEnabled(False)
        self.bar.setVisible(True)
        self.bar.setMaximum(len(days))

        def work():
            return tk.post_all(days, skip_vocab_days=skip)

        def done(future):
            self.bar.setVisible(False)
            self.buttons.setEnabled(True)
            try:
                out = future.result()
            except TrackerError as e:
                showWarning(f"Backfill failed: {e}", parent=self)
                return
            # An inbox only STORED the payload; it has no database and cannot
            # say what was inserted or suppressed. Reporting its zeros as if
            # they were counters would claim the run did nothing.
            if out.get("queued"):
                msg = (f"{out['days']} days queued for Konseki." "\n" +
                       "They will appear the next time the desktop app "
                       "drains the inbox.")
            else:
                n = len(out["skipped_days"])
                msg = (f"{out['days']} days imported "
                       f"({out['inserted']} new, {out['updated']} updated).")
                if n:
                    msg += ("\n" + f"Time suppressed on {n} days that "
                            "already had Vocabulary logged.")
            tooltip(msg, period=6000)
            # Those rows are authoritative now; drop the confirmed map so the
            # next push re-states the window rather than assuming.
            _state["posted"] = {}
            save_state()
            self.accept()

        mw.taskman.run_in_background(work, done)


def open_backfill():
    if mw.col is None:
        return
    if not cfg()["token"]:
        showWarning("Set the host and token in the addon config first "
                    "(Tools → Add-ons → Konseki → Config).")
        return
    why = refresh_rollover(blocking=True)
    if not _state["rollover_seen"]:
        # Refuse rather than guess. Without Konseki's rollover hour we would
        # bucket the WHOLE history at 0, and if the real setting is non-zero
        # every late-night review lands a day early. That is not something a
        # later run cleans up by itself, so it must not happen silently.
        showWarning(
            "Konseki did not answer, so the day-rollover hour is unknown."
            "\n\n"
            f"{why}"
            "\n\n"
            "Backfilling without it would file every late-night review under "
            "the wrong day, so nothing was sent. Check the host, port and token "
            "in this add-on's config, and that Konseki is running.")
        return
    buckets, notes = read_all()   # main thread: mw.col.db is not thread-safe
    if not buckets:
        tooltip("No reviews found in this collection.")
        return
    BackfillDialog(mw, buckets, notes).exec()


# ── lifecycle ─────────────────────────────────────────────────────────────────
def refresh_rollover(blocking=False):
    """Fetch Konseki's rollover hour. Never resets the cache on failure."""
    def work():
        return tracker().fetch_rollover_hour()

    def done(future):
        try:
            hour = future.result()
        except Exception:
            return
        if hour is not None:
            _state["rollover"] = hour
            _state["rollover_seen"] = True
            save_state()

    if blocking:
        tk = tracker()
        try:
            hour = tk.fetch_rollover_hour()
        except Exception as e:
            return str(e)
        if hour is None:
            return tk.last_error or "Konseki did not answer."
        _state["rollover"] = hour
        _state["rollover_seen"] = True
        save_state()
        return None
    mw.taskman.run_in_background(work, done)
    return None


def on_profile_open():
    global _retry
    load_state()
    refresh_rollover()
    _retry = 0
    # Forget what we believe about the whole window, so a row deleted in Konseki
    # is re-created on the next push rather than staying "confirmed" forever
    # against a row that no longer exists.
    _state["posted"] = {}
    _dirty_on()
    arm(STARTUP_MS)


def _dirty_on():
    global _dirty
    _dirty = True


def on_profile_close():
    try:
        push_now(force=True)
        # taskman work is dropped at shutdown, so give the post a moment to
        # leave. Anything that doesn't is re-sent on the next launch — the day
        # totals are cumulative, so nothing is lost by arriving late.
        time.sleep(0.4)
    except Exception:
        pass


action = QAction("Send Anki history to Konseki…", mw)
qconnect(action.triggered, open_backfill)
mw.form.menuTools.addAction(action)

gui_hooks.profile_did_open.append(on_profile_open)
gui_hooks.profile_will_close.append(on_profile_close)
gui_hooks.reviewer_did_answer_card.append(mark_dirty)
gui_hooks.sync_did_finish.append(on_sync_done)
anki_hooks.note_will_be_added.append(on_note_added)
