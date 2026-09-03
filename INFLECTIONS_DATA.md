# Japanese conjugation-class data

`inflections-data.json` is a compact classification snapshot: for every verb
and adjective in `japaneseWords.csv`, which conjugation class it belongs to
(ichidan, godan-by-ending, one of the irregular classes, i-adjective,
na-adjective, ...).

- Source: [jmdict-simplified](https://github.com/scriptin/jmdict-simplified),
  a structured JSON export of **JMdict**
- JMdict/EDICT is the property of the [Electronic Dictionary Research and
  Development Group](https://www.edrdg.org/), and is used in conformance
  with the Group's licence:
  [Creative Commons Attribution-ShareAlike 4.0 International](https://www.edrdg.org/edrdg/licence.html)

## Why classification only, not full paradigms

Norwegian's `inflections-data.json` (see `norwegian/INFLECTIONS_DATA.md`)
stores whole precomputed word forms, because Bokmål noun gender and verb
paradigms are lexically irregular -- there is no rule that derives them from
the spelling alone, so they have to come from a corpus (Norsk Ordbank).

Japanese conjugation doesn't have that problem: given the correct
conjugation class, every form is a fully regular, rule-derived suffix
replacement -- even the handful of genuinely irregular verbs (する, 来る)
conjugate identically for every word in their class. The only thing that
can't be recovered from spelling alone is the class itself: the famous
"fake ichidan" godan verbs (帰る, 入る, 走る, 知る, ...) are spelled exactly
like a real ichidan verb (食べる, 見る) and are only distinguishable by
looking them up.

So the split here is:

- **This file** (built by `scripts/build-inflections.py`): which class each
  word belongs to, resolved against JMdict's own part-of-speech tags
  (`v1`, `v5r`, `vs-i`, `adj-na`, ...).
- **`inflections.js`**: the actual conjugation engine -- the suffix rules
  for each class, applied at runtime to the dictionary headword. This is
  the single source of truth for every generated form (the Word Forms
  table, sentence-search matching, and future cross-reference linking all
  go through it), so there is no risk of the rules drifting out of sync
  with themselves the way two independently-maintained copies could.

A few entries have no reliable classification: `japaneseWords.csv` has no
kanji/reading pair matching *any* JMdict entry (almost always because the
CSV headword itself is a conjugated form rather than a dictionary
citation form -- the build script's own report lists these). Those fall
back to a spelling-based estimate and are labeled `"source": "estimated"`
in the data file, surfaced in the UI the same honest way Norwegian labels
an unverified paradigm.

## Rebuilding

```sh
python3 scripts/build-inflections.py
```

For a reproducible build from an already-downloaded export:

```sh
python3 scripts/build-inflections.py --source /path/to/jmdict-eng-x.y.z.json
```

(Use the plain `jmdict-eng-*` release asset, not `jmdict-eng-common-*` --
the common-only subset misses enough of this project's less-frequent
vocabulary to matter.)
