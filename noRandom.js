// Headwords excluded from random-pick features (Random Word, Word Game).
// This used to be a leftover copy of the Spanish app's Spanish-language
// profanity list — it never matched any Japanese headword (matching is
// `r.word.toLowerCase()` against this list), so random picks here were
// effectively unfiltered the whole time. Left empty pending a real Japanese
// blocklist; populate with lowercase Japanese headwords (kana/kanji) as
// needed. See norwegian/noRandom.js for the shape of an equivalent list
// once populated.
const noRandom = [];
