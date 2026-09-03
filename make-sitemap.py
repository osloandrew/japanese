#!/usr/bin/env python3
"""Generate sitemap.xml from what's actually on disk.

Lists the site's core app views plus every /word/<slug>/index.html that
scripts/capture-word-pages.py has written. Reading the word/ directory
directly (rather than re-deriving slugs from the CSV independently) means
the sitemap can never list a URL that doesn't actually have a page behind
it — whatever's on disk is exactly what's on the sitemap.

Run after scripts/capture-word-pages.py --all (or any time word/ changes).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

SITE = "https://osloandrew.github.io/japanese"
ROOT = Path(__file__).resolve().parent

SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"
MAX_SITEMAP_URLS = 50_000
MAX_SITEMAP_BYTES = 50 * 1024 * 1024

# Real, distinct application views with meaningful default content — see the
# individual handleTypeChange() branches in scripts.js. Ordinary
# ?type=...&word=...-style search-result states are deliberately not listed
# here: those are per-visit results, not distinct indexable pages, and are
# now properly served by the individual /word/<slug>/ pages instead.
CORE_URLS = [
    f"{SITE}/",
    f"{SITE}/stories/",
    f"{SITE}/sentences/",
    f"{SITE}/word-game/",
    f"{SITE}/pronunciation/",
    f"{SITE}/updates/",
]


def captured_slugs(directory: Path) -> list[str]:
    if not directory.is_dir():
        return []
    return sorted(
        p.name for p in directory.iterdir() if p.is_dir() and (p / "index.html").is_file()
    )


def captured_page_urls(directory: Path, url_prefix: str) -> list[str]:
    return [f"{SITE}/{url_prefix}/{slug}/" for slug in captured_slugs(directory)]


def write_sitemap(urls: list[str], output_file: Path) -> None:
    if len(urls) > MAX_SITEMAP_URLS:
        raise ValueError(f"Sitemap contains {len(urls)} URLs; the maximum is {MAX_SITEMAP_URLS}.")

    ET.register_namespace("", SITEMAP_NAMESPACE)
    urlset = ET.Element(f"{{{SITEMAP_NAMESPACE}}}urlset")

    for page_url in urls:
        url_element = ET.SubElement(urlset, f"{{{SITEMAP_NAMESPACE}}}url")
        location_element = ET.SubElement(url_element, f"{{{SITEMAP_NAMESPACE}}}loc")
        location_element.text = page_url

    tree = ET.ElementTree(urlset)
    ET.indent(tree, space="  ")

    temporary_file = output_file.with_suffix(".xml.tmp")
    tree.write(temporary_file, encoding="utf-8", xml_declaration=False)

    declaration = b'<?xml version="1.0" encoding="UTF-8"?>\n'
    temporary_file.write_bytes(declaration + temporary_file.read_bytes())

    sitemap_size = temporary_file.stat().st_size
    if sitemap_size > MAX_SITEMAP_BYTES:
        temporary_file.unlink(missing_ok=True)
        raise ValueError(f"Sitemap is {sitemap_size} bytes; the maximum is {MAX_SITEMAP_BYTES} bytes.")

    ET.parse(temporary_file)  # raises if the generated XML is invalid
    temporary_file.replace(output_file)


def write_page_manifest(site_root: Path, word_slugs: list[str], story_slugs: list[str]) -> None:
    # Lets the client answer "does a pretty page exist for this word/story"
    # instantly and offline (see updateURL() in scripts.js) instead of
    # guessing or probing the network on every click. Compact on purpose —
    # this ships to every visitor's browser on load.
    #
    # NOTE: unlike norwegian, this app's scripts.js does not currently read
    # page-manifest.json at all (no pageManifest global, no pretty-path
    # rewriting — see the "no pretty-path rewriting" comment on #mode-nav in
    # index.html). The file is still generated here for parity/forward
    # compatibility and because validate-static-pages.py checks it against
    # the generated pages, but nothing in the client consumes it yet.
    import json

    manifest_path = site_root / "page-manifest.json"
    manifest_path.write_text(
        json.dumps({"words": word_slugs, "stories": story_slugs}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {manifest_path} ({manifest_path.stat().st_size} bytes)")


def build(site_root: Path = ROOT) -> None:
    word_slugs = captured_slugs(site_root / "word")
    story_slugs = captured_slugs(site_root / "story")
    word_urls = [f"{SITE}/word/{slug}/" for slug in word_slugs]
    story_urls = [f"{SITE}/story/{slug}/" for slug in story_slugs]

    urls = list(dict.fromkeys(CORE_URLS + word_urls + story_urls))

    output_file = site_root / "sitemap.xml"
    write_sitemap(urls, output_file)
    write_page_manifest(site_root, word_slugs, story_slugs)

    print(f"Wrote {output_file} with {len(urls)} URLs.")
    print(f"  {len(CORE_URLS)} core app views")
    print(f"  {len(word_urls)} word pages")
    print(f"  {len(story_urls)} story pages")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--site-root",
        type=Path,
        default=ROOT,
        help="Site root containing generated word/ and story/ directories.",
    )
    args = parser.parse_args()
    build(args.site_root.resolve())


if __name__ == "__main__":
    main()
