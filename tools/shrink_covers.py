#!/usr/bin/env python
"""One-time migration: downscale oversized stored book covers.

Book covers dropped from a file are saved at the file's full resolution — often
1500-2560px on the long edge — but nothing in the UI shows a cover larger than
~250px (the media-grid cards and the 160px detail box). The webview then live-
downscales that ~10x in one cheap pass, so book covers look soft/aliased on the
grid while the already-small GSM game covers (~400px) stay crisp through the
identical CSS.

This resamples each stored cover down to COVER_MAX_EDGE with a Lanczos filter —
the same treatment new covers now get on import (tracker._shrink_cover_b64), so
they render as sharply as game covers everywhere. Idempotent: covers already at
or under the cap are skipped, so it's safe to re-run. Backs the database up
before writing anything.

Usage:
    python tools/shrink_covers.py            # the app's real data-dir DB
    python tools/shrink_covers.py --dry-run  # report only, write nothing
    python tools/shrink_covers.py --db PATH  # a specific database file
"""
import argparse
import base64
import io
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# Import the app's single source of truth for the shrink logic + cap.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tracker import _shrink_cover_b64, COVER_MAX_EDGE, _COVER_PIL_OK, _CoverImage  # noqa: E402
import db as dbmod  # noqa: E402


def _dims(data_url):
    b64 = data_url.split(",", 1)[1]
    im = _CoverImage.open(io.BytesIO(base64.b64decode(b64)))
    return im.size


def main():
    # Cover titles are Japanese; keep prints from blowing up on a cp1252 console.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", help="database file (default: the app's data-dir DB)")
    ap.add_argument("--dry-run", action="store_true", help="report only")
    args = ap.parse_args()

    if not _COVER_PIL_OK:
        print("Pillow is not available — cannot resize. `pip install Pillow`.")
        return 1

    db_path = Path(args.db) if args.db else Path(dbmod.DB_PATH)
    if not db_path.exists():
        print("Database not found:", db_path)
        return 1
    print("Database:", db_path)

    con = sqlite3.connect(str(db_path))
    rows = con.execute("SELECT title, image_data FROM book_covers").fetchall()

    oversized = []
    for title, data_url in rows:
        if not data_url or not data_url.startswith("data:"):
            continue
        try:
            w, h = _dims(data_url)
        except Exception as e:
            print("  ! unreadable, skipping:", (title or "")[:40], "-", e)
            continue
        if max(w, h) > COVER_MAX_EDGE:
            oversized.append((title, data_url, (w, h)))

    print(f"{len(rows)} covers total, {len(oversized)} over {COVER_MAX_EDGE}px.")
    if not oversized:
        con.close()
        return 0

    if not args.dry_run:
        bdir = db_path.parent / "backups"
        bdir.mkdir(exist_ok=True)
        bak = bdir / f"{db_path.stem}-precovershrink-{datetime.now():%Y%m%d-%H%M%S}.db"
        shutil.copy2(db_path, bak)
        print("Backup written:", bak)

    changed = 0
    for title, data_url, (w, h) in oversized:
        b64 = data_url.split(",", 1)[1]
        try:
            mime, b64_out = _shrink_cover_b64(b64)
        except Exception as e:
            print("  ! resize failed, kept original:", (title or "")[:40], "-", e)
            continue
        if len(b64_out) >= len(b64):
            print(f"  = {(title or '')[:40]}  {w}x{h}  (no size gain, kept)")
            continue
        nw, nh = _dims(f"data:{mime};base64,{b64_out}")
        old_kb = len(b64) * 3 // 4 // 1024
        new_kb = len(b64_out) * 3 // 4 // 1024
        print(f"  ↓ {(title or '')[:40]:<40}  {w}x{h} -> {nw}x{nh}   {old_kb}KB -> {new_kb}KB")
        if not args.dry_run:
            con.execute(
                "UPDATE book_covers SET image_data=?, updated_at=? WHERE title=?",
                (f"data:{mime};base64,{b64_out}", datetime.now().isoformat(), title),
            )
            changed += 1

    if args.dry_run:
        print("(dry run — nothing written)")
    else:
        con.commit()
        print(f"Done — {changed} cover(s) shrunk and committed.")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
