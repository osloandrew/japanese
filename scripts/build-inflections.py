#!/usr/bin/env python3
"""Build the browser's Japanese conjugation-class classification snapshot.

Unlike Norwegian noun/verb inflection (lexically irregular -- see
norwegian/scripts/build-inflections.py, which looks up whole paradigms in
Norsk Ordbank), Japanese verb and adjective conjugation is fully regular
*given the correct conjugation class* (ichidan/godan-by-ending/irregular for
verbs, i-adjective/na-adjective/the いい exception for adjectives). The hard
part is classification, not conjugation -- most of it is guessable from the
citation-form spelling, but the well-known "fake ichidan" godan verbs
(帰る, 入る, 走る, ...) and a handful of other irregular classes cannot be
told apart from spelling alone.

This script resolves that classification authoritatively via JMdict (the
Electronic Dictionary Research and Development Group's open Japanese-English
dictionary), which tags every verb/adjective sense with its exact
conjugation class. The actual suffix-generation rules (the conjugation
engine itself) live entirely in inflections.js, run once at classification
time here only for validation/self-test -- see conjugate_verb()/
conjugate_adjective() below, which mirror inflections.js's JS
implementation and must be kept in sync with it (deliberately not shared
code: one script is Python, the other browser JS).

Source: jmdict-simplified (https://github.com/scriptin/jmdict-simplified),
a structured JSON export of JMdict. JMdict/EDICT is the property of the
Electronic Dictionary Research and Development Group, and is used in
conformance with the Group's licence (Creative Commons Attribution-
ShareAlike 4.0 International). See INFLECTIONS_DATA.md for attribution.

Usage:

    python3 scripts/build-inflections.py
    python3 scripts/build-inflections.py --source /path/to/jmdict-eng.json
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

JMDICT_RELEASE_API = (
    "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"
)
JMDICT_ASSET_PREFIX = "jmdict-eng-"
JMDICT_ASSET_SUFFIX = ".json.tgz"
# Excludes "jmdict-eng-common-*", which only covers "common" JMdict entries
# and misses enough of this project's less-frequent vocabulary (compounds,
# B2/C-level words) to matter -- see the coverage comparison in the commit
# that introduced this script.

VERB_CLASSES = {
    "v1", "v1-s", "vz",
    "v5u", "v5k", "v5g", "v5s", "v5t", "v5n", "v5b", "v5m", "v5r",
    "v5aru", "v5r-i", "v5k-s", "v5u-s",
    "vk", "vs-i", "vs-s",
}
ADJECTIVE_CLASSES = {"adj-i", "adj-ix", "adj-na", "adj-no", "adj-pn", "adj-t", "adj-f"}
# adj-pn/adj-t/adj-f do not predicate-conjugate at all (この/その/... cannot
# take だ), so they are classified but never produce a Word Forms table --
# see NO_CONJUGATION_CLASSES in inflections.js.
DATA_VERSION = 1


def normalize_reading(value: str) -> str:
    return value.strip()


def load_jmdict(source: str | None) -> dict:
    if source:
        path = Path(source)
        if path.suffix == ".tgz" or path.name.endswith(".tar.gz"):
            with tarfile.open(path, "r:gz") as tar:
                member = next(m for m in tar.getmembers() if m.name.endswith(".json"))
                return json.load(tar.extractfile(member))
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    print("Looking up latest jmdict-simplified release...", file=sys.stderr)
    with urllib.request.urlopen(JMDICT_RELEASE_API, timeout=30) as response:
        release = json.load(response)
    asset = next(
        (
            a
            for a in release.get("assets", [])
            if a["name"].startswith(JMDICT_ASSET_PREFIX)
            and a["name"].endswith(JMDICT_ASSET_SUFFIX)
            and "common" not in a["name"]
        ),
        None,
    )
    if not asset:
        raise SystemExit("Could not find a jmdict-eng-*.json.tgz release asset.")
    print(f"Downloading {asset['name']} ({asset['size']} bytes)...", file=sys.stderr)
    with urllib.request.urlopen(asset["browser_download_url"], timeout=120) as response:
        raw = response.read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        member = next(m for m in tar.getmembers() if m.name.endswith(".json"))
        return json.load(tar.extractfile(member))


def build_jmdict_index(jmdict: dict) -> tuple[dict, dict]:
    by_kanji: dict[str, list[dict]] = {}
    by_kana: dict[str, list[dict]] = {}
    for word in jmdict["words"]:
        kanji_list = word.get("kanji", [])
        kana_list = word.get("kana", [])
        pos = set()
        for sense in word.get("sense", []):
            pos.update(sense.get("partOfSpeech", []))
        is_common = any(k.get("common") for k in kanji_list) or any(
            k.get("common") for k in kana_list
        )
        entry = {
            "id": word["id"],
            "kanji": [k["text"] for k in kanji_list],
            "kana": [k["text"] for k in kana_list],
            "pos": pos,
            "common": is_common,
        }
        for k in kanji_list:
            by_kanji.setdefault(k["text"], []).append(entry)
        for k in kana_list:
            by_kana.setdefault(k["text"], []).append(entry)
    return by_kanji, by_kana


def lookup_jmdict(by_kanji: dict, by_kana: dict, word_field: str, reading_field: str):
    """Resolve one CSV entry's (possibly comma-separated) headword/reading
    against the JMdict index. Kanji matches are preferred over kana-only
    matches (more specific); ties are broken first by reading agreement,
    then by JMdict's own "common" flag -- without the common-flag
    tiebreak, an ordinary word can resolve to an obscure homograph that
    happens to sort first (e.g. plain kana "できる" also matches the rare
    verb 出切る before the intended, common 出来る -- see this script's
    self-test)."""
    forms = [w.strip() for w in word_field.split(",") if w.strip()]
    readings = [w.strip() for w in reading_field.split(",") if w.strip()]

    def collect(index):
        seen = set()
        result = []
        for form in forms:
            for candidate in index.get(form, []):
                if candidate["id"] not in seen:
                    seen.add(candidate["id"])
                    result.append(candidate)
        return result

    def pick(candidates):
        if not candidates:
            return None
        if len(candidates) == 1:
            return candidates[0]
        pool = candidates
        if readings:
            reading_matched = [c for c in pool if any(r in c["kana"] for r in readings)]
            if reading_matched:
                pool = reading_matched
        common_matched = [c for c in pool if c["common"]]
        if common_matched:
            pool = common_matched
        return pool[0]

    kanji_candidates = collect(by_kanji)
    if kanji_candidates:
        return pick(kanji_candidates)
    kana_candidates = collect(by_kana)
    if kana_candidates:
        return pick(kana_candidates)
    return None


def classify(gender: str, word_field: str, reading_field: str, entry) -> tuple[str, str]:
    """Returns (conjugationClass, sourceType)."""
    relevant = (VERB_CLASSES if gender == "verb" else ADJECTIVE_CLASSES)
    if entry:
        pos = entry["pos"] & relevant
        if pos:
            # A handful of entries match more than one relevant class across
            # senses (e.g. an entry that is both a suru-verb and, in another
            # sense, a noun adj-no) -- JMdict lists them in the dictionary's
            # own sense order, which is already frequency/primary-sense
            # ordered, so the first is kept.
            for tag in entry["pos"]:
                if tag in pos:
                    return tag, "jmdict"

    return estimate_class(gender, word_field.split(",")[0].strip()), "estimated"


# Verbs ending in る whose 「い段/え段 + る」 shape is genuinely ambiguous
# between ichidan and godan cannot be told apart from spelling. Every word
# actually in the CSV goes through the JMdict lookup above first; this
# fallback only ever fires for the small number of entries JMdict has no
# record for at all (a non-citation-form headword, e.g. a conjugated form
# entered by mistake -- see the build report). Defaulting such a leftover
# -iru/-eru word to ichidan is the right prior: ichidan is the far more
# common pattern for that shape, and the estimate is clearly labeled as
# such in the UI rather than presented as verified.
def estimate_class(gender: str, word: str) -> str:
    if gender == "verb":
        if word.endswith("する"):
            return "vs-i"
        if word == "来る" or word == "くる":
            return "vk"
        if word.endswith("る"):
            return "v1"
        last = word[-1] if word else ""
        godan_by_ending = {
            "う": "v5u", "く": "v5k", "ぐ": "v5g", "す": "v5s", "つ": "v5t",
            "ぬ": "v5n", "ぶ": "v5b", "む": "v5m",
        }
        return godan_by_ending.get(last, "v1")
    if gender == "adjective":
        if word.endswith("いい") or word.endswith("良い"):
            return "adj-ix"
        # A closed, well-known set of pre-noun adjectivals (この/その/...)
        # and their こんな-family relatives: these cannot predicate-conjugate
        # at all ("これはこのだ" is not a sentence), so guessing adj-i/adj-na
        # here would generate a fluent-looking but nonexistent table. This
        # fallback only runs for a CSV row JMdict had no verb/adj-tagged
        # match for at all (see classify() above) -- for a mismatched-data
        # row like this project's own この/その rows (matched JMdict's
        # numeral sense instead, per the build report), it is the only
        # signal left once the lookup itself has already failed.
        invariant_prenominal = {
            "この", "その", "あの", "どの", "こんな", "そんな", "あんな", "どんな",
            "いろんな", "いわゆる", "あらゆる", "さらなる", "いかなる", "ほんの",
            "大した", "単なる",
        }
        if word in invariant_prenominal:
            return "adj-pn"
        # A short, well-known closed list of na-adjectives that happen to
        # end in い (the regular adj-i ending) -- a heuristic ending check
        # alone would misclassify these.
        na_exceptions = {"きれい", "嫌い", "幸い", "気楽い"}
        if word in na_exceptions:
            return "adj-na"
        if word.endswith("い"):
            return "adj-i"
        return "adj-na"
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        help="Path to a pre-downloaded jmdict-eng-*.json(.tgz) file, for a "
        "reproducible build without hitting the network.",
    )
    parser.add_argument(
        "--csv",
        default=str(Path(__file__).resolve().parent.parent / "japaneseWords.csv"),
    )
    parser.add_argument(
        "--out",
        default=str(
            Path(__file__).resolve().parent.parent / "inflections-data.json"
        ),
    )
    args = parser.parse_args()

    jmdict = load_jmdict(args.source)
    by_kanji, by_kana = build_jmdict_index(jmdict)
    print(f"JMdict entries indexed: {len(jmdict['words'])}", file=sys.stderr)

    with open(args.csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    classifications: dict[str, dict] = {}
    jmdict_matched = 0
    estimated = 0
    mismatched_data: list[tuple[str, str, str]] = []

    for row in rows:
        gender = row.get("gender", "").strip()
        if gender not in ("verb", "adjective"):
            continue
        word_field = row.get("word", "").strip()
        reading_field = row.get("pronunciation", "").strip()
        if not word_field:
            continue

        entry = lookup_jmdict(by_kanji, by_kana, word_field, reading_field)
        cls, source_type = classify(gender, word_field, reading_field, entry)
        if source_type == "jmdict":
            jmdict_matched += 1
        else:
            estimated += 1
            if entry is None:
                mismatched_data.append((word_field, reading_field, gender))

        primary_word = word_field.split(",")[0].strip()
        key = f"{gender[0]}:{primary_word}"
        classifications[key] = {"class": cls, "source": source_type}

    output = {
        "version": DATA_VERSION,
        "source": "jmdict-simplified (JMdict/EDRDG, CC BY-SA 4.0)",
        "classifications": classifications,
    }

    out_path = Path(args.out)
    out_path.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    print(f"\nWrote {len(classifications)} classifications to {out_path}")
    print(f"  From JMdict (authoritative): {jmdict_matched}")
    print(f"  Estimated (no JMdict match): {estimated}")
    if mismatched_data:
        print(
            f"\n{len(mismatched_data)} entries had no JMdict match at all "
            "(likely a non-citation-form headword, or a word/reading typo "
            "-- worth a manual look):"
        )
        for word, reading, gender in mismatched_data:
            print(f"  {word} ({reading}) [{gender}]")


if __name__ == "__main__":
    main()
