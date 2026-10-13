# Konseki Anki addon

Sends Anki review time and card counts to Konseki. Rows land as
`source='anki'`, `activity_type='Vocabulary'`, one pooled row per logical day.

Built against **Anki 25.09**. Nothing here uses an API newer than 2.1.50.

## Install

```bash
python tools/install_anki_addon.py
```

Copies `anki/konseki_anki/` into your `addons21` folder, preserving the
`user_files/` directory if one is already there. Restart Anki afterwards.

Then: **Tools → Add-ons → Konseki → Config**, and paste the host, port and token
from Konseki → Settings → Browser extension.

To develop against it, pass `--link` to symlink instead of copy (Windows needs
Developer Mode or an elevated shell for that).

## What it does

**Ongoing.** There is no polling timer. A push happens when you stop answering
cards (debounced by `idle_push_mins`), when a sync finishes, and when a profile
opens or closes. Each push re-states the last **seven** logical days' cumulative
totals — wide enough that a sync bringing in phone reviews from a few days back
is picked up, and free in steady state because a day whose numbers haven't moved
is filtered out before anything goes over the wire.

A failed push restores the pending flag and arms a backing-off retry (1, 5, then
15 minutes) that stops once the post lands. The polling timer this replaced was
*supposed* to be that retry and wasn't: it cleared the pending flag before the
request and never restored it on failure, so every later trigger short-circuited
and the day was never resent.

**Backfill.** Tools → *Send Anki history to Konseki…* reads the whole `revlog`
and sends every day at once. Re-runnable: each day is keyed, so a second run
rewrites rather than duplicates.

## Layout

| File | |
|---|---|
| `revlog.py` | **Pure.** No Anki imports — the bucketing logic, unit-tested by `tests/test_revlog_bucket.py` in the repo's normal pytest run. |
| `net.py` | The wire contract from `CLIENT-INTEGRATION.md`. Stdlib only. Tested by `tests/test_anki_client.py`. |
| `__init__.py` | Anki glue: hooks, timer, menu action, the backfill dialog. Deliberately thin. |

The collection is read on the **main thread** (`mw.col.db` is not safe from a
worker, and the read is a single indexed scan); only the POST goes to `taskman`.

## Two things not to break

**The `client_id` is collection-scoped, not device-scoped.** This inverts the
rule the YouTube tracker follows. A browser only sees its own viewing, so two
machines must *sum* and YouTube keys per device to let them. An Anki collection
is **synced** — every device that opens it computes the same day totals from the
same revlog — so a per-device key would make a second desktop insert a second
row and double the day. `anki:<date>` is what makes the second machine rewrite
the first's row instead.

**A day with no reviews is still sent, as `0/0`.** That is what deletes the
stored row of a day the user emptied out (undone reviews, a deleted deck).
Sending only the days found in the revlog would leave that row frozen at its old
total forever.
