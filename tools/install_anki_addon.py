"""Install the Konseki addon into Anki's addons21 folder.

    python tools/install_anki_addon.py            # copy (safe default)
    python tools/install_anki_addon.py --link     # symlink, for development
    python tools/install_anki_addon.py --dest ... # explicit addons21 path

A copy rather than a symlink by default because a symlink on Windows needs
Developer Mode or an elevated shell, and failing that it is better to succeed
loudly than to fail obscurely.

Two files in the installed folder are NEVER overwritten:

  user_files/  - the map of which days the tracker has confirmed. Clobbering it
                 makes the addon re-post a week of days it had already settled.
  meta.json    - Anki-owned. It holds the addon's display name AND the user's
                 CONFIG (host, port, token). Deleting it on a re-install would
                 silently wipe the token and the addon would go quiet.

`manifest.json` sets the name only when Anki installs from a .ankiaddon zip; for
a hand-copied folder Anki reads meta.json instead, so this script seeds one with
the name on a first install and leaves it alone afterwards.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "anki" / "konseki_anki"
NAME = "konseki_anki"
KEEP = ("user_files", "meta.json")     # addon/user state - never clobbered


def default_dest():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "Anki2" / "addons21"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Anki2" / "addons21"
    return Path.home() / ".local" / "share" / "Anki2" / "addons21"


def seed_meta(target):
    """Give Anki a display name, without ever touching an existing meta.json.

    Anki resolves an add-on's listed name from meta.json's "name" - manifest.json
    is only consulted when installing from a .ankiaddon zip. Without this the
    add-on lists as its folder name, "konseki_anki".

    meta.json is also where Anki stores the user's CONFIG, so this writes it only
    when absent. Rewriting it would discard the token on every re-install.
    """
    meta = target / "meta.json"
    if meta.exists():
        return
    manifest = SRC / "manifest.json"
    name = "Konseki"
    try:
        name = json.loads(manifest.read_text(encoding="utf-8")).get("name", name)
    except (OSError, ValueError):
        pass
    meta.write_text(json.dumps({"name": name}), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dest", type=Path, default=None, help="addons21 directory")
    ap.add_argument("--link", action="store_true", help="symlink instead of copy")
    args = ap.parse_args()

    if not SRC.is_dir():
        sys.exit(f"Addon source not found: {SRC}")

    dest_root = args.dest or default_dest()
    if not dest_root or not dest_root.parent.exists():
        sys.exit(f"Could not find Anki's data folder (looked for {dest_root}).\n"
                 f"Pass --dest /path/to/addons21 explicitly.")
    dest_root.mkdir(parents=True, exist_ok=True)
    target = dest_root / NAME

    if target.is_symlink():
        target.unlink()
    elif target.is_dir():
        # Keep the confirmed-days map and Anki's meta.json (which holds the
        # user's token); replace everything else.
        for child in target.iterdir():
            if child.name in KEEP:
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()

    if args.link:
        if target.exists():
            shutil.rmtree(target)
        try:
            target.symlink_to(SRC, target_is_directory=True)
        except OSError as e:
            sys.exit(f"Could not symlink ({e}).\n"
                     f"On Windows this needs Developer Mode or an elevated shell - "
                     f"or just drop --link to copy instead.")
        print(f"Linked  {target}  ->  {SRC}")
    else:
        target.mkdir(exist_ok=True)
        for child in SRC.iterdir():
            if child.name in ("__pycache__",) + KEEP:
                continue
            if child.is_dir():
                shutil.copytree(child, target / child.name, dirs_exist_ok=True)
            else:
                shutil.copy2(child, target / child.name)
        (target / "user_files").mkdir(exist_ok=True)
        seed_meta(target)
        print(f"Copied  {SRC}  ->  {target}")

    print("Restart Anki, then set the host and token in "
          "Tools -> Add-ons -> Konseki -> Config.")


if __name__ == "__main__":
    main()
