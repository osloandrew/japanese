#!/usr/bin/env python3
"""Replace japaneseWords.csv's AI-generated `definition` column with a
monolingual Japanese definition of the headword, sourced from open
Japanese lexical resources -- the `English` column is left untouched;
that one is written and maintained by hand.

Two sources, tried in this order:

  1. Japanese WordNet 2.0 (https://github.com/bond-lab/wnja) -- Japanese
     definitions attached to Princeton WordNet-aligned synsets. Originally
     developed at NICT; the v2.0 release used here also folds in NTU-MC
     data and manual corrections by Francis Bond and Takayuki Kuribayashi.
     License: NICT's Japanese WordNet Licence (BSD-like; permits any use
     provided the copyright notice is preserved -- see the licence text
     bundled with the release). NICT's licence also asks that any
     web-facing use link back to the Japanese WordNet site; see
     DEFINITIONS_DATA.md for the credit this project uses to satisfy that.
  2. Japanese Wiktionary (ja.wiktionary.org), as structured JSON via
     Tatu Ylonen's Wiktextract (https://github.com/tatuylonen/wiktextract),
     redistributed at https://kaikki.org/. License: CC BY-SA 4.0 (the
     underlying Wiktionary content's license).

A word with no definition in either source keeps its existing CSV value
untouched -- this script only replaces cells it has better data for.

Candidate dictionary entries are looked up by the row's `word`/
`pronunciation` (kanji forms preferred over kana-only matches, tied broken
by reading agreement), then narrowed to senses whose part of speech is
consistent with the CSV's `gender` column (which despite its name holds
this word's part of speech, not grammatical gender).

Usage:

    python3 scripts/build-definitions.py
    python3 scripts/build-definitions.py --dry-run
    python3 scripts/build-definitions.py \\
        --wnja-source /path/to/wnja-2.0.xml \\
        --wiktionary-source /path/to/ja-extract.jsonl.gz
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import sys
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "japaneseWords.csv"
REPORT_PATH = ROOT / "scripts" / "build-definitions-report.txt"

WNJA_RELEASES_API = "https://api.github.com/repos/bond-lab/wnja/releases"

WIKTIONARY_URL = "https://kaikki.org/dictionary/downloads/ja/ja-extract.jsonl.gz"

# gender (CSV) -> Japanese WordNet partOfSpeech letters. WordNet's POS
# system is much coarser than JMdict's, so this is only applied for the
# categories it actually distinguishes -- everything else matches any POS
# (WordNet's coverage of particles/conjunctions/etc. is too sparse to
# usefully filter on).
WNJA_POS_BY_GENDER = {
    "noun": {"n"},
    "verb": {"v"},
    "adjective": {"a", "s"},
    "adverb": {"r"},
}


def http_get(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


# ---------------------------------------------------------------------------
# Japanese WordNet 2.0 (Japanese definitions)
# ---------------------------------------------------------------------------


def load_wnja_bytes(source: str | None) -> bytes:
    if source:
        return Path(source).read_bytes()
    # Not /releases/latest: that endpoint only ever returns the newest
    # release GitHub doesn't consider a pre-release, which currently means
    # it skips wnja's v2.0 (published as a pre-release) and falls back to
    # v1.1 -- whose only assets are .xml.gz/.tab.gz/.zip, not the plain
    # .xml this script wants. Listing all releases and taking the first one
    # with a plain .xml asset finds v2.0 regardless of its pre-release flag.
    print("Looking up latest wnja release with a .xml asset...", file=sys.stderr)
    releases = json.loads(http_get(WNJA_RELEASES_API, timeout=30))
    asset = next(
        (
            a
            for release in releases
            for a in release.get("assets", [])
            if a["name"].endswith(".xml")
        ),
        None,
    )
    if not asset:
        raise SystemExit("Could not find a wnja-*.xml release asset.")
    print(f"Downloading {asset['name']} ({asset['size']} bytes)...", file=sys.stderr)
    return http_get(asset["browser_download_url"])


class WnjaIndex:
    def __init__(self, xml_bytes: bytes):
        self.by_form: dict[str, list[dict]] = {}
        self.synset_defs: dict[str, str] = {}
        current: dict | None = None
        for event, elem in ET.iterparse(io.BytesIO(xml_bytes), events=("start", "end")):
            tag = elem.tag
            if event == "start" and tag == "LexicalEntry":
                current = {"pos": None, "forms": [], "senses": []}
            elif event == "end" and tag == "Lemma" and current is not None:
                current["forms"].append(nfkc(elem.get("writtenForm")))
                current["pos"] = elem.get("partOfSpeech")
            elif event == "end" and tag == "Form" and current is not None:
                current["forms"].append(nfkc(elem.get("writtenForm")))
            elif event == "end" and tag == "Sense" and current is not None:
                current["senses"].append(
                    {
                        "synset": elem.get("synset"),
                        "count": int(elem.findtext("Count") or 0),
                    }
                )
            elif event == "end" and tag == "LexicalEntry":
                if current["forms"]:
                    for form in set(current["forms"]):
                        self.by_form.setdefault(form, []).append(current)
                current = None
                elem.clear()
            elif event == "end" and tag == "Synset":
                defn = elem.findtext("Definition")
                if defn:
                    self.synset_defs[elem.get("id")] = defn.strip()
                elem.clear()

    def lookup(self, forms: list[str], readings: list[str], gender: str) -> tuple[str | None, str]:
        candidates: list[dict] = []
        seen_ids = set()
        for form in forms:
            for entry in self.by_form.get(form, []):
                if id(entry) not in seen_ids:
                    seen_ids.add(id(entry))
                    candidates.append(entry)
        if not candidates:
            return None, "none"

        wanted_pos = WNJA_POS_BY_GENDER.get(gender)
        if wanted_pos:
            pos_matched = [c for c in candidates if c["pos"] in wanted_pos]
            if pos_matched:
                candidates = pos_matched
        candidates = narrow_by_reading(candidates, readings, forms_key="forms")

        # Each candidate entry lists its senses in no particular order --
        # unlike JMdict, wnja doesn't promise frequency-sorted senses.
        # <Count> (from SemCor tagging) is the only real frequency signal a
        # sense can carry, and most don't have one. When a word has several
        # senses with definitions and none carries a Count, picking "the
        # first" is a coin flip -- see this script's --report output
        # ("low confidence") for cases where that happened, e.g. 限りない
        # ("unlimited") landing on an unrelated adjective sense of 限りない
        # that happens to sort first with no Count to say otherwise.
        results = []
        for entry in candidates:
            usable = [s for s in entry["senses"] if s["synset"] in self.synset_defs]
            if not usable:
                continue
            usable.sort(key=lambda s: -s["count"])
            text = self.synset_defs[usable[0]["synset"]]
            if not text.endswith(("。", "！", "？")):
                text += "。"
            confident = len(usable) == 1 or usable[0]["count"] > 0
            results.append((text, confident))

        distinct_texts = {t for t, _ in results}
        if not distinct_texts:
            return None, "none"
        if len(distinct_texts) > 1:
            return None, "ambiguous"
        text = results[0][0]
        confident = all(c for _, c in results)
        return text, ("ok" if confident else "low_confidence")


# ---------------------------------------------------------------------------
# Japanese Wiktionary (fallback Japanese definitions)
# ---------------------------------------------------------------------------


def open_wiktionary_lines(source: str | None):
    if source:
        path = Path(source)
        if path.suffix == ".gz":
            return gzip.open(path, "rt", encoding="utf-8")
        return open(path, encoding="utf-8")
    print(f"Streaming {WIKTIONARY_URL} ...", file=sys.stderr)
    response = urllib.request.urlopen(WIKTIONARY_URL, timeout=120)
    return io.TextIOWrapper(gzip.GzipFile(fileobj=response), encoding="utf-8")


# gender (CSV) -> Wiktextract `pos` values for jawiktionary.
WIKTIONARY_POS_BY_GENDER = {
    "noun": {"noun"},
    "verb": {"verb"},
    "adjective": {"adj"},
    "adverb": {"adv"},
    "pronoun": {"pron"},
    "particle": {"particle"},
    "conjunction": {"conj"},
    "interjection": {"intj"},
    "prefix": {"prefix"},
    "suffix": {"suffix"},
    "numeral": {"num"},
}


# Wiktionary entries for an alternate spelling are frequently just a
# cross-reference to the "main" spelling ("お宅" -> "「おたく」の漢字表記。")
# rather than an actual definition. _resolve_redirect() follows these to
# the real definition instead of surfacing the unhelpful stub.
REDIRECT_PATTERN = re.compile(
    r"^「?([^「」、。]+?)」?の(?:漢字表記|平仮名表記|片仮名表記|別表記|異表記|旧字体|異体字)。?$"
)


class WiktionaryIndex:
    def __init__(self, lines_iterable):
        self.by_word: dict[str, list[dict]] = {}
        with lines_iterable as lines:
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                if entry.get("lang_code") != "ja":
                    continue
                glosses = []
                for sense in entry.get("senses", []):
                    glosses.extend(sense.get("glosses", []))
                if not glosses:
                    continue
                self.by_word.setdefault(nfkc(entry["word"]), []).append(
                    {"pos": entry.get("pos"), "gloss": glosses[0]}
                )

    def _resolve_redirect(self, gloss: str, depth: int = 0) -> str:
        if depth >= 3:
            return gloss
        match = REDIRECT_PATTERN.match(gloss)
        if not match:
            return gloss
        target = nfkc(match.group(1).strip())
        candidates = self.by_word.get(target)
        if not candidates:
            return gloss
        return self._resolve_redirect(candidates[0]["gloss"], depth + 1)

    def lookup(self, forms: list[str], gender: str) -> tuple[str | None, str]:
        wanted_pos = WIKTIONARY_POS_BY_GENDER.get(gender)
        for form in forms:
            candidates = self.by_word.get(form)
            if not candidates:
                continue
            if wanted_pos:
                matched = [c for c in candidates if c["pos"] in wanted_pos]
                if matched:
                    candidates = matched
            text, status = resolve_unambiguous_text(candidates, lambda c: c["gloss"])
            if text:
                text = self._resolve_redirect(text)
            return text, status
        return None, "none"


# ---------------------------------------------------------------------------
# Shared matching helpers
# ---------------------------------------------------------------------------


def nfkc(value: str) -> str:
    """Fold full-width/half-width and other compatibility variants (e.g.
    ASCII "CD" vs full-width "ＣＤ") so the same loanword headword matches
    regardless of which width a particular source happened to use."""
    return unicodedata.normalize("NFKC", value)


def split_forms(field: str) -> list[str]:
    return [nfkc(w.strip()) for w in field.split(",") if w.strip()]


def narrow_by_reading(candidates: list[dict], readings: list[str], forms_key: str = "kana") -> list[dict]:
    if not readings or len(candidates) <= 1:
        return candidates
    matched = [c for c in candidates if any(r in c[forms_key] for r in readings)]
    return matched or candidates


def resolve_unambiguous_text(candidates: list[dict], extract_text) -> tuple[str | None, str]:
    """Reduce a candidate pool to one piece of text, or report why it
    couldn't: "none" (no candidate has usable text) or "ambiguous" (two or
    more candidates disagree and nothing narrowed it further -- e.g. "CD"
    resolving to both "compact disc" and, in Japanese, the unrelated
    wasei-eigo "cash dispenser" homograph). Returns (text, status)."""
    texts = []
    for c in candidates:
        text = extract_text(c)
        if text:
            texts.append(text)
    distinct = set(texts)
    if not distinct:
        return None, "none"
    if len(distinct) == 1:
        return texts[0], "ok"
    return None, "ambiguous"


# ---------------------------------------------------------------------------
# CSV pass
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wnja-source", help="Local wnja-*.xml instead of downloading")
    parser.add_argument("--wiktionary-source", help="Local ja-extract.jsonl(.gz) instead of downloading")
    parser.add_argument("--dry-run", action="store_true", help="Report coverage without writing the CSV")
    parser.add_argument("--report", default=str(REPORT_PATH), help="Where to write the unmatched-rows report")
    args = parser.parse_args()

    wnja_index = WnjaIndex(load_wnja_bytes(args.wnja_source))
    print(
        f"Japanese WordNet: {len(wnja_index.by_form)} indexed forms, "
        f"{len(wnja_index.synset_defs)} synsets with definitions",
        file=sys.stderr,
    )

    wiktionary_index = WiktionaryIndex(open_wiktionary_lines(args.wiktionary_source))
    print(f"Wiktionary: {len(wiktionary_index.by_word)} indexed words", file=sys.stderr)

    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        raw_rows = list(reader)

    word_i = header.index("word")
    reading_i = header.index("pronunciation")
    gender_i = header.index("gender")
    definition_i = header.index("definition")

    # Filtered on `word`, not `English` -- a real row's `word` is never
    # blank, but its `English` gloss legitimately can be: this project
    # stopped auto-generating English glosses (see the "Stop
    # auto-generating English glosses" commit), so a newly-added word can
    # sit with no English translation yet, pending a manual one. Filtering
    # on English here used to silently drop every such row on the next
    # regen -- not just fail the "up to date" CI check, but actually delete
    # the word from japaneseWords.csv the moment anyone ran this script and
    # committed the result.
    rows = [row for row in raw_rows if row and len(row) > word_i and row[word_i].strip()]

    stats = {
        "definition_wnja": 0,
        "definition_wnja_low_confidence": [],
        "definition_wiktionary": 0,
        "definition_none": [],
        "definition_ambiguous": [],
    }

    for row in rows:
        forms = split_forms(row[word_i])
        readings = split_forms(row[reading_i])
        gender = row[gender_i].strip().lower()
        primary_word = forms[0] if forms else row[word_i]

        wnja_def, wnja_status = wnja_index.lookup(forms, readings, gender)
        if wnja_def and wnja_status == "ok":
            row[definition_i] = wnja_def
            stats["definition_wnja"] += 1
        else:
            # A low-confidence wnja pick (multiple senses, no frequency data
            # to rank them -- see DEFINITIONS_DATA.md) defers to Wiktionary's
            # single, natively-written definition when one exists, rather
            # than keep a possibly-wrong-sense WordNet pick.
            wikt_def, wikt_status = wiktionary_index.lookup(forms, gender)
            if wikt_def:
                row[definition_i] = wikt_def
                stats["definition_wiktionary"] += 1
            elif wnja_def:
                row[definition_i] = wnja_def
                stats["definition_wnja"] += 1
                stats["definition_wnja_low_confidence"].append(primary_word)
            elif wnja_status == "ambiguous" or wikt_status == "ambiguous":
                stats["definition_ambiguous"].append(primary_word)
            else:
                stats["definition_none"].append(primary_word)

    total = len(rows)
    summary_lines = [
        f"Total rows: {total}",
        f"definition: {stats['definition_wnja']} from Japanese WordNet "
        f"({len(stats['definition_wnja_low_confidence'])} low-confidence sense picks), "
        f"{stats['definition_wiktionary']} from Wiktionary, "
        f"{len(stats['definition_none'])} left unchanged (no match), "
        f"{len(stats['definition_ambiguous'])} left unchanged (ambiguous -- multiple conflicting senses found)",
        "",
        "Definitions APPLIED but low-confidence (WordNet has multiple senses with no "
        "frequency data to rank them and Wiktionary had nothing better to fall back "
        "on -- the pick was arbitrary; spot-check these):",
        *[f"  {w}" for w in stats["definition_wnja_low_confidence"]],
        "",
        "Definitions left unchanged -- ambiguous (needs a human to pick the sense):",
        *[f"  {w}" for w in stats["definition_ambiguous"]],
        "",
        "Definitions left unchanged -- no match in either source:",
        *[f"  {w}" for w in stats["definition_none"]],
    ]
    summary = "\n".join(summary_lines)
    print(summary, file=sys.stderr)
    Path(args.report).write_text(summary + "\n", encoding="utf-8")
    print(f"\nFull report written to {args.report}", file=sys.stderr)

    if args.dry_run:
        print("\n--dry-run: CSV not modified.", file=sys.stderr)
        return

    with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, lineterminator="\r\n")
        writer.writerow(header)
        writer.writerows(rows)
    print(f"\nWrote {CSV_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
