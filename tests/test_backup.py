"""Offsite backup copy.

Two halves, tested against each other rather than against mocks where it's
cheap to do so: pi/inbox_server.py stores dated copies of the desktop's daily
zip, and src/backup.py pushes them.

The security-shaped assertions here are load-bearing, not box-ticking. The whole
design rests on the inbox being *write-only over HTTP* — a backup can be given
to it and listed, never read back — because KONSEKI_TOKEN is copied onto every
device that posts sessions and each needs only "append a session". A download
route behind that token would hand a lost e-reader the entire database. So
"there is no such route" is asserted, not merely intended.
"""
import hashlib
import io
import os
import shutil
import socket
import sys
import threading
import time
import zipfile
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pi"))
import inbox_server as ibx                                       # noqa: E402

TOKEN = "test-token-abc123"
HDRS  = {"X-Tracker-Token": TOKEN}


def _zip_bytes(payload=b"pretend this is tracker.db"):
    """A real, openable zip — so `zipfile.testzip()` on the stored copy is a
    genuine integrity check rather than a length comparison."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("tracker.db", payload)
        zf.writestr("catalog.db", b"ledger")
    return buf.getvalue()


@pytest.fixture
def inbox(tmp_path):
    """A real inbox_server on an ephemeral port, mirroring main()'s wiring."""
    db_path    = tmp_path / "inbox.db"
    backup_dir = tmp_path / "backups"
    store      = ibx.BackupStore(str(backup_dir), keep=3)
    queue      = ibx.Inbox(str(db_path))
    handler    = type("H", (ibx._Handler,),
                      {"inbox": queue, "backups": store, "token": TOKEN})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        yield type("Ctx", (), {"base": base, "dir": backup_dir, "store": store})
    finally:
        srv.shutdown()
        srv.server_close()
        queue.close()


def _push(base, data, sha=True, extra_headers=None):
    hdrs = dict(HDRS)
    hdrs["Content-Type"] = "application/zip"
    if sha:
        hdrs["X-Backup-Sha256"] = hashlib.sha256(data).hexdigest()
    hdrs.update(extra_headers or {})
    return requests.post(f"{base}/backup", data=data, headers=hdrs, timeout=10)


# ── storing ───────────────────────────────────────────────────────────────────
class TestStore:
    def test_pushed_backup_lands_and_still_opens(self, inbox):
        """The stored copy must be a working zip, not merely a file of the right
        size. Nothing can read it back over HTTP to check, so this is the only
        place that verification can happen."""
        data = _zip_bytes()
        r = _push(inbox.base, data)
        assert r.status_code == 200 and r.json()["ok"] is True

        stored = list(inbox.dir.glob("konseki_*.zip"))
        assert len(stored) == 1
        assert stored[0].read_bytes() == data
        with zipfile.ZipFile(stored[0]) as zf:
            assert zf.testzip() is None
            assert sorted(zf.namelist()) == ["catalog.db", "tracker.db"]

    def test_name_is_server_derived_from_the_date(self, inbox):
        _push(inbox.base, _zip_bytes())
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        assert (inbox.dir / f"konseki_{today}.zip").exists()

    def test_same_day_push_replaces_rather_than_accumulates(self, inbox):
        _push(inbox.base, _zip_bytes(b"first"))
        _push(inbox.base, _zip_bytes(b"second"))
        stored = list(inbox.dir.glob("konseki_*.zip"))
        assert len(stored) == 1, "one backup per calendar day"
        with zipfile.ZipFile(stored[0]) as zf:
            assert zf.read("tracker.db") == b"second"

    def test_a_push_leaves_no_part_file_behind(self, inbox):
        _push(inbox.base, _zip_bytes())
        assert not list(inbox.dir.glob("*.part"))


# ── the filename is ours, never the client's ──────────────────────────────────
class TestFilenameIsNotClientControlled:
    @pytest.mark.parametrize("hostile", [
        "../../../../etc/cron.d/pwn",
        "/etc/passwd",
        "..\\..\\windows\\system32\\evil.zip",
        "konseki_2099-01-01.zip",
    ])
    def test_headers_cannot_steer_where_the_file_lands(self, inbox, hostile):
        """The client supplies bytes and nothing else. Every header a caller
        might hope is a filename is ignored, so traversal has no surface to
        attack — there is no request-supplied name read anywhere."""
        _push(inbox.base, _zip_bytes(), extra_headers={
            "X-Filename":          hostile,
            "X-Backup-Name":       hostile,
            "Content-Disposition": f'attachment; filename="{hostile}"',
        })
        today  = datetime.now().astimezone().strftime("%Y-%m-%d")
        stored = [p.name for p in inbox.dir.iterdir() if p.is_file()]
        assert stored == [f"konseki_{today}.zip"]

    def test_query_string_cannot_steer_it_either(self, inbox):
        data = _zip_bytes()
        hdrs = dict(HDRS)
        hdrs["Content-Type"]    = "application/zip"
        hdrs["X-Backup-Sha256"] = hashlib.sha256(data).hexdigest()
        r = requests.post(f"{inbox.base}/backup?name=../../evil.zip",
                          data=data, headers=hdrs, timeout=10)
        assert r.status_code == 200
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        assert [p.name for p in inbox.dir.iterdir()] == [f"konseki_{today}.zip"]


# ── write-only: the design decision this suite exists to protect ──────────────
class TestNoDownloadRoute:
    def test_backup_contents_are_not_served(self, inbox):
        """If this ever starts passing a 200, the privilege-scope argument in
        BackupStore's docstring has been quietly undone. KONSEKI_TOKEN lives on
        every capturing device; it must not unlock the whole database."""
        _push(inbox.base, _zip_bytes())
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        for path in (f"/backups/konseki_{today}.zip",
                     "/backups/../inbox.db",
                     "/backup/konseki_%s.zip" % today):
            r = requests.get(f"{inbox.base}{path}", headers=HDRS, timeout=10)
            assert r.status_code == 404, f"{path} must not serve contents"

    def test_listing_is_metadata_only(self, inbox):
        data = _zip_bytes(b"secret reading history")
        _push(inbox.base, data)
        r = requests.get(f"{inbox.base}/backups", headers=HDRS, timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        row = body["backups"][0]
        assert set(row) == {"name", "bytes", "mtime"}
        assert row["bytes"] == len(data)
        assert b"secret reading history" not in r.content

    def test_listing_and_push_both_need_the_token(self, inbox):
        assert requests.get(f"{inbox.base}/backups", timeout=10).status_code == 403
        r = requests.post(f"{inbox.base}/backup", data=_zip_bytes(),
                          headers={"Content-Type": "application/zip"}, timeout=10)
        assert r.status_code == 403
        assert not list(inbox.dir.glob("*.zip"))


# ── integrity: a bad upload must never cost a good generation ─────────────────
class TestIntegrity:
    def test_hash_mismatch_is_rejected_and_nothing_is_stored(self, inbox):
        data = _zip_bytes()
        r = requests.post(
            f"{inbox.base}/backup", data=data,
            headers={**HDRS, "Content-Type": "application/zip",
                     "X-Backup-Sha256": hashlib.sha256(b"different").hexdigest()},
            timeout=10)
        assert r.status_code == 400
        assert not list(inbox.dir.glob("*.zip"))
        assert not list(inbox.dir.glob("*.part"))

    def test_a_rejected_push_leaves_existing_generations_intact(self, inbox):
        """The nightmare this ordering exists to prevent: a truncated upload
        that stores cleanly and prunes a good copy to make room."""
        for day in ("2026-08-10", "2026-08-11", "2026-08-12"):
            (inbox.dir).mkdir(exist_ok=True)
            (inbox.dir / f"konseki_{day}.zip").write_bytes(_zip_bytes(day.encode()))
        before = {p.name: p.read_bytes() for p in inbox.dir.glob("*.zip")}

        requests.post(
            f"{inbox.base}/backup", data=_zip_bytes(),
            headers={**HDRS, "Content-Type": "application/zip",
                     "X-Backup-Sha256": "0" * 64},
            timeout=10)

        after = {p.name: p.read_bytes() for p in inbox.dir.glob("*.zip")}
        assert after == before

    def test_oversize_push_is_refused(self, inbox, monkeypatch):
        monkeypatch.setattr(ibx, "MAX_BACKUP_BYTES", 100)
        r = _push(inbox.base, _zip_bytes(b"x" * 5000))
        assert r.status_code == 413
        assert not list(inbox.dir.glob("*.zip"))


# ── retention ─────────────────────────────────────────────────────────────────
class TestPrune:
    def test_prune_keeps_the_newest_and_drops_the_oldest(self, inbox):
        inbox.dir.mkdir(exist_ok=True)
        for day in ("2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"):
            (inbox.dir / f"konseki_{day}.zip").write_bytes(b"old")
        _push(inbox.base, _zip_bytes())          # keep=3 on the fixture

        names = sorted(p.name for p in inbox.dir.glob("*.zip"))
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        assert len(names) == 3
        assert f"konseki_{today}.zip" in names, "today's push must survive its own prune"
        assert "konseki_2026-08-01.zip" not in names, "oldest goes first"

    def test_prune_ignores_files_it_did_not_write(self, inbox):
        inbox.dir.mkdir(exist_ok=True)
        (inbox.dir / "notes.txt").write_text("leave me alone")
        for day in ("2026-08-01", "2026-08-02", "2026-08-03"):
            (inbox.dir / f"konseki_{day}.zip").write_bytes(b"old")
        _push(inbox.base, _zip_bytes())
        assert (inbox.dir / "notes.txt").exists()


# ── the desktop half, driven against a real inbox ─────────────────────────────
import backup as bkp                                            # noqa: E402


@pytest.fixture
def desktop(seed, inbox):
    """A clean DB pointed at the live inbox fixture, with today's zip made."""
    bkp._last_push_error = ""
    seed.setting("ext_token", TOKEN)
    seed.setting("inbox_url", inbox.base)
    if bkp.BACKUP_DIR.exists():
        shutil.rmtree(bkp.BACKUP_DIR)
    bkp.make_backup()
    return inbox


def _make_local(date, payload=b"x"):
    """Plant a dated zip in the desktop's own backups/ folder."""
    bkp.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    p = bkp.BACKUP_DIR / f"immersion_{date}.zip"
    p.write_bytes(_zip_bytes(payload))
    return p


def _dead_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{s.getsockname()[1]}"


class TestDesktopPush:
    def test_the_pushed_zip_lands_and_opens_on_the_inbox(self, desktop):
        """End to end: the desktop's own daily zip, through HTTP, onto the
        inbox's disk, still a working archive containing both databases."""
        assert bkp.push_backups_if_due() == 1

        stored = list(desktop.dir.glob("konseki_*.zip"))
        assert len(stored) == 1
        with zipfile.ZipFile(stored[0]) as zf:
            assert zf.testzip() is None
            assert "tracker.db" in zf.namelist()

    def test_it_pushes_once_per_day_not_every_tick(self, desktop, db):
        assert bkp.push_backups_if_due() == 1
        assert db.get_setting("last_backup_pushed_date", "") != ""
        assert bkp.push_backups_if_due() == 0, "second tick has nothing to send"
        assert len(list(desktop.dir.glob("konseki_*.zip"))) == 1

    def test_an_unreachable_inbox_is_quiet_and_the_next_tick_retries(
            self, desktop, db, seed):
        """THE claim the design rests on. A push wired into make_backup() would
        fire once and never again; re-reading the inbox's listing each tick means
        the same day's zip goes as soon as the inbox comes back."""
        seed.setting("inbox_url", _dead_url())

        assert bkp.push_backups_if_due() == 0
        assert db.get_setting("last_backup_pushed_date", "") == "", \
            "a failed push must not record success"
        assert bkp._last_push_error, "the failure is recorded for Settings"

        seed.setting("inbox_url", desktop.base)     # inbox comes back
        assert bkp.push_backups_if_due() == 1
        assert len(list(desktop.dir.glob("konseki_*.zip"))) == 1
        assert bkp._last_push_error == ""

    def test_no_inbox_url_means_no_network_at_all(self, desktop, seed, monkeypatch):
        seed.setting("inbox_url", "")

        def _boom(*a, **k):
            raise AssertionError("must not touch the network with no inbox_url")
        monkeypatch.setattr(bkp.requests, "post", _boom)
        monkeypatch.setattr(bkp.requests, "get", _boom)
        assert bkp.push_backups_if_due() == 0

    def test_a_rejected_push_is_not_recorded_as_success(
            self, desktop, db, monkeypatch):
        """A 200 carrying {"ok": false} is a failure. Recording it would strand
        that day's backup on this machine forever."""
        def _refuse(*a, **k):
            raise ValueError("disk full")
        monkeypatch.setattr(desktop.store, "store", _refuse)

        assert bkp.push_backups_if_due() == 0
        assert db.get_setting("last_backup_pushed_date", "") == ""
        assert bkp._last_push_error

    def test_nothing_to_push_when_there_are_no_local_zips(self, desktop, seed):
        shutil.rmtree(bkp.BACKUP_DIR)
        assert bkp.push_backups_if_due() == 0


# ── backfill: a fresh or rebuilt inbox catches up at once ─────────────────────
class TestBackfill:
    def test_an_empty_inbox_receives_the_whole_local_folder(self, desktop):
        """The cold start. Seven good zips already exist here; an inbox that has
        to accrue them one a day holds LESS history than the drive it insures
        for a week. Matters most after the inbox is rebuilt — a dead SD card
        would otherwise reset the offsite history to nothing, silently."""
        for d in ("2026-08-15", "2026-08-16"):       # + today = 3, the keep limit
            _make_local(d, d.encode())

        sent = bkp.push_backups_if_due()
        assert sent == 3, "two backfilled plus today's"

        names = sorted(p.name for p in desktop.dir.glob("konseki_*.zip"))
        assert "konseki_2026-08-15.zip" in names
        assert "konseki_2026-08-16.zip" in names
        # Each landed under ITS OWN date, not all under today's — which is the
        # entire reason X-Backup-Date exists.
        with zipfile.ZipFile(desktop.dir / "konseki_2026-08-15.zip") as zf:
            assert zf.read("tracker.db") == b"2026-08-15"

    def test_a_backfill_larger_than_retention_keeps_the_newest(self, desktop):
        """The desktop holds 7 and the inbox keeps 30 in real life, so this
        can't bite — but the ordering has to be right regardless, or a backfill
        would leave the OLDEST copies and prune the useful ones."""
        for d in ("2026-08-11", "2026-08-12", "2026-08-13",
                  "2026-08-14", "2026-08-15"):
            _make_local(d, d.encode())

        bkp.push_backups_if_due()
        names = sorted(p.name for p in desktop.dir.glob("konseki_*.zip"))
        today = datetime.now().strftime("%Y-%m-%d")
        assert len(names) == 3, "fixture keeps 3"
        assert names[-1] == f"konseki_{today}.zip"
        assert "konseki_2026-08-11.zip" not in names, "oldest dropped, not newest"

    def test_only_the_gaps_are_sent(self, desktop):
        _make_local("2026-08-14")
        _make_local("2026-08-15")
        bkp.push_backups_if_due()
        assert bkp.push_backups_if_due() == 0, "a second pass has nothing to do"

        _make_local("2026-08-13")        # an older one appears
        assert bkp.push_backups_if_due() == 1

    def test_an_unreachable_inbox_is_not_mistaken_for_an_empty_one(
            self, desktop, seed, monkeypatch):
        """"Don't know" must never read as "has nothing" — otherwise every tick
        against a sleeping inbox would queue a full re-upload."""
        _make_local("2026-08-14")
        seed.setting("inbox_url", _dead_url())

        posts = []
        real_post = bkp.requests.post
        monkeypatch.setattr(bkp.requests, "post",
                            lambda *a, **k: posts.append(a) or real_post(*a, **k))
        assert bkp.push_backups_if_due() == 0
        assert posts == [], "no uploads attempted when the listing is unknown"

    def test_an_existing_generation_is_never_overwritten(self, inbox, desktop):
        """The rule that makes a client-supplied date acceptable: an empty slot
        has nothing to lose, but a filled past slot is immutable. Without it a
        stolen token could destroy every generation one at a time."""
        inbox.dir.mkdir(exist_ok=True)
        (inbox.dir / "konseki_2026-08-14.zip").write_bytes(b"ORIGINAL")

        r = _push(inbox.base, _zip_bytes(b"replacement"),
                  extra_headers={"X-Backup-Date": "2026-08-14"})
        assert r.status_code == 409
        assert (inbox.dir / "konseki_2026-08-14.zip").read_bytes() == b"ORIGINAL"

    def test_todays_slot_stays_writable(self, inbox):
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        _push(inbox.base, _zip_bytes(b"first"))
        r = _push(inbox.base, _zip_bytes(b"second"),
                  extra_headers={"X-Backup-Date": today})
        assert r.status_code == 200
        with zipfile.ZipFile(inbox.dir / f"konseki_{today}.zip") as zf:
            assert zf.read("tracker.db") == b"second"


class TestDateValidation:
    @pytest.mark.parametrize("bad", [
        "../../etc/passwd",
        "2026-08-14/../../evil",
        "2026-8-4",
        "not-a-date",
        "2026-13-01",
        "2026-02-30",
        "0000-00-00",
    ])
    def test_a_date_that_is_not_a_date_is_refused(self, inbox, bad):
        r = _push(inbox.base, _zip_bytes(), extra_headers={"X-Backup-Date": bad})
        assert r.status_code == 400
        assert not list(inbox.dir.glob("*.zip"))

    def test_a_future_date_is_refused(self, inbox):
        """A future name sorts newest forever: it would survive every prune and
        quietly evict real backups from the retention window."""
        r = _push(inbox.base, _zip_bytes(),
                  extra_headers={"X-Backup-Date": "2099-01-01"})
        assert r.status_code == 400
        assert not list(inbox.dir.glob("*.zip"))

    def test_an_absent_date_still_means_today(self, inbox):
        _push(inbox.base, _zip_bytes())
        today = datetime.now().astimezone().strftime("%Y-%m-%d")
        assert (inbox.dir / f"konseki_{today}.zip").exists()


class TestPushStatus:
    def test_status_is_disabled_without_an_inbox(self, seed):
        seed.setting("inbox_url", "")
        assert bkp.push_status() == {"enabled": False}

    def test_status_reports_the_inbox_holdings(self, desktop):
        bkp.push_backups_if_due()
        st = bkp.push_status()
        assert st["enabled"] and st["reachable"] is True
        assert st["count"] == 1
        assert st["newest"].startswith("konseki_")
        assert st["last_pushed"] == datetime.now().strftime("%Y-%m-%d")

    def test_status_survives_an_unreachable_inbox(self, desktop, seed):
        seed.setting("inbox_url", _dead_url())
        st = bkp.push_status()
        assert st["enabled"] is True and st["reachable"] is False
        assert st["count"] is None
