"""Shared helpers for reading the app's story-catalog CSV(s) together:

- japaneseStories.csv — the app's primary story catalog.
- japaneseAuthenticStories.csv — reserved for real, licensed web sources,
  mirroring norwegian's norwegianAuthenticStories.csv (see that repo's
  import-authentic-story.py and AUTHENTIC_STORIES_DATA.md). This file does
  not exist yet in this repo; every function below treats its absence as
  "no rows from it" rather than an error, so this module works unchanged if
  it's adopted later.

Both are read the same way stories.js reads them client-side
(fetchFreshStoryData): as one combined catalog, keyed by titleJapanese. The
second file is optional everywhere in this module.
"""

from __future__ import annotations

import csv
from pathlib import Path

STORY_CSV_NAMES = ("japaneseStories.csv", "japaneseAuthenticStories.csv")


def story_csv_paths(root: Path) -> tuple[Path, ...]:
    """Both story CSV paths under root, in a fixed, stable order — original
    stories first, then authentic/sourced ones — regardless of whether each
    one currently exists."""
    return tuple(root / name for name in STORY_CSV_NAMES)


def existing_story_csv_paths(root: Path) -> tuple[Path, ...]:
    return tuple(path for path in story_csv_paths(root) if path.is_file())


def read_story_rows(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def load_all_story_titles(root: Path) -> list[str]:
    """Every distinct titleJapanese across both CSVs, first-seen order."""
    seen: dict[str, str] = {}
    for path in story_csv_paths(root):
        for row in read_story_rows(path):
            title = (row.get("titleJapanese") or "").strip()
            if title and title.lower() not in seen:
                seen[title.lower()] = title
    return list(seen.values())
