#!/usr/bin/env python3
"""
inbox_server.py — Konseki's always-on store-and-forward inbox.

Runs on a Pi (or any box that's up more than the desktop is). Devices post
sessions here; the desktop drains them whenever it wakes. Nothing else.

THE RULE THIS FILE EXISTS TO PROTECT: exactly one process ever writes
tracker.db, and that process is the desktop. This server never sees tracker.db,
never imports db.py or imports.py, and never parses a payload beyond "is this
JSON". It stores bytes and hands them back in order.

That ignorance is deliberate and load-bearing. Konseki's schema and its
cross-cutting concerns (GSM rollover attribution, the manual time overlay — see
CLAUDE.md) change often; this file must not have to change with them. If you
find yourself wanting to inspect a payload's fields here, that belongs in the
desktop's apply_payload() instead.

Stdlib only — no pip install on the Pi, ever.

Run:
    KONSEKI_TOKEN=<same token as the desktop's Settings page> \
        python3 inbox_server.py --db /var/lib/konseki/inbox.db --port 18463

See README.md for the systemd unit.
"""

import argparse
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_PORT      = 18463
DEFAULT_DB        = "inbox.db"
DEFAULT_RETENTION = 30      # days to keep applied rows; see "Ack marks, doesn't delete"
PRUNE_EVERY_SECS  = 6 * 3600
MAX_BODY_BYTES    = 8 * 1024 * 1024   # a ttsu full-history post is the big one

# Queued verbatim, same as any other payload. /cover carries a base64 image, which
# is the one thing that makes MAX_BODY_BYTES load-bearing rather than theoretical —
# the desktop caps covers at 6MB of base64, comfortably under the limit here.
INGEST_PATHS = ("/import", "/log-manual", "/cover")

# Mirrors ext_server.py. Kept as a literal rather than imported — this file has
# no access to src/, which is the point.
ALLOWED_ORIGINS = {"https://reader.ttsu.app"}

# Fresh on every start, and served with every /inbox and /pending answer. It is
# how the desktop notices this process restarted and lost the in-memory caches
# below — without it, the desktop's push dedup (drain.py) has no way to tell "I
# already sent this" from "I already sent this, to a process that no longer
# exists", and a restarted inbox serves DEFAULT_CONFIG forever. Nothing else
# reads it; it is not persisted, and it must not be — a value that survived a
# restart would defeat the entire point.
BOOT_ID = secrets.token_hex(8)


def _is_extension_origin(origin):
    return origin.startswith("moz-extension://") or origin.startswith("chrome-extension://")


# ── Storage ───────────────────────────────────────────────────────────────────
class Inbox:
    """Append-only queue of raw payloads.

    `id` is monotonic and is the high-water mark the desktop tracks. Rows are
    never deleted on ack — only stamped — so restoring a week-old desktop backup
    is a rewind rather than data loss. Pruning happens on a long timer instead.

    ── ONE PERSISTENT CONNECTION, ON PURPOSE ────────────────────────────────
    This runs off an SD card, and SD cards die of writes. Not from this
    workload's volume — a few hundred payloads a day is nothing (see README) —
    but connect-per-request quietly multiplies it for no benefit:

      * The LAST connection to close a WAL database checkpoints it and deletes
        the -wal/-shm files. Reconnecting per request therefore forces a full
        checkpoint on *every commit* — reinstating exactly the double-write that
        WAL exists to defer — and churns four file create/deletes (filesystem
        metadata, itself journalled) around each one.
      * Even a pure read creates and removes -shm. `/pending` is unauthenticated
        so a browser left refreshing it would generate writes while reading
        nothing.

    Holding one connection open collapses a payload to a single sequential WAL
    append, with a real checkpoint only every `wal_autocheckpoint` pages.
    `check_same_thread=False` + the lock, because ThreadingHTTPServer dispatches
    each request on its own thread. At this request rate the lock never contends.
    """

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        d = os.path.dirname(os.path.abspath(path))
        if d:
            os.makedirs(d, exist_ok=True)
        self._con = sqlite3.connect(path, timeout=10.0, check_same_thread=False)
        self._con.execute("PRAGMA busy_timeout=10000")
        self._con.execute("PRAGMA journal_mode=WAL")
        # FULL fsyncs the WAL on each commit. That's one sequential fsync per
        # payload — irrelevant for wear at this volume — and it's what makes a
        # yanked power cable lose nothing already acknowledged with a 200. An
        # inbox that drops the last few sessions on a power cut has failed at the
        # one job it has, so this is not the knob to turn for card life.
        self._con.execute("PRAGMA synchronous=FULL")
        self._con.execute("""
            CREATE TABLE IF NOT EXISTS inbox (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at TEXT NOT NULL,
                path        TEXT NOT NULL,
                source      TEXT,
                device_id   TEXT,
                body_json   TEXT NOT NULL,
                applied_at  TEXT
            )
        """)
        self._con.execute("""
            CREATE INDEX IF NOT EXISTS idx_inbox_unapplied
                ON inbox(id) WHERE applied_at IS NULL
        """)
        self._con.commit()

    def close(self):
        with self._lock:
            self._con.close()

    def append(self, path, body):
        """Store one payload verbatim. `source`/`device_id` are lifted out for the
        /pending display only — nothing downstream reads them from here."""
        source    = body.get("source")    if isinstance(body, dict) else None
        device_id = body.get("device_id") if isinstance(body, dict) else None
        with self._lock:
            cur = self._con.execute(
                "INSERT INTO inbox (received_at, path, source, device_id, body_json) "
                "VALUES (?,?,?,?,?)",
                (datetime.now().astimezone().isoformat(), path,
                 str(source) if source else None,
                 str(device_id) if device_id else None,
                 json.dumps(body, ensure_ascii=False)),
            )
            self._con.commit()
            return cur.lastrowid

    def unapplied(self, since=0, limit=500):
        with self._lock:
            rows = self._con.execute(
                "SELECT id, received_at, path, source, device_id, body_json "
                "FROM inbox WHERE id > ? AND applied_at IS NULL "
                "ORDER BY id ASC LIMIT ?",
                (int(since), int(limit)),
            ).fetchall()
        return [
            {"id": r[0], "received_at": r[1], "path": r[2],
             "source": r[3], "device_id": r[4], "body_json": r[5]}
            for r in rows
        ]

    def ack(self, through_id):
        with self._lock:
            cur = self._con.execute(
                "UPDATE inbox SET applied_at=? WHERE id <= ? AND applied_at IS NULL",
                (datetime.now().astimezone().isoformat(), int(through_id)),
            )
            self._con.commit()
            return cur.rowcount

    def pending(self):
        with self._lock:
            n, oldest = self._con.execute(
                "SELECT COUNT(*), MIN(received_at) FROM inbox WHERE applied_at IS NULL"
            ).fetchone()
            by_source = dict(self._con.execute(
                "SELECT COALESCE(source, path), COUNT(*) FROM inbox "
                "WHERE applied_at IS NULL GROUP BY 1"
            ).fetchall())
            high = self._con.execute("SELECT COALESCE(MAX(id), 0) FROM inbox").fetchone()[0]
        return {"count": n, "oldest_received_at": oldest,
                "by_source": by_source, "max_id": high}

    def prune(self, retention_days):
        cutoff = (datetime.now().astimezone() - timedelta(days=retention_days)).isoformat()
        with self._lock:
            cur = self._con.execute(
                "DELETE FROM inbox WHERE applied_at IS NOT NULL AND applied_at < ?",
                (cutoff,),
            )
            self._con.commit()
            # A prune is the one place rows leave, so it's the only place the file
            # can shrink. Checkpoint here rather than leaving a WAL that has
            # absorbed a month of deletes. No VACUUM: rewriting the whole file to
            # reclaim a few KB is precisely the write burst we're avoiding.
            if cur.rowcount:
                self._con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return cur.rowcount


# ── Desktop-pushed caches ─────────────────────────────────────────────────────
# Two things a client needs that this box has no way to work out for itself. The
# desktop pushes both after each drain and we serve the last copy, so a client
# behaves identically whether it's pointed at the desktop or here.
#
# Held in memory, not the db, and deliberately so: this file stores payload bytes
# and nothing else (see the module docstring). Losing them on restart is
# harmless ONLY because BOOT_ID tells the desktop it happened — the desktop
# dedups its pushes by value, so without that signal it would stay silent and
# this box would serve DEFAULT_CONFIG until a setting happened to change. See
# _push_settings in src/drain.py; the two halves have to stay in step.
# Clients cache their last known value rather than resetting to the default,
# which is what keeps the repopulation window (one drain interval) harmless.
BUILTIN_ACTIVITY_TYPES = ["Listening", "Reading", "Speaking", "Vocabulary", "Other"]
_activity_types = list(BUILTIN_ACTIVITY_TYPES)

# rollover_hour decides which LOGICAL day a device's accrual belongs to. A
# capturing device must know it BEFORE it posts, because the capturer owns the
# date — see apply_payload() in src/ext_server.py. Serving 0 before the first
# push matches the app's own default, so a client that reads this early behaves
# like a machine with no rollover set rather than getting nonsense.
DEFAULT_CONFIG = {"rollover_hour": 0}
_config = dict(DEFAULT_CONFIG)


# ── HTTP ──────────────────────────────────────────────────────────────────────
class _Handler(BaseHTTPRequestHandler):
    inbox     = None
    token     = ""
    server_version = "konseki-inbox"

    def log_message(self, fmt, *args):
        pass

    # This box is LAN-only by definition, so Origin/Host prove nothing (any
    # device can set any header) and an absent Origin is normal — phones, the
    # e-reader and curl don't send one. The token is the only real control.
    # Same reasoning as ext_server._origin_ok; keep the two in step.
    def _token_ok(self):
        provided = self.headers.get("X-Tracker-Token", "")
        return bool(self.token) and secrets.compare_digest(provided, self.token)

    def _send_cors(self, origin):
        if origin and (origin in ALLOWED_ORIGINS or _is_extension_origin(origin)):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tracker-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._send_cors(self.headers.get("Origin", ""))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, code):
        self.send_response(code)
        self.end_headers()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors(self.headers.get("Origin", ""))
        self.end_headers()

    def do_GET(self):
        u    = urlparse(self.path)
        qs   = parse_qs(u.query)
        path = u.path

        # /pending is deliberately unauthenticated: its whole value is that you
        # can eyeball the backlog from a phone browser with nothing configured.
        # It exposes counts and timestamps, never payload contents.
        if path == "/pending":
            return self._json({**self.inbox.pending(), "boot_id": BOOT_ID})

        if not self._token_ok():
            return self._reject(403)

        if path == "/inbox":
            since = int((qs.get("since") or ["0"])[0] or 0)
            limit = min(int((qs.get("limit") or ["500"])[0] or 500), 2000)
            rows  = self.inbox.unapplied(since, limit)
            # boot_id rides along on the call the desktop already makes every
            # tick, so noticing a restart costs no extra request.
            return self._json({"rows": rows, "count": len(rows), "boot_id": BOOT_ID})

        if path == "/activity-types":
            return self._json(_activity_types)

        if path == "/config":
            return self._json(_config)

        return self._reject(404)

    def do_POST(self):
        global _activity_types, _config
        path = urlparse(self.path).path

        if not self._token_ok():
            return self._reject(403)

        if "application/json" not in self.headers.get("Content-Type", ""):
            return self._reject(415)

        try:
            body = self._read_json_body()
        except (ValueError, json.JSONDecodeError):
            return self._reject(400)
        if body is None:
            return self._reject(400)

        if path in INGEST_PATHS:
            # "Is it JSON" is the ENTIRE validation. Anything stricter would
            # couple this box to the desktop's schema — see the module docstring.
            row_id = self.inbox.append(path, body)
            return self._json({"ok": True, "queued": row_id})

        if path == "/ack":
            n = self.inbox.ack(int(body.get("through_id", 0)))
            return self._json({"ok": True, "acked": n})

        if path == "/activity-types":
            types = body.get("types")
            if isinstance(types, list) and types:
                _activity_types = [str(t) for t in types]
            return self._json({"ok": True, "count": len(_activity_types)})

        if path == "/config":
            # Replace wholesale rather than merging: the desktop sends the
            # complete set it wants served, so a setting it stops sending should
            # stop being served rather than linger here as a stale override.
            cfg = body.get("config")
            if isinstance(cfg, dict) and cfg:
                _config = dict(cfg)
            return self._json({"ok": True, **_config})

        return self._reject(404)


def main():
    ap = argparse.ArgumentParser(description="Konseki inbox — store and forward")
    ap.add_argument("--db",   default=os.environ.get("KONSEKI_INBOX_DB", DEFAULT_DB))
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("KONSEKI_INBOX_PORT", DEFAULT_PORT)))
    ap.add_argument("--bind", default=os.environ.get("KONSEKI_INBOX_BIND", "0.0.0.0"))
    ap.add_argument("--retention-days", type=int,
                    default=int(os.environ.get("KONSEKI_INBOX_RETENTION", DEFAULT_RETENTION)))
    args = ap.parse_args()

    token = os.environ.get("KONSEKI_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "KONSEKI_TOKEN is not set.\n"
            "Copy the token from Konseki's Settings > Browser extension page and\n"
            "export it here. It must be the SAME token — clients use one config\n"
            "whether they post to the desktop or to this inbox."
        )

    inbox = Inbox(args.db)
    handler = type("H", (_Handler,), {"inbox": inbox, "token": token})

    def _prune_loop():
        while True:
            try:
                n = inbox.prune(args.retention_days)
                if n:
                    print(f"[inbox] pruned {n} applied row(s) older than "
                          f"{args.retention_days}d", flush=True)
            except Exception as e:
                print(f"[inbox] prune failed: {e}", flush=True)
            threading.Event().wait(PRUNE_EVERY_SECS)

    threading.Thread(target=_prune_loop, daemon=True, name="inbox-prune").start()

    p = inbox.pending()
    print(f"[inbox] db={args.db}  pending={p['count']}  max_id={p['max_id']}", flush=True)
    print(f"[inbox] listening on {args.bind}:{args.port}", flush=True)

    ThreadingHTTPServer((args.bind, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
