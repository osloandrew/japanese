#!/usr/bin/env python3
"""Make sure the words CSV always carries its stable `id` column.

Re-exporting the CSV from a spreadsheet silently drops the appended `id`
column (and the CI check then fails after the push). This script re-attaches
every row's id from the last committed version of the file -- matching on
(English, primary-word) first, then falling back to a unique match on either
column for rows whose translation or spelling was edited -- and mints fresh
ids only for genuinely new rows. Safe to run any time; a file whose ids are
already intact is left byte-for-byte alone.

Runs automatically from .githooks/pre-commit; manual use:

    python3 scripts/restore-word-ids.py
"""
import csv
import io
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = next(ROOT.glob("*Words.csv"))
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def read(text):
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"), newline="")))
    return rows[0], rows[1:]


def committed_rows():
    try:
        text = subprocess.check_output(
            ["git", "show", f"HEAD:{CSV_PATH.name}"], cwd=ROOT, stderr=subprocess.DEVNULL
        ).decode("utf-8")
    except subprocess.CalledProcessError:
        return []
    header, rows = read(text)
    if "id" not in header:
        return []
    i = header.index("id")
    return [(r[0], r[3], r[i]) for r in rows if len(r) > i and r[i].strip()]


def main():
    header, rows = read(CSV_PATH.read_text(encoding="utf-8"))
    if "id" not in header:
        header.append("id")
    id_i = header.index("id")
    for r in rows:
        r.extend([""] * (id_i + 1 - len(r)))

    old = committed_rows()
    by_key = {}
    for e, w, i in old:
        by_key.setdefault((e, w), i)
    current_keys = {(r[0], r[3]) for r in rows}
    orphans = [o for o in old if (o[0], o[1]) not in current_keys]

    used = {r[id_i].strip() for r in rows if r[id_i].strip()}
    changed = False
    for r in rows:
        if r[id_i].strip():
            continue
        cand = by_key.get((r[0], r[3]))
        if not cand:
            pool = [o[2] for o in orphans if o[0] == r[0] and o[2] not in used]
            pool = pool or [o[2] for o in orphans if o[1] == r[3] and o[2] not in used]
            cand = pool[0] if len(pool) == 1 else None
        if cand and cand in used:
            cand = None
        while not cand or cand in used:
            cand = "".join(secrets.choice(ALPHABET) for _ in range(10))
        used.add(cand)
        r[id_i] = cand
        changed = True

    if changed or header[-1] != "id":
        with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\r\n")
            w.writerow(header)
            w.writerows(rows)
        print(f"{CSV_PATH.name}: restored/assigned missing ids")
    return 0


if __name__ == "__main__":
    sys.exit(main())
