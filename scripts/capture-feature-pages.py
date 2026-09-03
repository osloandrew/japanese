#!/usr/bin/env python3
"""Capture the real default UI for each crawlable feature route.

Unlike norwegian, this app never sets a <link rel="canonical"> at all for a
plain ?type=sentences/word-game/pronunciation navigation (there is no
per-route canonical-setting code here, only the word-specific
updateWordMetadata() -- see static_metadata.py's docstring), so each
captured page below gets one added, plus a matching og:url, pointing at its
own real captured URL. The removed norwegian readiness check that waited
for the *live* canonical to already end with `/${feature}/` is dropped for
the same reason -- it would never become true here.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import sys
import tempfile
import threading
from pathlib import Path

from static_metadata import set_canonical_link, set_og_url

ROOT = Path(__file__).resolve().parent.parent
PRODUCTION_ORIGIN = "https://osloandrew.github.io"
SITE_PATH = "/japanese/"
PAGE_BASE_HREF = "../"

FEATURES = {
    "sentences": "#results-container .sentence-container",
    "word-game": "#results-container .game-intro-card",
    "pronunciation": "#results-container .sentence-box-practice",
}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as current_socket:
        current_socket.bind(("127.0.0.1", 0))
        return current_socket.getsockname()[1]


def capture(output_root: Path) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright isn't installed. Install requirements-pages.txt and Chromium first.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    temporary = tempfile.TemporaryDirectory(prefix="japanese-feature-capture-")
    temporary_root = Path(temporary.name)
    (temporary_root / "japanese").symlink_to(ROOT)
    port = find_free_port()
    handler = lambda *args, **kwargs: QuietHandler(
        *args, directory=str(temporary_root), **kwargs
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{port}"
    base_url = f"{origin}{SITE_PATH}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for feature, ready_selector in FEATURES.items():
                context = browser.new_context()
                page = context.new_page()
                page.add_init_script("Math.random = () => 0")
                page.goto(f"{base_url}?type={feature}", wait_until="load")
                page.wait_for_function(
                    "typeof results !== 'undefined' && results.length > 0",
                    timeout=30_000,
                )
                if feature == "pronunciation":
                    # Unlike sentences/word-game, loadStateFromURL()'s own
                    # ?type=pronunciation branch calls handleTypeChange(),
                    # whose body never actually mentions "pronunciation" —
                    # this route currently has no #mode-nav tab, no
                    # type-select option, and no landing-page card, so
                    # nothing in the live UI ever reaches it that way either
                    # (a real, pre-existing gap in this app, not something
                    # this build script should paper over by inventing new
                    # UI). initPronunciation() is called directly here
                    # instead, the same way capture-story-pages.py calls
                    # displayStory() directly rather than relying on
                    # navigation to trigger it.
                    #
                    # The settle delay first matters: loadStateFromURL()'s
                    # own interval-polled checkDataLoaded also fires once
                    # results.length > 0 and runs its own (harmless, generic)
                    # handling for this URL, which touches #results-container
                    # too — calling initPronunciation() before that interval
                    # has had a chance to fire lets its later firing wipe out
                    # the content this call just rendered. Confirmed by
                    # testing: without this wait, resultsContainer ends up
                    # empty even though initPronunciation() ran and its
                    # audio fetch visibly went out.
                    page.wait_for_timeout(1500)
                    page.evaluate("() => initPronunciation()")
                page.wait_for_selector(ready_selector, state="visible", timeout=60_000)
                # No canonical-based readiness wait here (unlike norwegian):
                # this app never sets a per-route canonical at all, so
                # there's nothing to poll for — the visible-content selector
                # above plus this fixed settle delay is the whole signal.
                page.wait_for_timeout(250)

                # The Word Game entry screen depends on the visitor's saved
                # placement status. Capturing a fresh browser's placement UI
                # bakes that personalized state into HTML, so returning users
                # see it flash before their local state is restored. Preserve
                # only a neutral shell; the normal app startup replaces it
                # with placement or the round picker for the actual visitor.
                if feature == "word-game":
                    page.evaluate(
                        """
                        () => {
                          document.querySelector("#results-container").innerHTML = `
                            <div class="game-intro-card word-game-loading-card">
                              <h2 class="game-intro-heading">Preparing Word Game</h2>
                              <p class="game-today-practice-note">Loading your next vocabulary practice…</p>
                            </div>
                          `;
                        }
                        """
                    )

                # myWordsAuth.js lazily injects the Firebase SDK <script>
                # tags into <head> once Auth is ready to prepare — a fresh
                # Playwright context always takes that path, so by the time
                # we serialize outerHTML below those tags are already
                # sitting in the live DOM. Baking them into the static
                # snapshot means a real visitor's browser loads the
                # Firebase SDK twice: once from this snapshot, once again
                # when myWordsAuth.js runs its own loadFirebaseScripts()
                # (logging "Firebase is already defined in the global
                # scope"). Stripping them restores the same clean shell the
                # source template ships, so myWordsAuth.js injects them
                # exactly once for a real visitor.
                page.evaluate(
                    """
                    () => {
                      document
                        .querySelectorAll('script[src^="https://www.gstatic.com/firebasejs/"]')
                        .forEach((script) => script.remove());
                    }
                    """
                )

                html_out = page.evaluate("document.documentElement.outerHTML")
                html_out = html_out.replace(
                    "<head>", f'<head>\n    <base href="{PAGE_BASE_HREF}">', 1
                )
                html_out = html_out.replace(origin, PRODUCTION_ORIGIN)

                canonical = f"{PRODUCTION_ORIGIN}{SITE_PATH}{feature}/"
                html_out = set_canonical_link(html_out, canonical)
                html_out = set_og_url(html_out, canonical)

                output = output_root / feature / "index.html"
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text("<!doctype html>\n" + html_out, encoding="utf-8")
                print(f"Wrote {output}")
                context.close()
            browser.close()
    finally:
        server.shutdown()
        temporary.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT)
    args = parser.parse_args()
    capture(args.output_root.resolve())


if __name__ == "__main__":
    main()
