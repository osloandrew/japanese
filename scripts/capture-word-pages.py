#!/usr/bin/env python3
"""Capture real, rendered word pages by driving the actual live app.

This does not reconstruct the app's markup by hand (that approach produced
a real bug in norwegian: hand-typed HTML silently dropped icons the live app
has). It loads the real index.html in a real headless browser, lets the real
scripts.js load the dictionary once, then repeatedly calls the app's own
renderWordDefinition() for each requested word and saves exactly what it
produced. The output is byte-for-byte what a visitor's browser would show.

Usage:
    python3 scripts/capture-word-pages.py --words と言う 違う
    python3 scripts/capture-word-pages.py --batch-test
    python3 scripts/capture-word-pages.py --all

--batch-test runs a small, deliberately diverse set of words — meant to be
run and checked before ever running --all.
"""

from __future__ import annotations

import argparse
import csv
import http.server
import re
import socket
import sys
import tempfile
import threading
import urllib.parse
from pathlib import Path

from static_metadata import enrich_word_html

ROOT = Path(__file__).resolve().parent.parent
WORDS_CSV = ROOT / "japaneseWords.csv"
PRODUCTION_ORIGIN = "https://osloandrew.github.io"
SITE_PATH = "/japanese/"
# From word/<slug>/, this reaches the site root whether the site itself is
# mounted at /japanese/ (GitHub Pages) or / (local preview).
PAGE_BASE_HREF = "../../"

# A deliberately diverse sample — kana-only entries, kanji with okurigana, a
# verb phrase with a particle, and a mix of parts of speech/CEFR levels.
BATCH_TEST_WORDS = [
    "と言う",
    "違う",
    "遊園地",
    "友だち",
    "電車",
    "混む",
    "元気",
    "今日",
]


def slugify(word: str) -> str:
    word = (word or "").strip().lower()
    word = word.replace("’", "'")
    word = re.sub(r"[\s/]+", "-", word)
    word = "".join(ch for ch in word if ch.isalnum() or ch == "-")
    word = re.sub(r"-{2,}", "-", word)
    return word.strip("-")


def load_all_primary_words(csv_path: Path) -> list[str]:
    # Matches parseCSVData()'s own filter in scripts.js: a row with no
    # English translation never becomes a real dictionary entry there, so
    # renderWordDefinition() finds nothing for it and never sets a page
    # canonical — generating a static page for it here would just produce
    # a broken one that fails validation.
    seen = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not (row.get("English") or "").strip():
                continue
            # Alternative spellings in this CSV are separated by either an
            # ASCII comma or the ideographic comma "、" (e.g. "あ、あっ") —
            # scripts.js splits on the same /[,、]/ pattern everywhere it
            # reads this column (see e.g. its updateWordMetadata()). A
            # plain "," split misses the ideographic form entirely, leaving
            # the whole unsplit string as "the word" — renderWordDefinition()
            # then finds no matching entry for it at all.
            primary = re.split(r"[,、]", row.get("word") or "")[0].strip()
            if primary and primary.lower() not in seen:
                seen[primary.lower()] = primary
    return list(seen.values())


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def start_server(root: Path, port: int) -> http.server.ThreadingHTTPServer:
    handler = lambda *args, **kwargs: QuietHandler(
        *args, directory=str(root), **kwargs
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def capture(words: list[str], output_root: Path = ROOT) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright isn't installed. Run: pip3 install playwright && "
            "python3 -m playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(1)

    # Served nested under /japanese/, matching GitHub Pages' actual project
    # path. Captured pages use a directory-relative <base>, so that same HTML
    # also works when VS Code previews the repository at the server root.
    # The symlink is read-only from the server's perspective; nothing is ever
    # written through it.
    tmp_dir_ctx = tempfile.TemporaryDirectory(prefix="japanese-capture-")
    tmp_dir = Path(tmp_dir_ctx.name)
    (tmp_dir / "japanese").symlink_to(ROOT)

    port = find_free_port()
    server = start_server(tmp_dir, port)
    origin = f"http://127.0.0.1:{port}"
    base_url = f"{origin}{SITE_PATH}"
    print(f"Serving {ROOT} at {base_url}")

    written = []
    skipped = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            console_errors = []
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text)
                if msg.type == "error"
                else None,
            )

            # Loads with a real word already in the query string (rather than
            # the bare landing page) so the app's own one-time onload-driven
            # loadStateFromURL() renders THAT word instead of the landing
            # page. That one-time init is interval-polled and races with
            # anything we render ourselves in the meantime — if we start
            # capturing before it fires, it can wipe our first render right
            # out from under us a moment later. Waiting for the title to move
            # off the page's static default is a real completion signal for
            # that; a fixed sleep isn't reliable enough for a timing race
            # like this.
            first_word = words[0]
            page.goto(
                f"{base_url}?type=words&word={urllib.parse.quote(first_word)}",
                wait_until="load",
            )
            page.wait_for_function(
                "typeof results !== 'undefined' && results.length > 0",
                timeout=30000,
            )
            page.wait_for_function(
                "document.title !== "
                "'Japanese Dictionary | Search in Japanese or English'",
                timeout=10000,
            )
            print(f"Dictionary loaded ({page.evaluate('results.length')} rows).")

            # myWordsAuth.js lazily injects the Firebase SDK <script> tags
            # into <head> once Auth is ready to prepare — a fresh Playwright
            # context always takes that path, so by the time we serialize
            # outerHTML below those tags are already sitting in the live
            # DOM. Baking them into the static snapshot means a real
            # visitor's browser loads the Firebase SDK twice: once from
            # this snapshot, once again when myWordsAuth.js runs its own
            # loadFirebaseScripts() (logging "Firebase is already defined
            # in the global scope"). Stripping them restores the same
            # clean shell the source template ships, so myWordsAuth.js
            # injects them exactly once for a real visitor. One removal
            # covers every word below — this page is never re-navigated,
            # only re-rendered in place.
            page.evaluate(
                """
                () => {
                  document
                    .querySelectorAll('script[src^="https://www.gstatic.com/firebasejs/"]')
                    .forEach((script) => script.remove());
                }
                """
            )

            for word in words:
                slug = slugify(word)
                if not slug:
                    print(f"  SKIP {word!r}: empty slug")
                    skipped.append(word)
                    continue

                page.evaluate(
                    "(w) => { clearContainer(); renderWordDefinition(w, ''); }",
                    word,
                )

                # ':not(.error-message)' matters: renderWordDefinition()'s
                # "No Definition Found" box also carries the .definition
                # class, so a plain '.definition' count reports a match
                # even when nothing actually rendered.
                match_count = page.evaluate(
                    "document.querySelectorAll("
                    "'#results-container .definition:not(.error-message)'"
                    ").length"
                )
                if match_count == 0:
                    print(f"  SKIP {word!r}: no matching dictionary entry rendered")
                    skipped.append(word)
                    continue

                html = page.evaluate("document.documentElement.outerHTML")
                html = html.replace(
                    "<head>", f'<head>\n    <base href="{PAGE_BASE_HREF}">', 1
                )
                # canonical/og:url/og:image were built (correctly) against
                # this capture session's local origin — the only fix left
                # is swapping that origin for the real one; the path
                # portion after it is already right.
                html = html.replace(origin, PRODUCTION_ORIGIN)

                canonical = f"{PRODUCTION_ORIGIN}{SITE_PATH}word/{slug}/"
                html = enrich_word_html(html, word=word, canonical=canonical)

                out_dir = output_root / "word" / slug
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / "index.html").write_text(
                    "<!doctype html>\n" + html, encoding="utf-8"
                )
                print(f"  OK   {word!r} -> word/{slug}/index.html ({match_count} entr{'y' if match_count == 1 else 'ies'})")
                written.append(word)

            browser.close()

            if console_errors:
                print("\nBrowser console errors seen during capture:")
                for err in console_errors[:20]:
                    print(f"  {err}")
    finally:
        server.shutdown()
        tmp_dir_ctx.cleanup()

    print(f"\nWrote {len(written)} page(s), skipped {len(skipped)}.")
    if skipped:
        print("Skipped:", ", ".join(skipped))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--batch-test",
        action="store_true",
        help="Capture a small, diverse hand-picked set of words (recommended first run).",
    )
    group.add_argument("--words", nargs="+", help="Capture these specific words.")
    group.add_argument(
        "--all", action="store_true", help="Capture every word in japaneseWords.csv."
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=ROOT,
        help="Site root beneath which word/<slug>/index.html is written.",
    )
    args = parser.parse_args()

    if args.batch_test:
        words = BATCH_TEST_WORDS
    elif args.words:
        words = args.words
    else:
        words = load_all_primary_words(WORDS_CSV)

    capture(words, args.output_root.resolve())


if __name__ == "__main__":
    main()
