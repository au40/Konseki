# Konseki inbox

An always-on place for devices to drop sessions when the desktop is asleep.
One file, stdlib only, no pip install.

See [plans/SERVER-PLAN.md](../plans/SERVER-PLAN.md) for why this exists and what
it must never become.

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
| GET | `/inbox?since=<id>&limit=<n>` | token | Unapplied rows in id order |
| POST | `/ack` `{"through_id":n}` | token | Stamp rows `applied_at` |
| GET | `/pending` | **none** | Backlog count + oldest timestamp |
| GET/POST | `/activity-types` | token | Desktop-pushed category cache |

`/pending` is intentionally open so you can check the backlog from a phone browser
with nothing configured. It returns counts and timestamps only — never payload
contents.

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
