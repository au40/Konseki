"""
ext_server.py — Localhost HTTP server for the browser extension.
Binds to 127.0.0.1 only. Validates Origin, Host, and a shared secret token
before accepting import payloads from the extension.
"""

import json
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from db import get_setting, set_setting, db_get_custom_categories
from imports import import_ttsu_entries, log_manual_session

BUILTIN_ACTIVITY_TYPES = ["Listening", "Reading", "Speaking", "Vocabulary", "Other"]

DEFAULT_PORT    = 18463
ALLOWED_ORIGINS = {
    "https://reader.ttsu.app",
}


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


class _Handler(BaseHTTPRequestHandler):
    _token     = ""
    _on_import = None

    def log_message(self, format, *args):
        pass  # suppress stdout access log

    def _origin_ok(self, origin):
        return origin in ALLOWED_ORIGINS or _is_extension_origin(origin)

    def _host_ok(self):
        host = self.headers.get("Host", "")
        port = self.server.server_address[1]
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
        if self._origin_ok(origin):
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
        if self.path != "/activity-types":
            return self._reject(404)

        custom = [c["name"] for c in db_get_custom_categories()]
        types  = BUILTIN_ACTIVITY_TYPES + [c for c in custom if c not in BUILTIN_ACTIVITY_TYPES]
        resp   = json.dumps(types).encode()

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
        if self.path not in ("/import", "/log-manual"):
            return self._reject(404)

        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            return self._reject(415)

        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))

            if self.path == "/import":
                source  = body.get("source", "")
                entries = body.get("entries", [])
                if source == "ttsureader":
                    result = import_ttsu_entries(entries)
                    if self._on_import and result.get("imported", 0) > 0:
                        self._on_import()
                    resp = json.dumps({"ok": True, **result}).encode()
                else:
                    return self._reject(400)
            else:  # /log-manual
                result = log_manual_session(
                    body.get("activity_type", ""),
                    body.get("time_seconds", 0),
                    body.get("session_date", ""),
                )
                if self._on_import and result.get("logged"):
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
        self._server   = None
        self._thread   = None

        handler           = type("H", (_Handler,), {
            "_token":     self.token,
            "_on_import": on_import,
        })
        self._server = HTTPServer(("127.0.0.1", self.port), handler)

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
        print(f"[ext-server] Listening on 127.0.0.1:{self.port}")

    def stop(self):
        if self._server:
            self._server.shutdown()

    @property
    def info(self):
        return {"port": self.port, "token": self.token}
