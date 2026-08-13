# Posting sessions to Konseki

Hand this to any project you want to feed Konseki — a manga reader, a forked epub
reader, a script. It describes the wire contract and the four rules that make a
client correct rather than merely working.

---

## The shape in one paragraph

You POST JSON to one HTTP endpoint with a shared token. You can point at
Konseki's desktop app **or** at the always-on inbox — same paths, same token,
same body, and you should make the host configurable so it doesn't matter which.
The inbox stores your payload as opaque bytes and the desktop collects it
whenever it's next awake. **Your payload may therefore be applied hours after you
sent it**, which is the single fact that drives every rule below.

## Connection

| | |
|---|---|
| Base URL | `http://<host>:18463` — a bare host or IP, no scheme baked in, user-configurable |
| Auth | header `X-Tracker-Token: <token>` on every request |
| Body | `Content-Type: application/json` — anything else gets `415` |
| Bad token | `403` |

The token comes from Konseki → Settings → Browser extension. The same token works
against the desktop and the inbox; that is deliberate, so one config serves both.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/import` | A source-tagged content session (has a title) — `ttsureader`, `mangawari`, `youtube` |
| POST | `/log-manual` | A time-only session (no title) |
| POST | `/cover` | A cover image for a title — metadata, sent once |
| GET | `/activity-types` | String list for a category picker |
| GET | `/config` | `{"rollover_hour": N}` — see rule 1 |

---

## The four rules

### 1. You decide the date. Never let the server do it.

Fetch `rollover_hour` from `GET /config`, compute the logical date **locally**,
and send it explicitly in every payload.

```
logical_date(now, rollover_hour):
    if rollover_hour > 0 and now.hour < rollover_hour:
        return (now - 1 day).date()
    return now.date()
```

The user can set a rollover hour so that "today" doesn't end at midnight — with
`rollover_hour = 4`, reading at 01:00 still belongs to the previous day. If you
omit the date and let the applier fill it in, a session captured at 01:00 and
drained at 09:00 lands on the wrong day. The bug is invisible: nothing errors, a
day is just quietly short and the next quietly long.

Re-fetch the config periodically. Cache the last value and keep using it when the
fetch fails — never reset to a default on a failed request.

### 2. Pick the right flavour of `client_id`

`client_id` is an optional string that makes re-sending a payload a no-op instead
of a duplicate. There are two kinds, and using the wrong one is the one way this
can silently lose data.

**Event-shaped** — a discrete session that happened once (a reading sitting, a
stopwatch run). Mint a fresh UUID **when the session ends**, persist it, and
re-send that same id on every retry of that session.

```
client_id = "manga:9d3f0c72-..."     # minted once, stored, reused on retry
```

Minting one per *request* gives every retry a new id and buys nothing. Reusing one
across two genuinely different sessions makes the server drop the second.

**Cumulative** — a running total for a day that you re-post as it grows (the
YouTube tracker works this way). Use a **stable, deliberately reused** key naming
what's being accumulated, plus the device:

```
client_id = f"manga:{device}:{date}"   # same key all day; each post rewrites
```

Include the device name if more than one machine might post the same kind of
thing on the same day. Without it, the second machine's post *replaces* the
first's total instead of adding to it.

**If your payload already has a natural key** — the ttsu shape below upserts on
`(title, session_date)` — you need no `client_id` at all. A replay rewrites the
same row by construction. The `mangawari` shape has one too, so its key is
optional and buys you only the second-device case.

### 3. A `200` carrying `{"error": "..."}` is a failure

The status code alone is not proof the row was stored. Check the body:

```
if not response.ok:            -> retry later (403 = token, 415 = content-type, 400 = unknown source)
if body.get("error"):          -> do NOT mark as sent; retrying won't help, surface it
if body.get("duplicate"):      -> SUCCESS. Already stored. Mark as sent.
```

A `duplicate` is the idempotency key doing its job, not an error.

How rejection is reported differs by endpoint, so read the one you're using:

- **`/log-manual`** answers `200` with `{"error": "..."}` for a payload it
  understood but refused (missing `activity_type`, non-positive time). This is
  the case that bites — it looks like success at the status line.
- **`/import` with the ttsu shape** answers `200` with `{"imported": N,
  "skipped": M, "titles": [...]}`. There's no `error` key; a **non-zero
  `skipped`** is how it tells you entries were dropped. Treat `imported == 0`
  with entries sent as a failure to investigate, not a success.
- **`/import` with the `mangawari` or `youtube` shape** answers `200` with
  `{"logged": true, ...}`, or `{"error": "..."}` for a bad date or non-positive
  time. Absence of `logged` is a failure — do not read a bare `200` as stored.
- **`/import` with an unrecognised `source`** is a real `400`.

### 4. Freeze before you post, delete only on confirmation

Order matters and this is worth getting right the first time:

1. Capture ends → **write the session to local storage**
2. POST it
3. **Only on confirmed success**, drop the local copy

Any other order loses data. The obvious-looking version — clear the timer, then
post — destroys the session whenever the post fails, and the elapsed time existed
only in the state you just deleted. Assume the network fails; the local copy is
the only copy until the server says otherwise.

---

## Payload shapes

### A reader with titles and character counts

This is the path that needs **no changes to Konseki at all**. Pose as a ttsu-shaped
reader and your entries upsert on `(title, session_date)`:

```http
POST /import
{
  "source": "ttsureader",
  "entries": [
    {
      "dateKey": "2026-08-12",
      "title": "本のタイトル",
      "charactersRead": 12345,
      "readingTime": 3600
    }
  ]
}
```

- `dateKey` — `YYYY-MM-DD`, the **logical** date from rule 1. Required.
- `title` — required; it's the identity of the row.
- `charactersRead` — integer. `readingTime` — seconds.
- An entry with **both** chars and time at zero is skipped.
- Field names are camelCase. Yes, really.

**Do not use this shape for a source with no character count.** The upsert is
guarded on *characters*: it only rewrites the row when `charactersRead` is
greater than what is stored. Send `charactersRead: 0` twice for one title on one
day and the second post is skipped — reported as `skipped: 1`, with the reading
time silently dropped. That guard is right for ttsu (IndexedDB reports stale
values, tabs race) and fatal for anything chars-less. Use the shape below.

### A reader with no character count

Manga, or anything else where there is nothing to count. Cumulative per (title,
logical day), last-write-wins, no monotonic guard:

```http
POST /import
{
  "source": "mangawari",
  "title": "極夜行",
  "session_date": "2026-08-12",
  "time_seconds": 3600,
  "client_id": "mangawari:<device>:極夜行:2026-08-12"
}
```

- `time_seconds` is that title's **running total for the day**, re-posted as it
  grows — not each sitting's delta. Posting a delta would overwrite, not add.
- `client_id` is the **cumulative** flavour from rule 2: stable, reused all day,
  and carrying the device name so two readers sum instead of clobbering.
  Omit it and you get the same behaviour for a single device.
- Answers `{"logged": true, ...}`. There is no `imported`/`skipped` here.
- Rows land as `activity_type: "Reading"` with `chars_read` 0, which keeps the
  hours in every total while staying out of the chars/hour denominators.

The title is a real media entry, so `/cover` attaches to it.

### A time-only session

```http
POST /log-manual
{
  "activity_type": "Listening",
  "time_seconds": 1800,
  "session_date": "2026-08-12",
  "client_id": "manga:9d3f0c72-..."
}
```

`activity_type` must be one of the strings from `GET /activity-types` — fetch it,
don't hardcode it, since the user can define their own categories.

### A cover image

If your reader has the cover in hand — a manga reader, an epub reader — send it
once and the title gets a real cover in the media grid instead of a placeholder.

```http
POST /cover
{
  "title": "極夜行",
  "cover_b64": "iVBORw0KGgoAAAA..."
}
```

- `title` must match **exactly** the title you send in your session payloads —
  that string is the join key.
- **No mime type.** The server sniffs the format, and may re-encode (an oversized
  PNG comes back as JPEG), so a type you declared would be wrong exactly when it
  mattered. Send raw base64, no `data:` prefix.
- Covers are downscaled to a 600px long edge server-side. Sending a 3000px scan
  wastes bandwidth but is otherwise harmless. Hard cap is 6 MB of base64.
- It touches no session data. Posting a cover never creates a row.

**Insert-if-absent: the first cover for a title wins.** A re-send is a silent
no-op returning `{"stored": false, "existing": true}` — which is a *success*, not
an error. This protects a cover the user set by hand (dropping an image or an
EPUB on the media entry) from being overwritten by whatever your app ships.

**Send it once per title, and remember locally that you did.** You cannot ask
whether a cover already exists — the always-on inbox has no database and cannot
answer that question, so a probe endpoint would work against the desktop and fail
against the Pi, breaking the "identical against both hosts" property everything
else here depends on. Keep a local set of titles you've sent covers for and skip
them. Re-sending isn't harmful, just wasteful — and a 300 KB blob on every post
would bloat the queue on an SD card.

### A source of your own

If you want your reader to appear as its own source rather than borrowing ttsu's,
that needs a change on the Konseki side as well as yours:

1. An `import_<yoursource>()` in `src/imports.py` that owns the upsert and its key.
2. A branch for it in `apply_payload()` in `src/ext_server.py`.

`import_mangawari_day` is a worked example of both, and of when it's worth doing:
the chars guard on the ttsu path made borrowing that shape lossy, not just
mislabelled.

`apply_payload` is the single import path — both the live HTTP handler and the
inbox drain call it, which is what makes a payload behave identically whether it
arrived instantly or out of the queue the next morning. Put the logic there and
nowhere else.

**The inbox needs no change.** It validates a payload no further than "is this
JSON" and has no idea what your source is. That ignorance is deliberate: it means
you never redeploy the always-on box to add a source.

---

## What the inbox guarantees

- Payloads are stored verbatim and handed to the desktop **in id order**.
- Applied rows are stamped, not deleted, and pruned after 30 days — so restoring
  an old desktop backup is a rewind rather than data loss.
- `GET /pending` is unauthenticated on purpose: counts and timestamps only, so you
  can eyeball a backlog from a phone with nothing configured. Never payload contents.
- It will happily accept a payload no version of Konseki understands. It'll be
  skipped at apply time with a log line, not retried forever.

## Testing without touching real data

Run the inbox yourself on a scratch port and database — stdlib only, no install:

```bash
KONSEKI_TOKEN=testtoken python3 pi/inbox_server.py --port 18999 --db ./scratch.db
```

Post to it, then `curl -s localhost:18999/pending` to see your payload queued.
Nothing reaches a real database until a desktop drains that inbox, so this is a
free place to get your shapes right.

## Checklist

- [ ] Host and token are user-configurable; no hardcoded `127.0.0.1`
- [ ] `rollover_hour` fetched from `/config`, cached, never reset on a failed fetch
- [ ] Logical date computed locally and sent explicitly with every payload
- [ ] `client_id` is the right flavour, minted at the right moment, and persisted
- [ ] Response body checked for `error`, not just the status code
- [ ] `duplicate: true` treated as success
- [ ] Local copy retained until the server confirms
- [ ] Retries re-send the identical payload, same `client_id`
- [ ] Covers sent once per title, tracked locally; `existing: true` treated as success
- [ ] Cover `title` byte-identical to the title in your session payloads
- [ ] Verified against a scratch inbox before pointing at anything real
