"""
singleton.py  —  one Konseki per data directory.

Konseki lives in the tray, so it's easy to forget it's running and launch it
again (Konseki.vbs, the .exe, a pinned shortcut). Two processes sharing one
DATA_DIR is never benign: both auto-pull GSM, both roll backups, both truncate
konseki.log at startup, and they race on tracker.db and the ext-server port
(SO_REUSEADDR means the second bind *succeeds* on Windows, so the extension's
imports land in whichever process happens to win).

The lock is a named mutex (Windows) / flock (elsewhere) keyed on the resolved
DATA_DIR, so a `dev.ps1` run against dev-data/ still coexists with the real
app — what must not double up is a data folder, not the program. The OS drops
both lock kinds when the process dies, so a crash can never strand a stale
lock the user has to clear by hand.

Alongside the lock we publish DATA_DIR/konseki.lock (pid, a loopback port, a
token). A duplicate launch reads it, asks the running instance to show its
window — which is what the user actually wanted when they double-clicked — and
exits. That request is handled *inside* the running process so the window goes
through pywebview's own `window.show()`; poking its HWND from outside would
leave WinForms believing the window is still hidden, which deadens the close
button (it hides an already-hidden window).
"""

import ctypes
import json
import os
import secrets
import socket
import sys
import threading
import time
from hashlib import sha1

from db import APP_NAME, DATA_DIR

LOCK_FILE = DATA_DIR / "konseki.lock"

# Passed to the process spawned by the tray's Restart so it waits for the
# outgoing instance to drop the lock instead of bouncing off it.
RESTART_FLAG   = "--restarted"
HANDOFF_SECS   = 5.0

_ALREADY_EXISTS = 183  # ERROR_ALREADY_EXISTS
_IS_WIN         = sys.platform == "win32"


def _lock_key():
    """Stable id for this data dir, so dev-data/ and the real folder differ."""
    try:
        target = DATA_DIR.resolve()
    except OSError:
        target = DATA_DIR
    return sha1(str(target).lower().encode("utf-8")).hexdigest()[:16]


def _kernel32():
    # Explicit restype: HANDLE is 64-bit and ctypes' default c_int would
    # truncate it. use_last_error is what makes get_last_error() meaningful.
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    k.CreateMutexW.restype  = ctypes.c_void_p
    k.CloseHandle.argtypes  = [ctypes.c_void_p]
    k.CloseHandle.restype   = ctypes.c_int
    return k


class SingleInstance:
    """The run lock, plus the channel a duplicate uses to raise our window."""

    def __init__(self):
        self._mutex = None   # Windows mutex HANDLE
        self._fd    = None   # POSIX flock fd
        self._sock  = None   # loopback activation listener
        self._token = secrets.token_hex(8)
        self.port   = 0

    # ── Acquire / release ─────────────────────────────────────────────────────
    def acquire(self, timeout=0.0):
        """Take the lock and publish konseki.lock. False means another instance
        already owns this data dir. `timeout` covers the restart handoff."""
        deadline = time.monotonic() + timeout
        while True:
            if self._take_lock():
                self._open_listener()
                self._publish()
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    def _take_lock(self):
        if _IS_WIN:
            try:
                k      = _kernel32()
                handle = k.CreateMutexW(None, False, f"Local\\{APP_NAME}-{_lock_key()}")
                if not handle:
                    return True  # can't create it at all — never block the app
                if ctypes.get_last_error() == _ALREADY_EXISTS:
                    # Someone else owns the name; drop our reference or it
                    # would outlive their process.
                    k.CloseHandle(handle)
                    return False
                self._mutex = handle
                return True
            except Exception:
                return True
        try:
            import fcntl
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(DATA_DIR / ".konseki.flock"), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                return False
            self._fd = fd
            return True
        except Exception:
            return True

    def release(self):
        """Drop the lock. Call this before spawning a replacement process (tray
        Restart) — the OS would otherwise only release it at interpreter exit,
        after the new process has already tried to acquire."""
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None
        try:
            LOCK_FILE.unlink()
        except OSError:
            pass
        if self._mutex is not None:
            try:
                _kernel32().CloseHandle(self._mutex)
            except Exception:
                pass
            self._mutex = None
        if self._fd is not None:
            try:
                os.close(self._fd)  # closing the fd drops the flock
            except OSError:
                pass
            self._fd = None

    # ── "Show the running window" channel ────────────────────────────────────
    def _open_listener(self):
        """Bound during acquire(), before the slow startup work, so a duplicate
        launched mid-boot still connects — its ping waits in the backlog until
        serve() picks it up."""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            sock.listen(4)
            self._sock = sock
            self.port  = sock.getsockname()[1]
        except OSError as e:
            print(f"[single] activation listener unavailable: {e}")
            self._sock = None
            self.port  = 0

    def serve(self, on_activate):
        """Start answering pings by calling `on_activate()` — pass the window's
        show(). Safe to call from any thread, same as the tray's Open item."""
        if self._sock is None:
            return
        threading.Thread(target=self._accept_loop, args=(on_activate,),
                         daemon=True, name="single-instance").start()

    def _accept_loop(self, on_activate):
        want = f"show {self._token}".encode("utf-8")
        while True:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return  # socket closed by release()
            try:
                conn.settimeout(2.0)
                msg = conn.recv(64).strip()
            except OSError:
                msg = b""
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
            if not secrets.compare_digest(msg, want):
                continue
            # Never let a bad ping (or a console that can't encode our own log
            # line) kill the loop — that would silently stop answering launches.
            try:
                on_activate()
                print("[single] second launch: showed the existing window")
            except Exception as e:
                try:
                    print(f"[single] could not show window: {e}")
                except Exception:
                    pass

    def _publish(self):
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            LOCK_FILE.write_text(json.dumps({
                "pid":     os.getpid(),
                "port":    self.port,
                "token":   self._token,
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }), encoding="utf-8")
        except OSError as e:
            print(f"[single] could not write {LOCK_FILE.name}: {e}")


def ask_running_instance_to_show():
    """Ping whoever owns the lock. True means the request was delivered —
    fire-and-forget, since that process may still be booting and will answer
    once its window exists."""
    try:
        info  = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
        port  = int(info.get("port") or 0)
        token = str(info.get("token") or "")
    except (OSError, ValueError, TypeError):
        return False
    if not port or not token:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0) as conn:
            conn.sendall(f"show {token}".encode("utf-8"))
        return True
    except OSError:
        return False


def show_already_running_dialog():
    """Fallback when the running instance can't be reached (no lock file, or its
    listener never came up): say where it is, so a dead double-click isn't
    mistaken for a broken app."""
    msg = f"{APP_NAME} is already running.\n\nOpen it from the system tray icon."
    if _IS_WIN:
        try:
            # MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND
            ctypes.windll.user32.MessageBoxW(None, msg, APP_NAME, 0x40 | 0x10000)
            return
        except Exception:
            pass
    print(msg)
