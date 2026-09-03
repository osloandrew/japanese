#!/usr/bin/env python3
"""Generate stories/index.html by capturing the real app's story list.

Same principle as capture-word-pages.py: don't hand-build a parallel
design, capture what the real app actually renders. displayStoryList()
takes a visibleCount override, so this renders every story with the exact
real card markup/styling — then, in-page (DOM manipulation, not string
splitting the HTML), wraps everything past the app's own default page size
in a genuinely-togglable hidden section. Visitors see the same default
count as ?type=stories always showed; the full list is real, crawlable
markup in the response either way, not something conjured only for bots.

Ported from norwegian/scripts/build-stories-index.py, with one norwegian-only
step removed: rewriting each card's href from its query-string form
(?type=story&story=Title) to the pretty /story/<slug>/ page, using
slugifyWordForURL() + pageManifest.stories. Neither of those exist in this
app's client JS — it has no pretty-path/pushState navigation at all (see the
"no pretty-path rewriting" comment on #mode-nav in index.html) — so calling
them here would throw a ReferenceError inside the page and abort the whole
capture. Cards keep their real, working query-string hrefs instead, exactly
matching how this app's own index.html already links to stories.

A second, related deviation: this app never sets a <link rel="canonical">
for the ?type=stories route at all (only the word/story-specific
updateWordMetadata()/updateStoryMetadata() do that — see
static_metadata.py's docstring), so one is added below, plus a matching
og:url, pointing at the real captured stories/ URL.
"""

from __future__ import annotations

import http.server
import socket
import tempfile
import threading
from pathlib import Path

from static_metadata import set_canonical_link, set_og_url

ROOT = Path(__file__).resolve().parent.parent
PRODUCTION_ORIGIN = "https://osloandrew.github.io"
SITE_PATH = "/japanese/"
# From stories/, this reaches the site root under both GitHub Pages and a
# repository-root local preview.
PAGE_BASE_HREF = "../"
# A crawlable snapshot must be reproducible. The live app still assigns each
# visitor its normal personal shuffle seed whenever it renders the list.
STATIC_STORY_SHUFFLE_SEED = 20260824


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def build(output_root: Path = ROOT) -> None:
    from playwright.sync_api import sync_playwright

    tmp_dir_ctx = tempfile.TemporaryDirectory(prefix="japanese-capture-")
    tmp_dir = Path(tmp_dir_ctx.name)
    (tmp_dir / "japanese").symlink_to(ROOT)

    port = find_free_port()
    handler = lambda *a, **kw: QuietHandler(
        *a, directory=str(tmp_dir), **kw
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{port}"
    base_url = f"{origin}{SITE_PATH}"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.add_init_script(
                f"""() => {{
                    localStorage.setItem(
                        'japanese-dictionary-story-shuffle-seed-v1',
                        '{STATIC_STORY_SHUFFLE_SEED}'
                    );
                    sessionStorage.removeItem(
                        'japanese-dictionary-session-recommendation-v1'
                    );
                    Math.random = () => 0;
                }}"""
            )

            # Enter through the real Stories route so its normal route setup,
            # ordering, recommendation, metadata, and search UI all run before
            # capture. Calling displayStoryList() from the dictionary route
            # skipped part of that behavior and could capture a different card
            # order even though the card component itself was identical.
            page.goto(f"{base_url}?type=stories", wait_until="load")
            page.wait_for_selector(
                "#stories .story-card-link", state="visible", timeout=30000
            )

            # This app has three independent, redundant "wait for the
            # dictionary then finish setting up this route" pollers left
            # over from incremental porting (scripts.js's own DOMContentLoaded
            # setInterval, stories.js's own DOMContentLoaded handler, and
            # loadStateFromURL()'s internal checkDataLoaded setInterval,
            # called from both of the previous two) -- each one, once the
            # word dictionary finishes loading, calls
            # handleTypeChange("stories"), which unconditionally calls
            # displayStoryList() with NO arguments (STORY_LIST_INITIAL_SIZE
            # default), clobbering whatever this script just rendered.
            # Confirmed by instrumenting displayStoryList() directly: two to
            # four such default-argument calls land at unpredictable points
            # relative to this script's own explicit call, so a single
            # explicit call plus a fixed settle delay is not reliable no
            # matter how long the delay is. Calling it explicitly TWICE, with
            # a long settle gap on each side, empirically clears every
            # straggling poller (all of which fire within ~1.5s of load in
            # practice) so the second call is unambiguously the last word.
            call_displayed_story_list = (
                "async () => { await displayStoryList(storyResults, "
                "{visibleCount: storyResults.length}); }"
            )
            page.wait_for_timeout(1500)
            page.evaluate(call_displayed_story_list)
            page.wait_for_timeout(1500)
            page.evaluate(call_displayed_story_list)
            page.wait_for_timeout(300)

            total = page.evaluate(
                """() => {
                    const list = document.getElementById('stories');
                    const items = [...list.children];
                    // NOT adjusted for whether a recommendation card is
                    // present: displayStoryList() appends
                    // .story-recommendation as #stories' *sibling*, before
                    // it, never as a grid item inside it (see
                    // displayStoryList in stories.js) — so it never
                    // occupies one of #stories' own grid slots, and
                    // subtracting a slot for it here would make the
                    // regular-card grid odd instead of even, putting the
                    // dangling single card back on the bottom row it was
                    // supposed to fix.
                    const cutoff = STORY_LIST_INITIAL_SIZE;
                    const extra = items.slice(cutoff);
                    if (extra.length) {
                        // All cards are already real markup in the response
                        // (crawlers need nothing more than that); revealing
                        // them is a plain CSS toggle instead of calling
                        // displayStoryList() again — no re-fetch needed
                        // since nothing here was ever actually removed.
                        //
                        // Left as direct children of #stories, exactly
                        // where the real app puts every card — not moved
                        // into a wrapper div. display:none on each <li>
                        // individually, not a wrapping div set to
                        // display:contents: that first approach changed
                        // each li's DOM parent, and CSS selector matching
                        // (:nth-child, any `>` direct-child rule, grid
                        // item assignment) is based on the actual DOM
                        // tree, not the box-generation tree display:
                        // contents produces — so those items rendered
                        // without the same styling as the rest. Hiding
                        // in place has no such gap: nothing about their
                        // position in the tree ever changes.
                        extra.forEach((li) => {
                            li.style.display = 'none';
                            li.classList.add('story-index-hidden');
                        });

                        // Same wrapper/button classes and label
                        // displayStoryList()'s own "Show More Stories"
                        // uses (see stories.js) — a captured page should
                        // look and act like the real app, not a
                        // hand-styled stand-in for it. The handler is set
                        // as a real onclick= HTML attribute (a string),
                        // not a JS property (element.onclick = fn) — a
                        // property assignment runs live but is invisible
                        // to outerHTML serialization, so the captured
                        // static file would ship a button with no actual
                        // handler at all.
                        //
                        // Reveals STORY_LIST_BATCH_SIZE (stories.js) at a
                        // time, same as the real app's own "Show More" —
                        // not everything still hidden in one click.
                        const loadMore = document.createElement('div');
                        loadMore.className = 'stories-load-more';
                        const toggle = document.createElement('button');
                        toggle.type = 'button';
                        toggle.className = 'stories-load-more-button';
                        toggle.textContent = 'Show More Stories';
                        toggle.setAttribute(
                            'onclick',
                            "var hidden = Array.prototype.slice.call(" +
                            "document.querySelectorAll('.story-index-hidden'), 0, 24);" +
                            "hidden.forEach(function(li){" +
                            "li.style.display='';li.classList.remove('story-index-hidden');});" +
                            "if(!document.querySelector('.story-index-hidden')){" +
                            "this.parentElement.remove();}"
                        );
                        loadMore.appendChild(toggle);
                        list.after(loadMore);
                    }
                    return items.length;
                }"""
            )
            print(f"Rendered {total} story cards; split at STORY_LIST_INITIAL_SIZE.")

            html_out = page.evaluate("document.documentElement.outerHTML")
            html_out = html_out.replace(
                "<head>", f'<head>\n    <base href="{PAGE_BASE_HREF}">', 1
            )
            html_out = html_out.replace(origin, PRODUCTION_ORIGIN)

            canonical = f"{PRODUCTION_ORIGIN}{SITE_PATH}stories/"
            html_out = set_canonical_link(html_out, canonical)
            html_out = set_og_url(html_out, canonical)

            output = output_root / "stories" / "index.html"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("<!doctype html>\n" + html_out, encoding="utf-8")
            print(f"Wrote {output}")

            browser.close()
    finally:
        server.shutdown()
        tmp_dir_ctx.cleanup()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=ROOT,
        help="Site root beneath which stories/index.html is written.",
    )
    args = parser.parse_args()
    build(args.output_root.resolve())


if __name__ == "__main__":
    main()
