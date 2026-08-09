"""
drain.py — Pulls queued sessions off the always-on inbox and applies them.

The desktop is the sole writer of tracker.db, so it fetches; the inbox never
pushes and needs no knowledge that this machine exists. That direction is
deliberate: the desktop is the party behind a sleep state and a possibly-changing
IP, and the only party that knows when it's ready to write.

Disabled unless `inbox_url` is set. See plans/SERVER-PLAN.md and pi/README.md.
"""

import json
import socket
import threading

import requests

from db import get_setting, set_setting
from ext_server import apply_payload, activity_types

DEFAULT_DRAIN_SECS = 120
STARTUP_DELAY_SECS = 5      # let the window come up before the first network hit
BATCH_LIMIT        = 500
TIMEOUT            = (4, 20)   # (connect, read)


def get_inbox_url():
    """Base URL of the inbox, or '' when the feature is off (the default)."""
    return get_setting("inbox_url", "").strip().rstrip("/")


def get_device_id():
    """Stable name for THIS machine, used to label payloads it produces.

    Nothing in M1-M3 sends payloads from the desktop — it only receives — so this
    is unused today. It exists because the GSM agent will need it, and because a
    device id that changes after the fact is worse than useless: it is what a
    remote machine's GSM game_ids get namespaced with. Persist it on first read
    so it can never drift."""
    did = get_setting("device_id", "").strip()
    if not did:
        try:
            did = socket.gethostname().strip().lower() or "desktop"
        except OSError:
            did = "desktop"
        set_setting("device_id", did)
    return did


class DrainLoop:
    """Background thread that drains the inbox on a timer.

    Unreachability is the normal case, not an error: the inbox is off, the wifi
    dropped, the URL is a typo. All of those are quiet — a noisy popup every two
    minutes would train the user to ignore it. `last_error` is kept for the
    Settings readout instead, which is where a persistently broken drain becomes
    visible.
    """

    def __init__(self, on_applied=None):
        self._on_applied = on_applied
        self._stop       = threading.Event()
        self._thread     = None
        self._lock       = threading.Lock()
        self.last_error  = ""
        self.last_ok     = ""
        self.last_applied_count = 0

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self):
        if get_inbox_url():
            print(f"[drain] Inbox at {get_inbox_url()} "
                  f"(every {self._interval()}s, resuming after id "
                  f"{self._high_water()})")
        self._thread = threading.Thread(target=self._run, daemon=True, name="inbox-drain")
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _interval(self):
        try:
            return max(15, int(get_setting("inbox_drain_secs", str(DEFAULT_DRAIN_SECS))))
        except ValueError:
            return DEFAULT_DRAIN_SECS

    def _run(self):
        self._stop.wait(STARTUP_DELAY_SECS)
        while not self._stop.is_set():
            # Re-read the URL every tick so switching it on in Settings takes
            # effect without a restart (unlike the ext-server bind, which owns a
            # socket and can't).
            if get_inbox_url():
                try:
                    self.drain_once()
                except Exception as e:                      # never kill the thread
                    self.last_error = str(e)
                    print(f"[drain] {e}")
            self._stop.wait(self._interval())

    # ── state ────────────────────────────────────────────────────────────────
    def _high_water(self):
        try:
            return int(get_setting("last_applied_inbox_id", "0") or 0)
        except ValueError:
            return 0

    # ── the drain ────────────────────────────────────────────────────────────
    def drain_once(self):
        """Fetch, apply, ack. Returns the number of payloads applied.

        Ordering is the whole correctness argument, so read it before changing it:

        1. Rows are applied in **id order**. The inbox hands them back that way and
           we must not reorder — a GSM payload is a cumulative snapshot, so for
           those last-write-wins is the intended semantics and only holds if the
           last write really is last.
        2. `last_applied_inbox_id` advances **after each row**, not after the
           batch. `import_ttsu_entries` de-dups a replay, but `log_manual_session`
           does not — a re-applied manual session double-counts. Per-row
           persistence shrinks the exposure to a crash landing between the session
           INSERT and the setting write. It does not close it; nothing short of a
           shared transaction would, and the import functions own their own
           connections.
        3. The `/ack` goes **last**, after everything is applied and persisted. Ack
           marks rather than deletes, so an ack that never lands is harmless — the
           high-water mark already stops us re-fetching. The reverse order is the
           one that loses data.
        """
        base  = get_inbox_url()
        if not base:
            return 0
        token = get_setting("ext_token", "")
        hdrs  = {"X-Tracker-Token": token}

        with self._lock:
            since = self._high_water()
            try:
                r = requests.get(f"{base}/inbox", params={"since": since, "limit": BATCH_LIMIT},
                                 headers=hdrs, timeout=TIMEOUT)
                r.raise_for_status()
                rows = (r.json() or {}).get("rows", [])
            except requests.exceptions.RequestException as e:
                # Unreachable is normal and quiet. Recorded, not surfaced.
                self.last_error = self._short_error(e)
                return 0

            applied  = 0
            highest  = since
            for row in rows:
                rid = int(row.get("id", 0))
                try:
                    body = json.loads(row.get("body_json") or "{}")
                    result, status = apply_payload(row.get("path", ""), body)
                    if status != 200:
                        # A payload this build can't understand must not wedge the
                        # queue behind it forever — skip past it, loudly.
                        print(f"[drain] skipping inbox #{rid}: "
                              f"{result.get('error', status)}")
                    elif result.get("error"):
                        print(f"[drain] inbox #{rid} rejected: {result['error']}")
                    else:
                        applied += 1
                except Exception as e:
                    print(f"[drain] inbox #{rid} failed to apply: {e}")
                highest = max(highest, rid)
                set_setting("last_applied_inbox_id", highest)

            if highest > since:
                try:
                    requests.post(f"{base}/ack", json={"through_id": highest},
                                  headers=hdrs, timeout=TIMEOUT)
                except requests.exceptions.RequestException:
                    pass   # already past it locally; the next ack covers it

            self.last_error = ""
            self.last_ok    = _now()
            self.last_applied_count = applied

        if applied:
            print(f"[drain] Applied {applied} queued session payload(s)")
            self._push_activity_types(base, hdrs)
            if self._on_applied:
                self._on_applied()
        return applied

    def _push_activity_types(self, base, hdrs):
        """Keep the inbox's /activity-types cache in step with our categories, so
        the extension's dropdown is identical whichever host it points at."""
        try:
            requests.post(f"{base}/activity-types", json={"types": activity_types()},
                          headers=hdrs, timeout=TIMEOUT)
        except requests.exceptions.RequestException:
            pass

    # ── status readout ───────────────────────────────────────────────────────
    def status(self):
        base = get_inbox_url()
        if not base:
            return {"enabled": False}
        out = {
            "enabled":         True,
            "url":             base,
            "last_applied_id": self._high_water(),
            "last_ok":         self.last_ok,
            "last_error":      self.last_error,
        }
        try:
            r = requests.get(f"{base}/pending", timeout=(3, 5))
            r.raise_for_status()
            p = r.json() or {}
            out.update(reachable=True, pending=p.get("count", 0),
                       oldest=p.get("oldest_received_at"))
        except requests.exceptions.RequestException as e:
            out.update(reachable=False, pending=None, oldest=None,
                       last_error=self._short_error(e))
        return out

    @staticmethod
    def _short_error(e):
        if isinstance(e, requests.exceptions.ConnectTimeout):
            return "timed out connecting"
        if isinstance(e, requests.exceptions.ConnectionError):
            return "could not connect"
        if isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
            if e.response.status_code == 403:
                return "rejected (token mismatch?)"
            return f"HTTP {e.response.status_code}"
        return str(e)[:120]


def _now():
    from datetime import datetime
    return datetime.now().isoformat(timespec="seconds")
