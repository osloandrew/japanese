#!/usr/bin/env python3
"""Build the browser frequency sidecar from NINJAL's BCCWJ LUW list."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path


SOURCE_URL = (
    "https://repository.ninjal.ac.jp/record/3230/files/"
    "BCCWJ_frequencylist_luw2_ver1_0.zip"
)
SOURCE_DOI = "https://doi.org/10.15084/00003214"
CEFR_BANDS = ("A1", "A2", "B1", "B2", "C")


def source_match_key(value: str) -> str:
    value = unicodedata.normalize("NFC", value or "")
    return re.sub(r"[\s・･（）()、,，/\[\]〜~]", "", value).lower()


def primary_form(value: str) -> str:
    return re.split(r"[,、]", value or "", maxsplit=1)[0].strip()


def runtime_key(word: str, word_class: str) -> str:
    # Mirrors getVocabularyFrequencyEntryKey() in wordGame.js.
    displayed_word = " ".join(primary_form(word).split()).lower()
    return f"{unicodedata.normalize('NFC', displayed_word)}|{unicodedata.normalize('NFC', word_class.strip().lower())}"


def read_bccwj(source_zip: Path) -> dict[str, dict[str, int]]:
    lemmas: dict[str, dict[str, int]] = {}
    with zipfile.ZipFile(source_zip) as archive:
        tsv_names = [name for name in archive.namelist() if name.endswith(".tsv")]
        if len(tsv_names) != 1:
            raise ValueError("Expected exactly one TSV in the BCCWJ archive")
        with archive.open(tsv_names[0]) as raw:
            rows = csv.DictReader(
                io.TextIOWrapper(raw, encoding="utf-8-sig"), delimiter="\t"
            )
            for row in rows:
                lemma = source_match_key(row.get("lemma", ""))
                if not lemma:
                    continue
                try:
                    frequency = int(row["frequency"])
                    source_rank = int(row["rank"])
                except (KeyError, TypeError, ValueError):
                    continue
                record = lemmas.setdefault(
                    lemma, {"frequency": 0, "sourceRank": source_rank}
                )
                # POS rows are disjoint observations of the same written lemma.
                record["frequency"] += frequency
                record["sourceRank"] = min(record["sourceRank"], source_rank)
    return lemmas


def build(source_zip: Path, dictionary_csv: Path) -> dict:
    lemmas = read_bccwj(source_zip)
    grouped: dict[str, dict] = {}

    with dictionary_csv.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))

    for row in rows:
        word = row.get("word", "")
        key = runtime_key(word, row.get("gender", ""))
        match = lemmas.get(source_match_key(primary_form(word)))
        if not key or not match:
            continue
        record = grouped.setdefault(
            key,
            {
                "frequency": match["frequency"],
                "sourceRank": match["sourceRank"],
                "bands": set(),
            },
        )
        cefr = (row.get("CEFR") or "").strip().upper()
        if cefr in CEFR_BANDS:
            record["bands"].add(cefr)

    log_frequencies = [math.log1p(item["frequency"]) for item in grouped.values()]
    minimum = min(log_frequencies)
    maximum = max(log_frequencies)
    span = maximum - minimum or 1
    for item in grouped.values():
        item["weight"] = (math.log1p(item["frequency"]) - minimum) / span

    ordered = sorted(grouped.items(), key=lambda pair: (-pair[1]["weight"], pair[0]))
    for rank, (_, item) in enumerate(ordered, start=1):
        item["rank"] = rank

    by_band: dict[str, list[dict]] = defaultdict(list)
    for item in grouped.values():
        for band in item["bands"]:
            by_band[band].append(item)
    for band, items in by_band.items():
        values = [item["weight"] for item in items]
        low, high = min(values), max(values)
        band_span = high - low or 1
        for item in items:
            item.setdefault("bandPercentiles", {})[band] = round(
                (item["weight"] - low) / band_span, 6
            )

    entries = {}
    for key, item in sorted(grouped.items()):
        entries[key] = {
            "rank": item["rank"],
            "weight": round(item["weight"], 6),
            "sources": {
                "bccwj": {
                    "count": item["frequency"],
                    "coverage": "exact-lemma",
                    "sourceRank": item["sourceRank"],
                }
            },
            "bandPercentiles": item.get("bandPercentiles", {}),
        }

    source_hash = hashlib.sha256(source_zip.read_bytes()).hexdigest()
    return {
        "version": 5,
        "sources": {
            "bccwj": {
                "source": SOURCE_DOI,
                "download": SOURCE_URL,
                "sourceCorpus": "Balanced Corpus of Contemporary Written Japanese",
                "sourceFile": source_zip.name,
                "license": "Free for research or educational purposes",
                "sha256": source_hash,
                "sourceLemmas": len(lemmas),
                "matchedDictionaryEntries": len(entries),
            }
        },
        "method": "exact-primary-lemma-match",
        "dictionaryRows": len(rows),
        "matchedDictionaryEntries": len(entries),
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Path to the versioned BCCWJ_frequencylist_luw2_ver1_0.zip archive",
    )
    parser.add_argument("--dictionary", type=Path, default=Path("japaneseWords.csv"))
    parser.add_argument("--output", type=Path, default=Path("vocabulary-frequency.json"))
    args = parser.parse_args()

    payload = build(args.source, args.dictionary)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {args.output} with {payload['matchedDictionaryEntries']} matched entries "
        f"from {payload['dictionaryRows']} dictionary rows."
    )


if __name__ == "__main__":
    main()
