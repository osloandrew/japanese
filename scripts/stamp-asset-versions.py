#!/usr/bin/env python3
"""Stamp ``?v=`` cache-busting query strings from file content.

Every local <script src="…?v=XXXX"> and <link href="…?v=XXXX"> in index.html,
plus every new Audio("…?v=XXXX") call in wordGame.js, used to share one
hand-typed version string that had to be bumped by hand on every deploy. Miss
a line, or forget to bump it at all, and a returning visitor's browser
silently keeps serving a stale cached copy of that file — the audio chimes
have no other cache-busting, since unlike script/link tags their URL isn't
re-parsed from HTML on every load.

This script replaces that by deriving each asset's version from its own
content: a short SHA-256 hash of the file's current bytes. Nothing to
remember — an unchanged file keeps its existing query string (so browser
caches for OTHER files aren't invalidated for no reason), and a changed file
gets a new one automatically. Run it before every deploy:

    python3 scripts/stamp-asset-versions.py
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HASH_LENGTH = 10

TARGETS = [
    {
        "path": ROOT / "index.html",
        # Matches src="foo.js?v=XXXX" or href="foo.css?v=XXXX" for a local
        # file (no scheme/host — leaves CDN URLs like Google Fonts alone).
        "pattern": re.compile(r'((?:src|href)=")([^":?]+\.(?:js|css))\?v=[^"]*(")'),
    },
    {
        "path": ROOT / "wordGame.js",
        # Matches new Audio("Resources/Audio/foo.mp3?v=XXXX"), tolerating a
        # trailing comma and/or line break for calls a formatter has wrapped
        # onto their own line.
        "pattern": re.compile(r'(new Audio\(\s*")([^"?]+\.mp3)\?v=[^"]*("\s*,?\s*\))'),
    },
]


def content_hash(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest[:HASH_LENGTH]


def stamp(text: str, pattern: re.Pattern) -> tuple[str, list[str]]:
    changes: list[str] = []
    missing: list[str] = []

    def replace(match: re.Match) -> str:
        prefix, rel_path, suffix = match.groups()
        asset_path = ROOT / rel_path
        if not asset_path.is_file():
            missing.append(rel_path)
            return match.group(0)

        new_version = content_hash(asset_path)
        old_full = match.group(0)
        old_version = old_full[len(prefix) + len(rel_path) + len("?v=") : -len(suffix)]
        new_ref = f"{prefix}{rel_path}?v={new_version}{suffix}"
        if old_version != new_version:
            changes.append(f"{rel_path}: {old_version} -> {new_version}")
        return new_ref

    new_text = pattern.sub(replace, text)

    for rel_path in missing:
        print(f"warning: referenced asset not found on disk: {rel_path}", file=sys.stderr)

    return new_text, changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any target isn't already up to date, without writing.",
    )
    args = parser.parse_args()

    all_changes: list[str] = []
    for target in TARGETS:
        path = target["path"]
        # newline="" disables universal-newline translation on both ends, so
        # existing CRLF line endings round-trip unchanged instead of
        # silently turning into LF and rewriting every line in the diff.
        with open(path, encoding="utf-8", newline="") as f:
            text = f.read()
        new_text, changes = stamp(text, target["pattern"])
        if changes:
            all_changes.extend(f"{path.name} — {c}" for c in changes)
            if not args.check:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_text)

    if not all_changes:
        print("All asset versions already up to date.")
        return 0

    if args.check:
        print("Out of date — the following assets need re-stamping:")
        for change in all_changes:
            print(f"  {change}")
        return 1

    print(f"Updated {len(all_changes)} asset version(s):")
    for change in all_changes:
        print(f"  {change}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
