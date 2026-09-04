# Definition data

`japaneseWords.csv`'s `definition` column (a monolingual Japanese
definition of the headword) is built by `scripts/build-definitions.py`
from two open sources, replacing definitions that were previously written
by an LLM with no cited source. The `English` column is written and
maintained by hand -- this script never touches it.

## Sources

Tried in order:

1. [Japanese WordNet 2.0](https://github.com/bond-lab/wnja) -- Japanese
   definitions attached to Princeton WordNet-aligned synsets, originally
   developed at NICT and continued by Francis Bond and Takayuki
   Kuribayashi. Licensed under NICT's Japanese WordNet Licence (BSD-like:
   free to use, copy, modify and redistribute provided the copyright
   notice is preserved). NICT's licence also asks that any web-facing use
   link back to the [Japanese WordNet site](https://bond-lab.github.io/wnja/).
2. [Japanese Wiktionary](https://ja.wiktionary.org/) (as structured JSON
   via Tatu Ylonen's [Wiktextract](https://github.com/tatuylonen/wiktextract),
   redistributed at [kaikki.org](https://kaikki.org/)), used only for
   words WordNet has no definition for. Licensed CC BY-SA 4.0.

A word not found in either source keeps its existing CSV value untouched.

## Known limitations

**Japanese WordNet's sense counts are English-corpus frequency, not
Japanese usage.** When a headword has several senses, the build script
prefers the sense with the highest `<Count>` (from SemCor tagging) to pick
the most representative one. That count reflects how often the *aligned
English* Princeton WordNet sense was tagged in an English corpus, not how
a Japanese speaker actually uses the word -- so it's a reasonable proxy,
not a reliable one. For example, 尻 ("buttocks") resolved to a
higher-frequency-in-English "final part or section" sense instead, because
that sense happened to have more SemCor tags. Entries where this
disagreement is more likely to occur (multiple senses in Japanese WordNet
with *no* count data at all, so the "highest count" pick is arbitrary) are
listed separately in the build's report as **low-confidence** -- currently
about a third of WordNet-sourced definitions -- worth spot-checking before
treating them as final.

**Genuine homographs are left unchanged, not guessed.** Words like CD
(which resolves to both "compact disc" and, in Japanese, the unrelated
wasei-eigo "cash dispenser") or あの (demonstrative "that" vs. the filler
"um") have multiple *conflicting* definitions across sources with no
signal to prefer one. The build script detects this and leaves the
existing CSV value in place rather than pick arbitrarily, listing these
rows in its report as **ambiguous**.

This is a known open problem for Japanese WordNet generally, not specific
to this pipeline -- the upstream `wnja` project runs its own LLM-based
definition-audit pipeline for the same reason (see its `CLAUDE.md`).

## Rebuilding

```sh
python3 scripts/build-definitions.py
```

Add `--dry-run` to see the coverage report without writing the CSV, or
`--wnja-source` / `--wiktionary-source` to build from already-downloaded
files instead of fetching the latest release of each.

The build prints a summary to stderr and writes the full report (every
row left unchanged, and every low-confidence pick) to
`scripts/build-definitions-report.txt` (gitignored -- regenerate as
needed).

CI regenerates this automatically whenever `japaneseWords.csv` changes
(the `definitions-data` job in `.github/workflows/test.yml`, mirroring how
`inflections-data.json` is kept in sync) and fails the build if the result
doesn't match what's committed -- run the command above and commit the
result when that happens.
