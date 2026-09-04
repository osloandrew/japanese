#!/usr/bin/env python3
"""Compare captured HTML visually with the same app rendered by JavaScript.

JavaScript is disabled for the captured side, proving the checked static
markup itself renders the requested content. The comparison side loads the
normal app shell and lets its production rendering functions create the same
view. Representative pages must be pixel-identical within their content area.
The captured URL is then loaded with JavaScript enabled as a behavior smoke
test, proving it upgrades into the normal interactive application.

Ported from norwegian/scripts/verify-static-page-equivalence.py. Several
norwegian mechanisms this app genuinely doesn't have are removed rather than
faked (see comments at each site below, and static_metadata.py's/
capture-story-pages.py's docstrings for the underlying differences):

- window.__APP_READY__ doesn't exist here at all -- every wait that polled
  it is replaced with a wait on the actual rendered content instead.
- pageManifest / slugifyWordForURL don't exist -- this app has no
  pretty-path/pushState navigation (see index.html's #mode-nav comment), so
  the live app's own canonical never becomes a pretty /word/<slug>/ or
  /story/<slug>/ URL, and clicking into a word/story never changes
  location.pathname. Readiness waits that polled the live canonical for a
  pretty-path suffix are replaced with content-based waits; the whole
  pretty-path routing portion of the original behavior_smoke_check (an
  alternative-spelling word resolving to /word/<slug>/, a sentence search
  changing location.pathname) is dropped rather than adapted, since there is
  no such behavior in this app to verify.
- Story heading is <h2 class="sticky-title-japanese"> here, not
  norwegian's <h1 lang="nb" ...> -- heading_semantics_pixel_check's story
  portion (swapping an existing <h1> to <h2> and comparing) does not apply,
  since there is no <h1> on a story page to begin with, and is dropped.
"""

from __future__ import annotations

import argparse
import http.server
import io
import re
import socket
import tempfile
import threading
import urllib.parse
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import Browser, Page, sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError


ROOT = Path(__file__).resolve().parent.parent
SITE_PATH = "/japanese/"
VIEWPORT = {"width": 1280, "height": 900}
SCREENSHOT_STYLE = (
    "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"
    ".story-quiz-section,#waveform,#user-waveform{display:none!important}"
)
STATIC_STORY_SHUFFLE_SEED = 20260824


def use_static_story_index_seed(page: Page) -> None:
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


def slugify(value: str) -> str:
    value = value.strip().lower().replace("’", "'")
    value = re.sub(r"[\s/]+", "-", value)
    value = "".join(character for character in value if character.isalnum() or character == "-")
    return re.sub(r"-{2,}", "-", value).strip("-")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        # Browser navigation can cancel an in-flight multi-megabyte CSV
        # response after the next page is already ready. That expected
        # disconnect is not a test failure and should not dump a traceback.
        return


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as current_socket:
        current_socket.bind(("127.0.0.1", 0))
        return current_socket.getsockname()[1]


def wait_for_fonts(page: Page) -> None:
    """Block until webfonts have finished loading. Without this, a screenshot
    taken while a fallback font is still showing (font-display: swap) can
    measure different text metrics than one taken a few milliseconds later —
    enough to flip a boundary line's wrap and produce a flaky pixel-size
    mismatch. page.evaluate runs via CDP regardless of java_script_enabled,
    so this works on the static (JS-disabled) page too."""
    page.evaluate("() => document.fonts.ready")


# Chromium can rasterize an otherwise pixel-identical document to a height
# a few rows taller or shorter depending on whether scripting is enabled
# (java_script_enabled=False for the static side), independent of any actual
# DOM/CSS/text difference. Tolerate the observed rounding gap by comparing
# only the shared region; anything beyond this, or any pixel difference
# within the shared region, still fails.
MAX_SIZE_ROUNDING_TOLERANCE = 3


def compare_png(left: bytes, right: bytes, label: str) -> None:
    left_image = Image.open(io.BytesIO(left)).convert("RGBA")
    right_image = Image.open(io.BytesIO(right)).convert("RGBA")
    if left_image.size != right_image.size:
        width_gap = abs(left_image.width - right_image.width)
        height_gap = abs(left_image.height - right_image.height)
        if width_gap > MAX_SIZE_ROUNDING_TOLERANCE or height_gap > MAX_SIZE_ROUNDING_TOLERANCE:
            raise AssertionError(f"{label}: rendered size differs: {left_image.size} != {right_image.size}")
        shared_box = (0, 0, min(left_image.width, right_image.width), min(left_image.height, right_image.height))
        left_image = left_image.crop(shared_box)
        right_image = right_image.crop(shared_box)
    difference = ImageChops.difference(left_image, right_image)
    if difference.getbbox() is not None:
        changed_pixels = sum(1 for pixel in difference.getdata() if pixel != (0, 0, 0, 0))
        raise AssertionError(f"{label}: {changed_pixels} rendered pixels differ")


def word_visual_check(browser: Browser, base_url: str, word: str) -> None:
    slug = slugify(word)
    dynamic = browser.new_page(viewport=VIEWPORT)
    static_context = browser.new_context(java_script_enabled=False, viewport=VIEWPORT)
    static = static_context.new_page()
    try:
        dynamic.goto(f"{base_url}?type=words&word={urllib.parse.quote(word)}", wait_until="load")
        # No canonical-based readiness wait here (unlike norwegian): this
        # app's live canonical for a word is always its query-string lookup
        # URL, never a pretty /word/<slug>/ path (see
        # static_metadata.py's docstring), so it can never satisfy a
        # pretty-path wait. The rendered definition itself is the signal.
        dynamic.wait_for_selector("#results-container .definition", state="visible", timeout=30_000)
        dynamic.wait_for_timeout(120)

        static.goto(f"{base_url}word/{urllib.parse.quote(slug)}/", wait_until="load")
        static.wait_for_selector("#results-container .definition", state="visible")
        wait_for_fonts(dynamic)
        wait_for_fonts(static)
        compare_png(
            static.locator("#results-container").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
            dynamic.locator("#results-container").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
            f"word {word!r}",
        )
    finally:
        dynamic.close()
        static_context.close()


def story_visual_check(browser: Browser, base_url: str, title: str) -> None:
    slug = slugify(title)
    dynamic = browser.new_page(viewport=VIEWPORT)
    static_context = browser.new_context(java_script_enabled=False, viewport=VIEWPORT)
    static = static_context.new_page()
    try:
        dynamic.goto(f"{base_url}?type=stories&story={urllib.parse.quote(title)}", wait_until="load")
        # Same reasoning as word_visual_check above -- no pretty-path
        # canonical to wait for here either.
        dynamic.wait_for_selector("#story-content .japanese-sentence", state="visible", timeout=30_000)
        dynamic.wait_for_timeout(170)

        static.goto(f"{base_url}story/{urllib.parse.quote(slug)}/", wait_until="load")
        static.wait_for_selector("#story-content .japanese-sentence", state="visible")
        wait_for_fonts(dynamic)
        wait_for_fonts(static)
        compare_png(
            static.locator("#story-content").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
            dynamic.locator("#story-content").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
            f"story {title!r}",
        )
    finally:
        dynamic.close()
        static_context.close()


def stories_index_visual_check(browser: Browser, base_url: str) -> None:
    dynamic = browser.new_page(viewport=VIEWPORT)
    use_static_story_index_seed(dynamic)
    static_context = browser.new_context(java_script_enabled=False, viewport=VIEWPORT)
    static = static_context.new_page()
    try:
        dynamic.goto(f"{base_url}?type=stories", wait_until="load")
        dynamic.wait_for_selector("#stories .story-card-link", state="visible", timeout=30_000)
        dynamic.wait_for_timeout(200)

        static.goto(f"{base_url}stories/", wait_until="load")
        static.wait_for_selector("#stories .story-card-link", state="visible")
        wait_for_fonts(dynamic)
        wait_for_fonts(static)
        static_png = static.locator("#results-container").screenshot(
            animations="disabled", style=SCREENSHOT_STYLE
        )
        dynamic_png = dynamic.locator("#results-container").screenshot(
            animations="disabled", style=SCREENSHOT_STYLE
        )
        try:
            compare_png(static_png, dynamic_png, "stories index")
        except AssertionError:
            describe = """() => ({
                children: [...document.querySelector('#results-container').children].map(
                    element => ({
                        className: element.className,
                        height: element.getBoundingClientRect().height,
                        display: getComputedStyle(element).display
                    })
                ),
                visibleCards: [...document.querySelectorAll('#stories > li')].filter(
                    element => getComputedStyle(element).display !== 'none'
                ).length,
                firstTitles: [...document.querySelectorAll('#stories > li')].filter(
                    element => getComputedStyle(element).display !== 'none'
                ).slice(0, 10).map(element => element.querySelector('.story-card-link')?.dataset.storyTitle)
            })"""
            print(f"Static stories layout: {static.evaluate(describe)}")
            print(f"Dynamic stories layout: {dynamic.evaluate(describe)}")
            raise
    finally:
        dynamic.close()
        static_context.close()


def feature_visual_check(browser: Browser, base_url: str, feature: str, ready_selector: str) -> None:
    dynamic = browser.new_page(viewport=VIEWPORT)
    dynamic.add_init_script("Math.random = () => 0")
    static_context = browser.new_context(java_script_enabled=False, viewport=VIEWPORT)
    static = static_context.new_page()
    try:
        dynamic.goto(f"{base_url}?type={feature}", wait_until="load")
        dynamic.wait_for_function(
            "typeof results !== 'undefined' && results.length > 0", timeout=30_000
        )
        if feature == "pronunciation":
            # Same fix as capture-feature-pages.py's own pronunciation
            # branch, for the same reason: ?type=pronunciation reaches no
            # code path in this app that calls initPronunciation() on its
            # own (a real, pre-existing gap -- see that script's comment),
            # and calling it too early loses a race with this app's own
            # redundant dictionary-loaded pollers.
            dynamic.wait_for_timeout(1500)
            dynamic.evaluate("() => initPronunciation()")
        dynamic.wait_for_selector(ready_selector, state="visible", timeout=60_000)
        dynamic.wait_for_timeout(250)

        static.goto(f"{base_url}{feature}/", wait_until="load")
        static.wait_for_selector(ready_selector, state="visible")
        if feature == "word-game":
            # Word Game is deliberately the one feature whose captured HTML
            # must not be identical to a fresh browser's live UI. The live
            # entry screen depends on saved placement state, so the capture
            # contains a neutral shell that JavaScript replaces after reading
            # the current visitor's state. Comparing that shell with the live
            # first-time placement screen would reject the intended behavior.
            static_loading_card = static.locator(
                "#results-container .game-intro-card.word-game-loading-card"
            )
            if static_loading_card.count() != 1:
                raise AssertionError("word-game: static page is missing its neutral loading card")
            static_heading = (
                static_loading_card.locator(".game-intro-heading").text_content() or ""
            ).strip()
            if static_heading != "Preparing Word Game":
                raise AssertionError("word-game: static page has the wrong neutral loading state")
            if dynamic.locator("#results-container .word-game-loading-card").count() != 0:
                raise AssertionError("word-game: live page did not replace the neutral loading card")
            if dynamic.locator("#results-container .placement-card").count() != 1:
                raise AssertionError("word-game: fresh live page did not render placement")
        else:
            wait_for_fonts(dynamic)
            wait_for_fonts(static)
            compare_png(
                static.locator("#main-content").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
                dynamic.locator("#main-content").screenshot(animations="disabled", style=SCREENSHOT_STYLE),
                feature,
            )
        # This checks only the STATIC page's own canonical (added by
        # capture-feature-pages.py -- see its docstring), not a comparison
        # against the dynamic page's canonical: the live app never sets one
        # for a plain feature-route navigation at all.
        canonical = static.locator('link[rel="canonical"]').get_attribute("href")
        if canonical != f"https://osloandrew.github.io/japanese/{feature}/":
            raise AssertionError(f"{feature}: wrong static canonical {canonical!r}")
    finally:
        dynamic.close()
        static_context.close()


def heading_semantics_pixel_check(browser: Browser, base_url: str, word: str) -> None:
    """Only the word-page portion of norwegian's check applies here: a story
    page's title is an <h2 class="sticky-title-japanese"> with no <h1> to
    begin with (see this module's docstring), so there is no heading tag
    to swap and re-compare for stories."""
    page = browser.new_page(viewport=VIEWPORT)
    replace_tag = """selectorAndTag => {
        const [selector, tagName] = selectorAndTag;
        const current = document.querySelector(selector);
        if (!current) throw new Error(`Missing heading: ${selector}`);
        const replacement = document.createElement(tagName);
        for (const attribute of current.attributes) {
            replacement.setAttribute(attribute.name, attribute.value);
        }
        replacement.innerHTML = current.innerHTML;
        current.replaceWith(replacement);
    }"""
    try:
        page.goto(f"{base_url}?type=words&word={urllib.parse.quote(word)}", wait_until="load")
        page.wait_for_selector("#results-container h1.word-gender", state="visible", timeout=30_000)
        wait_for_fonts(page)
        header_new = page.locator("header").screenshot(animations="disabled", style=SCREENSHOT_STYLE)
        word_new = page.locator("#results-container").screenshot(animations="disabled", style=SCREENSHOT_STYLE)
        page.evaluate(replace_tag, ["#site-title", "h1"])
        page.evaluate(replace_tag, ["#results-container h1.word-gender", "h2"])
        compare_png(header_new, page.locator("header").screenshot(animations="disabled", style=SCREENSHOT_STYLE), "site title semantic tag")
        compare_png(word_new, page.locator("#results-container").screenshot(animations="disabled", style=SCREENSHOT_STYLE), "word heading semantic tag")
    finally:
        page.close()


def behavior_smoke_check(browser: Browser, base_url: str, word: str, story: str) -> None:
    """Interactive-upgrade smoke test for the captured pages. Deliberately
    narrower than norwegian's: the pretty-path routing assertions there (an
    alternative spelling resolving to /word/<slug>/, a sentence search
    changing location.pathname) test client-side navigation behavior this
    app doesn't have at all (see this module's docstring) and are dropped
    rather than adapted into something that would just always pass/fail on
    an irrelevant premise."""
    page = browser.new_page(viewport=VIEWPORT)
    try:
        page.goto(f"{base_url}word/{urllib.parse.quote(slugify(word))}/", wait_until="load")
        page.wait_for_selector("#results-container .definition", state="visible", timeout=30_000)
        page.wait_for_function("() => document.querySelector('#type-select')?.value === 'words'")
        if page.locator(".definition").count() < 1:
            raise AssertionError("Captured word page did not upgrade to the interactive dictionary")

        page.goto(f"{base_url}story/{urllib.parse.quote(slugify(story))}/", wait_until="load")
        page.wait_for_selector("#story-content .japanese-sentence", state="visible", timeout=30_000)
        toggle = page.locator("#toggle-english-btn")
        english_sentence = page.locator("#story-content .english-sentence").first
        was_visible = english_sentence.is_visible()
        toggle.click()
        try:
            english_sentence.first.wait_for(
                state="hidden" if was_visible else "visible", timeout=5_000
            )
        except PlaywrightTimeoutError:
            raise AssertionError("Captured story page's English toggle is not interactive")

        page.goto(f"{base_url}stories/", wait_until="load")
        page.wait_for_selector("#stories .story-card-link", state="visible", timeout=30_000)
        hidden_before = page.locator(".story-index-hidden").count()
        show_more = page.locator(".stories-load-more-button")
        if hidden_before < 1 or show_more.count() != 1:
            raise AssertionError("Captured stories index is missing its progressive list")
        show_more.click()
        if page.locator(".story-index-hidden").count() >= hidden_before:
            raise AssertionError("Captured stories index's Show More button is not interactive")

        feature_selectors = {
            "sentences": "#results-container .sentence-container",
            "word-game": "#results-container .game-intro-card",
            "pronunciation": "#results-container .sentence-box-practice",
        }
        for feature, selector in feature_selectors.items():
            page.goto(f"{base_url}{feature}/", wait_until="load")
            page.wait_for_selector(selector, state="visible", timeout=60_000)
            if feature == "word-game":
                page.wait_for_selector(
                    "#results-container .word-game-loading-card",
                    state="detached",
                    timeout=60_000,
                )
            # Pronunciation and sentences are deliberately not checked
            # against #type-select here: pronunciation has no option in that
            # dropdown at all (see capture-feature-pages.py), and re-running
            # the same #type-select assertion norwegian uses for both would
            # just reproduce a false failure on a route this app doesn't
            # wire the dropdown to.
            canonical_path = urllib.parse.urlparse(
                page.locator('link[rel="canonical"]').get_attribute("href") or ""
            ).path
            if not canonical_path.endswith(f"/{feature}/"):
                raise AssertionError(f"Captured {feature} page lost its canonical URL")
    finally:
        page.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--site-root", type=Path, default=ROOT)
    parser.add_argument("--word", action="append", default=[])
    parser.add_argument("--story", action="append", default=[])
    parser.add_argument(
        "--root-mount",
        action="store_true",
        help="Serve the site at /, matching VS Code's repository-root preview.",
    )
    args = parser.parse_args()
    words = args.word or ["今日"]
    stories = args.story or ["遊園地での一日"]

    temporary = tempfile.TemporaryDirectory(prefix="japanese-equivalence-")
    temporary_root = Path(temporary.name)
    source_root = args.source_root.resolve()
    site_root = args.site_root.resolve()
    serve_root = temporary_root / "serve"
    serve_root.mkdir()
    overlay_root = serve_root if args.root_mount else serve_root / "japanese"
    if not args.root_mount:
        overlay_root.mkdir()
    generated_names = {
        "word", "story", "stories", "sentences", "word-game", "pronunciation",
        "sitemap.xml", "page-manifest.json"
    }
    for source_item in source_root.iterdir():
        if source_item.name in generated_names:
            continue
        (overlay_root / source_item.name).symlink_to(source_item)
    for name in generated_names:
        preferred = site_root / name
        fallback = source_root / name
        target = preferred if preferred.exists() else fallback
        if target.exists():
            (overlay_root / name).symlink_to(target)
    port = find_free_port()
    handler = lambda *handler_args, **handler_kwargs: QuietHandler(
        *handler_args, directory=str(serve_root), **handler_kwargs
    )
    server = QuietServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    mount_path = "/" if args.root_mount else SITE_PATH
    base_url = f"http://127.0.0.1:{port}{mount_path}"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for word in words:
                word_visual_check(browser, base_url, word)
            for story in stories:
                story_visual_check(browser, base_url, story)
            stories_index_visual_check(browser, base_url)
            feature_visual_check(browser, base_url, "sentences", "#results-container .sentence-container")
            feature_visual_check(browser, base_url, "word-game", "#results-container .game-intro-card")
            feature_visual_check(browser, base_url, "pronunciation", "#results-container .sentence-box-practice")
            heading_semantics_pixel_check(browser, base_url, words[0])
            behavior_smoke_check(browser, base_url, words[0], stories[0])
            browser.close()
    finally:
        server.shutdown()
        temporary.cleanup()
    print(
        f"Verified exact rendering for {len(words)} word page(s), "
        f"{len(stories)} story page(s), the stories index, and three feature pages, plus "
        "interactive upgrade behavior."
    )


if __name__ == "__main__":
    main()
