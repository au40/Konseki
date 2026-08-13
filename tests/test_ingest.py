"""Network ingest: the shared applier, the drain loop's ordering guarantees,
and the auth boundary that moves when the server leaves loopback.

The capture-time trap is the reason most of this file exists. A payload can be
applied the instant it arrives or the next morning after sitting in the always-on
inbox, and it has to land identically either way. See plans/SERVER-PLAN.md.
"""
import json
import sqlite3
from datetime import datetime, timezone

import pytest

import db as dbm
import drain as drainm
import ext_server


def _rows(cols="session_date"):
    con = sqlite3.connect(dbm.DB_PATH)
    try:
        return con.execute(f"SELECT {cols} FROM sessions ORDER BY id").fetchall()
    finally:
        con.close()


def _last_date():
    con = sqlite3.connect(dbm.DB_PATH)
    try:
        r = con.execute("SELECT session_date FROM sessions ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        con.close()
    return r[0] if r else None


# ── logical_date_for ──────────────────────────────────────────────────────────
class TestLogicalDateFor:
    def test_matches_get_today_at_now(self, seed):
        seed.setting("rollover_hour", 4)
        assert dbm.logical_date_for(datetime.now()) == dbm.get_today()

    def test_before_rollover_belongs_to_previous_day(self, seed):
        seed.setting("rollover_hour", 4)
        assert dbm.logical_date_for(datetime(2026, 5, 14, 1, 0)) == "2026-05-13"

    def test_after_rollover_is_its_own_day(self, seed):
        seed.setting("rollover_hour", 4)
        assert dbm.logical_date_for(datetime(2026, 5, 14, 5, 0)) == "2026-05-14"

    def test_boundary_hour_is_its_own_day(self, seed):
        seed.setting("rollover_hour", 4)
        assert dbm.logical_date_for(datetime(2026, 5, 14, 4, 0)) == "2026-05-14"

    def test_rollover_zero_never_shifts(self, seed):
        seed.setting("rollover_hour", 0)
        assert dbm.logical_date_for(datetime(2026, 5, 14, 0, 30)) == "2026-05-14"


# ── apply_payload: the capture-time trap ──────────────────────────────────────
class TestManualCaptureTime:
    """The extension's timer posts elapsed seconds with NO session_date, so
    without captured_at the logical day would be decided by whenever the desktop
    happened to drain — moving a 01:00 session onto the wrong day."""

    def test_captured_before_rollover_lands_on_previous_day(self, seed):
        seed.setting("rollover_hour", 4)
        ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 600,
            "captured_at": "2026-05-14T01:00:00",
        })
        assert _last_date() == "2026-05-13"

    def test_captured_after_rollover_lands_on_its_own_day(self, seed):
        seed.setting("rollover_hour", 4)
        ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 600,
            "captured_at": "2026-05-14T05:00:00",
        })
        assert _last_date() == "2026-05-14"

    def test_applying_the_same_payload_twice_gives_the_same_date(self, seed):
        """The whole invariant: apply time must not enter the calculation. Two
        applies at different wall-clock moments (this test runs at 'now', the
        payload is dated months away) must agree."""
        seed.setting("rollover_hour", 4)
        body = {"activity_type": "Reading", "time_seconds": 60,
                "captured_at": "2026-05-14T01:00:00"}
        ext_server.apply_payload("/log-manual", body)
        first = _last_date()
        ext_server.apply_payload("/log-manual", body)
        assert _last_date() == first == "2026-05-13"

    def test_explicit_session_date_beats_captured_at(self, seed):
        seed.setting("rollover_hour", 4)
        ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 600,
            "captured_at": "2026-05-14T01:00:00", "session_date": "2026-01-01",
        })
        assert _last_date() == "2026-01-01"

    def test_tz_aware_captured_at_is_converted_to_local(self, seed):
        """The extension sends toISOString(), i.e. UTC with a Z. rollover_hour is
        a LOCAL hour, so the comparison is meaningless until it comes back."""
        seed.setting("rollover_hour", 4)
        local_1am = datetime(2026, 5, 14, 1, 0).astimezone()
        ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 600,
            "captured_at": local_1am.astimezone(timezone.utc)
                                    .isoformat().replace("+00:00", "Z"),
        })
        assert _last_date() == "2026-05-13"

    @pytest.mark.parametrize("bad", ["", "not-a-date", "2026-13-45T99:00:00", None])
    def test_unusable_captured_at_falls_back_to_today(self, seed, bad):
        seed.setting("rollover_hour", 0)
        ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 600, "captured_at": bad,
        })
        assert _last_date() == dbm.get_today()


class TestIdempotency:
    """A manual session has no natural key, so a retry is indistinguishable from
    a second session without one. These are the guarantees the client relies on."""

    def _log(self, seed, key, secs=600, date="2026-03-01", atype="Reading"):
        return ext_server.apply_payload("/log-manual", {
            "activity_type": atype, "time_seconds": secs,
            "session_date": date, "client_id": key,
        })[0]

    def test_the_same_key_twice_stores_one_row(self, seed):
        first  = self._log(seed, "abc-123")
        second = self._log(seed, "abc-123")
        assert first == {"logged": True}
        assert second == {"logged": True, "duplicate": True}
        assert len(_rows()) == 1

    def test_different_keys_store_separate_rows(self, seed):
        """Two genuinely separate identical sessions must BOTH be kept — that's
        why a natural key can't work here."""
        self._log(seed, "k1")
        self._log(seed, "k2")
        assert len(_rows()) == 2

    def test_a_duplicate_does_not_overwrite_the_original(self, seed):
        self._log(seed, "k1", secs=600)
        self._log(seed, "k1", secs=99999, date="2099-01-01")
        rows = _rows("session_date, time_seconds")
        assert rows == [("2026-03-01", 600.0)]

    def test_rows_without_a_key_never_collide(self, seed):
        """In-app logging and CSV import pass no key; NULL is outside the partial
        index, so identical rows must still all be stored."""
        for _ in range(3):
            ext_server.apply_payload("/log-manual", {
                "activity_type": "Reading", "time_seconds": 600,
                "session_date": "2026-03-01",
            })
        assert len(_rows()) == 3

    @pytest.mark.parametrize("blank", ["", "   ", None])
    def test_a_blank_key_is_treated_as_absent(self, seed, blank):
        for _ in range(2):
            ext_server.apply_payload("/log-manual", {
                "activity_type": "Reading", "time_seconds": 600,
                "session_date": "2026-03-01", "client_id": blank,
            })
        assert len(_rows()) == 2

    def test_a_key_does_not_bypass_validation(self, seed):
        res, _ = ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 0, "client_id": "k1",
        })
        assert res.get("error") and _rows() == []

    def test_the_key_does_not_leak_into_gsm_rows(self, seed):
        """The partial index spans the whole table. GSM rows carry NULL, so the
        one-row-per-(game_id, date) index is the only one that governs them."""
        seed.gsm(seed.day(0), chars=100, secs=60, game_id="g1")
        con = sqlite3.connect(dbm.DB_PATH)
        try:
            keys = con.execute(
                "SELECT DISTINCT client_id FROM sessions WHERE source='gsm'").fetchall()
        finally:
            con.close()
        assert keys == [(None,)]


class TestDrainReplayIsIdempotent:
    """The gap this closes: a crash landing between the session INSERT and the
    high-water-mark write replays one row on restart."""

    def test_replaying_a_manual_row_does_not_double_count(self, loop, monkeypatch):
        body = {"activity_type": "Reading", "time_seconds": 600,
                "session_date": "2026-03-01", "client_id": "replay-me"}
        fake = FakeInbox([_row(1, "/log-manual", body)])
        _wire(monkeypatch, fake)
        loop.drain_once()

        # Simulate the crash: the row was applied but the pointer never advanced.
        dbm.set_setting("last_applied_inbox_id", "0")
        loop.drain_once()

        assert len(_rows()) == 1

    def test_a_keyless_row_still_double_counts_on_replay(self, loop, monkeypatch):
        """Documents the remaining exposure honestly: older extension builds send
        no key, and nothing can dedup those."""
        body = {"activity_type": "Reading", "time_seconds": 600,
                "session_date": "2026-03-01"}
        fake = FakeInbox([_row(1, "/log-manual", body)])
        _wire(monkeypatch, fake)
        loop.drain_once()
        dbm.set_setting("last_applied_inbox_id", "0")
        loop.drain_once()
        assert len(_rows()) == 2

    def test_a_duplicate_still_counts_as_applied(self, loop, monkeypatch):
        """It must not look like a failure, or the drain would stall retrying."""
        body = {"activity_type": "Reading", "time_seconds": 600,
                "session_date": "2026-03-01", "client_id": "k1"}
        fake = FakeInbox([_row(1, "/log-manual", body)])
        _wire(monkeypatch, fake)
        loop.drain_once()
        dbm.set_setting("last_applied_inbox_id", "0")
        assert loop.drain_once() == 1
        assert dbm.get_setting("last_applied_inbox_id") == "1"


class TestApplyPayloadDispatch:
    def test_ttsu_entries_keep_their_own_datekey(self, seed):
        """ttsu payloads are already date-pinned per entry, so captured_at must
        not override them."""
        seed.setting("rollover_hour", 4)
        res, status = ext_server.apply_payload("/import", {
            "source": "ttsureader", "captured_at": "2026-05-14T01:00:00",
            "entries": [{"dateKey": "2026-02-02", "title": "B",
                         "charactersRead": 100, "readingTime": 60}],
        })
        assert status == 200 and res["imported"] == 1
        assert _last_date() == "2026-02-02"

    def test_unknown_source_is_rejected_not_applied(self, seed):
        res, status = ext_server.apply_payload("/import", {"source": "wat", "entries": []})
        assert status == 400 and "wat" in res["error"]
        assert _rows() == []

    def test_unknown_path_is_rejected(self, seed):
        _, status = ext_server.apply_payload("/nope", {})
        assert status == 404

    def test_device_id_is_accepted_and_ignored(self, seed):
        """It's in the contract for the GSM agent; it must not affect ttsu/manual."""
        _, status = ext_server.apply_payload("/log-manual", {
            "activity_type": "Reading", "time_seconds": 60,
            "session_date": "2026-03-03", "device_id": "laptop",
        })
        assert status == 200 and _last_date() == "2026-03-03"


# ── drain loop ────────────────────────────────────────────────────────────────
class FakeInbox:
    """Stands in for pi/inbox_server.py over requests. Records acks so the
    ordering guarantees can be asserted."""

    def __init__(self, rows):
        self.rows = rows
        self.acked = []
        self.pushed_types = None
        self.pushed_config = None
        self.push_count = 0         # how many times the caches were written
        self.fail_after = None      # apply this many rows, then raise on ack

    def get(self, url, params=None, headers=None, timeout=None):
        if url.endswith("/inbox"):
            since = int((params or {}).get("since", 0))
            rows = [r for r in self.rows if r["id"] > since]
            return _Resp({"rows": rows, "count": len(rows)})
        if url.endswith("/pending"):
            n = len([r for r in self.rows if r["id"] > max(self.acked, default=0)])
            return _Resp({"count": n, "oldest_received_at": None})
        raise AssertionError(url)

    def post(self, url, json=None, headers=None, timeout=None):
        if url.endswith("/ack"):
            self.acked.append(json["through_id"])
        elif url.endswith("/activity-types"):
            self.pushed_types = json["types"]
            self.push_count += 1
        elif url.endswith("/config"):
            self.pushed_config = json["config"]
        return _Resp({"ok": True})


class _Resp:
    def __init__(self, payload):
        self._p = payload
    def json(self):
        return self._p
    def raise_for_status(self):
        pass


def _row(rid, path, body):
    return {"id": rid, "path": path, "body_json": json.dumps(body)}


def _manual(secs, date):
    return {"activity_type": "Reading", "time_seconds": secs, "session_date": date}


@pytest.fixture
def loop(seed, monkeypatch):
    seed.setting("inbox_url", "http://inbox.test")
    seed.setting("ext_token", "t0ken")
    return drainm.DrainLoop()


def _wire(monkeypatch, fake):
    monkeypatch.setattr(drainm.requests, "get", fake.get)
    monkeypatch.setattr(drainm.requests, "post", fake.post)


class TestDrain:
    def test_applies_queued_rows_and_advances_high_water(self, loop, monkeypatch):
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01")),
                          _row(2, "/log-manual", _manual(120, "2026-03-02"))])
        _wire(monkeypatch, fake)
        assert loop.drain_once() == 2
        assert [r[0] for r in _rows()] == ["2026-03-01", "2026-03-02"]
        assert dbm.get_setting("last_applied_inbox_id") == "2"

    def test_a_second_drain_applies_nothing_and_does_not_duplicate(self, loop, monkeypatch):
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01"))])
        _wire(monkeypatch, fake)
        loop.drain_once()
        assert loop.drain_once() == 0
        assert len(_rows()) == 1

    def test_ack_is_sent_only_after_everything_is_applied(self, loop, monkeypatch):
        """Ack-after-apply. A crash before the ack costs a re-fetch that the
        high-water mark absorbs; the reverse order loses data outright."""
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01")),
                          _row(2, "/log-manual", _manual(60, "2026-03-02"))])
        seen = []
        real_post = fake.post
        def spy(url, json=None, headers=None, timeout=None):
            if url.endswith("/ack"):
                seen.append(len(_rows()))
            return real_post(url, json=json, headers=headers, timeout=timeout)
        monkeypatch.setattr(drainm.requests, "get", fake.get)
        monkeypatch.setattr(drainm.requests, "post", spy)
        loop.drain_once()
        assert seen == [2]                 # both rows were in the DB before the ack
        assert fake.acked == [2]

    def test_high_water_survives_a_lost_ack(self, loop, monkeypatch):
        """The inbox going away between apply and ack must not cause a replay —
        log_manual_session has no de-dup, so a replay double-counts."""
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01"))])
        def dead_post(url, json=None, headers=None, timeout=None):
            raise drainm.requests.exceptions.ConnectionError("gone")
        monkeypatch.setattr(drainm.requests, "get", fake.get)
        monkeypatch.setattr(drainm.requests, "post", dead_post)
        loop.drain_once()
        assert dbm.get_setting("last_applied_inbox_id") == "1"
        assert len(_rows()) == 1

    def test_a_bad_payload_does_not_wedge_the_queue_behind_it(self, loop, monkeypatch):
        fake = FakeInbox([_row(1, "/import", {"source": "unknown-future-thing"}),
                          _row(2, "/log-manual", _manual(60, "2026-03-02"))])
        _wire(monkeypatch, fake)
        assert loop.drain_once() == 1
        assert [r[0] for r in _rows()] == ["2026-03-02"]
        assert dbm.get_setting("last_applied_inbox_id") == "2"

    def test_rows_are_applied_in_id_order(self, loop, monkeypatch):
        """GSM payloads are cumulative snapshots, so last-write-wins only holds
        if the last write really is last."""
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01")),
                          _row(2, "/log-manual", _manual(60, "2026-03-02")),
                          _row(3, "/log-manual", _manual(60, "2026-03-03"))])
        _wire(monkeypatch, fake)
        loop.drain_once()
        assert [r[0] for r in _rows()] == ["2026-03-01", "2026-03-02", "2026-03-03"]

    def test_unreachable_inbox_is_quiet_and_changes_nothing(self, loop, monkeypatch):
        def dead(*a, **k):
            raise drainm.requests.exceptions.ConnectionError("no route")
        monkeypatch.setattr(drainm.requests, "get", dead)
        monkeypatch.setattr(drainm.requests, "post", dead)
        assert loop.drain_once() == 0
        assert _rows() == []
        assert loop.last_error == "could not connect"

    def test_no_inbox_url_means_no_network_at_all(self, seed, monkeypatch):
        seed.setting("inbox_url", "")
        def boom(*a, **k):
            raise AssertionError("drain must not touch the network when disabled")
        monkeypatch.setattr(drainm.requests, "get", boom)
        assert drainm.DrainLoop().drain_once() == 0

    def test_settings_are_pushed_even_when_nothing_was_applied(self, loop, monkeypatch):
        """This used to be gated on `applied > 0`, and that was circular once
        `rollover_hour` joined the payload: a device needs the rollover hour
        BEFORE its first post, because the capturer decides the date it sends.
        Waiting for a post to arrive means the value only lands after the
        payload that needed it."""
        fake = FakeInbox([])
        _wire(monkeypatch, fake)
        loop.drain_once()
        assert "Reading" in fake.pushed_types
        assert fake.pushed_config == {"rollover_hour": 0}

    def test_unchanged_settings_are_not_repushed(self, loop, monkeypatch):
        """Deduped against the last acknowledged copy, so draining every two
        minutes forever is one comparison and no traffic."""
        fake = FakeInbox([])
        _wire(monkeypatch, fake)
        loop.drain_once()
        loop.drain_once()
        loop.drain_once()
        assert fake.push_count == 1

    def test_a_changed_setting_is_pushed_again(self, loop, seed, monkeypatch):
        fake = FakeInbox([])
        _wire(monkeypatch, fake)
        loop.drain_once()
        seed.setting("rollover_hour", "4")
        loop.drain_once()
        assert fake.push_count == 2
        assert fake.pushed_config == {"rollover_hour": 4}

    def test_an_unreachable_inbox_retries_the_push(self, loop, monkeypatch):
        """A failed push must not record itself as done, or the inbox would sit
        on stale settings until the next time one of them changed."""
        fake = FakeInbox([])
        _wire(monkeypatch, fake)

        real_post = fake.post
        def flaky(url, **kw):
            if url.endswith("/config"):
                raise drainm.requests.exceptions.ConnectionError("no route")
            return real_post(url, **kw)
        fake.post = flaky
        loop.drain_once()

        fake.post = real_post
        loop.drain_once()
        assert fake.pushed_config == {"rollover_hour": 0}

    def test_status_reports_backlog_when_reachable(self, loop, monkeypatch):
        fake = FakeInbox([_row(1, "/log-manual", _manual(60, "2026-03-01"))])
        _wire(monkeypatch, fake)
        st = loop.status()
        assert st["enabled"] and st["reachable"] and st["pending"] == 1

    def test_status_is_disabled_without_a_url(self, seed):
        seed.setting("inbox_url", "")
        assert drainm.DrainLoop().status() == {"enabled": False}


class TestDeviceId:
    def test_is_persisted_on_first_read_so_it_cannot_drift(self, seed):
        first = drainm.get_device_id()
        assert first and dbm.get_setting("device_id") == first
        assert drainm.get_device_id() == first

    def test_an_existing_value_is_never_overwritten(self, seed):
        """It's what a remote machine's GSM game_ids get namespaced with — a
        device id that changes after the fact splits a title's history."""
        seed.setting("device_id", "laptop")
        assert drainm.get_device_id() == "laptop"


# ── auth boundary ─────────────────────────────────────────────────────────────
class _FakeHandler(ext_server._Handler):
    """Exercises the two checks that change meaning off loopback, without
    standing up a socket."""
    def __init__(self, lan, host, port=18463):
        self._lan = lan
        self.headers = {"Host": host}
        class _S:
            server_address = ("0.0.0.0", port)
        self.server = _S()


class TestAuthBoundary:
    @pytest.mark.parametrize("host,ok", [
        ("127.0.0.1:18463", True), ("localhost", True),
        ("192.168.1.50:18463", False), ("konseki.local:18463", False),
    ])
    def test_loopback_mode_keeps_the_strict_host_allowlist(self, host, ok):
        assert _FakeHandler(False, host)._host_ok() is ok

    @pytest.mark.parametrize("host,ok", [
        ("192.168.1.50:18463", True), ("konseki.local:18463", True),
        ("127.0.0.1:18463", True), ("konseki.local", True),
        ("192.168.1.50:9999", False),
    ])
    def test_lan_mode_degrades_to_a_port_check(self, host, ok):
        assert _FakeHandler(True, host)._host_ok() is ok

    def test_absent_origin_is_refused_on_loopback(self):
        """Today's behaviour, and why pull_from_ereader.py has to forge one."""
        assert _FakeHandler(False, "127.0.0.1")._origin_ok("") is False

    def test_absent_origin_is_accepted_on_lan(self):
        """A phone, the Boox, or curl send no Origin. The token is the control."""
        assert _FakeHandler(True, "192.168.1.50")._origin_ok("") is True

    @pytest.mark.parametrize("lan", [True, False])
    def test_browser_origins_are_allowed_either_way(self, lan):
        h = _FakeHandler(lan, "127.0.0.1")
        assert h._origin_ok("https://reader.ttsu.app") is True
        assert h._origin_ok("moz-extension://abc") is True

    @pytest.mark.parametrize("lan", [True, False])
    def test_a_hostile_origin_is_refused_either_way(self, lan):
        assert _FakeHandler(lan, "127.0.0.1")._origin_ok("https://evil.example") is False
