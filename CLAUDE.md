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
    game_id       TEXT,   -- which GSM game this displacement belongs to
    chars         INTEGER,
    time_seconds  REAL,
    cards         INTEGER,
    updated_at    TEXT,
    PRIMARY KEY (rollover_date, source_date, game_id)
)
```

Only rows with `rollover_date <> source_date` represent an actual displacement.
Rows where they match are no-ops (they exist as snapshots for tail-settle).

**`game_id` is in the PK** because two *different* games can be read on the same
real `source_date` — one pre-rollover (displaced to the prior logical day) and one
after. Without per-game keying, the second game's row inherited the first's
displacement: the deduction zeroed the post-rollover game and the pre-rollover
game's row (deleted by the old date-only live pull) was stranded on the wrong
title. The live pull now keeps one file + one session row **per (real_date,
game_id)** (matching the `sessions(game_id, session_date)` unique index), and every
per-row/per-title consumer keys the deduction and phantom-title lookup on
`(source_date, game_id)`. The **net-per-day** helpers (`get_gsm_day_adjustment(s)`)
stay game-agnostic — they sum across games per date, so the extra column doesn't
change their math. `init_db` migrates the pre-`game_id` shape by backfilling each
old row's `game_id` from the sole GSM session that lived on its `source_date`.

Attribution rows are written by `upsert_gsm_attribution` and
`refresh_gsm_attribution_tail` in [db.py](db.py), called from the GSM import
path in [imports.py](imports.py) — and, manually, by `set_rollover_attribution`
(also [db.py](db.py)), the **Rollover tab** of the per-row GSM adjust modal
(`openGsmEdit()`/`submitGsmEdit()` in [ui.js](ui.js), Api `set_rollover_attribution`
in [tracker.py](tracker.py), shown on real GSM rows in the dashboard and History).
That control is the user's escape hatch
for displacements the live pull missed — app closed at the rollover hour, or data
corrected after the fact: it sets how many chars/minutes of a game's `source_date`
reading belong to `source_date - 1`, clamped to the row's own totals (never exceeds
what was read), and `0/0` deletes the row. It writes the *same* `(rollover_date,
source_date, game_id)` shape every read path already understands, so no consumer
needs special-casing. When the history import (`import_gsm_history_apply`)
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
- For each `(date, game_id)`, **deduct** the sum of outgoing attributions
  (`source_date=d AND game_id=g AND rollover_date<>d`) from *that game's* GSM row
  on that date — not "the first GSM row on the date", or a second game read that
  day eats the shave.
- **Drop** any row whose chars/secs/lines are all zero after the deduction.
- For each date, **synthesize phantom rows** for incoming attributions
  (`rollover_date=d AND source_date<>d`), grouped by `(source_date, game_id)` so
  each phantom row borrows its title from that game's real session on the source
  date. Phantom rows have `id=None`; the UI's `makeSessionRow` already handles this.

**2. Net adjustment per day (single-number-per-day queries).** Used by
`get_daily_time_series`, `get_weekly_summary`, and `get_heatmap` in
[db.py](db.py). Helper: `get_gsm_day_adjustment(d)` returns
`(chars_delta, secs_delta, cards_delta)` to add to date `d`'s raw GSM totals.
Always `max(0, raw + delta)` — net can go negative if all chars rolled out.
Note this helper's `secs_delta` **also folds in the manual time overlay**
(`manual_time_adjust`, documented below — keyed per game but summed per day here),
so consumers get both overlays from one call — don't re-apply the manual overlay
on top.

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

# Manual per-game time overlay (`manual_time_adjust`)

The `manual_time_adjust` table (defined in [db.py](db.py)) is the user's escape
hatch for the rollover-tail desync above: when GSM strands dead/AFK time on a day
(the documented limitation of the reopen catch-up), the user shaves it off by
hand — **per game**, picking which game on the dashboard absorbs the shave. It's a
second display-time overlay that lives **alongside** GSM rollover attribution, for
the same reason the attribution table exists — it must survive GSM re-ingests,
which `DELETE`+re-insert or `UPDATE` the underlying `sessions` rows
([imports.py](imports.py)) and would wipe any edit made to the row itself.

```
manual_time_adjust (
    date        TEXT,   -- the DISPLAY (logical) date, like rollover_date
    game_id     TEXT,   -- which GSM game absorbs the shave (stable across re-ingest)
    secs_delta  REAL,   -- signed; negative shaves dead time off that game that day
    note        TEXT,
    updated_at  TEXT,
    PRIMARY KEY (date, game_id)
)
```

`secs_delta` is signed but the UI only ever writes **negative** (subtract). The
key is `(display date, game_id)`: the date is the logical/display date
(`get_today()` for "today"), the same date a `rollover_date` uses — never a raw
`session_date`; `game_id` is the GSM game's stable id (survives the re-ingest that
churns rowids). Only GSM rows carry a `game_id`, so only GSM sessions can be
adjusted. Helpers in [db.py](db.py): `set_manual_time_adjust(date, game_id, …)`,
`get_manual_time_adjust(date, game_id)`, plus three read shapes —
`get_manual_time_adjusts_by_day` (date→summed secs, for net-per-day),
`get_manual_time_adjusts_all` ((date,game_id)→secs, for per-row), and
`get_manual_time_adjusts_for_date` (game_id→secs, for the dashboard indicator). A
zero delta deletes the row. Written from `set_game_time_adjust` in
[tracker.py](tracker.py); the per-row control is the **Subtract minutes tab** of the
GSM adjust modal (`openGsmEdit()`/`submitGsmEdit()` in [ui.js](ui.js), the ✎ chip
shown on GSM rows in both the dashboard and History — the same modal also hosts the
Rollover tab above).

**An earlier cut was day-level** (PRIMARY KEY `(date)`, no `game_id`, drained the
day's GSM rows in `ingested_at` order). `init_db` drops that obsolete shape on
sight — the per-game key is the current model.

## How it's applied — same cross-cutting rule as attribution

This is a **second instance of the load-bearing concern** at the top of this
file: any query that surfaces session-level time must apply it. It is folded into
the **same chokepoints** so the surface stays minimal:

- **Net-per-day pattern:** folded directly into `get_gsm_day_adjustment` and
  `get_gsm_day_adjustments` via `get_manual_time_adjusts_by_day` (sum across games
  per date — aggregates don't care which game; the `secs` component only, never
  chars/cards). Every consumer of those helpers — daily series, weekly summary,
  heatmap data, `_adjusted_day_totals` (best-day/week/streak/consistency + range
  totals), and goal progress — picks it up for free. **Do not re-apply it in those
  callers.** The dict now also contains entries for manual-only dates (no
  displacement), since callers default with `adj.get(d, (0,0,0))`.
- **Per-row pattern:** `get_today_stats` and `get_recent_sessions` apply it
  **per game**, shaving `secs` off the rows matching each adjusted `game_id` on the
  display date (so the game the user picked absorbs it, not whichever row sorts
  first). A game's shave budget is tracked across its rows in case the rollover
  bucket holds more than one. Both functions now carry `game_id` as the last tuple
  element (mapped into the dashboard/History payloads). `max(0, …)` floors
  over-subtraction; chars are left intact (only time is dead time).
  - **Rollover-bucket targeting:** `get_today_stats` merges logical-today with the
    real calendar date during the rollover window, so a game can have two rows in
    one bucket (its own day + a post-midnight session). The shave is applied to the
    row whose `session_date` equals the logical day **first** (then spills to
    others), so a shave set on day D lands on D's own row — not on the live
    post-midnight session that merged in. This matches `get_recent_sessions`, where
    each date is processed separately and the real row precedes the phantom — keep
    the two consistent or the dashboard and History will disagree on which row
    shows the shave.
- **Heatmaps go through the chokepoint too.** `get_heatmap_data` (rolling-window,
  [db.py](db.py)) and `Api.get_heatmap` year-mode ([tracker.py](tracker.py)) build
  `{session_date: raw_secs}` then apply `get_gsm_day_adjustments()` per date,
  clamped to their window. They used to re-derive attribution+manual inline; that
  was consolidated so they can't drift.
- **Paths that legitimately need a different aggregation** than per-day — leave
  these as-is, they're not whack-a-mole, they just can't use the per-day dict:
  - `get_activity_breakdown` ([db.py](db.py)) unions manual-overlay dates into its
    candidate-date set so a shave folds into the Reading slice (the per-day
    `adj.get(d)[1]` it sums already bundles the manual delta — the union just makes
    sure manual-only dates are visited; dedupe prevents double-count).
  - `get_all_time_totals` ([db.py](db.py)) adds `_manual_secs_sum()`. GSM rollover
    attribution nets to zero over all-time (both endpoints in range) so it's
    ignored there, but the manual overlay is a **true reduction** and must be
    subtracted or the dashboard all-time total drifts from the daily views.
  - The chars/hour denominators in `get_extra_stats` / `get_range_extra_stats`
    ([db.py](db.py)) use `_manual_secs_sum(since)` so reading speed is computed
    against the same adjusted time the page shows as "Total time" (reading-speed
    invariant below). The dashboard's cph falls out of the already-shaved
    `get_today_stats` rows, so it's consistent for free.

## Per-title applies it too (via game_id)

Because the overlay is keyed **per game**, a shave maps cleanly to a title, so the
media views honor it. Two rails:

- **Per-day per-title** (detail panel + milestone chart): `_compute_title_core`
  ([db.py](db.py)) deducts the `(date, game_id)` shave from its `daily_map` secs
  right after the attribution deduction (secs only — chars stay, so reading speed
  *rises*). The per-day speed line, the title average, and `db_get_milestone_detail`
  (which slices `_compute_title_core`'s `daily`) all recompute from that adjusted
  chars/time — the same Method-A chars÷time rule as everywhere else.
- **Per-title totals** (media grid `get_media_stats`, Stats `get_top_titles`):
  subtract `get_manual_secs_by_title()`. For an all-time title *total*, GSM rollover
  attribution nets to zero (a displacement just relabels which of the title's own
  days the time shows on), so only the manual shave — a true reduction — matters.
  That helper maps each shave's `game_id` to its title via the game's sessions.

There is **no per-title carve-out** anymore. (An earlier day-level cut skipped
per-title, on the theory that day-level dead time wasn't any one title's; per-game
keying removed that ambiguity.)

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
