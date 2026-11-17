"""Reading Anki's review log and bucketing it into Konseki's logical days.

**This module imports nothing from Anki.** That is deliberate: it is the only
part of the addon with real logic in it, and keeping it pure means the repo's
pytest suite can exercise it without Anki installed. `__init__.py` is glue.

Anki's `revlog` table is a complete per-answer ledger: one row per card
answered, ever, with a millisecond timestamp (`id`) and the time spent on that
answer (`time`, also ms). Nothing else is needed to reconstruct a day.

Three facts about that table worth knowing before changing anything here:

- **`time` is already capped** by the deck preset's "maximum answer seconds"
  (default 60), so a card left on screen over lunch contributes a minute, not an
  afternoon. AFK time is bounded at the source, which is why Anki needs no
  equivalent of the `manual_time_adjust` overlay GSM has.
- **Reviews of deleted cards survive** in `revlog`. They are counted, and that
  is correct rather than a leak: the time was really spent.
- **Types 4 and 5** (manual reschedule, set-due) are not answers. They carry
  `time = 0`, so they are excluded twice over — by type and by the time guard.

It also counts **notes added**, from the `notes` table rather than the revlog.
A note's `id` is the millisecond timestamp it was created at, so the ids alone
say which logical day each note was added on. Two consequences of reading it
that way, unlike the revlog:

- **A deleted note is gone from the count.** Deleting a bad mined card lowers
  the day it was added on, the same way Anki's own "Added" graph does.
- **An imported shared deck keeps its author's ids**, so its notes land on the
  author's dates, not the day you imported it. The periodic push only reads the
  last week, so an import never counts there; the backfill drops any note day
  before your first review (see `backfill_range`), but notes whose borrowed
  dates fall inside your own history still count on those days.
"""
from datetime import date, datetime, timedelta

# Learning, review, relearning, filtered/cram. Anki's own "studied today" figure
# is `type != 4`; naming the four we want is the same set today and does not
# quietly acquire a new kind if Anki adds one.
COUNTED_TYPES = (0, 1, 2, 3)

REVLOG_SQL = (
    "SELECT id, time FROM revlog "
    "WHERE type IN (0,1,2,3) AND time > 0 AND id >= ? "
    "ORDER BY id"
)

# Notes, not cards: one mined word is one note, however many card templates its
# note type generates. `id >= ?` is the same bound REVLOG_SQL uses, and `notes.id`
# is the primary key, so a routine push is an index range scan.
NOTES_SQL = "SELECT id FROM notes WHERE id >= ? ORDER BY id"

# Anki's own cap, as a sanity ceiling on a single answer. A revlog row above
# this is corrupt rather than heroic, and one bad row would otherwise land as
# hours of immersion time.
MAX_ANSWER_SECS = 600


def logical_date(ts_ms, rollover_hour):
    """The Konseki logical day a review at `ts_ms` belongs to, as 'YYYY-MM-DD'.

    A literal transcription of `logical_date_for` in src/db.py and the pseudocode
    in CLIENT-INTEGRATION.md. **Konseki's rollover hour, not Anki's** — the two
    are independent settings and every other source in Konseki sits on Konseki's
    calendar, so this one does too. The visible consequence is that Anki's own
    "cards studied today" can disagree with Konseki's Anki row on days where the
    two hours straddle a review.
    """
    dt = datetime.fromtimestamp(ts_ms / 1000.0)   # naive local, like db.py
    d  = dt.date()
    if rollover_hour > 0 and dt.hour < rollover_hour:
        d -= timedelta(days=1)
    return d.isoformat()


def logical_day_start_ms(date_str, rollover_hour):
    """Epoch ms at which logical day `date_str` begins.

    Inverse of `logical_date`: a review at exactly this instant belongs to
    `date_str`, and one a millisecond earlier belongs to the day before. Used to
    bound the incremental query so a routine push reads two days of revlog
    rather than all of it.
    """
    d = date.fromisoformat(date_str)
    return int(datetime(d.year, d.month, d.day, rollover_hour).timestamp() * 1000)


def today_logical(rollover_hour, now_ms=None):
    """Konseki's logical 'today', the same value `get_today()` returns."""
    if now_ms is None:
        now_ms = int(datetime.now().timestamp() * 1000)
    return logical_date(now_ms, rollover_hour)


def prev_day(date_str):
    return (date.fromisoformat(date_str) - timedelta(days=1)).isoformat()


def next_day(date_str):
    return (date.fromisoformat(date_str) + timedelta(days=1)).isoformat()


def date_range(start, end):
    """Every date from `start` to `end` inclusive, including empty ones.

    The backfill reports on this rather than on the dates it found reviews for.
    A date with no reviews still has to be SENT, as 0/0, or a re-run cannot
    correct a row the previous run put there wrongly: `days_payload` would
    simply never mention that date again and its stale row would survive.
    """
    out, d = [], start
    while d <= end:
        out.append(d)
        d = next_day(d)
    return out


def recent_days(end_date, n):
    """The `n` logical days ending at `end_date`, oldest first.

    The push window. Wider than "today and yesterday" because a sync can bring
    in reviews done on a phone days ago, and because Anki may not have been
    opened since. A day outside this window is only ever corrected by re-running
    the backfill.
    """
    out = [end_date]
    for _ in range(max(0, n - 1)):
        out.append(prev_day(out[-1]))
    return list(reversed(out))


def bucket_reviews(rows, rollover_hour):
    """`(revlog_id_ms, time_ms)` rows -> `{date: (secs, cards)}`.

    Bucketing happens here in Python rather than in the SQL. The SQL form —
    `date(id/1000 - rollover*3600, 'unixepoch', 'localtime')` — is shorter, but
    it leans on SQLite's `localtime` modifier inside Anki's Rust-backed
    connection, and that is one more thing that can quietly disagree with
    `datetime.fromtimestamp` about a DST boundary. The Python form is the one
    src/db.py uses, so the two calendars are the same calendar by construction.

    Rows with no usable time are skipped rather than counted as a zero-second
    card: a card in the count with nothing in the time would drag cards/hour up.
    """
    out = {}
    for row in rows:
        ts_ms, time_ms = row[0], row[1]
        if not ts_ms or not time_ms or time_ms <= 0:
            continue
        secs = min(time_ms / 1000.0, MAX_ANSWER_SECS)
        d = logical_date(ts_ms, rollover_hour)
        prev_secs, prev_cards = out.get(d, (0.0, 0))
        out[d] = (prev_secs + secs, prev_cards + 1)
    return out


def bucket_notes(rows, rollover_hour):
    """`(note_id_ms,)` rows -> `{date: notes_added}`.

    Same calendar as `bucket_reviews`, by the same function, so a note mined at
    01:00 under a rollover of 4 counts toward the same logical day as the
    reviews done alongside it.
    """
    out = {}
    for row in rows:
        ts_ms = row[0]
        if not ts_ms or ts_ms <= 0:
            continue
        d = logical_date(ts_ms, rollover_hour)
        out[d] = out.get(d, 0) + 1
    return out


def backfill_range(review_buckets, note_buckets):
    """`(dates, notes)` for the history backfill: the dense range it reports on,
    and the note counts it may send within it.

    The range starts on the **first day with reviews, never earlier.** An
    imported shared deck keeps its author's note ids, so a deck built in 2012
    would otherwise put notes-only days in 2012 — rows that pull Konseki's
    earliest date back by years and stretch every all-time chart to cover them.
    Note days before that start are dropped.

    It ends on the later of the last review day and the last note day, so a
    final day with mining but no reviews is still sent.
    """
    if not review_buckets:
        return [], {}
    start = min(review_buckets)
    end   = max([max(review_buckets)] + [d for d in note_buckets if d >= start])
    notes = {d: n for d, n in note_buckets.items() if d >= start}
    return date_range(start, end), notes


def days_payload(buckets, dates, client_id_for, notes=None):
    """Turn `{date: (secs, cards)}` into the `days` list the tracker expects.

    `dates` is what to report on, not what was found — a date with no reviews
    must still be sent, as `0/0`, because that is how a day the user emptied out
    (undone reviews, a deleted deck) gets its stored row deleted. Sending only
    the dates present in `buckets` would leave that row frozen at its old total
    forever.

    `notes` is `{date: notes_added}` from `bucket_notes`. When it is given,
    every day carries `notes_added`, zero included — a day whose notes were all
    deleted must be able to fall to zero. When it is None the field is left out
    entirely, which the server reads as "leave the stored count alone".
    """
    days = []
    for d in dates:
        secs, cards = buckets.get(d, (0.0, 0))
        day = {
            "session_date": d,
            "time_seconds": round(secs, 3),
            "cards":        cards,
            "client_id":    client_id_for(d),
        }
        if notes is not None:
            day["notes_added"] = notes.get(d, 0)
        days.append(day)
    return days
