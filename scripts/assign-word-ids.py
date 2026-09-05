#!/usr/bin/env python3
"""Assign a stable `id` to every japaneseWords.csv row that doesn't have one.

The `id` column is the stable key My Words/word-strength records are saved
under (see getMyWordsEntryId in wordList.js) -- generated once per row and
never recomputed, so it survives edits to any other column and, since it
travels with the row rather than being derived from its position, survives
rows being added, removed, or reordered too.

ids are random tokens rather than a sequential counter: japaneseWords.csv
rows get added on separate branches all the time, and two branches each
computing "next sequential id" from their own view of the file would very
likely collide on merge, silently reassigning one branch's new word onto
the other's. Random tokens make that collision astronomically unlikely
instead.

Only rows with a blank `id` are touched -- safe to re-run any time new rows
without one show up (a manual addition, a merge, ...). Existing ids are
never regenerated, since doing so would orphan whatever they're already
saved under (see scripts/check-word-ids.py, which enforces that every row
ends up with one, and wordList.js's migrateMyWordsEntryIds, which only
protects a *pre-existing* id from being reassigned by content changes --
not from being overwritten outright).

Usage:

    python3 scripts/assign-word-ids.py
"""
import csv
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "japaneseWords.csv"

ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
ID_LENGTH = 10


def new_id(existing):
    while True:
        candidate = "".join(secrets.choice(ID_ALPHABET) for _ in range(ID_LENGTH))
        if candidate not in existing:
            return candidate


def main():
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    if "id" in header:
        id_i = header.index("id")
    else:
        # Appended, not inserted at the front -- build-definitions.py's
        # blank-row filter checks row[0] on the assumption it's "English",
        # and several other scripts/CSV consumers expect the existing
        # column order; appending avoids disturbing any of that.
        header.append("id")
        id_i = len(header) - 1
        for row in rows:
            row.append("")

    for row in rows:
        while len(row) <= id_i:
            row.append("")

    existing_ids = {row[id_i].strip() for row in rows if row[id_i].strip()}

    assigned = 0
    for row in rows:
        if not row[id_i].strip():
            word_id = new_id(existing_ids)
            existing_ids.add(word_id)
            row[id_i] = word_id
            assigned += 1

    with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)

    print(
        f"{CSV_PATH.name}: assigned {assigned} new id(s); "
        f"{len(rows) - assigned} row(s) already had one."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
