#!/usr/bin/env python3
"""Verify every row in japaneseWords.csv has a non-empty, unique `id`.

The `id` column is the stable key My Words/word-strength records are saved
under (see getMyWordsEntryId in wordList.js) — deliberately independent of
every other column so editing a word's definition, translation, reading, or
class can never orphan a saved word. That guarantee only holds if every row
actually has one and no two rows share one, which this check enforces for
new rows the same way build-definitions.py enforces the definition column
staying in sync.
"""
import csv
import pathlib
import sys

CSV_PATH = pathlib.Path(__file__).resolve().parent.parent / "japaneseWords.csv"


def main():
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    if "id" not in (rows[0].keys() if rows else []):
        print(f"::error::{CSV_PATH.name} has no `id` column.")
        return 1

    missing = []
    seen = {}
    duplicates = set()

    for line_number, row in enumerate(rows, start=2):
        word_id = (row.get("id") or "").strip()
        word = row.get("word") or "(blank)"

        if not word_id:
            missing.append(f"  line {line_number}: {word}")
            continue

        if word_id in seen:
            duplicates.add(word_id)
        seen.setdefault(word_id, []).append(f"line {line_number}: {word}")

    problems = []

    if missing:
        problems.append(
            "Row(s) with no id (every row needs one — see wordList.js's "
            "getMyWordsEntryId):\n" + "\n".join(missing)
        )

    for word_id in sorted(duplicates):
        problems.append(
            f"id '{word_id}' is reused by multiple rows:\n"
            + "\n".join(f"  {entry}" for entry in seen[word_id])
        )

    if problems:
        print(f"::error::{CSV_PATH.name} id column has problems:\n\n" + "\n\n".join(problems))
        return 1

    print(f"{CSV_PATH.name}: {len(rows)} rows, all with a unique id.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
