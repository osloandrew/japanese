#!/usr/bin/env python3
"""Validate exact captured-page completeness and shared-app integrity.

Ported from norwegian/scripts/validate-static-pages.py, adapted for real,
verified differences in this app (see comments at each adapted check):

- CSV columns: japaneseWords.csv uses "word"/"English" (not "ord"/"engelsk"),
  japaneseStories.csv uses "titleJapanese" (STORY_CSV_NAMES from
  story_sources.py already matches).
- No window.__PRELOADED_STORY__: this app's loadStateFromURL() never reads
  that global (see capture-story-pages.py's docstring), so it is never
  injected into a captured story page and must not be required here.
- Story heading: displayStory() renders the story title as
  <h1 class="sticky-title-japanese"> with no `lang` attribute (not
  norwegian's <h1 lang="nb" ...>) -- confirmed by inspecting a real captured
  page. Both words and stories render exactly one real <h1>
  (renderWordDefinition()'s <h1 class="word-gender"> for words, confirmed
  the same way), so the "exactly one <h1>" requirement applies to both.
- FEATURE_PAGES required_text values are the real default-view text/markup
  observed in an actual capture (see capture-feature-pages.py), not guessed:
  "Results for" is the Sentences tab's default heading here, same as
  norwegian -- showSentencesSearchExample() (scripts.js) now renders a real
  "apple" search result there instead of a random sentence, mirroring
  norwegian's own landing state.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

from story_sources import existing_story_csv_paths

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://osloandrew.github.io/japanese"
FEATURE_PAGES = {
    "sentences": "Results for",
    "word-game": "Preparing Word Game",
    "pronunciation": "sentence-box-practice",
}
LOCAL_ASSET_RE = re.compile(r'(?:src|href)="([^":?#]+\.(?:js|css)(?:\?v=[^"]*)?)"')
CANONICAL_RE = re.compile(r'<link rel="canonical" href="([^"]+)">')
PAGE_STRUCTURED_DATA_RE = re.compile(
    r'<script type="application/ld\+json" id="page-structured-data">(.*?)</script>',
    re.DOTALL,
)


class ValidationError(RuntimeError):
    pass


def slugify(value: str) -> str:
    value = (value or "").strip().lower().replace("’", "'")
    value = re.sub(r"[\s/]+", "-", value)
    value = "".join(character for character in value if character.isalnum() or character == "-")
    return re.sub(r"-{2,}", "-", value).strip("-")


def source_values(
    path: Path, column: str, *, primary_word: bool = False, require_english: bool = False
) -> dict[str, str]:
    values: dict[str, str] = {}
    with path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            # Matches parseCSVData()'s own filter in scripts.js: a row with
            # no English translation never becomes a real dictionary entry
            # there, so no static page is captured for it either.
            if require_english and not (row.get("English") or "").strip():
                continue
            value = (row.get(column) or "").strip()
            if primary_word:
                # Alternative spellings are separated by either an ASCII
                # comma or the ideographic comma "、" (e.g. "あ、あっ") — see
                # capture-word-pages.py's load_all_primary_words() for the
                # full explanation.
                value = re.split(r"[,、]", value)[0].strip()
            if value:
                # The page capture keeps the first display spelling when
                # entries differ only by case (for example, "ID" and "id")
                # because both entries intentionally share one canonical URL.
                # Validate against that same spelling instead of replacing it
                # with whichever case variant appears last in the CSV.
                values.setdefault(slugify(value), value)
    return values


def page_slugs(site_root: Path, folder: str) -> set[str]:
    directory = site_root / folder
    if not directory.is_dir():
        raise ValidationError(f"Missing {folder}/ directory")
    items = [item for item in directory.iterdir() if not item.name.startswith(".")]
    unexpected = [item for item in items if not item.is_dir() or not (item / "index.html").is_file()]
    if unexpected:
        raise ValidationError(f"Unexpected generated-page entries: {unexpected[:3]}")
    return {item.name for item in items}


def local_assets(html_source: str) -> set[str]:
    return set(LOCAL_ASSET_RE.findall(html_source))


def validate_page(
    path: Path,
    canonical: str,
    shared_assets: set[str],
    required_text: str,
    expected_base_href: str,
) -> None:
    source = path.read_text(encoding="utf-8")
    canonical_match = CANONICAL_RE.search(source)
    if not canonical_match or urllib.parse.unquote(canonical_match.group(1)) != canonical:
        raise ValidationError(f"Wrong canonical URL in {path}")
    if f'<base href="{expected_base_href}">' not in source:
        raise ValidationError(f"Wrong directory-relative site base in {path}")
    if not shared_assets.issubset(local_assets(source)):
        missing = sorted(shared_assets - local_assets(source))
        raise ValidationError(f"{path} is missing shared app assets: {missing[:5]}")
    if html.escape(required_text, quote=False) not in source:
        raise ValidationError(f"{path} does not contain its rendered source content")
    for required_id in ('id="search-container"', 'id="results-container"'):
        if required_id not in source:
            raise ValidationError(f"{path} is missing the application shell element {required_id}")


def validate_detail_metadata(path: Path, source: str) -> dict[str, object]:
    for attribute, value in (
        ("property", "og:site_name"),
        ("property", "og:image:alt"),
        ("name", "twitter:title"),
        ("name", "twitter:description"),
        ("name", "twitter:image"),
        ("name", "twitter:image:alt"),
    ):
        if not re.search(
            rf'<meta\s+[^>]*{attribute}="{re.escape(value)}"[^>]*>', source
        ):
            raise ValidationError(f"{path} is missing {value} metadata")
    return page_structured_data(path, source)


def page_structured_data(path: Path, source: str) -> dict[str, object]:
    match = PAGE_STRUCTURED_DATA_RE.search(source)
    if not match:
        raise ValidationError(f"{path} is missing page-specific structured data")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise ValidationError(f"{path} has invalid page-specific structured data") from error
    if payload.get("@context") != "https://schema.org" or not isinstance(
        payload.get("@graph"), list
    ):
        raise ValidationError(f"{path} has an invalid page-specific schema graph")
    return payload


def graph_node(payload: dict[str, object], node_type: str) -> dict[str, object] | None:
    return next(
        (
            node
            for node in payload["@graph"]
            if isinstance(node, dict) and node.get("@type") == node_type
        ),
        None,
    )


def validate(source_root: Path, site_root: Path) -> tuple[int, int, int]:
    words = source_values(
        source_root / "japaneseWords.csv", "word", primary_word=True, require_english=True
    )
    stories: dict[str, str] = {}
    for story_csv_path in existing_story_csv_paths(source_root):
        stories.update(source_values(story_csv_path, "titleJapanese"))
    generated_words = page_slugs(site_root, "word")
    generated_stories = page_slugs(site_root, "story")
    if generated_words != set(words):
        raise ValidationError(
            f"Word pages differ from source (missing {len(set(words) - generated_words)}, stale {len(generated_words - set(words))})"
        )
    if generated_stories != set(stories):
        raise ValidationError(
            f"Story pages differ from source (missing {len(set(stories) - generated_stories)}, stale {len(generated_stories - set(stories))})"
        )

    manifest = json.loads((site_root / "page-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("words") != sorted(generated_words) or manifest.get("stories") != sorted(generated_stories):
        raise ValidationError("Page manifest does not exactly match captured pages")

    locations = [node.text for node in ET.parse(site_root / "sitemap.xml").getroot().findall("{*}url/{*}loc")]
    if len(locations) != len(set(locations)):
        raise ValidationError("Sitemap contains duplicate URLs")
    expected_urls = {
        *(f"{SITE}/word/{slug}/" for slug in words),
        *(f"{SITE}/story/{slug}/" for slug in stories),
        f"{SITE}/stories/",
        f"{SITE}/updates/",
        *(f"{SITE}/{feature}/" for feature in FEATURE_PAGES),
    }
    if not expected_urls.issubset(set(locations)):
        raise ValidationError("Sitemap is missing captured-page URLs")
    if any("?type=" in location for location in locations):
        raise ValidationError("Sitemap still contains a query-string feature URL")

    updates_page = site_root / "updates" / "index.html"
    if not updates_page.is_file():
        raise ValidationError("Missing generated Updates page")
    updates_source = updates_page.read_text(encoding="utf-8")
    if f'<link rel="canonical" href="{SITE}/updates/">' not in updates_source:
        raise ValidationError("Updates page has the wrong canonical URL")
    if '<base href="../">' not in updates_source or "What's New" not in updates_source:
        raise ValidationError("Updates page is missing its crawlable content or site base")

    index_source = (source_root / "index.html").read_text(encoding="utf-8")
    shared_assets = local_assets(index_source)
    # Every page is captured from this shell. Checking every one is
    # intentional: a partial or interrupted build must never deploy.
    for slug, word in words.items():
        page = site_root / "word" / slug / "index.html"
        validate_page(
            page,
            f"{SITE}/word/{slug}/",
            shared_assets,
            word,
            "../../",
        )
        page_source = page.read_text(encoding="utf-8")
        if '<h1 class="word-gender' not in page_source or page_source.count("<h1") != 1:
            raise ValidationError(f"Word content heading is not the page H1 in {page}")
        payload = validate_detail_metadata(page, page_source)
        term = graph_node(payload, "DefinedTerm")
        if (
            not term
            or term.get("name") != word
            or term.get("url") != f"{SITE}/word/{slug}/"
        ):
            raise ValidationError(f"{page} has incorrect DefinedTerm structured data")
        if not graph_node(payload, "BreadcrumbList"):
            raise ValidationError(f"{page} is missing breadcrumb structured data")
    for slug, title in stories.items():
        page = site_root / "story" / slug / "index.html"
        validate_page(page, f"{SITE}/story/{slug}/", shared_assets, title, "../../")
        page_source = page.read_text(encoding="utf-8")
        # No window.__PRELOADED_STORY__ requirement here (unlike norwegian)
        # -- see this module's docstring: this app's displayStory() never
        # reads a preloaded-story global at all.
        if (
            '<h1 class="sticky-title-japanese">' not in page_source
            or page_source.count("<h1") != 1
        ):
            raise ValidationError(f"Story content heading is not the page H1 in {page}")
        payload = validate_detail_metadata(page, page_source)
        resource = graph_node(payload, "LearningResource")
        if (
            not resource
            or resource.get("name") != title
            or resource.get("url") != f"{SITE}/story/{slug}/"
        ):
            raise ValidationError(f"{page} has incorrect LearningResource structured data")
        if not graph_node(payload, "BreadcrumbList"):
            raise ValidationError(f"{page} is missing breadcrumb structured data")

    stories_index = site_root / "stories" / "index.html"
    validate_page(
        stories_index,
        f"{SITE}/stories/",
        shared_assets,
        next(iter(stories.values())),
        "../",
    )
    for feature, required_text in FEATURE_PAGES.items():
        validate_page(
            site_root / feature / "index.html",
            f"{SITE}/{feature}/",
            shared_assets,
            required_text,
            "../",
        )
    return len(words), len(stories), len(locations)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--site-root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        word_count, story_count, url_count = validate(args.source_root.resolve(), args.site_root.resolve())
    except (ValidationError, OSError, json.JSONDecodeError, ET.ParseError) as error:
        print(f"Static page validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(f"Validated {word_count} exact word pages, {story_count} exact story pages, and {url_count} sitemap URLs.")


if __name__ == "__main__":
    main()
