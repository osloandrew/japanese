// Single source of truth for classifying a dictionary entry's grammatical
// category from its CSV `gender` field. Unlike Norwegian's version this is
// ported from (norwegian/wordClass.js), that field here is already a flat,
// single word-class token per entry (noun/verb/adjective/adverb/
// conjunction/expression/interjection/numeral/particle/pronoun -- checked
// against the actual CSV, no compound "en-et"-style values), since
// Japanese has no grammatical gender for wordClass.js's noun-article logic
// to collapse. Kept as its own module (not inlined into scripts.js) purely
// to match wordList.js's expected window.WordClass API surface, which is
// itself the reason to have one shared implementation at all: this logic
// used to be reimplemented ad hoc per call site.
//
// Loaded first — a plain, non-deferred <script> before every other app
// script — so its globals are available to wordList.js/myWordsAuth.js,
// which run synchronously during HTML parsing, before the deferred
// scripts (scripts.js, wordGame.js, ...) run after parsing ends.
(function () {
  "use strict";

  function normalizeWordClass(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  // No-ops here (kept only so callers written against Norwegian's API,
  // which strips/adds a "noun - " display prefix for compound noun
  // genders, don't need a separate code path) -- there's no such prefix
  // scheme for a flat word-class value.
  function stripNounPrefix(value) {
    return normalizeWordClass(value);
  }

  function getWordClass(genderValue) {
    return normalizeWordClass(genderValue);
  }

  // True if `genderValue` belongs to the word class named by
  // `selectedPOS` (a token like "noun", "verb", "adjective", as used by
  // the Word Class filter dropdown). Anchored on the whole value, not a
  // substring match -- "adverb" must never match a "verb" filter.
  function matchesWordClass(genderValue, selectedPOS) {
    if (!selectedPOS) return true;
    return normalizeWordClass(genderValue) === normalizeWordClass(selectedPOS);
  }

  // True if two `gender` values are the same word class -- used to keep a
  // Word Game distractor grammatically plausible (a noun swapped for
  // another noun, not for a particle).
  function hasCompatibleGender(targetGender, candidateGender) {
    if (!candidateGender) return false;
    return getWordClass(targetGender) === getWordClass(candidateGender);
  }

  // Identity here (no article to prefix, unlike Norwegian's "en" ->
  // "noun - en") -- kept for API compatibility with call sites ported
  // from Norwegian.
  function formatWordClassLabel(genderValue) {
    return String(genderValue ?? "").trim();
  }

  self.WordClass = Object.freeze({
    stripNounPrefix,
    getWordClass,
    matchesWordClass,
    hasCompatibleGender,
    formatWordClassLabel,
  });
})();
