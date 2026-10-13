## Konseki — Anki review time

Sends your daily Anki review time and card count to Konseki, where it lands as a
**Vocabulary** session — one pooled row per day.

| Setting | What it does |
|---|---|
| `host` | Where Konseki is. `127.0.0.1` if the tracker runs on this machine; otherwise the desktop's LAN address, or your always-on inbox. |
| `port` | Konseki's ingest port. `18463` unless you changed it. |
| `token` | From Konseki → Settings → Browser extension. The same token works against the desktop and the inbox. |
| `collection_tag` | Leave empty. Only needed if you feed **two separate Anki collections** into one tracker — give each a different tag so their days don't overwrite each other. |
| `idle_push_mins` | How long after you stop answering cards before the day is sent. There is no polling timer - a sync sends immediately, and each card answered pushes this deadline back, so one study session means one send. |

### Notes

- **The day boundary is Konseki's, not Anki's.** The addon reads Konseki's
  rollover hour and buckets reviews by it. If your two rollover hours differ,
  Anki's own "cards studied today" won't always match Konseki's figure — that's
  expected, so every source in Konseki sits on the same calendar.
- **Do not set the same `collection_tag` on two different collections.** They
  would share a key and each would overwrite the other's day.
- **Backfill is separate**: Tools → *Send Anki history to Konseki…*. It imports
  your whole review history in one pass, and by default skips counting the time
  on days where you'd already logged Vocabulary time by hand.
