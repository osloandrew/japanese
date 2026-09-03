// Exact, Unicode-aware matching for learner-facing example sentences. A form
// must occupy a complete word/phrase boundary: "ugle" can match "ugla", when
// that accepted form is supplied, but can never match the prefix of "uglasert".
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
    ].sort((a, b) => b.length - a.length || a.localeCompare(b, "nb"));
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
    const source = `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`;
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
