# GSM rollover attribution

The `gsm_rollover_attributions` table (defined in [db.py](src/db.py)) is a load-bearing
cross-cutting concern. **Any query that surfaces session-level chars/time/cards
must apply it.** Forgetting to do so produces numbers that silently disagree
with the rest of the app.

## Why it exists

Sessions are stored in the `sessions` table at their **real calendar
`session_date`**. But the user can set a `rollover_hour` in settings — when
non-zero, "logical today" is the previous calendar date until that hour passes
(see `get_today()` in [db.py](src/db.py)). GSM is the only source that pulls
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
title. The live pull now keeps one session row **per (real_date, game_id)**
(matching the `sessions(game_id, session_date)` unique index), and every
per-row/per-title consumer keys the deduction and phantom-title lookup on
`(source_date, game_id)`. The pull deletes that row and re-inserts it in one
transaction — in that order, because the unique index is what makes a racing
second pull collide instead of double-counting. The **net-per-day** helpers (`get_gsm_day_adjustment(s)`)
stay game-agnostic — they sum across games per date, so the extra column doesn't
change their math. `init_db` migrates the pre-`game_id` shape by backfilling each
old row's `game_id` from the sole GSM session that lived on its `source_date`.

Attribution rows are written by `upsert_gsm_attribution` and
`refresh_gsm_attribution_tail` in [db.py](src/db.py), called from the GSM import
path in [imports.py](src/imports.py) — and, manually, by `set_rollover_attribution`
(also [db.py](src/db.py)), the **Rollover tab** of the per-row GSM adjust modal
(`openGsmEdit()`/`submitGsmEdit()` in [ui.js](src/ui.js), Api `set_rollover_attribution`
in [tracker.py](src/tracker.py), shown on real GSM rows in the dashboard and History).
That control is the user's escape hatch
for displacements the live pull missed — app closed at the rollover hour, or data
corrected after the fact: it sets how many chars/minutes of a game's `source_date`
reading belong to `source_date - 1`, clamped to the row's own totals (never exceeds
what was read), and `0/0` deletes the row. It writes the *same* `(rollover_date,
source_date, game_id)` shape every read path already understands, so no consumer
needs special-casing. When the history import (`import_gsm_history_apply`)
updates a session row's totals, `_sync_rollover_attribution_to` in
[imports.py](src/imports.py) **clamps** that date's attributions so a displacement
never exceeds the new total (preventing ghost rows in per-title charts). It must
only ever SHRINK a displacement, never grow one — a displacement is a fixed
historical event. The old version overwrote the attribution to the full-day
total, which turned a 0- or partial-displacement row into a full-day displacement
and shoved an entire day's reading onto the prior day.

## How to apply it

There are two canonical patterns. Pick whichever fits the query shape:

**1. Per-row reconciliation (multi-session lists).** Used by `get_today_stats`
in [db.py](src/db.py) and `get_recent_sessions` (History page). The shape is:

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
[db.py](src/db.py). Helper: `get_gsm_day_adjustment(d)` returns
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
the shared `_adjusted_day_totals` helper — reuse it rather than re-deriving, as
`get_hour_blocks` (the Lifetime pace chart) does.

## Misc related notes

- `in_rollover_window()` in [db.py](src/db.py) is the test for "are we currently
  inside the window where attribution writes can happen." Use it before
  capturing snapshots; don't use it to decide whether to APPLY attribution
  (always apply, regardless of current time).
- `window_bounds(n)` clamps date-ranged queries to logical-today as the upper
  bound. GSM imports can write `session_date` values that exceed logical today
  during the rollover window, so any unbounded `WHERE session_date >= ?` query
  will leak future-dated rows. Use `window_bounds` or replicate its clamping.
- The attribution table is GSM-specific. No other source (ttsu, anki, manual,
  ext, youtube, mangawari) needs it because they don't do live incremental pulls
  during the rollover window — the network sources pin their own logical date
  before posting.
- **There is no `sessions/` drop-folder.** Every import path — GSM live pull, GSM
  history, ttsu, manual, CSV, the browser extension — writes to the `sessions`
  table directly. The live pull used to `json.dump` a file and read it straight
  back via `ingest_session_file` one line later; that round trip, the folder
  watcher, the startup scan, the `ingested_files` de-dup table and
  `tools/gsm_export.py` are all gone (`init_db` drops the table on sight). Don't
  reintroduce a file hop for a new source — insert directly. `sessions.raw_file`
  survives for schema compatibility but is written `NULL` and read by nothing,
  same as `cards_mined`.

# `sessions.client_id` — idempotency for network-delivered sessions

`client_id` is an optional key a *network* client stamps on a session so that
re-sending it is a no-op instead of a duplicate. Enforced by a **partial** unique
index (`idx_sessions_client_id ... WHERE client_id IS NOT NULL`, [db.py](src/db.py)).

**Why it exists.** A manual/stopwatch session has no natural key: two separate
30-minute Listening sessions on one day are byte-identical to one logged twice.
So a client that retries — the extension after a failed POST, or the drain loop
replaying an inbox row after a crash landed between the INSERT and its
high-water-mark write — cannot be told apart from a genuine second session. ttsu
needs none of this; `import_ttsu_entries` upserts on `(title, session_date)`,
which *is* a natural key.

**Rules if you touch it:**

- **Locally created rows leave it `NULL`** — in-app logging (`insert_manual_session`),
  CSV import, GSM, ttsu. NULLs are outside the partial index and can never
  collide, so nothing about those paths changes.
- **A partial unique index requires its `WHERE` clause repeated in any
  `ON CONFLICT` target.** A bare `ON CONFLICT(client_id)` raises *"does not match
  any PRIMARY KEY or UNIQUE constraint"*. See `log_manual_session` in
  [imports.py](src/imports.py) for the working form.
- **Clients must mint a fresh id per session and persist it.** Generating one
  per *request* gives every retry a new id and buys nothing; reusing one across
  two genuinely different sessions makes the server silently drop the second —
  the one way this feature can lose data. `popup.js` mints at freeze time and
  stores it in `timerClientId` (part of `TIMER_STATE_KEYS`, so it's cleared with
  the rest of the session).
- `log_manual_session` returns `{"logged": True, "duplicate": True}` when the key
  was already stored. **A duplicate is a success, not an error** — the drain must
  still advance its high-water mark past it or it will replay forever.
- The Pi inbox knows nothing about this. It stores raw JSON, so the key rides
  through untouched — no deploy needed there.

Any future producer (the GSM agent) gets idempotency by including a key.

### Two flavours of key — don't apply the stopwatch's rule to a cumulative source

The stopwatch mints a key **per session** because each session is a distinct
event that must not be stored twice. The YouTube tracker does the opposite: its
key, `youtube:<device>:<date>`, is **stable and deliberately reused** for the
whole day, because every post carries the day's *cumulative* total and is
supposed to rewrite the previous one. Both are idempotent; they differ in what
"the same thing" means.

Which means the "mint a fresh id per session" rule above is specific to
event-shaped sources. For a cumulative source the equivalent rule is: the key
must name the thing being accumulated (here, one device's viewing on one logical
day), and a *second device must not share it* — that's the entire reason the
device name is in there. Two machines on one date without it means the second's
post silently replaces the first's total instead of adding to it.

`import_mangawari_day` ([imports.py](src/imports.py)) is the second cumulative
source, keyed `mangawari:<device>:<title>:<date>` — same contract, one row per
title per logical day. It exists **because** the ttsu shape could not carry it:
`import_ttsu_entries` only updates when the character count grows, and a manga
reader has no characters to count, so posing as ttsu meant every sitting after
the first each day was skipped and its time dropped. If you ever add another
chars-less source, copy that function, not the ttsu one.

`import_youtube_day` ([imports.py](src/imports.py)) also **adopts** a keyless row
for its date on the first keyed post, rather than inserting beside it, so naming
a machine that previously posted keyless doesn't double-count the changeover day.
That replaces the one-shot backfill migration this originally called for — it
needs no guess about which device the old rows belonged to, and is correct
whether or not any exist.

#### Zero is a payload, not an absence

`import_youtube_day` treats `time_seconds == 0` as **delete the row this key
resolves to**. The extension's correction control can empty a day out entirely
(one accidental video, and it was the whole day), and the stored row has to
follow the total down or the extension believes it corrected a day whose figure
never moved.

Two consequences, both load-bearing:

- **A missing value must never be defaulted into a zero.** The `/import`
  dispatch in [ext_server.py](src/ext_server.py) passes `time_seconds` through
  with no `, 0` default precisely so an omitted field arrives as `None` and is
  rejected. Restoring that default turns every malformed body into a deletion.
- **Deleting a row that isn't there is a SUCCESS.** A 200 carrying `error` reads
  as a failure to the extension, which retries forever, and the Pi drain never
  advances its high-water mark past that inbox row. Same reason a replayed post
  must settle.

`import_mangawari_day` shares the cumulative contract but **not** this: zero is
still an error there.

#### The per-video ledger is browser-local and stays that way

`ytLedger` in [background.js](ext/background.js) records which video contributed
what to each day's number, for today and yesterday only. It exists so a video
that shouldn't have counted can be pointed at and taken back out — the popup
lists it, and removing an entry subtracts its seconds and re-posts the corrected
day total.

**It is never posted, and it must not become a second source of session rows.**
Same rule as `gsm_session_evidence` below, for the same reason: the `sessions`
table still gets one pooled `title='YouTube'` row per logical day per device, and
reading per-video data alongside it would double-count. If you want per-video
data on the desktop, that is a schema decision, not a wiring one.

The channel cache (`ytChannelVerdicts`) gained a third value, `"never"`, checked
**above** the ASR rung rather than below it — the one rung that can overrule a
correct `ja` verdict, which is what a translation channel needs. The two original
values are observations the tracker may revise; `"never"` is the user's rule, so
`rememberChannel` (the automatic write-back, which fires on every settled ASR
verdict) **must refuse to overwrite it**. Without that guard the next video from
a blocked channel silently unblocks it.

Songs get the same treatment for the same reason — a Japanese song's ASR verdict
is a correct `ja`, so the rule has to sit above it. `classifyNow` in
[yt-track.js](ext/yt-track.js) now wraps a pure language layer
(`languageVerdict`) with the counts-or-not rules, and music is the second of
those, in two tiers: YouTube's own label (`" - Topic"` auto-channels, or a
`musicVideoType` of album track / official video) turns the video off; the
uploader's "Music" category, or a fan-upload type, only **asks** on the chip.
`MUSIC_VIDEO_TYPE_PODCAST_EPISODE` is deliberately not music. **Nothing a song
teaches reaches the channel cache** — neither the automatic write-back
(`cacheable` is forced false) nor a chip click — because an `other` learned from
one English cover would stop that channel's uncaptioned Japanese talk streams
counting. Whether `musicVideoType` and the microformat category actually arrive
on youtube.com after an in-page navigation is unverified; the `ytDebug` probe
logs both raw, and an absent field just means that tier never fires.

### The inbox distributes settings, it doesn't hold them

The desktop is the sole source of anything a capturing device needs to know, and
the inbox is a dumb relay for it. `/activity-types` and `/config` on
[pi/inbox_server.py](pi/inbox_server.py) are in-memory caches the desktop
overwrites from `_push_settings` in [drain.py](src/drain.py) on every successful
drain — **not** only on one that applied something. That gating was circular
once `rollover_hour` joined the payload: a device needs it *before* its first
post, since the capturer decides the date. Adding a setting a device needs means
adding it to that one dict; the inbox never learns what any of it means.

**The dedup is keyed on `(boot_id, payload)`, not the payload alone.** The inbox
mints `BOOT_ID` per process and returns it on `/inbox` (and `/pending`), so it
rides along on a request the drain already makes. Keying on the payload alone was
wrong in a way that only showed up in deployment: those caches live in the
inbox's memory and reset to defaults when it restarts, while `_pushed` lives in
the desktop's memory and survives that — so a Pi reboot left the inbox serving
`rollover_hour: 0` and the desktop, seeing nothing changed on its side, never
corrected it. Every device that reads its rollover hour from the inbox then filed
late-night viewing under the wrong logical day, silently. An inbox too old to
send a `boot_id` reads as `None`, which pushes every tick rather than guessing.
Push failures — including a non-2xx, which is checked — leave `_pushed` untouched
and retry. If you add another desktop→inbox cache, put it behind this same stamp.

## GSM "reopen catch-up" pull — EXPERIMENTAL

`GsmWalHandler` in [tracker.py](src/tracker.py) has a third pull trigger
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

# `gsm_session_evidence` — per-sitting timestamps, currently INERT

The `gsm_session_evidence` table ([db.py](src/db.py)) records one row per GSM
sitting from `/api/today-stats`: `game_id`, `start_ts`, `end_ts`, `real_date`,
`logical_date`, chars, secs, lines. It is the shadow phase of the per-sitting
timestamp work: recorded and compared, never displayed.

**No display path reads it directly, and it is not a second source of session
rows — do not wire it up as one.** The invariant at the top of this file does
*not* apply to it: reading it alongside the `sessions` rows it describes would
double-count. It has exactly two consumers:

1. `resolve_gsm_time_seconds` ([imports.py](src/imports.py)) — supplies
   **measured** `time_seconds` for the row the live pull is about to write.
2. `get_gsm_evidence_report` ([db.py](src/db.py)) — the read-only Settings →
   Advanced readout.

Written by `collect_today_stats_evidence`, gated on the `gsm_today_stats`
setting (`off` | `shadow` | `live`).

## Measured time replaces the chars ÷ speed derivation — but only when proven

The live pull has never measured time; it divides the day's characters by GSM's
reported speed ([imports.py](src/imports.py)). When that speed figure runs
slightly high the row silently loses real minutes — 309s vanished from a single
observed day, matching the measured-vs-derived gap exactly.

In `live` mode `resolve_gsm_time_seconds` stores GSM's measured seconds instead,
**gated on an exact character match** between the evidence and the day's
authoritative character count. Both sources report characters unambiguously, so
equality means every sitting is accounted for. Partial evidence, no evidence, an
unreachable endpoint, or any other mode falls through to the derivation
unchanged. **The failure mode is "no improvement", never "under-reported time"** —
keep it that way if you touch it.

Two consequences worth knowing:

- **Ordering is load-bearing.** Evidence must be captured *before* the session
  row is written, or the row can only ever see the previous pull's evidence.
  `TestPullIntegration` pins this.
- **The gate is only as good as the character count it compares against.** If
  `characterActivityData` is an all-games total (see the multi-game note at that
  lookup), a multi-game day can never match and the pull quietly stays on the
  derivation. The readout's `time_source` column is what makes that visible —
  a day stuck on "calculated" with complete-looking evidence is the symptom.

Three things worth knowing if you touch it:

- **`logical_date` is computed once at ingest and stored, never re-derived on
  read.** A DST shift would otherwise silently re-bucket a stored sitting, and
  changing `rollover_hour` would rewrite history as a side effect of a read.
- **The replacement floor is `min(start_ts)` of the incoming payload**, not "all
  of today". Evidence older than the window GSM is currently reporting on must
  survive. This is what lets us ignore GSM's own rollover-hour setting: GSM's
  setting decides which sittings appear, the tracker's decides which logical day
  each belongs to. The two drifting apart costs coverage, never correctness.
- **A sitting straddling the rollover hour is assigned wholly by `start_ts`.**
  Splitting it would need the per-line timestamps this design deliberately
  doesn't read.

The eventual plan is to repoint `gsm_rollover_attributions`' *writer* at this
table — the schema of `get_gsm_evidence_attributions()` output is already
`(rollover_date, source_date, game_id) → (chars, secs)` for exactly that reason.
The table itself and every read path stay. A full sunset was considered and
rejected: `sessions.session_date` must stay real-calendar to join against
`gsm.db`'s `game_daily_rollup`, which has no rollover concept.

# Manual per-game time overlay (`manual_time_adjust`)

The `manual_time_adjust` table (defined in [db.py](src/db.py)) is the user's escape
hatch for the rollover-tail desync above: when GSM strands dead/AFK time on a day
(the documented limitation of the reopen catch-up), the user shaves it off by
hand — **per game**, picking which game on the dashboard absorbs the shave. It's a
second display-time overlay that lives **alongside** GSM rollover attribution, for
the same reason the attribution table exists — it must survive GSM re-ingests,
which `DELETE`+re-insert or `UPDATE` the underlying `sessions` rows
([imports.py](src/imports.py)) and would wipe any edit made to the row itself.

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

`secs_delta` is signed and the UI writes **both signs**. Negative shaves dead/AFK
time GSM over-counted. Positive credits time it *under*-counted — the live pull
derives time as `chars ÷ speed` rather than measuring it, so a slightly high
speed figure silently loses real minutes (observed: 309s missing from a single
day, exactly matching the measured-vs-derived gap the today-stats readout
reports). The two signs apply differently in the per-row paths: a shave carries a
**budget spread across the game's rows and floored at zero**, while a credit needs
neither, so it lands **whole on the highest-priority row**. Keep `get_today_stats`
and `get_recent_sessions` in step here or the dashboard and History will disagree
about which row carries the edit. The
key is `(display date, game_id)`: the date is the logical/display date
(`get_today()` for "today"), the same date a `rollover_date` uses — never a raw
`session_date`; `game_id` is the GSM game's stable id (survives the re-ingest that
churns rowids). Only GSM rows carry a `game_id`, so only GSM sessions can be
adjusted. Helpers in [db.py](src/db.py): `set_manual_time_adjust(date, game_id, …)`,
`get_manual_time_adjust(date, game_id)`, plus three read shapes —
`get_manual_time_adjusts_by_day` (date→summed secs, for net-per-day),
`get_manual_time_adjusts_all` ((date,game_id)→secs, for per-row), and
`get_manual_time_adjusts_for_date` (game_id→secs, for the dashboard indicator). A
zero delta deletes the row. Written from `set_game_time_adjust` in
[tracker.py](src/tracker.py); the per-row control is the **Subtract minutes tab** of the
GSM adjust modal (`openGsmEdit()`/`submitGsmEdit()` in [ui.js](src/ui.js), the ✎ chip
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
  [db.py](src/db.py)) and `Api.get_heatmap` year-mode ([tracker.py](src/tracker.py)) build
  `{session_date: raw_secs}` then apply `get_gsm_day_adjustments()` per date,
  clamped to their window. They used to re-derive attribution+manual inline; that
  was consolidated so they can't drift.
- **Reading speed goes through the chokepoint too.**
  `get_daily_reading_speed_basis` ([db.py](src/db.py)) applies
  `get_gsm_day_adjustments()` per date, and `get_extra_stats` /
  `get_range_extra_stats` / the Stats brush / `get_prev_range_speed_basis` all
  sum *that map* rather than running their own SQL. It used to add
  `_manual_secs_sum(since)` to a raw denominator, which left the numerator on the
  real calendar and the overlay on the display one. See the reading-speed
  invariant below for the full basis.
- **Paths that legitimately need a different aggregation** than per-day — leave
  these as-is, they're not whack-a-mole, they just can't use the per-day dict:
  - `get_activity_breakdown` ([db.py](src/db.py)) unions manual-overlay dates into its
    candidate-date set so a shave folds into the Reading slice (the per-day
    `adj.get(d)[1]` it sums already bundles the manual delta — the union just makes
    sure manual-only dates are visited; dedupe prevents double-count).
  - `get_all_time_totals` ([db.py](src/db.py)) adds `_manual_secs_sum()`. GSM rollover
    attribution nets to zero over all-time (both endpoints in range) so it's
    ignored there, but the manual overlay is a **true reduction** and must be
    subtracted or the dashboard all-time total drifts from the daily views.

## Per-title applies it too (via game_id)

Because the overlay is keyed **per game**, a shave maps cleanly to a title, so the
media views honor it. Two rails:

- **Per-day per-title** (detail panel + milestone chart): `_compute_title_core`
  ([db.py](src/db.py)) deducts the `(date, game_id)` shave from its `daily_map` secs
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
[imports.py](src/imports.py). So on a freshly-ingested row the three fields are
self-consistent: `chars_read / (time_seconds/3600) == reading_speed`.

But the **GSM rollover attribution deduction** in `_compute_title_core`
([db.py](src/db.py)) subtracts an outgoing attribution's chars and time from a
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

## Which sessions the speed basis counts — one map, four consumers

Dividing the right way is only half of it; the surfaces also have to agree on
*which rows* go into the ratio. There is now exactly one definition, in
`get_daily_reading_speed_basis` ([db.py](src/db.py)): Reading rows with a tracked
char count (`chars_read>0 AND time_seconds>0`) that are **not** `time_excluded`,
bounded by `window_bounds`, with `get_gsm_day_adjustments()` applied per date so
chars, time and both overlays sit on the display calendar. `get_extra_stats`,
`get_range_extra_stats`, `get_prev_range_speed_basis` and the Stats brush
(`computeBrushView` in [ui.js](src/ui.js), via `spd_chars`/`spd_secs`) all sum
that one map. `_basis_cph` is the shared reducer; its `int()` truncation is what
makes a full-span brush print the same digits as the 'All' preset.

Three things that map got wrong when the Stats page ran its own SQL, all of which
made the Chars/hour card disagree with the Total time card directly above it:

- **`time_excluded` rows belong in neither side.** They are the default shape for
  GSM-history and ttsu-history backfill ("chars-only"), and their time is
  suppressed in every other figure — Total time, daily series, heatmap, donut,
  streaks, `get_today_stats`. Leaving that time in the denominator alone made the
  card read low; keeping their chars with no time would swing it high. Drop the
  row. That's also what makes the dashboard's cph agree, since
  `get_today_stats` filters them upstream.
- **Chars-less reading belongs in neither side** — time in the denominator with
  nothing in the numerator. (The media panes still count it; `_compute_title_core`
  sums every session on a title regardless. Known, deliberately deferred.)
- **An unbounded `session_date >= ?` leaks rollover-window future-dated rows**
  into the speed while every other card on the page holds them back. See the
  `window_bounds` note at the top of this file.

## The invariant

`sessions.reading_speed` is still written by ingest paths as a diagnostic
audit field (what the source told us), but no read path consults it. If you
add a new chars/hour display and reach for that column because it's
conveniently in the schema, you are reintroducing the bug — the gap only
shows up on titles with GSM rollover attribution active, so it's easy to
miss in spot-checks.

# Per-title chars exclusion (`media_chars_excluded`)

The user's escape hatch for media whose character counts are unrepresentative —
a game whose text hooks catch a fraction of what's actually read. Presence of a
row means **this title's characters are withheld from every global figure**.

```
media_chars_excluded (
    title       TEXT PRIMARY KEY,
    excluded_at TEXT NOT NULL
)
```

Title-keyed and display-only, exactly like `media_completions` /
`media_char_counts` above it: it never touches `sessions`, so it survives the GSM
re-ingests that `DELETE`+re-insert those rows, and toggling it is instant and
retroactive. A `sessions` column would have to be written at insert time and
rewritten on every flip; that was considered and rejected for the same reason
`manual_time_adjust` isn't one. Written by `db_set_media_chars_excluded`
([db.py](src/db.py)), toggled from the **detail pane's "Don't count characters"
button** next to "Complete game" (`renderMediaDetail`/`onCharsExcludedToggle` in
[ui.js](src/ui.js), Api `set_media_chars_excluded` in [tracker.py](src/tracker.py)).

**Two rules define the whole feature:**

1. **Chars only. Time is never affected.** Every second an excluded title logged
   still counts in Total time, the daily/weekly series, the heatmap, streaks,
   consistency, the Lifetime pace chart and the activity donut. This is what
   separates it from `time_excluded`, which is the mirror concept for time.
2. **Global figures only. Per-title surfaces keep the full count.** The detail
   pane, its per-day chars/speed line, the progress bar and its completion mark,
   the milestone splits, the media grid card, series totals, the title-streams
   chart and the speed box plots all show the title's real characters. That is
   the point of the feature — the count is still worth having, just not worth
   pooling. (Consequence worth knowing: the stacked title-streams chart can sum
   higher than the Stats chars card. Deliberate.)

## How to apply it

**Global chars sums** use the `_counted_chars()` SQL expression
([db.py](src/db.py)) in place of a bare `chars_read`, mirroring the
`CASE WHEN time_excluded ... THEN time_seconds ELSE 0 END` idiom already used for
time. Keeping it as one expression is the point: this is a cross-cutting concern
like GSM rollover attribution, and what keeps it consistent is that every global
chars sum spells it the same way. Applied in `get_weekly_summary`,
`get_all_time_totals`, `get_daily_time_series`, `_adjusted_day_totals` (and so
range totals, prev-range deltas, best day/week, streak and consistency),
`get_extra_stats`, `db_get_goal_progress` and `db_get_goal_burnup`.

**Reading speed drops the title from BOTH sides**, and this is the trap.
Zeroing an excluded title's chars while leaving its time would put its hours in
the cph denominator with nothing above them and collapse the figure — the exact
failure a chars-less Reading session causes, and the rule already documented
under the speed basis below. So `get_daily_reading_speed_basis` filters the rows
out with `title NOT IN (SELECT title FROM media_chars_excluded)` rather than
zeroing them. The filter is per row, so the rest of a mixed day survives.

**The per-day adjustment chokepoint has to know too.**
`get_gsm_day_adjustment(s)` is game-agnostic by design, so an excluded game's
rollover displacement would hand its chars straight back to the figures the raw
sum had just zeroed. Both helpers now resolve the exclusion to game ids
(`_chars_excluded_game_ids`) and drop those games' **chars**, keeping their
**seconds** — except under `drop_excluded_secs=True`, which the reading-speed
basis passes to get the both-sides treatment there too. The manual overlay rides
the same switch (`get_manual_time_adjusts_by_day(skip_games=…)`): for the speed
basis, a shave on an excluded game must not come off a denominator its time never
entered.

**Per-row lists show the chars and withhold them from the total.**
`get_dashboard` and `get_history` ([tracker.py](src/tracker.py)) stamp each row
with `chars_counted`, from `get_chars_excluded_titles()`. The row still renders
its characters with a muted "not counted" badge — they really were read, and
hiding them would make the row disagree with the media pane — while the
dashboard's client-side day total and cph skip it (`refreshDashboard` in
[ui.js](src/ui.js)). An absent flag reads as counted, so other payloads are
unaffected.

## The invariant

Same shape as the attribution rule at the top of this file: **if you add a query
that surfaces a chars total pooled across titles, it must apply this.** Ask which
rail it's on — a figure that aggregates ACROSS titles applies the exclusion; a
figure that is per-title does not. Getting it wrong is quiet: it only shows up
once a title is actually excluded, so it survives spot-checks. `time_excluded` is
not a substitute — that suppresses time and leaves chars, this does the reverse.

# Media status — In progress / On hold / Completed / Dropped

Display-only, title-keyed, never touches `sessions` — same family as
`media_completions` and `media_chars_excluded`. No stat figure reads it; the
only consumers are the media grid (filter chips, card edge line), the detail
pane's status pill, and the Shelf (In progress only).

**Three storages, one status at a time:**

- **In progress is the absence of any row.** That is what makes every title
  from every import path start In progress with nothing written — don't add a
  write to an importer to "set" it.
- **Completed IS `media_completions`.** Not a copy: the completion bar's 100%
  pin and the catalog's manga volume count (`_completed_titles` in
  [catalog.py](src/catalog.py)) both read that table, so Completed must keep
  living there.
- **On hold / Dropped live in `media_status`.** `db_set_media_status`
  ([db.py](src/db.py)) clears the other table on every write; leaving Completed
  un-pins the bar exactly as the old "Mark incomplete" did.

**On hold resumes on read, Dropped never does.** Setting either snapshots the
title's raw `SUM(chars_read)` / `SUM(time_seconds)`; `_derive_media_status`
reports In progress once the title has grown past it. Chars are the signal when
the title tracks any — a GSM row's time can creep up from a tail/AFK flush after
you stop, chars only grow with real lines. Chars-less media (manga, paper books)
falls back to time. Compare against **raw** sums, never the overlaid
`get_media_stats` time, or a manual shave reads as (un)resumed reading. Resuming
is derived, not written, so no import path needs to know statuses exist.

**Statuses are for reading media only.** `hasMediaStatus` in [ui.js](src/ui.js):
Reading activity, mangawari, or any chars. Anime/listening show under All and
never get a pill — the user's call, not an oversight.

**The card's edge line is its only status marker: colour is status, length is
progress.** No badges, glyphs or cover filters — those were tried and dropped.
Completed is always full; without a known length (manga, books with no total
entered) In progress draws no line at all and On hold / Dropped draw full-width
so their colour still shows. `get_media_stats` carries `length` (user total wins
over GSM's, same precedence as the detail bar and the Shelf) for this.

**A series has no status of its own.** `seriesStatusOf` ([ui.js](src/ui.js))
reads it off the volumes, most active first: any In progress → In progress,
else any On hold → On hold, else all Completed → Completed, else Dropped.
Volumes without a status don't vote. Don't add a series status column — it
would drift from the per-volume completion the catalog counts. Consequences:

- The series pill writes the **volumes**, via `db_set_series_status`
  ([db.py](src/db.py)), in one transaction. Completed marks them all; any other
  pick spares volumes already Completed, so dropping a series never erases what
  was finished.
- Under a status filter the grid **unpacks** series into their matching volumes.
  The chip counts are per volume, and this is what keeps cards and counts in
  agreement. Under All they stay stacked, with the edge line drawn from the
  derived status and the same progress basis as the series page's bar.
- Accepted gap: between volumes, a series whose known volumes are all done reads
  Completed until the next volume is dragged in.

# Anki review time — `source='anki'`, and the two rules it adds

The Anki addon (`anki/konseki_anki/`) reads Anki's `revlog` — a complete
per-answer ledger with millisecond timestamps — buckets it into Konseki's
logical days, and posts each day's cumulative total to `/import`. Rows land as
`source='anki'`, `title='Anki'`, `activity_type='Vocabulary'`, `chars_read=0`,
**`game_id` NULL** (which is what keeps this source outside the GSM rollover
attribution and `manual_time_adjust` rails entirely). Written by
`import_anki_days` in [imports.py](src/imports.py); dispatched in
`apply_payload` ([ext_server.py](src/ext_server.py)).

`revlog.time` is already capped by the deck preset's "maximum answer seconds",
so AFK time is bounded at the source — Anki needs no equivalent of the manual
time overlay GSM has.

## The `client_id` is collection-scoped, NOT device-scoped

This **inverts** the YouTube rule documented above, and getting it backwards
double-counts silently. YouTube keys per device because a browser only knows its
own viewing and two machines must *sum*. An Anki collection is **synced**: every
device that opens it computes the same day totals from the same `revlog`. A
per-device key would make a second desktop insert a second row and double the
day; the collection-scoped `anki:<date>` makes it rewrite the first instead.

The generalisation, which the YouTube note above states and this is the second
instance of: **the key names the thing being accumulated.** There, one device's
viewing on one day. Here, one collection's studying on one day. `collection_tag`
(default empty) adds a segment only for the two-collections case.

Both counters zero **deletes** the row, same as `import_youtube_day` and for the
same reason — so neither `days` nor the per-entry counters get a `, 0` default
anywhere in the chain. A day with no reviews is still *sent* as `0/0`, which is
what deletes the row of a day the user emptied out.

## `skip_days_with_vocabulary_time` — the backfill's don't-double-count rule

Some of the user's Anki history is already in Konseki, hand-logged or
CSV-imported as Vocabulary sessions. Importing on top of it would double-count.
Rather than a date cutoff (considered and rejected — it needs a date chosen, and
goes stale where the hand-logging was patchy rather than continuous), the rule is
per day: **a day that already has counted Vocabulary time keeps it, and that
day's Anki row imports with `time_excluded=1`.**

`_days_with_vocabulary_time` in [imports.py](src/imports.py) answers it. Every
clause is load-bearing:

- **`source <> 'anki'`** is what makes the rule idempotent. Without it the second
  backfill run sees the row the first run wrote and flips every day to excluded,
  one run at a time.
- **`time_excluded = 0`** reads "already tracked" as *already counting*. A day
  whose only Vocabulary row is itself excluded contributes nothing to any total,
  so Anki should fill it.
- **`activity_type = 'Vocabulary'`** and not "any activity" — a day of reading
  must not suppress genuine Anki time logged nowhere else.
- **No source allowlist**: hand-logged, stopwatch and CSV-imported Vocabulary all
  block equally.

The flag is **tri-state, and the absent state is the point**: `None` (the
periodic push) leaves an existing row's `time_excluded` alone, so a nightly push
can never un-suppress what the backfill decided; `True`/`False` write it on
INSERT *and* UPDATE, so re-running the backfill re-decides. The `/import`
dispatch passes `body.get(...)` straight through for exactly this reason —
coercing it to a bool there would break the first case.

The decision is **server-side only**. The addon has no view of Konseki's
sessions and cannot make it.

## `cards_done` — and why it is not `cards_mined`

`sessions.cards_done` holds reviews answered. It is a **separate column from
`cards_mined`**, which means GSM's "cards mined from this game", is inert, and is
still summed into media-detail payloads by `_compute_title_core` — reusing it
would make Anki reviews surface there as mined cards.

Cards use **two different bases on purpose**, and the split mirrors how chars are
already treated:

- **Totals count every row**, `time_excluded` included — `get_daily_cards` in
  [db.py](src/db.py), same as `total_chars`. This is what makes the backfill rule
  work: a suppressed day still did those cards, and they were never logged
  anywhere else.
- **Rates drop excluded rows from both sides** — `get_card_speed_basis` +
  `_basis_cardsph`, the exact mirror of `get_daily_reading_speed_basis` +
  `_basis_cph`. A suppressed row has no usable time to divide by.

Cards/hour is **always derived** from a cards total over a time total, never
stored — the same invariant as chars/hour, for the same reason.

`get_today_stats` and `get_recent_sessions` carry `cards_done` as the **last**
tuple element (phantom rollover rows carry 0), and it joins their
drop-if-all-zero liveness test so an all-cards row survives. GSM rows carry
`cards_done=0`, so none of their behaviour changes.

## The add-on pushes on events, never on a clock

There is deliberately no repeating timer. Pushes are triggered by: a debounce
after the last answered card (`idle_push_mins`), a finished sync, and profile
open/close. Each one re-states a **seven-day** window; the confirmed-days map
filters out anything that hasn't moved, so the width is free.

**If you touch the failure path, restore the dirty flag.** `push_now` clears it
before handing the request to `taskman`, so a failure that returns without
setting it back means every later trigger short-circuits on `not _dirty` and
that day is never sent again. That was a real bug — the polling timer's comment
claimed "the next tick retries" while the code guaranteed it could not.
`tests/test_anki_addon_glue.py` pins this by stubbing `aqt`, and a mutation back
to the old shape fails three of its tests.

## Accepted limits

- A **suppressed Anki day is invisible in History and on the dashboard** — those
  two paths drop `time_excluded` rows outright and an Anki row has no chars to
  carry it. Benign under this rule rather than surprising: a day is only ever
  suppressed *because* it already has a counted Vocabulary row, so the day still
  shows Vocabulary time — just the hand-logged row. Its cards still reach the
  totals via `get_daily_cards`.
- **A day's hand-logged figure wins even when it is wrong.** 5 minutes logged by
  hand against 60 really done keeps the 5; the rule is all-or-nothing per day
  (topping up the difference was rejected — it blends an estimate with a
  measurement inside one figure). Delete the hand-logged row and re-run.
- **Anki's own "cards studied today" can disagree** with Konseki's Anki row when
  Anki's rollover hour differs from Konseki's. Deliberate: every source in
  Konseki sits on Konseki's calendar.
- `db_get_goal_progress` applies no `time_excluded` filter at all — a
  pre-existing quirk, now reachable by Anki rows too.
