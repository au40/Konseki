# Konseki

A language-immersion tracker for Windows. It pulls your reading/listening stats
from [GameSentenceMiner (GSM)](https://github.com/bpwhelan/GameSentenceMiner) and
[ッツ Reader (ttsu)](https://reader.ttsu.app) and aggregates everything — sessions,
streaks, goals, per-title breakdowns, heatmaps — into one dashboard. It runs in your
system tray and updates itself as you read.

## Features

- **Automatic GSM stats** — watches GSM's database and pulls new sessions hands-off
  (or pull manually with a button / tray menu if you'd rather opt out of auto-logging).
- **ッツ Reader sync** — via the browser extension (below).
- **Video tracking** — semi-automatic, via the browser extension.
- **Manual log entry** — for reading/listening done anywhere else.
- **Goals, stats & charts** — daily/weekly totals, streaks, reading speed,
  per-title detail, activity breakdowns, and heatmaps.
- **Reading catalog** — a spreadsheet-style ledger of titles read.
- **7-day rolling backups** of your data.

## Requirements

- Windows 10/11
- Python 3 (only if running from source — see below)

## Install & run

If you just want the logger plus automatic GSM logs, run the prebuilt `.exe`.

To run from source:

```
pip install -r requirements.txt
python src/tracker.py
```

Konseki is meant to stay open in your tray, monitoring GSM for changes and updating
automatically. Closing the window hides it to the tray; quit from the tray menu.

## Browser extension (optional)

The `ext/` extension ("Konseki Sync") is needed for **ッツ Reader automatic imports**
and **video tracking**. Load `ext/` as an unpacked extension in your browser. It talks
to the app over a local-only HTTP server (`127.0.0.1`) secured with a shared token.

## Data

Everything lives in `~/immersion-tracker/`:

- `tracker.db` — sessions and stats
- `catalog.db` — the reading catalog
- backups are kept here too (7-day rolling)

## Development

`dev.ps1` launches the app against an isolated `dev-data/` folder so your real data is
untouched:

```
.\dev.ps1          # launch with existing dev data
.\dev.ps1 -Fresh   # wipe dev data first (simulate a fresh install)
```
