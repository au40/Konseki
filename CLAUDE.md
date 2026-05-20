# GSM rollover attribution

The `gsm_rollover_attributions` table (defined in [db.py](db.py)) is a load-bearing
cross-cutting concern. **Any query that surfaces session-level chars/time/cards
must apply it.** Forgetting to do so produces numbers that silently disagree
with the rest of the app.

## Why it exists

Sessions are stored in the `sessions` table at their **real calendar
`session_date`**. But the user can set a `rollover_hour` in settings — when
non-zero, "logical today" is the previous calendar date until that hour passes
(see `get_today()` in [db.py](db.py)). GSM is the only source that pulls
incrementally during this rollover window, so it's the only source that needs
attribution: a GSM pull at 01:00 on 2026-05-14 with `rollover_hour=4` writes
session rows under `session_date='2026-05-14'`, but those chars logically
belong to the user's 2026-05-13 day.

The attribution table reconciles the two:

```
gsm_rollover_attributions (
    rollover_date TEXT,   -- where chars should DISPLAY
    source_date   TEXT,   -- where the session row actually LIVES
    chars         INTEGER,
    time_seconds  REAL,
    cards         INTEGER,
    updated_at    TEXT,
    PRIMARY KEY (rollover_date, source_date)
)
```

Only rows with `rollover_date <> source_date` represent an actual displacement.
Rows where they match are no-ops (they exist as snapshots for tail-settle).

Attribution rows are written by `upsert_gsm_attribution` and
`refresh_gsm_attribution_tail` in [db.py](db.py), called from the GSM import
path in [imports.py](imports.py). When the history import (`import_gsm_history_apply`)
updates a session row's totals, `_sync_rollover_attribution_to` in
[imports.py](imports.py) **clamps** that date's attributions so a displacement
never exceeds the new total (preventing ghost rows in per-title charts). It must
only ever SHRINK a displacement, never grow one — a displacement is a fixed
historical event. The old version overwrote the attribution to the full-day
total, which turned a 0- or partial-displacement row into a full-day displacement
and shoved an entire day's reading onto the prior day.

## How to apply it

There are two canonical patterns. Pick whichever fits the query shape:

**1. Per-row reconciliation (multi-session lists).** Used by `get_today_stats`
in [db.py](db.py) and `get_recent_sessions` (History page). The shape is:

- Fetch raw session rows for the dates you care about.
- For each date, **deduct** the sum of outgoing attributions
  (`source_date=d AND rollover_date<>d`) from the first GSM row on that date.
- **Drop** any row whose chars/secs/lines are all zero after the deduction.
- For each date, **synthesize phantom rows** for incoming attributions
  (`rollover_date=d AND source_date<>d`), grouped by `source_date` so each
  phantom row can borrow its title from a real session on that source date.
  Phantom rows have `id=None`; the UI's `makeSessionRow` already handles this.

**2. Net adjustment per day (single-number-per-day queries).** Used by
`get_daily_time_series`, `get_weekly_summary`, and `get_heatmap` in
[db.py](db.py). Helper: `get_gsm_day_adjustment(d)` returns
`(chars_delta, secs_delta, cards_delta)` to add to date `d`'s raw GSM totals.
Always `max(0, raw + delta)` — net can go negative if all chars rolled out.

## The invariant

If you write a new query that produces session-level chars/time data shown to
the user, audit it against this table. The History page was the lone holdout
through eab585e and was fixed afterward — that's the kind of drift to watch
for. The dashboard, stats range totals, daily/weekly series, heatmap,
per-title detail, the Stats-page best-day/best-week/streak/consistency
cards, and `get_range_totals` all already apply attribution; mirror
whichever of those matches your query shape. The Stats-page extra-stats
cards (`_best_day`/`_best_week`/`get_streak`/`get_range_totals`) build off
the shared `_adjusted_day_totals` helper — reuse it rather than re-deriving.

## Misc related notes

- `in_rollover_window()` in [db.py](db.py) is the test for "are we currently
  inside the window where attribution writes can happen." Use it before
  capturing snapshots; don't use it to decide whether to APPLY attribution
  (always apply, regardless of current time).
- `window_bounds(n)` clamps date-ranged queries to logical-today as the upper
  bound. GSM imports can write `session_date` values that exceed logical today
  during the rollover window, so any unbounded `WHERE session_date >= ?` query
  will leak future-dated rows. Use `window_bounds` or replicate its clamping.
- The attribution table is GSM-specific. No other source (ttsu, anki, manual,
  ext) needs it because they don't do live incremental pulls during the
  rollover window.

## GSM "reopen catch-up" pull — EXPERIMENTAL

`GsmWalHandler` in [tracker.py](tracker.py) has a third pull trigger
(`open_gap_secs`, setting `gsm_open_gap_secs`, **default 0 = OFF**, UI: Settings →
Advanced → "GSM reopen catch-up gap"): when a WAL write arrives after GSM has
been idle longer than the gap, it fires a pull immediately, before the debounce.
It ships disabled because in practice the normal post-rollover settle/debounce
pulls already grow the attribution tail in the quiet window before new reading
resumes (observed on real data: the attribution time settled correctly with no
reopen pull involved). It's left as an opt-in switch for the narrow case it
targets — GSM closed before the settle pull fires, then reopened the same day. The intent is to land in the quiet window after GSM flushes the
previous session's tail/AFK time but before the first new line, so
`refresh_gsm_attribution_tail` can grow yesterday's attribution while its char
count is still unchanged (the chars guard makes this safe — if new reading has
already bumped the count, the refresh no-ops instead of misattributing it).

**This is experimental.** Known limits, accepted by design:
- It only catches tail when GSM is reopened on the **same real calendar date**
  the post-midnight chars landed on. The post-rollover refresh is hardwired to
  `source_date = today's real date`, `rollover_date = yesterday`, so it cannot
  reach an attribution row from days ago. A midnight-crossing session followed
  by a multi-day GSM hiatus leaves that tail orphaned on its real date.
- It's racy: if you start reading immediately on reopen (first new line lands
  before the catch-up pull), the chars guard trips and the tail stays on today.
- The accepted rationale: it only needs to work for consecutive reading days
  (read late, read again next day), which is the case that actually occurs.
  Fully closing the gap would require the line-level `game_lines` approach
  (per-line timestamps), which is not built.

If you revisit this, the safe direction is reconciling recent PAST dates
explicitly (a closed calendar day can only grow via tail, so absorbing its
growth needs no chars guard) — but it turns ambiguous on days that mixed a
rollover session with later same-day reading, which again points to `game_lines`.

# Reading speed = chars / time, never `sessions.reading_speed`

Any chars/hour value shown to the user must be derived from a chars total
divided by a time total — **never** from the stored `sessions.reading_speed`
column directly, and never from a time-weighted average of that column.

## Why

GSM ingests give us `chars_read` and `reading_speed` from GSM's API, and we
derive `time_seconds = chars_read / reading_speed * 3600` in
[imports.py](imports.py). So on a freshly-ingested row the three fields are
self-consistent: `chars_read / (time_seconds/3600) == reading_speed`.

But the **GSM rollover attribution deduction** in `_compute_title_core`
([db.py](db.py)) subtracts an outgoing attribution's chars and time from a
row by independent amounts (the attribution row stores both). The amounts
are taken from a *different* GSM snapshot than the row itself, so their
chars/time ratio is whatever GSM's speed was *at the moment of that earlier
pull* — not the row's current `reading_speed`. After the deduction:

```
post_chars / (post_secs/3600)  ≠  row.reading_speed
```

The row's stored speed describes the *pre-deduction* blend, not the
remainder. So reading `reading_speed` off the row after attribution applies
gives a number that no longer corresponds to any displayed chars or time.

## How to apply it

Compute speed from the same chars/time you display:

```python
speed = chars / (secs / 3600) if secs > 0 and chars > 0 else 0
```

For a multi-day or multi-session aggregate, sum chars and sum secs first,
then divide. Do **not** time-weight per-session stored speeds.

In JS the canonical pattern is at `ui.js:2860` (milestone chart) and
`ui.js:2013` (title chart, post-fix); in Python it's at the end of
`_compute_title_core` and in `db_get_milestone_detail`. Mirror those.

## The invariant

`sessions.reading_speed` is still written by ingest paths as a diagnostic
audit field (what the source told us), but no read path consults it. If you
add a new chars/hour display and reach for that column because it's
conveniently in the schema, you are reintroducing the bug — the gap only
shows up on titles with GSM rollover attribution active, so it's easy to
miss in spot-checks.
