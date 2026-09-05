// Exact, Unicode-aware matching for learner-facing example sentences. Ported
// from Norwegian's sentenceFormMatching.js, where a form must occupy a
// complete word/phrase boundary ("ugle" can match "ugla" but never the
// prefix of "uglasert") -- there, boundaries work because Bokmål separates
// words with spaces, so any letter/digit neighbor means "still inside a
// longer word." Japanese has no such delimiter: kana and kanji are
// themselves Unicode letters, so requiring a non-letter neighbor on both
// sides (Norwegian's \p{L}\p{N} check) is almost never satisfiable inside a
// real sentence and silently matches nothing. The boundary here only
// excludes ASCII/digit neighbors instead, guarding against a form matching
// mid-word inside romaji or a number while still allowing any Japanese
// script character on either side, which is effectively a plain substring
// test for kana/kanji forms.
//
// That substring test alone still over-matches real compounds: "夜" (night)
// is a literal substring of "今夜" (tonight), so a sentence about tonight's
// pizza would otherwise show up as an example for "night". createMatcher's
// optional second argument -- the dictionary's own entries -- guards against
// this: any match that is actually a proper substring of a longer known
// headword ("今夜" containing "夜") is treated as shadowed and rejected,
// while a genuine standalone occurrence ("夜から雪になるそうです") still
// passes. This is a lexicon-driven stand-in for real segmentation, not a
// general tokenizer -- it only catches compounds already in this app's word
// list.
(function () {
  "use strict";

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeWord(value) {
    return String(value ?? "")
      .normalize("NFC")
      .toLocaleLowerCase("ja-JP")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeForms(forms) {
    return [
      ...new Set((forms || []).map(normalizeWord).filter(Boolean)),
    ].sort((a, b) => b.length - a.length || a.localeCompare(b, "ja"));
  }

  // Pulls every headword out of a list of dictionary entries (or plain
  // strings) to use as compound-shadowing guards -- see file header.
  function collectGuardWords(guardSource) {
    const words = new Set();
    for (const item of guardSource || []) {
      const raw = typeof item === "string" ? item : item?.word;
      for (const word of String(raw || "").split(/[,、]/)) {
        const normalized = normalizeWord(word);
        if (normalized) words.add(normalized);
      }
    }
    return words;
  }

  // For each accepted form, finds every longer guard word that contains it,
  // recording where within that word the form sits so a later match can be
  // checked against the exact surrounding characters.
  function buildShadowMap(acceptedForms, guardWords) {
    if (!guardWords || guardWords.size === 0) return null;
    const map = new Map();
    for (const form of acceptedForms) {
      const supersets = [];
      for (const word of guardWords) {
        if (word === form || word.length <= form.length) continue;
        let index = word.indexOf(form);
        while (index !== -1) {
          supersets.push({ word, offset: index });
          index = word.indexOf(form, index + 1);
        }
      }
      if (supersets.length) map.set(form, supersets);
    }
    return map.size ? map : null;
  }

  function createMatcher(forms, guardSource) {
    const acceptedForms = normalizeForms(forms);
    if (acceptedForms.length === 0) {
      return Object.freeze({
        forms: acceptedForms,
        test: () => false,
        find: () => null,
        highlight: (text) => String(text ?? ""),
      });
    }

    const shadowsByForm = buildShadowMap(
      acceptedForms,
      guardSource ? collectGuardWords(guardSource) : null,
    );

    const alternatives = acceptedForms
      .map((form) => escapeRegExp(form).replace(/ /g, "\\s+"))
      .join("|");
    const source = `(?<![A-Za-z0-9])(?:${alternatives})(?![A-Za-z0-9])`;
    const pattern = new RegExp(source, "giu");

    function isShadowed(text, index, matchedText) {
      if (!shadowsByForm) return false;
      const supersets = shadowsByForm.get(normalizeWord(matchedText));
      if (!supersets) return false;
      return supersets.some(({ word, offset }) => {
        const start = index - offset;
        const end = start + word.length;
        if (start < 0 || end > text.length) return false;
        return normalizeWord(text.slice(start, end)) === word;
      });
    }

    function findFirstUnshadowedMatch(text) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        if (!isShadowed(text, match.index, match[0])) return match;
        if (match[0].length === 0) pattern.lastIndex++;
      }
      return null;
    }

    return Object.freeze({
      forms: acceptedForms,
      test: (text) =>
        findFirstUnshadowedMatch(String(text ?? "").normalize("NFC")) !==
        null,
      // Position of the first unshadowed occurrence, for callers (e.g. a
      // Word Game cloze target) that need to slice the surrounding sentence
      // rather than just know whether a form is present.
      find: (text) => {
        const normalized = String(text ?? "").normalize("NFC");
        const match = findFirstUnshadowedMatch(normalized);
        return match
          ? {
              start: match.index,
              end: match.index + match[0].length,
              matchedText: match[0],
            }
          : null;
      },
      highlight: (text) => {
        const normalized = String(text ?? "").normalize("NFC");
        return normalized.replace(pattern, (matchedText, offset) =>
          isShadowed(normalized, offset, matchedText)
            ? matchedText
            : `<span style="color: var(--color-interactive);">${matchedText}</span>`,
        );
      },
    });
  }

  function splitSentences(text) {
    // eksempel/sentenceTranslation always hold exactly one sentence each —
    // a "." or "!" inside the text (decimal points, abbreviations like
    // "P.S.", "Halleluja! ropte...") is just part of that one sentence.
    if (!text) return [];
    const trimmed = String(text).trim();
    return trimmed ? [trimmed] : [];
  }

  function collectExamples(
    primaryEntry,
    entries,
    matcher,
    limit = 100,
    excludedEntries = [],
  ) {
    const uniqueSentences = new Set();
    const excludedEntrySet = new Set(excludedEntries || []);
    const primary = [];
    const supplemental = [];

    const addSentence = (target, entry, sentence, translation = "") => {
      const key = String(sentence ?? "")
        .normalize("NFC")
        .toLocaleLowerCase("ja-JP")
        .replace(/\s+/g, " ")
        .trim();
      if (!key || uniqueSentences.has(key)) return;
      uniqueSentences.add(key);
      target.push({
        ...entry,
        eksempel: sentence,
        sentenceTranslation: translation,
      });
    };

    // Add the selected entry before searching anything else. This makes the
    // first-example guarantee structural rather than dependent on later sort
    // behavior or the dictionary's row order.
    const primarySentences = splitSentences(primaryEntry?.eksempel);
    const primaryTranslations = splitSentences(
      primaryEntry?.sentenceTranslation,
    );
    primarySentences.forEach((sentence, index) => {
      addSentence(
        primary,
        primaryEntry,
        sentence,
        primaryTranslations[index] || "",
      );
    });

    outerLoop: for (const entry of entries || []) {
      if (entry !== primaryEntry && excludedEntrySet.has(entry)) continue;
      if (!entry?.eksempel || !matcher.test(entry.eksempel)) continue;
      const sentences = splitSentences(entry?.eksempel);
      const translations = splitSentences(entry?.sentenceTranslation);

      for (let index = 0; index < sentences.length; index++) {
        const sentence = sentences[index];
        if (!matcher.test(sentence)) continue;
        addSentence(
          supplemental,
          entry,
          sentence,
          translations[index] || "",
        );
        if (supplemental.length >= limit) break outerLoop;
      }
    }

    return { primary, supplemental };
  }

  window.SentenceFormMatching = Object.freeze({
    collectExamples,
    createMatcher,
    normalizeForms,
  });
})();
