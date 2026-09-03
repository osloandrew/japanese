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
(function () {
  "use strict";

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeForms(forms) {
    return [
      ...new Set(
        (forms || [])
          .map((form) =>
            String(form ?? "")
              .normalize("NFC")
              .toLocaleLowerCase("ja-JP")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .filter(Boolean),
      ),
    ].sort((a, b) => b.length - a.length || a.localeCompare(b, "ja"));
  }

  function createMatcher(forms) {
    const acceptedForms = normalizeForms(forms);
    if (acceptedForms.length === 0) {
      return Object.freeze({
        forms: acceptedForms,
        test: () => false,
        highlight: (text) => String(text ?? ""),
      });
    }

    const alternatives = acceptedForms
      .map((form) => escapeRegExp(form).replace(/ /g, "\\s+"))
      .join("|");
    const source = `(?<![A-Za-z0-9])(?:${alternatives})(?![A-Za-z0-9])`;
    const testPattern = new RegExp(source, "iu");
    const highlightPattern = new RegExp(source, "giu");

    return Object.freeze({
      forms: acceptedForms,
      test: (text) => testPattern.test(String(text ?? "").normalize("NFC")),
      highlight: (text) =>
        String(text ?? "")
          .normalize("NFC")
          .replace(
            highlightPattern,
            (matchedText) =>
              `<span style="color: var(--color-interactive);">${matchedText}</span>`,
          ),
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
