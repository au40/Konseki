"""
devlog.py  —  in-memory log capture for the Dev tab.

Tees sys.stdout/sys.stderr into a bounded ring buffer (plus a best-effort
per-run log file under DATA_DIR) so the app's print() diagnostics are visible
in-app — including under pythonw/frozen builds, where the real streams are
None and prints would otherwise vanish. Uncaught tracebacks arrive via the
default sys.excepthook/threading.excepthook writing to the teed stderr.
"""
import sys
import time
import logging
import threading
from collections import deque

_LOCK = threading.RLock()  # RLock: _Tee.write() holds it while calling _append()
_BUF = deque(maxlen=2000)
_SEQ = 0  # never resets — keeps incremental fetch valid across eviction and clear()
_LOGFILE = None


def _append(level, text):
    global _SEQ
    with _LOCK:
        _SEQ += 1
        _BUF.append({"seq": _SEQ, "ts": time.time(), "level": level, "text": text})
        if _LOGFILE is not None:
            try:
                _LOGFILE.write(f"{time.strftime('%H:%M:%S')} [{level}] {text}\n")
                _LOGFILE.flush()
            except Exception:
                pass


class _Tee:
    """stdout/stderr replacement; orig is None under pythonw/frozen console=False."""

    def __init__(self, orig, level):
        self._orig = orig
        self._level = level
        self._partial = ""

    def write(self, s):
        try:
            with _LOCK:
                if self._orig is not None:
                    try:
                        self._orig.write(s)
                    except Exception:
                        pass
                # print() issues separate write(text) / write("\n") calls:
                # buffer partials and emit only complete lines.
                self._partial += s
                while "\n" in self._partial:
                    line, self._partial = self._partial.split("\n", 1)
                    if line.strip():
                        _append(self._level, line)
        except Exception:
            pass
        return len(s)

    def flush(self):
        if self._orig is not None:
            try:
                self._orig.flush()
            except Exception:
                pass

    def isatty(self):
        return False


class _BufHandler(logging.Handler):
    """Catches logging-module output (pywebview js_api errors, watchdog warnings)."""

    def emit(self, record):
        try:
            level = "err" if record.levelno >= logging.ERROR else "info"
            _append(level, f"[{record.name}] {self.format(record)}")
        except Exception:
            pass


def install():
    """Idempotent; call at the top of main(), before anything prints."""
    global _LOGFILE
    if isinstance(sys.stdout, _Tee):
        return
    try:
        from db import DATA_DIR  # lazy: install() runs before init_db()
        DATA_DIR.mkdir(exist_ok=True)
        _LOGFILE = open(DATA_DIR / "konseki.log", "w", encoding="utf-8", errors="replace")
    except Exception:
        _LOGFILE = None  # file is forensics-only; never let it block capture
    sys.stdout = _Tee(sys.stdout, "info")
    sys.stderr = _Tee(sys.stderr, "err")
    handler = _BufHandler()
    handler.setLevel(logging.INFO)
    logging.getLogger().addHandler(handler)


def get_entries(after_seq=0):
    after = int(after_seq or 0)
    with _LOCK:
        return [e for e in _BUF if e["seq"] > after]


def clear():
    with _LOCK:
        _BUF.clear()
