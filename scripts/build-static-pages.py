#!/usr/bin/env python3
"""Build crawlable pages by capturing the real rendered application.

This is the canonical production build. It deliberately delegates rendering
to the same JavaScript functions visitors use; the generated documents are
not a second, simplified implementation of the UI. A compatible validated
render cache can be updated from source-data diffs; renderer changes and cache
misses always fall back to a complete capture.

Ported from norwegian/scripts/build-static-pages.py. Two Norwegian-only data
sources are deliberately not part of this build: storyQuestions.json (a
story-quiz feature; this app has no storyQuiz.js and stories.js never
references story questions) and japaneseSounds.csv (a client-side "minimal
pairs" data file for the Word Game, loaded lazily by wordGame.js on demand —
never touched by the page-capture pipeline in norwegian either, so nothing
changes here).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from story_sources import STORY_CSV_NAMES, existing_story_csv_paths

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_VERSION = 2
# STORY_CSV_NAMES (japaneseStories.csv, japaneseAuthenticStories.csv — see
# story_sources.py) are both snapshotted and diffed independently, same as
# every other source file here; the second is optional (see
# read_csv_dataset_or_empty) so a checkout without it still builds.
SNAPSHOT_FILENAMES = (
    "japaneseWords.csv",
    *STORY_CSV_NAMES,
)
FEATURE_PAGE_FOLDERS = ("sentences", "word-game", "pronunciation")
# Avoid exceeding the platform command-line limit after an unusually broad
# data edit. At that point a complete capture of that page family is simpler
# and safer than passing thousands of individual values to the child script.
MAX_SELECTIVE_PAGES = 1_000


class BuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class CsvDataset:
    fieldnames: tuple[str, ...]
    rows: tuple[dict[str, str], ...]

    @property
    def signature(self) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]]:
        return (
            self.fieldnames,
            tuple(
                tuple(row.get(field, "") for field in self.fieldnames)
                for row in self.rows
            ),
        )


@dataclass(frozen=True)
class IncrementalPlan:
    words: tuple[str, ...]
    stories: tuple[str, ...]
    words_changed: bool
    stories_changed: bool

    @property
    def rebuild_features(self) -> bool:
        return self.words_changed

    @property
    def rebuild_story_index(self) -> bool:
        return self.stories_changed

def slugify(value: str) -> str:
    value = (value or "").strip().lower().replace("’", "'")
    value = re.sub(r"[\s/]+", "-", value)
    value = "".join(character for character in value if character.isalnum() or character == "-")
    return re.sub(r"-{2,}", "-", value).strip("-")


def source_slugs(csv_path: Path, column: str, *, primary_word: bool = False) -> set[str]:
    slugs: dict[str, str] = {}
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            value = (row.get(column) or "").strip()
            if primary_word:
                value = value.split(",", 1)[0].strip()
            if not value:
                continue
            current_slug = slugify(value)
            if not current_slug:
                raise BuildError(f"{csv_path.name}: {value!r} produces an empty slug")
            previous = slugs.get(current_slug)
            if previous is not None and previous.casefold() != value.casefold():
                raise BuildError(
                    f"{csv_path.name}: {previous!r} and {value!r} both produce /{current_slug}/"
                )
            slugs[current_slug] = value
    return set(slugs)


def read_csv_dataset(path: Path) -> CsvDataset:
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise BuildError(f"{path.name}: missing CSV header")
        fieldnames = tuple(reader.fieldnames)
        rows: list[dict[str, str]] = []
        for line_number, row in enumerate(reader, start=2):
            if None in row:
                raise BuildError(f"{path.name}:{line_number}: row has more values than the header")
            rows.append({field: row.get(field) or "" for field in fieldnames})
    return CsvDataset(fieldnames, tuple(rows))


EMPTY_CSV_DATASET = CsvDataset((), ())


def read_csv_dataset_or_empty(path: Path) -> CsvDataset:
    """Like read_csv_dataset, but a missing or genuinely empty file (an
    optional story CSV that doesn't exist on this fork, or its own empty
    snapshot placeholder — see write_snapshot) reads as EMPTY_CSV_DATASET
    rather than raising."""
    if not path.is_file() or path.stat().st_size == 0:
        return EMPTY_CSV_DATASET
    return read_csv_dataset(path)


def row_signature(row: dict[str, str]) -> tuple[tuple[str, str], ...]:
    """Stable, conservative signature for everything the browser receives."""
    return tuple(sorted(row.items()))


def primary_word(row: dict[str, str]) -> str:
    return (row.get("word") or "").split(",", 1)[0].strip()


def word_forms(row: dict[str, str]) -> tuple[str, ...]:
    return tuple(
        form.strip().lower()
        for form in (row.get("word") or "").split(",")
        if form.strip()
    )


def word_render_index(
    dataset: CsvDataset,
) -> dict[str, tuple[tuple[tuple[str, str], ...], ...]]:
    """Map every spelling to the ordered CSV rows its static page renders."""
    index: dict[str, list[tuple[tuple[str, str], ...]]] = {}
    for row in dataset.rows:
        signature = row_signature(row)
        for form in word_forms(row):
            index.setdefault(form, []).append(signature)
    return {form: tuple(signatures) for form, signatures in index.items()}


def primary_words(dataset: CsvDataset) -> dict[str, str]:
    values: dict[str, str] = {}
    for row in dataset.rows:
        value = primary_word(row)
        if value:
            values.setdefault(value.lower(), value)
    return values


def story_rows(
    dataset: CsvDataset,
) -> dict[str, tuple[tuple[tuple[str, str], ...], ...]]:
    values: dict[str, list[tuple[tuple[str, str], ...]]] = {}
    for row in dataset.rows:
        title = (row.get("titleJapanese") or "").strip()
        if title:
            values.setdefault(title, []).append(row_signature(row))
    return {title: tuple(signatures) for title, signatures in values.items()}


def plan_incremental_build(
    old_words: CsvDataset,
    new_words: CsvDataset,
    old_stories: tuple[CsvDataset, ...],
    new_stories: tuple[CsvDataset, ...],
) -> IncrementalPlan:
    """old_stories/new_stories are one CsvDataset per file in STORY_CSV_NAMES,
    same order, diffed independently and merged — see story_sources.py.
    Independent diffing (rather than concatenating rows into one dataset)
    matters because the two files have different columns: mixing rows would
    lose the authentic CSV's source/license/image columns from the change
    signature entirely."""
    old_word_index = word_render_index(old_words)
    new_word_index = word_render_index(new_words)
    old_primaries = primary_words(old_words)
    new_primaries = primary_words(new_words)
    affected_word_keys = {
        key
        for key in set(old_primaries) | set(new_primaries)
        if old_word_index.get(key, ()) != new_word_index.get(key, ())
    }
    affected_words = tuple(
        sorted(
            (new_primaries[key] for key in affected_word_keys if key in new_primaries),
            key=slugify,
        )
    )

    old_story_rows: dict[str, tuple] = {}
    new_story_rows: dict[str, tuple] = {}
    stories_changed = False
    for old_dataset, new_dataset in zip(old_stories, new_stories):
        old_story_rows.update(story_rows(old_dataset))
        new_story_rows.update(story_rows(new_dataset))
        if old_dataset.signature != new_dataset.signature:
            stories_changed = True
    affected_story_titles = {
        title
        for title in set(old_story_rows) | set(new_story_rows)
        if old_story_rows.get(title, ()) != new_story_rows.get(title, ())
    }
    affected_stories = tuple(
        sorted(
            (title for title in affected_story_titles if title in new_story_rows),
            key=slugify,
        )
    )

    return IncrementalPlan(
        words=affected_words,
        stories=affected_stories,
        words_changed=old_words.signature != new_words.signature,
        stories_changed=stories_changed,
    )


def snapshot_paths(snapshot_dir: Path) -> dict[str, Path]:
    return {name: snapshot_dir / name for name in SNAPSHOT_FILENAMES}


def snapshot_is_available(snapshot_dir: Path) -> bool:
    metadata = snapshot_dir / "metadata.json"
    try:
        value = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return value == {"version": SNAPSHOT_VERSION} and all(
        path.is_file() for path in snapshot_paths(snapshot_dir).values()
    )


def write_snapshot(snapshot_dir: Path) -> None:
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    for name, destination in snapshot_paths(snapshot_dir).items():
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        source = ROOT / name
        if source.is_file():
            shutil.copyfile(source, temporary)
        else:
            # Optional story CSV (japaneseAuthenticStories.csv) absent on
            # this fork — an empty placeholder snapshot, not a missing file,
            # so snapshot_is_available()'s all-files-present check still
            # passes and later reads see EMPTY_CSV_DATASET / no slugs.
            temporary.write_bytes(b"")
        temporary.replace(destination)
    metadata = snapshot_dir / "metadata.json"
    temporary_metadata = metadata.with_suffix(".json.tmp")
    temporary_metadata.write_text(
        json.dumps({"version": SNAPSHOT_VERSION}, separators=(",", ":")),
        encoding="utf-8",
    )
    temporary_metadata.replace(metadata)


def cached_site_is_complete(site_root: Path, snapshot_dir: Path) -> bool:
    try:
        expected_words = source_slugs(
            snapshot_dir / "japaneseWords.csv", "word", primary_word=True
        )
        expected_stories: set[str] = set()
        for story_csv_name in STORY_CSV_NAMES:
            expected_stories |= source_slugs(
                snapshot_dir / story_csv_name, "titleJapanese"
            )
    except (BuildError, OSError):
        return False

    def generated_slugs(folder: str) -> set[str] | None:
        directory = site_root / folder
        if not directory.is_dir():
            return None
        slugs: set[str] = set()
        for child in directory.iterdir():
            if child.name.startswith("."):
                continue
            if (
                not child.is_dir()
                or child.is_symlink()
                or not (child / "index.html").is_file()
            ):
                return None
            slugs.add(child.name)
        return slugs

    if (
        generated_slugs("word") != expected_words
        or generated_slugs("story") != expected_stories
    ):
        return False
    required_files = [
        site_root / "stories" / "index.html",
        site_root / "updates" / "index.html",
        site_root / "sitemap.xml",
        site_root / "page-manifest.json",
        *(site_root / folder / "index.html" for folder in FEATURE_PAGE_FOLDERS),
    ]
    return all(path.is_file() for path in required_files)


def prune_stale_pages(directory: Path, expected_slugs: set[str]) -> list[Path]:
    """Remove only generated slug directories absent from current source data."""
    removed: list[Path] = []
    if not directory.exists():
        return removed
    if directory.is_symlink() or not directory.is_dir():
        raise BuildError(f"Refusing to prune non-directory target: {directory}")
    for child in directory.iterdir():
        if child.name.startswith("."):
            continue
        if not child.is_dir() or child.is_symlink():
            raise BuildError(f"Unexpected item in generated page directory: {child}")
        if child.name not in expected_slugs:
            shutil.rmtree(child)
            removed.append(child)
    return removed


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def capture_selected(
    script: str, option: str, values: tuple[str, ...], site_root: Path
) -> None:
    if not values:
        return
    if len(values) > MAX_SELECTIVE_PAGES:
        print(
            f"{len(values)} affected pages exceeds the selective limit; "
            "recapturing this page family."
        )
        run([sys.executable, script, "--all", "--output-root", str(site_root)])
        return
    run([sys.executable, script, option, *values, "--output-root", str(site_root)])


def full_capture(site_root: Path) -> None:
    run(
        [
            sys.executable,
            "scripts/capture-word-pages.py",
            "--all",
            "--output-root",
            str(site_root),
        ]
    )
    run(
        [
            sys.executable,
            "scripts/capture-story-pages.py",
            "--all",
            "--output-root",
            str(site_root),
        ]
    )
    run(
        [
            sys.executable,
            "scripts/capture-feature-pages.py",
            "--output-root",
            str(site_root),
        ]
    )
    run([sys.executable, "make-sitemap.py", "--site-root", str(site_root)])
    run(
        [
            sys.executable,
            "scripts/build-stories-index.py",
            "--output-root",
            str(site_root),
        ]
    )


def incremental_capture(site_root: Path, snapshot_dir: Path) -> IncrementalPlan:
    paths = snapshot_paths(snapshot_dir)
    plan = plan_incremental_build(
        read_csv_dataset(paths["japaneseWords.csv"]),
        read_csv_dataset(ROOT / "japaneseWords.csv"),
        tuple(read_csv_dataset_or_empty(paths[name]) for name in STORY_CSV_NAMES),
        tuple(read_csv_dataset_or_empty(ROOT / name) for name in STORY_CSV_NAMES),
    )
    print(
        "Incremental plan: "
        f"{len(plan.words)} word page(s), {len(plan.stories)} story page(s), "
        f"features={'yes' if plan.rebuild_features else 'no'}, "
        f"story index={'yes' if plan.rebuild_story_index else 'no'}."
    )
    capture_selected(
        "scripts/capture-word-pages.py", "--words", plan.words, site_root
    )
    capture_selected(
        "scripts/capture-story-pages.py", "--titles", plan.stories, site_root
    )
    if plan.rebuild_features:
        run(
            [
                sys.executable,
                "scripts/capture-feature-pages.py",
                "--output-root",
                str(site_root),
            ]
        )

    # Story cards depend on the final set of pretty story URLs.
    run([sys.executable, "make-sitemap.py", "--site-root", str(site_root)])
    if plan.rebuild_story_index:
        run(
            [
                sys.executable,
                "scripts/build-stories-index.py",
                "--output-root",
                str(site_root),
            ]
        )
    return plan


def build(
    site_root: Path,
    *,
    prune: bool = True,
    stamp_assets: bool = True,
    incremental: bool = False,
    snapshot_dir: Path | None = None,
) -> None:
    site_root = site_root.resolve()
    snapshot_dir = (snapshot_dir or site_root / ".pages-cache").resolve()
    if stamp_assets:
        run([sys.executable, "scripts/stamp-asset-versions.py"])
    # This inexpensive page is rebuilt on every deployment so newly pushed
    # [update] commits appear immediately, even when the larger rendered-page
    # cache is otherwise reusable.
    run(
        [
            sys.executable,
            "scripts/build-updates-page.py",
            "--site-root",
            str(site_root),
        ]
    )

    word_slugs = source_slugs(ROOT / "japaneseWords.csv", "word", primary_word=True)
    story_slugs: set[str] = set()
    for story_csv_path in existing_story_csv_paths(ROOT):
        story_slugs |= source_slugs(story_csv_path, "titleJapanese")
    can_build_incrementally = (
        incremental
        and snapshot_is_available(snapshot_dir)
        and cached_site_is_complete(site_root, snapshot_dir)
    )
    if prune:
        removed_words = prune_stale_pages(site_root / "word", word_slugs)
        removed_stories = prune_stale_pages(site_root / "story", story_slugs)
        print(
            f"Pruned {len(removed_words)} stale word page(s) and "
            f"{len(removed_stories)} stale story page(s)."
        )

    if can_build_incrementally:
        incremental_capture(site_root, snapshot_dir)
    else:
        if incremental:
            print("No complete compatible page cache found; running a full capture.")
        full_capture(site_root)
    # Regenerate once more after every page family is complete. This is
    # intentionally cheap and makes the final output self-consistent.
    run([sys.executable, "make-sitemap.py", "--site-root", str(site_root)])
    run(
        [
            sys.executable,
            "scripts/validate-static-pages.py",
            "--site-root",
            str(site_root),
        ]
    )
    write_snapshot(snapshot_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--site-root",
        type=Path,
        default=ROOT,
        help="Deployment checkout into which exact captured pages are written.",
    )
    parser.add_argument(
        "--no-prune", action="store_true", help="Keep stale generated slug directories"
    )
    parser.add_argument(
        "--no-stamp", action="store_true", help="Do not refresh shared asset hashes first"
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Reuse a compatible generated-page cache and recapture only data-dependent pages",
    )
    parser.add_argument(
        "--snapshot-dir",
        type=Path,
        help="Stored source snapshots used to calculate incremental page dependencies",
    )
    args = parser.parse_args()
    try:
        build(
            args.site_root,
            prune=not args.no_prune,
            stamp_assets=not args.no_stamp,
            incremental=args.incremental,
            snapshot_dir=args.snapshot_dir,
        )
    except (BuildError, OSError, subprocess.CalledProcessError) as error:
        print(f"Static page build failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
