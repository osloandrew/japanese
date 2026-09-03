#!/usr/bin/env python3
"""Capture real, rendered story pages by driving the actual live app.

Same approach as scripts/capture-word-pages.py, adapted for stories: trigger
the app's own fetchAndLoadStoryData() + displayStory() and save exactly what
they render. No race condition to work around here (unlike words) — nothing
auto-triggers a *specific* story on a plain ``?type=words`` navigation, so
data loading is fully sequenced by this script rather than raced against the
page's own init.

Ported from norwegian/scripts/capture-story-pages.py, with two norwegian-only
mechanisms removed because this app doesn't have them:

- storyQuizState / storyImageState dataset polling: this app has no
  storyQuiz.js and displayStory() doesn't manage an async image slot -- it
  builds the whole story body (including any <img>) synchronously inside one
  async function and awaits it directly instead, which this script now does
  too (Playwright's page.evaluate() awaits a returned Promise for us).
- window.__PRELOADED_STORY__ injection: norwegian's DOMContentLoaded handler
  reads this to speed up a cold pretty-path load, but this app has no such
  handler (see the "no pretty-path rewriting" comment in index.html's
  #mode-nav) and never looks for that global, so injecting it here would be
  dead markup.

Usage:
    python3 scripts/capture-story-pages.py --titles "あの日の花火"
    python3 scripts/capture-story-pages.py --batch-test
    python3 scripts/capture-story-pages.py --all
"""

from __future__ import annotations

import argparse
import http.server
import re
import socket
import sys
import tempfile
import threading
from pathlib import Path

from static_metadata import enrich_story_html

from story_sources import load_all_story_titles

ROOT = Path(__file__).resolve().parent.parent
PRODUCTION_ORIGIN = "https://osloandrew.github.io"
SITE_PATH = "/japanese/"
# From story/<slug>/, this reaches the site root under both GitHub Pages and
# a repository-root local preview.
PAGE_BASE_HREF = "../../"

BATCH_TEST_TITLES = None  # filled in from CSV in main() — first 3 + any with special chars


def slugify(word: str) -> str:
    word = (word or "").strip().lower()
    word = word.replace("’", "'")
    word = re.sub(r"[\s/]+", "-", word)
    word = "".join(ch for ch in word if ch.isalnum() or ch == "-")
    word = re.sub(r"-{2,}", "-", word)
    return word.strip("-")


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


def capture(titles: list[str], output_root: Path = ROOT) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright isn't installed. Run: pip3 install playwright && "
            "python3 -m playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(1)

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
            # getNextStorySuggestion()'s "Keep Reading" pick and its shuffle
            # seed both use Math.random(); static HTML must be reproducible
            # so selectively rebuilding one story does not create arbitrary
            # output differences.
            page.add_init_script("Math.random = () => 0")
            console_errors = []
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text)
                if msg.type == "error"
                else None,
            )

            # Plain navigation — stories.js's DOMContentLoaded handler always
            # calls fetchAndLoadStoryData() (unlike norwegian, which only
            # does that for type=stories/a story URL), but never calls
            # displayStory() for a specific title unless the URL's own
            # "story" query parameter names one, which type=words never
            # does — so nothing races the explicit displayStory() calls
            # below.
            page.goto(f"{base_url}?type=words", wait_until="load")
            page.wait_for_function(
                "typeof fetchAndLoadStoryData === 'function'", timeout=15000
            )
            # Dictionary loading also controls the shared search shell. If we
            # serialize while it is still loading, otherwise-identical story
            # captures randomly contain disabled controls and a loading
            # placeholder depending on which fetch wins the race.
            page.wait_for_function(
                "typeof results !== 'undefined' && results.length > 0",
                timeout=30_000,
            )
            # Explicit call (rather than relying solely on the
            # DOMContentLoaded handler's own call) so this script controls
            # exactly when storyResults is guaranteed populated —
            # page.evaluate() awaits the returned Promise.
            page.evaluate("() => fetchAndLoadStoryData()")
            story_count = page.evaluate("storyResults.length")
            print(f"Story data loaded ({story_count} stories).")

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
            # covers every story below — this page is never re-navigated,
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

            for title in titles:
                slug = slugify(title)
                if not slug:
                    print(f"  SKIP {title!r}: empty slug")
                    skipped.append(title)
                    continue

                # displayStory() is itself an async function that awaits
                # image/audio lookups before synchronously building and
                # inserting the story body — page.evaluate() awaits that
                # returned Promise, so by the time this call returns the
                # content is fully rendered. No separate readiness-state
                # polling is needed (this app has neither storyQuizState nor
                # storyImageState).
                page.evaluate("(t) => displayStory(t)", title)

                has_content = page.evaluate(
                    "document.getElementById('story-content').children.length > 0"
                )
                if not has_content:
                    print(f"  SKIP {title!r}: no story rendered")
                    skipped.append(title)
                    continue

                story_data = page.evaluate(
                    "(t) => storyResults.find((s) => s.titleJapanese === t)",
                    title,
                )

                html = page.evaluate("document.documentElement.outerHTML")
                html = html.replace(
                    "<head>", f'<head>\n    <base href="{PAGE_BASE_HREF}">', 1
                )
                html = html.replace(origin, PRODUCTION_ORIGIN)

                canonical = f"{PRODUCTION_ORIGIN}{SITE_PATH}story/{slug}/"
                html = enrich_story_html(
                    html,
                    japanese_title=story_data.get("titleJapanese", ""),
                    english_title=story_data.get("titleEnglish", ""),
                    cefr_level=story_data.get("CEFR", ""),
                    genre=story_data.get("genre", ""),
                    canonical=canonical,
                )

                out_dir = output_root / "story" / slug
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / "index.html").write_text(
                    "<!doctype html>\n" + html, encoding="utf-8"
                )
                print(f"  OK   {title!r} -> story/{slug}/index.html")
                written.append(title)

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
    group.add_argument("--batch-test", action="store_true")
    group.add_argument("--titles", nargs="+")
    group.add_argument("--all", action="store_true")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=ROOT,
        help="Site root beneath which story/<slug>/index.html is written.",
    )
    args = parser.parse_args()

    all_titles = load_all_story_titles(ROOT)

    if args.batch_test:
        # First 2 plus anything with an apostrophe/quote or accented char —
        # same "diverse small sample first" discipline as the word capture.
        special = [
            t for t in all_titles
            if any(ch in t for ch in "'’") or any(ord(ch) > 127 for ch in t)
        ][:2]
        titles = all_titles[:2] + special
    elif args.titles:
        titles = args.titles
    else:
        titles = all_titles

    capture(titles, args.output_root.resolve())


if __name__ == "__main__":
    main()
