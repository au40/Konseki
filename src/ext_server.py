"""
ext_server.py — HTTP ingest server for the browser extension and other devices.

Binds 127.0.0.1 by default. With the `lan_ingest` setting on it binds 0.0.0.0 so
ttsu, the extension, a phone, or the e-reader can post from anywhere on the LAN.
Validates Origin, Host, and a shared secret token before accepting payloads.

Read `_host_ok` / `_origin_ok` before touching the auth: those two checks mean
something quite different once the socket leaves loopback, and the comments there
are the reason the LAN mode is safe.
"""

import json
import secrets
import socket
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

from db import get_setting, set_setting, db_get_custom_categories, logical_date_for
from imports import (import_anki_days, import_cover, import_mangawari_day,
                     import_ttsu_entries, import_youtube_day, log_manual_session)

BUILTIN_ACTIVITY_TYPES = ["Listening", "Reading", "Speaking", "Vocabulary", "Other"]

DEFAULT_PORT    = 18463
ALLOWED_ORIGINS = {
    "https://reader.ttsu.app",
}

INGEST_PATHS = ("/import", "/log-manual", "/cover")


def _is_extension_origin(origin):
    return origin.startswith("moz-extension://") or origin.startswith("chrome-extension://")


def _get_or_create_token():
    token = get_setting("ext_token", "")
    if not token:
        token = secrets.token_hex(32)
        set_setting("ext_token", token)
    return token


def _get_port():
    stored = get_setting("ext_port", "")
    return int(stored) if stored else DEFAULT_PORT


def lan_ingest_enabled():
    return get_setting("lan_ingest", "0") == "1"


def _get_bind_host():
    """0.0.0.0 when LAN ingest is on, else loopback. Read once at construction —
    flipping the setting needs an app restart to rebind the socket."""
    return "0.0.0.0" if lan_ingest_enabled() else "127.0.0.1"


def get_lan_ip():
    """Best-effort LAN address of this machine, for display in Settings.

    UDP 'connect' picks a route without sending a packet, which is the only
    reliable way to learn which local interface the LAN would actually use on a
    box with several (wifi + ethernet + virtual adapters). Falls back to the
    hostname lookup, then loopback."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))   # TEST-NET-1: routable-looking, never real
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


def _captured_date(body):
    """Logical date from the payload's `captured_at`, or '' if it has none.

    '' lets the caller fall through to log_manual_session's own get_today()
    default, which is right for a payload applied the instant it arrived."""
    ts = (body.get("captured_at") or "").strip()
    if not ts:
        return ""
    try:
        when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if when.tzinfo is not None:
        # Logical days are a local-wall-clock idea (rollover_hour is a local
        # hour), so an offset-carrying stamp has to come back to local time
        # before the rollover comparison means anything.
        when = when.astimezone().replace(tzinfo=None)
    return logical_date_for(when)


def apply_payload(path, body):
    """Apply one ingest payload. THE single import path for network-delivered
    sessions — both the live HTTP handler below and the Pi drain loop
    (drain.py) call this, so a payload behaves identically whether it arrived
    straight from a device or hours later out of the inbox queue.

    Returns (result_dict, http_status). Status is 200 on success so the handler
    can pass it straight through; the drain only cares that it's 200.

    Bodies may carry `device_id` and `captured_at`. THE APPLIER NEVER DECIDES A
    DATE THE CAPTURER ALREADY DECIDED — that is the capture-time trap, and the
    queue makes it real: a payload can arrive
    seconds after capture or the next morning, and it must land identically.

    ttsu entries carry an explicit per-entry `dateKey`, so they're already
    pinned. YouTube posts an explicit `session_date` for the same reason — the
    tracker reads `rollover_hour` from GET /config and buckets its accrual into
    the logical day itself before posting. A manual log is not — the extension's
    timer posts elapsed seconds with no date — so `captured_at` is what pins it.
    Falling back to "now" would silently move a 01:00 session onto the wrong
    logical day whenever the drain ran after the rollover hour.
    """
    if path == "/import":
        source = body.get("source", "")
        if source == "ttsureader":
            return import_ttsu_entries(body.get("entries", [])), 200
        if source == "youtube":
            # Cumulative total for one logical day, dated by the capturer.
            # Idempotent on its `client_id` (`youtube:<device>:<date>`), so a
            # replay is a rewrite rather than a second row — which is what makes
            # it safe to queue: an inbox row applied hours late rewrites that
            # device's total for the day instead of adding to it. The key is
            # per-device because two machines watching on the same day must sum,
            # not overwrite each other.
            #
            # No `, 0` default on time_seconds, deliberately: zero is a real
            # payload meaning "the day emptied out, delete its row", so a body
            # that omitted the field entirely must arrive as None and be
            # rejected rather than defaulted into a deletion.
            return import_youtube_day(
                body.get("session_date", ""),
                body.get("time_seconds"),
                body.get("client_id"),
            ), 200
        if source == "mangawari":
            # Cumulative total for one title on one logical day, dated by the
            # reader. Same last-write-wins contract as youtube — the e-reader
            # re-posts a growing total per (title, day) — but keyed per title so
            # each volume gets its own row, and therefore its own cover.
            #
            # NOT the ttsu path, deliberately: manga has no character count, and
            # `import_ttsu_entries` only updates when chars grow, so a second
            # sitting on one day would be skipped and its time lost.
            return import_mangawari_day(
                body.get("title", ""),
                body.get("session_date", ""),
                body.get("time_seconds", 0),
                body.get("client_id"),
            ), 200
        if source == "anki":
            # A BATCH of logical days, always — the addon's periodic push sends
            # today and yesterday, the history backfill sends hundreds. One
            # shape, so there is no second path to keep in step.
            #
            # Neither `days` nor the per-entry counters get a default, for the
            # same reason `youtube` refuses one: an omitted `time_seconds` must
            # arrive as None and be rejected, never be read as the zero that
            # means "delete this day".
            #
            # `skip_days_with_vocabulary_time` is passed through as-is because
            # it is TRI-STATE, and `.get` returning None for an absent key is
            # exactly the third state: the periodic push leaves an existing
            # row's time_excluded alone, while an explicit true/false from the
            # backfill re-decides it. Coercing it to a bool here would let every
            # nightly push un-suppress a day the backfill had skipped.
            return import_anki_days(
                body.get("days"),
                body.get("skip_days_with_vocabulary_time"),
            ), 200
        return {"error": f"unknown source {source!r}"}, 400

    if path == "/cover":
        # Metadata, not a session — no date, no idempotency key, and separate
        # from /import so a 300KB blob doesn't ride along on the payload a
        # client sends every couple of minutes. Insert-if-absent, so a client
        # re-sending after a reinstall can't overwrite a cover the user chose.
        return import_cover(body.get("title", ""), body.get("cover_b64", "")), 200

    if path == "/log-manual":
        # client_id is what makes a retry safe — the stopwatch re-sends the same
        # one, and so does a drain replaying an inbox row after a crash. Absent
        # (in-app logging, older extension builds) it behaves as it always did.
        return log_manual_session(
            body.get("activity_type", ""),
            body.get("time_seconds", 0),
            body.get("session_date", "") or _captured_date(body),
            body.get("client_id"),
        ), 200

    return {"error": f"unknown path {path!r}"}, 404


def activity_types():
    """Builtin categories plus the user's custom ones, in display order."""
    custom = [c["name"] for c in db_get_custom_categories()]
    return BUILTIN_ACTIVITY_TYPES + [c for c in custom if c not in BUILTIN_ACTIVITY_TYPES]


class _Handler(BaseHTTPRequestHandler):
    _token     = ""
    _on_import = None
    _lan       = False

    def log_message(self, format, *args):
        pass  # suppress stdout access log

    def _origin_ok(self, origin):
        """On loopback, an allowed Origin means 'a browser on this machine sent
        this'. On a LAN it means nothing — any device can set any header — so the
        token (below) is the only real control there.

        The practical reason this loosens in LAN mode: non-browser clients send
        NO Origin at all, and an empty Origin currently 403s. That's why the
        parked tools/pull_from_ereader.py has to forge one to reach loopback. A
        phone, the Boox, or a curl one-liner all hit the same wall. In LAN mode
        we accept the absent Origin and lean on the token; the allowlist stays so
        real browser requests still get a matching CORS header back."""
        if not origin:
            return self._lan
        return origin in ALLOWED_ORIGINS or _is_extension_origin(origin)

    def _host_ok(self):
        """Loopback mode keeps the strict allowlist — it's a cheap DNS-rebinding
        guard when the only legitimate caller is same-machine. LAN mode can't use
        it (the Host is whatever address the client dialled: an IP, a .local
        name, a hostname), so it degrades to a port sanity check."""
        host = self.headers.get("Host", "")
        port = self.server.server_address[1]
        if self._lan:
            if not host:
                return True
            hostport = host.rsplit(":", 1)
            return len(hostport) == 1 or hostport[1] == str(port)
        return host in (
            "127.0.0.1",
            f"127.0.0.1:{port}",
            "localhost",
            f"localhost:{port}",
        )

    def _token_ok(self):
        provided = self.headers.get("X-Tracker-Token", "")
        return bool(self._token) and secrets.compare_digest(provided, self._token)

    def _send_cors(self, origin):
        # Only echo a real Origin. In LAN mode _origin_ok("") passes for
        # non-browser clients, and those have no CORS opinion — emitting an empty
        # Allow-Origin header would be malformed for no benefit.
        if origin and self._origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tracker-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reject(self, code):
        self.send_response(code)
        self.end_headers()

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if not self._host_ok() or not self._origin_ok(origin):
            return self._reject(403)
        self.send_response(204)
        self._send_cors(origin)
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin", "")
        if not self._host_ok() or not self._origin_ok(origin):
            return self._reject(403)
        if not self._token_ok():
            return self._reject(403)
        if self.path == "/activity-types":
            payload = activity_types()
        elif self.path == "/config":
            # Settings a capturing device can't derive on its own. The YouTube
            # tracker needs rollover_hour to bucket accrual into the right
            # LOGICAL day before it posts — the capturer decides the date, so it
            # has to know where the boundary is.
            payload = {"rollover_hour": int(get_setting("rollover_hour", "0") or 0)}
        else:
            return self._reject(404)

        resp = json.dumps(payload).encode()

        self.send_response(200)
        self._send_cors(origin)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp)

    def do_POST(self):
        origin = self.headers.get("Origin", "")

        if not self._host_ok():
            return self._reject(403)
        if not self._origin_ok(origin):
            return self._reject(403)
        if not self._token_ok():
            return self._reject(403)
        if self.path not in INGEST_PATHS:
            return self._reject(404)

        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            return self._reject(415)

        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))

            result, status = apply_payload(self.path, body)
            if status != 200:
                return self._reject(status)
            if self._on_import and (result.get("imported", 0) > 0
                                    or result.get("logged")
                                    or result.get("stored")):
                self._on_import()
            resp = json.dumps({"ok": True, **result}).encode()

            self.send_response(200)
            self._send_cors(origin)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(resp)

        except Exception as e:
            print(f"[ext-server] {e}")
            self._reject(500)


class ExtServer:
    def __init__(self, on_import=None):
        self.token     = _get_or_create_token()
        self.port      = _get_port()
        self.lan       = lan_ingest_enabled()
        self.bind_host = _get_bind_host()
        self._server   = None
        self._thread   = None

        handler           = type("H", (_Handler,), {
            "_token":     self.token,
            "_on_import": on_import,
            "_lan":       self.lan,
        })
        self._server = HTTPServer((self.bind_host, self.port), handler)

    def reroll_token(self):
        new_token = secrets.token_hex(32)
        set_setting("ext_token", new_token)
        self.token = new_token
        self._server.RequestHandlerClass._token = new_token
        return new_token

    def start(self):
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="ext-server"
        )
        self._thread.start()
        print(f"[ext-server] Listening on {self.bind_host}:{self.port}")
        if self.lan:
            print(f"[ext-server] LAN ingest ON — clients post to http://{get_lan_ip()}:{self.port}")

    def stop(self):
        if self._server:
            self._server.shutdown()

    @property
    def info(self):
        return {
            "port":  self.port,
            "token": self.token,
            "lan":   self.lan,
            "host":  get_lan_ip() if self.lan else "127.0.0.1",
        }
