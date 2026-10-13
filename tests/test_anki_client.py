"""The Anki addon's wire behaviour — CLIENT-INTEGRATION.md rules 1, 2 and 3.

No sockets and no Anki: `_request` is stubbed, so what is under test is the
contract handling rather than urllib.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anki" / "konseki_anki"))

import net as netmod
from net import Tracker, TrackerError


def _tk(**kw):
    kw.setdefault("host", "127.0.0.1")
    kw.setdefault("port", 18463)
    kw.setdefault("token", "t0ken")
    return Tracker(**kw)


class Fake(Tracker):
    """Records requests and replays canned responses."""

    def __init__(self, replies, **kw):
        super().__init__(kw.pop("host", "127.0.0.1"), kw.pop("port", 18463),
                         kw.pop("token", "t0ken"), kw.pop("collection_tag", ""))
        self.replies = list(replies)
        self.sent = []

    def _request(self, path, payload=None):
        self.sent.append((path, payload))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class TestClientId:
    def test_is_collection_scoped_not_device_scoped(self):
        """The inversion of the YouTube rule. A synced collection means every
        device computes the same totals, so they must REWRITE one row."""
        assert _tk().client_id("2026-05-13") == "anki:2026-05-13"

    def test_two_machines_produce_the_same_key(self):
        a = Tracker("127.0.0.1", 18463, "t")
        b = Tracker("192.168.1.9", 18463, "t")
        assert a.client_id("2026-05-13") == b.client_id("2026-05-13")

    def test_a_tag_scopes_a_second_collection(self):
        assert _tk(collection_tag="jp").client_id("2026-05-13") == "anki:jp:2026-05-13"


class TestRolloverFetch:
    def test_reads_the_hour(self):
        assert Fake([{"rollover_hour": 4}]).fetch_rollover_hour() == 4

    @pytest.mark.parametrize("reply", [
        {}, {"rollover_hour": None}, {"rollover_hour": "x"}, {"rollover_hour": 99},
        TrackerError("down"),
    ])
    def test_a_bad_or_failed_fetch_returns_none_never_a_default(self, reply):
        """Returning 0 here would file every late-night review under the wrong
        logical day, with nothing to show for it."""
        assert Fake([reply]).fetch_rollover_hour() is None

    def test_a_failure_records_WHY(self):
        """A refused token and a stopped tracker are not the same problem, and
        the backfill guard tells the user which. Swallowing the reason sent them
        to restart a tracker that was already running."""
        f = Fake([TrackerError("Rejected (403) - check the token.")])
        assert f.fetch_rollover_hour() is None
        assert "403" in f.last_error

    def test_a_success_clears_a_previous_error(self):
        f = Fake([TrackerError("down"), {"rollover_hour": 4}])
        f.fetch_rollover_hour()
        assert f.fetch_rollover_hour() == 4
        assert f.last_error is None

    def test_a_nonsense_hour_is_reported_not_silently_dropped(self):
        f = Fake([{"rollover_hour": 99}])
        assert f.fetch_rollover_hour() is None
        assert "99" in f.last_error


class TestPostDays:
    DAY = [{"session_date": "2026-05-13", "time_seconds": 60.0, "cards": 4}]

    def test_a_200_carrying_error_is_a_failure(self):
        """Rule 3 — the status line alone is not proof anything was stored."""
        with pytest.raises(TrackerError, match="bad date"):
            Fake([{"error": "bad date"}]).post_days(self.DAY)

    def test_a_200_without_logged_is_a_failure(self):
        with pytest.raises(TrackerError):
            Fake([{"days": 1}]).post_days(self.DAY)

    def test_a_confirmed_post_returns_the_body(self):
        out = Fake([{"logged": True, "days": 1, "inserted": 1}]).post_days(self.DAY)
        assert out["inserted"] == 1

    def test_no_token_refuses_before_the_socket(self):
        with pytest.raises(TrackerError, match="token"):
            Tracker("h", 1, "").post_days(self.DAY)

    def test_the_skip_flag_is_tri_state_on_the_wire(self):
        """Absent must stay absent: it is what tells the server to leave an
        existing row's time_excluded alone."""
        f = Fake([{"logged": True}] * 3)
        f.post_days(self.DAY)
        f.post_days(self.DAY, skip_vocab_days=True)
        f.post_days(self.DAY, skip_vocab_days=False)
        bodies = [p for _, p in f.sent]
        assert "skip_days_with_vocabulary_time" not in bodies[0]
        assert bodies[1]["skip_days_with_vocabulary_time"] is True
        assert bodies[2]["skip_days_with_vocabulary_time"] is False

    def test_the_inbox_queued_reply_is_a_SUCCESS(self):
        """The desktop applies and answers `logged`; the always-on inbox only
        stores and answers `queued`. Requiring `logged` made every post to the
        inbox look like a failure — the one host that matters most when the
        desktop is asleep."""
        out = Fake([{"ok": True, "queued": 17}]).post_days(self.DAY)
        assert out["queued"] == 17

    def test_a_reply_that_confirms_neither_is_a_failure(self):
        with pytest.raises(TrackerError):
            Fake([{"ok": True}]).post_days(self.DAY)

    def test_every_post_names_the_source(self):
        f = Fake([{"logged": True}])
        f.post_days(self.DAY)
        assert f.sent[0][0] == "/import"
        assert f.sent[0][1]["source"] == "anki"


class TestOriginHeader:
    """Konseki's loopback listener 403s a request with no Origin, whatever the
    token. Without this the add-on could not reach a default install at all,
    and the failure was indistinguishable from a bad token."""

    def test_the_origin_passes_konsekis_loopback_check(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        import ext_server as es
        assert es._is_extension_origin(netmod.ORIGIN)

    def test_every_request_carries_it(self):
        sent = {}
        import urllib.request
        real = urllib.request.Request

        class CapturingRequest(real):
            def add_header(self, k, v):
                sent[k] = v
                return real.add_header(self, k, v)

        urllib.request.Request = CapturingRequest
        try:
            tk = Tracker("127.0.0.1", 18463, "t0ken")
            try:
                tk.fetch_rollover_hour()      # will fail to connect; headers set first
            except Exception:
                pass
        finally:
            urllib.request.Request = real
        assert sent.get("Origin") == netmod.ORIGIN
        assert sent.get("X-Tracker-Token") == "t0ken"


class TestPostAll:
    def _days(self, n):
        return [{"session_date": f"2026-05-{i % 28 + 1:02d}", "time_seconds": 1.0,
                 "cards": 1} for i in range(n)]

    def test_chunks_at_the_servers_batch_limit(self):
        n = netmod.POST_CHUNK * 2 + 5
        f = Fake([{"logged": True, "days": 0}] * 3)
        f.post_all(self._days(n))
        assert [len(p["days"]) for _, p in f.sent] == \
               [netmod.POST_CHUNK, netmod.POST_CHUNK, 5]

    def test_sums_the_results_across_chunks(self):
        f = Fake([
            {"logged": True, "days": 2, "inserted": 2, "skipped_days": ["a"]},
            {"logged": True, "days": 1, "updated": 1, "skipped_days": ["b"]},
        ])
        out = f.post_all(self._days(netmod.POST_CHUNK + 1))
        assert out["days"] == 3
        assert out["inserted"] == 2 and out["updated"] == 1
        assert out["skipped_days"] == ["a", "b"]

    def test_queued_chunks_report_queued_and_do_not_fake_counters(self):
        """An inbox has no database and cannot say what was inserted. Counting
        its absent fields as zeros would claim the run did nothing."""
        f = Fake([{"ok": True, "queued": 1}, {"ok": True, "queued": 2}])
        out = f.post_all(self._days(netmod.POST_CHUNK + 3))
        assert out["queued"] is True
        assert out["days"] == netmod.POST_CHUNK + 3
        assert out["inserted"] == 0 and out["skipped_days"] == []

    def test_a_desktop_run_is_not_marked_queued(self):
        out = Fake([{"logged": True, "days": 1, "inserted": 1}]).post_all(self._days(1))
        assert out["queued"] is False and out["inserted"] == 1

    def test_a_failing_chunk_stops_and_raises(self):
        f = Fake([{"logged": True, "days": 1}, {"error": "nope"}])
        with pytest.raises(TrackerError):
            f.post_all(self._days(netmod.POST_CHUNK + 1))

    def test_the_chunk_size_does_not_exceed_the_servers_limit(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        import imports as im
        assert netmod.POST_CHUNK <= im.ANKI_MAX_DAYS
