# Konseki inbox

An always-on place for devices to drop sessions when the desktop is asleep.
One file, stdlib only, no pip install.

## What it is

An append-only queue of raw payloads. Devices `POST /import` or `POST /log-manual`
here exactly as they would to the desktop — same paths, same token, same body — and
the desktop pulls them down whenever it's awake and applies them.

## What it is not

It is **not** a database and never becomes one. It does not import `db.py`, does
not know Konseki's schema, and validates a payload no further than "is this JSON".
The desktop remains the sole writer of `tracker.db`.

That ignorance is the feature: schema changes on the desktop never require
redeploying this. If you're tempted to inspect payload fields here, that logic
belongs in `apply_payload()` in [src/ext_server.py](../src/ext_server.py).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/import` | token | Queue a ttsu/extension payload |
| POST | `/log-manual` | token | Queue a hand-logged session |
| POST | `/cover` | token | Queue a cover image for a title |
| GET | `/inbox?since=<id>&limit=<n>` | token | Unapplied rows in id order, plus `boot_id` |
| POST | `/ack` `{"through_id":n}` | token | Stamp rows `applied_at` |
| GET | `/pending` | **none** | Backlog count + oldest timestamp, plus `boot_id` |
| GET/POST | `/activity-types` | token | Desktop-pushed category cache |
| GET/POST | `/config` | token | Desktop-pushed settings cache (`rollover_hour`) |
| POST | `/backup` | token | Store a dated copy of the desktop's database (raw zip body) |
| GET | `/backups` | token | List stored backups — **names and sizes only** |

`/backup` takes two optional headers: `X-Backup-Sha256`, verified before the file
is renamed into place, and `X-Backup-Date` (`YYYY-MM-DD`), naming the day the
copy belongs to so the desktop can backfill zips it already holds. Absent means
today. The date is validated to the point where it can only be a calendar day
and the filename is still built here — **the client never supplies a path**. A
past date whose slot is already filled is refused with a 409; only an empty slot
or today's is writable, so a backfill can fill holes but can never overwrite an
existing generation.

`/pending` is intentionally open so you can check the backlog from a phone browser
with nothing configured. It returns counts and timestamps only — never payload
contents.

`/activity-types` and `/config` are **caches, not sources**. The desktop pushes
them after each drain and this box serves back the last copy verbatim — it never
reads inside them or acts on them, so they cost this file no knowledge of the
schema. They exist so a client behaves identically whichever host it points at.
`/config` carries `rollover_hour`, which a capturing device has to know *before*
it posts, because the capturer decides the date (see `apply_payload()` in
[src/ext_server.py](../src/ext_server.py)). Both are held in memory and repopulate
on the next drain after a restart — which works only because `boot_id` tells the
desktop the restart happened. `boot_id` is fresh per process, never persisted,
and returned by `/inbox` and `/pending`; the desktop keys its push dedup on it
(`_push_settings` in [src/drain.py](../src/drain.py)) and would otherwise stay
silent after a reboot, leaving this box serving `rollover_hour: 0` indefinitely.

**Redeploy this file after updating Konseki.** A desktop running the newer drain
against an older inbox still works — it just pushes on every tick instead of
deduping, because there is no `boot_id` to key on.

## Deploy

```bash
sudo useradd --system --home /var/lib/konseki konseki
sudo mkdir -p /opt/konseki /etc/konseki
sudo cp inbox_server.py /opt/konseki/
sudo cp konseki-inbox.service /etc/systemd/system/

# Same token as Konseki's Settings > Browser extension page
printf 'KONSEKI_TOKEN=%s\n' 'paste-token-here' | sudo tee /etc/konseki/inbox.env
sudo chmod 600 /etc/konseki/inbox.env

sudo systemctl daemon-reload
sudo systemctl enable --now konseki-inbox
```

**Set the timezone and confirm NTP** (`timedatectl`). It doesn't affect the math
today — the desktop computes every date — but a box on UTC will misreport
`received_at`, and it matters properly the moment anything else runs here.

## Running it without a Pi

It runs anywhere Python 3 does, so you can drive the whole loop on the desktop
before buying hardware — just put it on a different port than the tracker's:

```bash
KONSEKI_TOKEN=$(echo paste-token-here) python pi/inbox_server.py --port 18464 --db ./scratch-inbox.db
```

Then set **inbox URL** in Konseki's Settings to `http://127.0.0.1:18464`.

## Backups

Konseki sends this box a dated copy of `tracker.db` + `catalog.db` once a day,
so the backups aren't all sitting on the drive they're meant to protect against.
They land in `/var/lib/konseki/backups/` (`--backup-dir`), 30 kept
(`--backup-keep`), one per calendar day, mode `0600` in a `0700` directory —
a backup carries the whole `settings` table, so it holds the token too.

**This box will never hand one back over HTTP, and must not be taught to.**
`KONSEKI_TOKEN` is copied onto every device that posts sessions — extensions,
the e-reader, any second GSM machine — and each of those needs one capability:
*append a session*. A download route behind that same token would let a single
lost device pull the entire database. Listing is fine; contents are not. See
`BackupStore` in `inbox_server.py`.

### Restoring

See what's there (from anywhere on the LAN, with the token):

```bash
curl -s -H "X-Tracker-Token: $KONSEKI_TOKEN" http://your-inbox-host:18463/backups
```

Then copy the one you want off the box — **this is the only way to retrieve it**:

```bash
scp konseki@your-inbox-host:/var/lib/konseki/backups/konseki_2026-08-17.zip .
```

Close Konseki, then unzip `tracker.db` and `catalog.db` over your data directory
(`%APPDATA%`-adjacent on Windows — whatever `IMMERSION_TRACKER_DATA_DIR` points
at, else `~/immersion-tracker`). Restart.

The `scp` line is written out in full on purpose. A restore is rare, happens
under stress, and quite possibly from a machine that isn't your usual one —
which is exactly when "you'll work out the path" fails.

## Retention

Applied rows are stamped, not deleted, and pruned after 30 days
(`--retention-days`). Rows are bytes; keeping weeks of them makes "I restored a
week-old backup" a rewind instead of data loss.

## Security

Plaintext HTTP plus a bearer token is a reasonable risk on a home LAN. The same
thing exposed to the internet is not.

**Do not port-forward this.** Don't let "I'll just check it from the train" become
the reason to. If a device is lost, reroll the token in Konseki's Settings and
update `/etc/konseki/inbox.env`.
