# Japanese vocabulary-frequency data

`vocabulary-frequency.json` supplies the frequency ranks used by the **All
Words** frequency sort and the **Word Game**. It is kept separate from
`japaneseWords.csv` so corpus updates cannot silently alter dictionary content.

## Source and permitted use

The data comes from the National Institute for Japanese Language and
Linguistics (NINJAL), **Balanced Corpus of Contemporary Written Japanese
(BCCWJ), Long Unit Word list, frequency 2 or higher, version 1.0**:

- Dataset DOI: <https://doi.org/10.15084/00003214>
- NINJAL word-list page: <https://clrd.ninjal.ac.jp/bccwj/en/freq-list.html>
- Source file: `BCCWJ_frequencylist_luw2_ver1_0.zip`
- Stated terms: free for research or educational purposes

This educational site stores only the small, derived records that match its
own dictionary. It does not redistribute the full BCCWJ list. The two local
Routledge frequency-dictionary PDFs are not build inputs: their copyright page
reserves reproduction and information-retrieval use without publisher
permission.

## Matching and ranking

The builder matches each dictionary row's primary Japanese spelling to a BCCWJ
long-unit lemma. Alternate spellings after `、` or `,` do not make a match on
their own. Frequencies for BCCWJ part-of-speech rows with the same lemma are
summed, because they are disjoint observations of the same written form.

Matched counts are transformed with `log1p`, normalized to a 0–1 `weight`, and
ranked from most to least frequent. A second normalized percentile is calculated
inside each CEFR band. The Word Game uses that percentile only to refine a
word's position inside its existing CEFR level; it cannot move a word across
levels.

The generated file records the exact source ZIP's SHA-256 hash. Unmatched words
remain available throughout the site and simply receive neutral frequency
weighting.

## Rebuild

Download the versioned ZIP from the dataset DOI, then run:

```sh
npm run build:frequency -- --source \
  /path/to/BCCWJ_frequencylist_luw2_ver1_0.zip
```

The build is deterministic for the same source ZIP and dictionary CSV.
