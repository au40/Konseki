"""Talking to Konseki. Stdlib only, and no Anki imports.

The wire contract is CLIENT-INTEGRATION.md in the repo root. The two rules that
shape this file:

**Rule 1 — the capturer decides the date.** `rollover_hour` comes from
`GET /config` and is cached; a failed fetch keeps the last known value and never
falls back to a default. Guessing zero when the user runs a rollover of 4 files
every late-night review under the wrong day, silently.

**Rule 3 — a 200 carrying `{"error": ...}` is a failure.** The status line alone
is not proof anything was stored. Every response goes through `_read`, which
folds both into one verdict so no caller can forget.

`urllib` rather than `requests`: Anki bundles requests today, but an addon that
depends on a host application's vendored packages breaks on the release that
drops one, and there is nothing here that needs more than urllib.
"""
import json
import urllib.error
import urllib.request

# Konseki's loopback listener 403s a request with NO Origin header: on
# 127.0.0.1 an allowed Origin is its "a browser on this machine sent this"
# check, and `_origin_ok` returns the lan flag when the header is absent. A
# non-browser client therefore cannot reach a default (loopback-only) install
# at all, whatever its token — the failure looks exactly like a bad token.
#
# So we present one, the same dodge `tools/pull_from_ereader.py` documents.
# This is not a security control being defeated: the check is explicitly
# documented as meaningless off-loopback, and the TOKEN is the real control on
# both paths. It just lets a local add-on reach a local tracker without asking
# the user to switch on LAN ingest, which would genuinely widen exposure.
ORIGIN = "moz-extension://konseki-anki"

TIMEOUT      = 20
POST_CHUNK   = 400          # must not exceed ANKI_MAX_DAYS in src/imports.py
DEFAULT_PORT = 18463


class TrackerError(Exception):
    """A post that did not store. Carries a message fit to show the user."""


class Tracker:
    """One configured endpoint. Cheap to construct; holds no socket."""

    def __init__(self, host, port, token, collection_tag=""):
        self.host  = (host or "127.0.0.1").strip() or "127.0.0.1"
        self.port  = int(port or DEFAULT_PORT)
        self.token = (token or "").strip()
        self.tag   = (collection_tag or "").strip()
        # Why the last fetch_rollover_hour failed. That call has to swallow its
        # exception (see below), which threw away the ONE thing the user needs:
        # a refused token and a stopped tracker are not the same problem.
        self.last_error = None

    # ── identity ──────────────────────────────────────────────────────────
    def client_id(self, date_str):
        """Collection-scoped, NOT device-scoped — the one place this inverts the
        YouTube tracker's rule.

        A browser only sees its own viewing, so two machines watching on one day
        must sum, and YouTube keys per device to let them. An Anki collection is
        *synced*: every device that opens it computes the same day totals from
        the same revlog. Keyed per device, a second desktop would insert a second
        row and double the day. Keyed per collection, it rewrites the first —
        which is what we want.

        `collection_tag` is empty by default and exists only for the "two
        separate collections feed one tracker" case.
        """
        return f"anki:{self.tag}:{date_str}" if self.tag else f"anki:{date_str}"

    # ── plumbing ──────────────────────────────────────────────────────────
    @property
    def base(self):
        return f"http://{self.host}:{self.port}"

    def _request(self, path, payload=None):
        if not self.token:
            raise TrackerError("No token set — paste it in the addon config.")
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="POST" if data else "GET")
        req.add_header("X-Tracker-Token", self.token)
        req.add_header("Origin", ORIGIN)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8") or "{}"
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise TrackerError("Rejected (403) — check the token.")
            if e.code == 415:
                raise TrackerError("Rejected (415) — content type.")
            raise TrackerError(f"HTTP {e.code} from {self.base}{path}.")
        except urllib.error.URLError as e:
            raise TrackerError(f"Could not reach {self.base} ({e.reason}).")
        try:
            return json.loads(raw)
        except ValueError:
            raise TrackerError("Response was not JSON.")

    @staticmethod
    def _read(body):
        """Rule 3. A 200 is not enough; the body decides."""
        if not isinstance(body, dict):
            raise TrackerError("Malformed response.")
        if body.get("error"):
            raise TrackerError(str(body["error"]))
        return body

    # ── endpoints ─────────────────────────────────────────────────────────
    def fetch_rollover_hour(self):
        """The one setting this device cannot derive on its own.

        Returns None on any failure, and the caller keeps its cached value. It
        must NOT return a default: falling back to 0 while the user runs 4 puts
        every post-midnight review on the wrong logical day, and nothing errors.
        """
        self.last_error = None
        try:
            body = self._request("/config")
        except TrackerError as e:
            self.last_error = str(e)
            return None
        try:
            hour = int(body.get("rollover_hour"))
        except (TypeError, ValueError):
            self.last_error = "Konseki did not report a rollover hour."
            return None
        if not 0 <= hour <= 23:
            self.last_error = f"Konseki reported an impossible rollover hour ({hour})."
            return None
        return hour

    def post_days(self, days, skip_vocab_days=None):
        """POST one batch of logical days. Raises TrackerError if it did not store.

        `skip_vocab_days` is tri-state and passed through untouched: None omits
        the key entirely, which is what tells the server "periodic push — leave
        an existing row's time_excluded alone". Coercing it to a bool here would
        let every push un-suppress a day the backfill had decided about.
        """
        payload = {"source": "anki", "days": days}
        if skip_vocab_days is not None:
            payload["skip_days_with_vocabulary_time"] = bool(skip_vocab_days)
        body = self._read(self._request("/import", payload))

        # The same request reaches two different servers, and they confirm
        # differently. The DESKTOP applies it now and answers `logged: true`
        # with counters. The INBOX only stores it — it has no database and no
        # idea what an Anki day is — and answers `queued: <rowid>`; the desktop
        # applies it whenever it next drains, possibly hours later.
        #
        # Both are success. Requiring `logged` made every post to the inbox look
        # like a failure, which is the one host the addon most needs to work
        # against when the desktop is asleep.
        if body.get("logged"):
            return body
        if body.get("queued") is not None:
            return {"queued": body["queued"]}
        raise TrackerError("Server did not confirm the post.")

    def post_all(self, days, skip_vocab_days=None, on_progress=None):
        """Chunked `post_days`. Returns the summed result across chunks.

        Chunks are applied independently, so a failure part-way leaves the
        earlier ones stored. That is safe rather than messy: every chunk is
        keyed and idempotent, so the retry re-sends the whole run and rewrites
        what already landed instead of duplicating it.
        """
        total = {"days": 0, "inserted": 0, "updated": 0, "deleted": 0,
                 "skipped_days": [], "queued": False}
        for i in range(0, len(days), POST_CHUNK):
            chunk = days[i:i + POST_CHUNK]
            body = self.post_days(chunk, skip_vocab_days)
            # A queued chunk carries no counters — nothing has been applied yet,
            # so there is nothing truthful to count. Say so rather than
            # reporting zeros as if the run had done nothing.
            if body.get("queued") is not None:
                total["queued"] = True
                total["days"] += len(chunk)
            else:
                for k in ("days", "inserted", "updated", "deleted"):
                    total[k] += int(body.get(k) or 0)
                total["skipped_days"].extend(body.get("skipped_days") or [])
            if on_progress:
                on_progress(min(i + POST_CHUNK, len(days)), len(days))
        return total
