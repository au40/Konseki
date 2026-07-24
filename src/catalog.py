"""
catalog.py  —  Read-only reading ledger for Konseki

A spreadsheet-style catalog of titles with a per-title char / volume count that
is DELIBERATELY isolated from the stats pipeline. It lives in its own SQLite file
(`catalog.db`) and only ever reads `tracker.db` (`sessions`) — it never writes to
it. Nothing in the stats / dashboard / media / goals path reads back from here, so
the load-bearing GSM rollover + manual-time overlays documented in CLAUDE.md can
never be perturbed by this module.

Two jobs:
  1. Hand-logged "outside reading" — books / manga / games read elsewhere.
  2. Auto-include titles already tracked in `sessions`: a new title is added on
     sight, and a linked title's char count grows when more chars are read in the
     tracker (manual baseline + accumulated session growth; never auto-decreases).

A "book" for the Total-books metric is 7 manga volumes OR 100,000 chars.
"""

import sqlite3
from datetime import datetime
from pathlib import Path

from db import DATA_DIR, DB_PATH, _get_aliases

CATALOG_DB = DATA_DIR / "catalog.db"

READING_TYPES      = ("manga", "book", "game")
MANGA_VOLS_PER_BOOK = 7
CHARS_PER_BOOK      = 100_000


def _con():
    return sqlite3.connect(CATALOG_DB)


def init_catalog_db():
    DATA_DIR.mkdir(exist_ok=True)
    con = _con()
    con.execute("""
        CREATE TABLE IF NOT EXISTS catalog (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL UNIQUE,
            reading_type  TEXT NOT NULL DEFAULT 'book',
            chars         INTEGER NOT NULL DEFAULT 0,
            volumes       INTEGER NOT NULL DEFAULT 0,
            linked        INTEGER NOT NULL DEFAULT 0,
            synced_chars  INTEGER NOT NULL DEFAULT 0,
            hidden        INTEGER NOT NULL DEFAULT 0,
            sort_pos      INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        )
    """)
    con.commit()
    con.close()


def _norm_type(t):
    return t if t in READING_TYPES else "book"


def book_equiv(reading_type, chars, volumes):
    """Book-equivalents for one row: 7 manga volumes OR 100,000 chars == 1 book."""
    if reading_type == "manga":
        return (volumes or 0) / MANGA_VOLS_PER_BOOK
    return (chars or 0) / CHARS_PER_BOOK


def _session_title_totals():
    """{title: (all_time_chars, src_type_hint)} from tracker.db, read-only.

    The per-title all-time char SUM is overlay-invariant: GSM rollover attribution
    nets to zero per title across all-time and the manual overlay is time-only, so
    this raw sum already matches the Media grid's total_chars (db.get_media_stats).
    Do not apply any overlay here."""
    if not Path(DB_PATH).exists():
        return {}
    con = sqlite3.connect(DB_PATH)
    try:
        rows = con.execute("""
            SELECT title,
                   COALESCE(SUM(chars_read), 0) AS chars,
                   MAX(CASE WHEN source = 'gsm'      THEN 'game'
                            WHEN source LIKE 'ttsu%'  THEN 'book' END) AS src_type
            FROM sessions
            WHERE title IS NOT NULL AND title != ''
            GROUP BY title
        """).fetchall()
    finally:
        con.close()
    return {r[0]: (int(r[1]), r[2]) for r in rows}


def sync_catalog():
    """Auto-add new session titles and grow linked char counts. Idempotent;
    runs lazily on Catalog load. Writes only catalog.db."""
    init_catalog_db()
    sess = _session_title_totals()

    con = _con()
    now = datetime.now().isoformat()
    existing = {
        r[0]: r for r in con.execute(
            "SELECT name, id, reading_type, chars, volumes, linked, synced_chars, hidden "
            "FROM catalog"
        ).fetchall()
    }

    for title, (schars, src_type) in sess.items():
        row = existing.get(title)
        if row is None:
            # Brand-new title → auto-add as a linked row seeded at its current total.
            con.execute("""
                INSERT INTO catalog (name, reading_type, chars, volumes, linked,
                                     synced_chars, hidden, sort_pos,
                                     created_at, updated_at)
                VALUES (?,?,?,0,1,?,0,0,?,?)
            """, (title, src_type or "book", schars, schars, now, now))
            continue

        _id     = row[1]
        rtype   = row[2]
        linked  = row[5]
        synced  = row[6]
        hidden  = row[7]
        if hidden:
            continue  # dismissed auto row — don't resurrect or bump
        if linked:
            # Grow only on MORE chars, and never for manga (volumes are manual).
            if rtype != "manga" and schars > synced:
                con.execute(
                    "UPDATE catalog SET chars = chars + ?, synced_chars = ?, "
                    "updated_at = ? WHERE id = ?",
                    (schars - synced, schars, now, _id))
        else:
            # A manual row whose name now matches a session title — adopt it.
            # Baseline at the current total so only FUTURE reading is added, never
            # retro-dumping the whole session count onto the user's manual number.
            con.execute(
                "UPDATE catalog SET linked = 1, synced_chars = ?, updated_at = ? "
                "WHERE id = ?",
                (schars, now, _id))

    con.commit()
    con.close()


def get_catalog():
    """Sync, then return {rows: [...], total_books: float}. The single source of
    truth for the book-equivalents constants."""
    sync_catalog()
    aliases = _get_aliases()
    con = _con()
    rows = con.execute("""
        SELECT id, name, reading_type, chars, volumes, linked
        FROM catalog WHERE hidden = 0
        ORDER BY sort_pos ASC, name COLLATE NOCASE ASC
    """).fetchall()
    con.close()

    out, total_books = [], 0.0
    for _id, name, rtype, chars, volumes, linked in rows:
        out.append({
            "id":            _id,
            "name":          name,
            "display_name":  aliases.get(name, name),
            "reading_type":  rtype,
            "chars":         chars,
            "volumes":       volumes,
            "linked":        bool(linked),
        })
        total_books += book_equiv(rtype, chars, volumes)
    return {"rows": out, "total_books": round(total_books, 3)}


def add_catalog_entry(name, reading_type="book", chars=0, volumes=0):
    """Manual outside-reading add. If a (possibly hidden) row with this name
    already exists, unhide + overwrite it rather than colliding on the UNIQUE name."""
    name = (name or "").strip()
    if not name:
        raise ValueError("name required")
    con = _con()
    now = datetime.now().isoformat()
    con.execute("""
        INSERT INTO catalog (name, reading_type, chars, volumes, linked,
                             synced_chars, hidden, sort_pos, created_at, updated_at)
        VALUES (?,?,?,?,0,0,0,0,?,?)
        ON CONFLICT(name) DO UPDATE SET
          reading_type = excluded.reading_type,
          chars        = excluded.chars,
          volumes      = excluded.volumes,
          hidden       = 0,
          updated_at   = excluded.updated_at
    """, (name, _norm_type(reading_type), int(chars or 0), int(volumes or 0),
          now, now))
    con.commit()
    con.close()


def update_catalog_entry(entry_id, name=None, reading_type=None,
                         chars=None, volumes=None):
    """Partial edit. Editing `chars` on a linked row sets the displayed value only;
    `synced_chars` is left intact so future reading still adds its delta on top."""
    sets, args = [], []
    if name is not None:
        sets.append("name = ?");         args.append(name.strip())
    if reading_type is not None:
        sets.append("reading_type = ?"); args.append(_norm_type(reading_type))
    if chars is not None:
        sets.append("chars = ?");        args.append(int(chars))
    if volumes is not None:
        sets.append("volumes = ?");      args.append(int(volumes))
    if not sets:
        return
    sets.append("updated_at = ?");       args.append(datetime.now().isoformat())
    args.append(int(entry_id))
    con = _con()
    con.execute(f"UPDATE catalog SET {', '.join(sets)} WHERE id = ?", args)
    con.commit()
    con.close()


def delete_catalog_entry(entry_id):
    """Linked (auto-added) rows are tombstoned (hidden=1) so sync won't resurrect
    them; purely manual rows are hard-deleted."""
    con = _con()
    row = con.execute("SELECT linked FROM catalog WHERE id = ?", (int(entry_id),)).fetchone()
    if row is None:
        con.close()
        return
    if row[0]:
        con.execute("UPDATE catalog SET hidden = 1, updated_at = ? WHERE id = ?",
                    (datetime.now().isoformat(), int(entry_id)))
    else:
        con.execute("DELETE FROM catalog WHERE id = ?", (int(entry_id),))
    con.commit()
    con.close()
