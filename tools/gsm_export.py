"""
gsm_export.py
─────────────
Pulls today's stats from GSM's local API and writes a session file
into ~/immersion-tracker/sessions/gsm_YYYY-MM-DD.json

Run manually:   python gsm_export.py
Or schedule it: add to Task Scheduler to run when GSM closes,
                or just run it from GSM's custom hooks if supported.

The main tracker app also has a "Pull GSM now" button that does the
same thing interactively.
"""

import requests
import json
import os
from datetime import date
from pathlib import Path

GSM_API  = "http://localhost:7275/api/stats"   # change port if needed
OUT_DIR  = Path.home() / "immersion-tracker" / "sessions"

def pull():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(GSM_API, timeout=5)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"[gsm_export] Could not reach GSM at {GSM_API}: {e}")
        return

    today_str  = str(date.today())
    today_year = today_str[:4]

    cur       = data.get("currentGameStats") or {}
    game_name = cur.get("game_name", "Unknown game")
    game_id   = cur.get("game_id", "")

    # Today's characters — try all-games combined first, fall back to current game
    today_chars = (data.get("characterActivityData") or {}) \
                      .get(today_year, {}).get(today_str, 0)
    if not today_chars:
        today_chars = cur.get("daily_activity", {}).get(today_str, 0)

    # Today's reading speed from heatmap, fall back to global average
    today_speed = (data.get("readingSpeedHeatmapData") or {}) \
                      .get(today_year, {}).get(today_str, 0)
    if not today_speed:
        today_speed = (data.get("allGamesStats") or {}).get("reading_speed", 0)
    time_seconds = (today_chars / today_speed * 3600) if today_speed > 0 else 0

    # Today's cards mined from the 30-day series
    cards_data  = data.get("cardsMinedLast30Days") or {}
    cl          = cards_data.get("labels", [])
    ct          = cards_data.get("totals", [])
    today_cards = ct[cl.index(today_str)] if today_str in cl else 0

    session = {
        "source":        "gsm",
        "activity_type": "Reading",
        "title":         game_name,
        "game_id":       game_id,
        "session_date":  today_str,
        "chars_read":    int(today_chars),
        "lines_read":    0,
        "time_seconds":  float(time_seconds),
        "reading_speed": float(today_speed),
        "cards_mined":   int(today_cards),
    }

    out_path = OUT_DIR / f"gsm_{today_str}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2, ensure_ascii=False)

    print(f"[gsm_export] Wrote {out_path}")
    print(f"             {session['chars_read']} chars  |  "
          f"{session['time_seconds']:.0f}s  |  {game_name}  |  "
          f"{session['reading_speed']:.0f} chars/hr  |  "
          f"{session['cards_mined']} cards mined")

if __name__ == "__main__":
    pull()
