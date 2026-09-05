// Analysis for dictionary entries whose word class is "expression" --
// grammatical patterns like てくれる, について, かもしれない, or fixed idioms
// like 仕方が無い.
//
// Norwegian's counterpart exists because Bokmål expressions are genuinely
// multi-word (kaste [noen] til ulvene) and can be interrupted by an inflected
// object pronoun or reflexive between their fixed components, which needs a
// token-span/paradigm model to bridge. Japanese has no whitespace and these
// entries are not "multi-word" in that sense at all: they are a fixed
// kanji/kana skeleton written directly against the stem it attaches to
// (てくれる glued straight onto a verb's te-form, について glued after a
// noun), with nothing ever inserted in between. The only thing that varies
// is the trailing edge, when it happens to end in an independently
// conjugating verb or adjective already in this dictionary (くれる in
// てくれる) -- so this module treats an expression as a fixed prefix plus,
// where one exists, that tail's own conjugated forms, then hands the
// resulting literal surface-form list to the same substring matcher already
// used for ordinary words (sentenceFormMatching.js), rather than building a
// second token/span system.
(function () {
  "use strict";

  // Auxiliary spellings this dictionary's expression entries actually use
  // with both a kanji and an all-kana form in the wild (仕方が無い vs the far
  // more common 仕方がない). Not a general kanji/kana normalizer -- just the
  // handful of alternations expression matching needs so a citation written
  // one way still matches a sentence written the other.
  const KANJI_KANA_ALTERNATIONS = [
    ["無い", "ない"],
    ["有る", "ある"],
    ["出来る", "できる"],
    ["良い", "いい"],
  ];

  function splitVariants(value) {
    return [
      ...new Set(
        String(value ?? "")
          .split(/[,、]/)
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ];
  }

  function applyKanjiKanaAlternations(variant) {
    const alternates = [];
    for (const [kanji, kana] of KANJI_KANA_ALTERNATIONS) {
      if (variant.includes(kanji)) {
        alternates.push(variant.split(kanji).join(kana));
      } else if (variant.includes(kana)) {
        alternates.push(variant.split(kana).join(kanji));
      }
    }
    return alternates;
  }

  // headword -> its own dictionary entry, for every verb/adjective in the
  // loaded word list. Rebuilt only when `results` itself changes (mirrors
  // wordGame.js's getGameNounGendersByLemma caching).
  let tailIndexSource = null;
  let tailIndexByHeadword = new Map();

  function getTailIndex() {
    if (typeof results === "undefined") return tailIndexByHeadword;
    if (tailIndexSource === results) return tailIndexByHeadword;

    const nextIndex = new Map();
    for (const entry of results) {
      const wordClass = String(entry?.gender ?? "").trim();
      if (wordClass !== "verb" && wordClass !== "adjective") continue;
      for (const headword of splitVariants(entry.ord)) {
        if (!nextIndex.has(headword)) nextIndex.set(headword, entry);
      }
    }
    tailIndexSource = results;
    tailIndexByHeadword = nextIndex;
    return tailIndexByHeadword;
  }

  // The longest dictionary verb/adjective headword that `variant` ends with
  // -- standing in for its inflecting component, e.g. くれる inside てくれる.
  function findTailEntry(variant) {
    let best = null;
    for (const [headword, entry] of getTailIndex()) {
      if (headword.length >= variant.length) continue;
      if (!variant.endsWith(headword)) continue;
      if (!best || headword.length > best.headword.length) {
        best = { headword, entry };
      }
    }
    return best;
  }

  async function buildSurfaceForms(baseVariants) {
    const forms = new Set();
    for (const variant of baseVariants) {
      forms.add(variant);
      for (const alternate of applyKanjiKanaAlternations(variant)) {
        forms.add(alternate);
      }

      const tail = findTailEntry(variant);
      if (!tail) continue;
      const prefix = variant.slice(0, variant.length - tail.headword.length);
      const tailForms = await window.Inflections?.getSentenceForms?.(
        tail.entry,
      );
      for (const tailForm of tailForms || []) {
        if (tailForm) forms.add(prefix + tailForm);
      }
    }
    return [...forms];
  }

  // Keyed by entry object identity, same as the dictionary's own row
  // objects stay stable for a session -- avoids rebuilding a matcher (and
  // re-awaiting Inflections) every time a definition or game round looks
  // the same expression up again.
  const analysisCache = new Map();

  async function getAnalysis(entry) {
    if (!entry?.ord) return null;
    if (analysisCache.has(entry)) return analysisCache.get(entry);

    const analysisPromise = (async () => {
      const baseVariants = splitVariants(entry.ord);
      if (baseVariants.length === 0) return null;

      const surfaceForms = await buildSurfaceForms(baseVariants);
      if (surfaceForms.length === 0) return null;

      const guardSource = typeof results !== "undefined" ? results : [];
      const matcher = window.SentenceFormMatching?.createMatcher(
        surfaceForms,
        guardSource,
      );
      if (!matcher) return null;

      return Object.freeze({ matcher, variants: baseVariants });
    })();

    analysisCache.set(entry, analysisPromise);
    return analysisPromise;
  }

  window.ExpressionPatterns = Object.freeze({
    getAnalysis,
  });
})();
