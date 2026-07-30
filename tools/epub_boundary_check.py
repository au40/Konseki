"""Diagnose EPUB chapter-boundary drift.

Prints where the app thinks each chapter boundary sits (the compacted axis
imports._epub_finalize writes) and, if you tell it where you ACTUALLY were,
decomposes the difference into a constant offset and a proportional one.

That decomposition is the whole point. The two causes need different fixes and
look identical from a single boundary:

  constant     — text in the axis you never read (front matter, an unskipped
                 section). Fix: mark it skip in the import checklist.
  proportional — our character counter and your reader's disagree on what
                 counts. Fix: a per-title calibration ratio; no amount of
                 section-skipping helps.

Usage
  python tools/epub_boundary_check.py BOOK.epub
  python tools/epub_boundary_check.py BOOK.epub --drift 450 619 492
  python tools/epub_boundary_check.py BOOK.epub --observed 9550 19880 29610

Give it EITHER form, for chapter 1, 2, 3 … in reading order:

  --drift     how far off the app was when you actually finished the chapter —
              i.e. how many more chars it still thought the chapter had
  --observed  the raw chars-read number the app showed at that moment

Two or more values; the more you give, the tighter the fit. Use `-` for a
boundary you didn't note.
"""

import argparse
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import imports  # noqa: E402


def load(path):
    with open(path, "rb") as fh:
        res = imports.extract_epub(fh.read())
    if not res.get("ok"):
        sys.exit(f"Could not read EPUB: {res.get('error')}")
    return res


# The sub-ranges that make up imports._TTSU_KEEP, named. A PROPORTIONAL verdict
# means our counter includes something the reader's doesn't; if exactly one class
# here is the size of the drift, that class IS the disagreement, and dropping it
# from _TTSU_KEEP fixes every book at once instead of per-title calibration.
_CLASSES = [
    ("kanji",           r"[㐀-䶿一-鿿]"),
    ("hiragana",        r"[ぁ-ゖ]"),
    ("katakana",        r"[ァ-ヺ]"),
    ("ー  chōonpu",     r"[ー]"),
    ("ASCII alnum",     r"[0-9A-Za-z]"),
    ("fullwidth alnum", r"[０-９Ａ-Ｚａ-ｚ]"),
    ("々〆〇〻",         r"[々-〇〻]"),
    ("○◯",             r"[○◯]"),
    ("ゝゞ",             r"[ゝ-ゞ]"),
    ("halfwidth kana",  r"[ｦ-ﾝ]"),
    ("CJK radicals",    r"[⺀-⻳⼀-⿕]"),
    ("SIP ideographs",  "[\U00020000-\U0002EBEF\U00030000-\U000323AF]"),
]


def class_breakdown(path):
    """Count each character class over the book's whole counted text."""
    with zipfile.ZipFile(io.BytesIO(open(path, "rb").read())) as zf:
        text = []
        for name in zf.namelist():
            if name.lower().endswith((".xhtml", ".html", ".htm")):
                try:
                    text.append(imports._ttsu_clean(
                        zf.read(name).decode("utf-8", "replace")))
                except Exception:
                    continue
    joined = "".join(text)
    total = len(imports._TTSU_STRIP_RE.sub("", joined))
    return total, [(n, len(re.findall(p, joined))) for n, p in _CLASSES]


def report_classes(path, target_pct=None):
    total, counts = class_breakdown(path)
    if not total:
        print("\n  No counted text found.")
        return
    print(f"\n  Character classes we count  (total {total:,})")
    print(f"  {'class':<18}{'chars':>10}{'share':>9}")
    for name, n in sorted(counts, key=lambda kv: -kv[1]):
        if not n:
            continue
        print(f"  {name:<18}{n:>10,}{n / total * 100:>8.2f}%")

    if target_pct is None:
        return
    # A class either accounts for the drift or it doesn't, so keep this tight:
    # ~15% relative (the slope estimate's own noise off a handful of boundaries),
    # never wider than a full percentage point.
    tol = min(1.0, max(0.1, target_pct * 0.15))
    print(f"\n  Looking for a class worth ~{target_pct:.2f}% of the total "
          f"(±{tol:.2f}):")
    hits = [(n, c) for n, c in counts
            if c and abs(c / total * 100 - target_pct) < tol]
    if hits:
        for name, c in hits:
            print(f"    {name} = {c / total * 100:.2f}%  <- candidate; try dropping it "
                  f"from _TTSU_KEEP")
    else:
        print("    no single class matches — the disagreement isn't one character")
        print("    class, so a per-title calibration ratio is the right fix.")


def fit(xs, ys):
    """Least-squares slope/intercept of ys on xs. Returns (slope, intercept)."""
    n = len(xs)
    if n < 2:
        return 1.0, (ys[0] - xs[0]) if n else 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    var = sum((x - mx) ** 2 for x in xs)
    if var == 0:
        return 1.0, my - mx
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / var
    return slope, my - slope * mx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("epub")
    ap.add_argument("--observed", nargs="*", default=[],
                    help="app chars-read at each true chapter end; '-' to skip one")
    ap.add_argument("--drift", nargs="*", default=[],
                    help="chars the app was still short by at each true chapter "
                         "end; '-' to skip one")
    ap.add_argument("--classes", action="store_true",
                    help="break the book down by character class (use after a "
                         "PROPORTIONAL verdict to find which class disagrees)")
    args = ap.parse_args()
    if args.observed and args.drift:
        sys.exit("Give --drift or --observed, not both.")

    res = load(args.epub)
    cand = res["chapter_candidates"]
    if not cand:
        sys.exit("No TOC sections found — nothing to check.")

    sections = [{"name": c["name"], "start_chars": c["start_chars"],
                 "state": c["default_state"]} for c in cand]
    milestones, adj_total = imports._epub_finalize(sections, res["char_count"])

    head_gap = float(cand[0]["start_chars"])
    skipped = [(c["name"], c["span"]) for c in cand if c["default_state"] == "skip"]

    print(f"\n{res.get('title') or os.path.basename(args.epub)}")
    print(f"  raw char count   {res['char_count']:>10,}")
    if head_gap:
        print(f"  head gap         {head_gap:>10,.0f}   (before the first TOC entry)")
    for name, span in skipped:
        print(f"  skipped          {span:>10,.0f}   {name}")
    print(f"  book length      {adj_total:>10,.0f}   <- what the progress bar uses")

    print(f"\n  {'#':>3}  {'chapter':<22}{'ends at':>10}{'span':>10}")
    for i, m in enumerate(milestones, 1):
        span = m["end_chars"] - m["start_chars"]
        print(f"  {i:>3}  {m['name'][:22]:<22}{m['end_chars']:>10,.0f}{span:>10,.0f}")

    # --drift is the same information as --observed, stated the way you actually
    # notice it while reading ("it thought I had 450 chars left"), so convert.
    flag = "--drift" if args.drift else "--observed"
    obs = []
    for i, raw in enumerate(args.drift or args.observed):
        if raw == "-" or i >= len(milestones):
            continue
        try:
            val = float(raw.replace(",", ""))
        except ValueError:
            sys.exit(f"{flag} values must be numbers or '-': {raw!r}")
        boundary = milestones[i]["end_chars"]
        obs.append((boundary, boundary - val if args.drift else val, i + 1))

    if not obs:
        if args.classes:
            report_classes(args.epub)
        else:
            print("\n  Next: note how far off the app is when you finish a chapter, then")
            print("  re-run with e.g.  --drift 450 619 492")
        return

    print(f"\n  {'#':>3}  {'app boundary':>13}{'you were at':>13}{'drift':>9}{'% of book':>11}")
    for boundary, actual, n in obs:
        d = boundary - actual
        print(f"  {n:>3}  {boundary:>13,.0f}{actual:>13,.0f}{d:>9,.0f}"
              f"{(d / boundary * 100 if boundary else 0):>10.2f}%")

    xs = [b for b, _, _ in obs]
    ys = [a for _, a, _ in obs]
    slope, intercept = fit(xs, ys)
    drifts = [b - a for b, a, _ in obs]
    spread = max(drifts) - min(drifts)
    mean_drift = sum(drifts) / len(drifts)

    print(f"\n  drift range      {min(drifts):,.0f} .. {max(drifts):,.0f}  (spread {spread:,.0f})")
    if len(obs) >= 2:
        print(f"  best fit         yours = {slope:.4f} x ours  {intercept:+,.0f}")

    # Order matters: a proportional term shows up as a slope away from 1, and a
    # constant one as an intercept. Test the slope first — a book can carry both,
    # and the constant-only branch is only meaningful once the slope is ruled out.
    print()
    if len(obs) < 2:
        print("  Need two or more boundaries to separate the two causes.")
    elif abs(1 - slope) > 0.005:
        print(f"  => PROPORTIONAL (~{abs(1 - slope) * 100:.1f}%). Our counter and your reader's")
        print(f"     disagree; every {1 / abs(1 - slope):,.0f} chars costs you ~1 char of drift.")
        print(f"     Skipping sections cannot fix this — it needs a {slope:.4f} calibration.")
        if abs(intercept) > 200:
            print(f"     There's also a {intercept:+,.0f} constant on top, so both are present.")
        if args.classes:
            report_classes(args.epub, abs(1 - slope) * 100)
        else:
            print("\n     Re-run with --classes to check whether one character class")
            print("     accounts for it — that would be fixable for every book at once.")
    elif abs(mean_drift) > 100:
        print(f"  => CONSTANT (~{mean_drift:,.0f} chars, holding steady across boundaries).")
        print("     Unread text still in the axis. Re-run the import and mark it skip —")
        print("     the checklist lists every section with its span.")
    else:
        print(f"  => ALIGNED (drift ~{mean_drift:,.0f}, within counter noise). Nothing to fix.")


if __name__ == "__main__":
    main()
