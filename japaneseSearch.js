/**
 * Shared search-matching helpers so a word can be found by kanji,
 * hiragana, katakana, romaji, or its English translation. Loaded before
 * scripts.js and wordList.js (see index.html) and exposed as
 * window.JapaneseSearch, the same pattern as window.WordClass.
 */
(function (global) {
  "use strict";

  const SMALL_TSU = "っ"; // っ

  // Katakana (U+30A1-U+30F6) sits exactly 0x60 above its Hiragana
  // counterpart (U+3041-U+3096), so a straight code-point shift covers
  // the whole block in both directions.
  function katakanaToHiragana(value) {
    return String(value ?? "").replace(/[ァ-ヶ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x60),
    );
  }

  function hiraganaToKatakana(value) {
    return String(value ?? "").replace(/[ぁ-ゖ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) + 0x60),
    );
  }

  // Longest-match-first Hepburn romaji -> hiragana table. Keys are tried
  // 3, then 2, then 1 characters at a time (see romajiToHiragana below).
  const ROMAJI_TO_HIRAGANA = {
    a: "あ", i: "い", u: "う", e: "え", o: "お",

    ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
    ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
    kya: "きゃ", kyu: "きゅ", kyo: "きょ",
    gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",

    sa: "さ", shi: "し", si: "し", su: "す", se: "せ", so: "そ",
    za: "ざ", ji: "じ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
    sha: "しゃ", sya: "しゃ", shu: "しゅ", syu: "しゅ", sho: "しょ", syo: "しょ",
    ja: "じゃ", zya: "じゃ", jya: "じゃ",
    ju: "じゅ", zyu: "じゅ", jyu: "じゅ",
    jo: "じょ", zyo: "じょ", jyo: "じょ",
    she: "しぇ", je: "じぇ",

    ta: "た", chi: "ち", ti: "ち", tsu: "つ", tu: "つ", te: "て", to: "と",
    da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
    cha: "ちゃ", tya: "ちゃ", cya: "ちゃ",
    chu: "ちゅ", tyu: "ちゅ", cyu: "ちゅ",
    cho: "ちょ", tyo: "ちょ", cyo: "ちょ",
    che: "ちぇ", thi: "てぃ",
    dya: "ぢゃ", dyu: "ぢゅ", dyo: "ぢょ",

    na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
    nya: "にゃ", nyu: "にゅ", nyo: "にょ",

    ha: "は", hi: "ひ", fu: "ふ", hu: "ふ", he: "へ", ho: "ほ",
    ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
    pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
    hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
    bya: "びゃ", byu: "びゅ", byo: "びょ",
    pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
    fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ", fyu: "ふゅ",

    ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
    mya: "みゃ", myu: "みゅ", myo: "みょ",

    ya: "や", yu: "ゆ", yo: "よ", ye: "いぇ",

    ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
    rya: "りゃ", ryu: "りゅ", ryo: "りょ",
    // A few learners type "l" instead of "r" for the ら-row.
    la: "ら", li: "り", lu: "る", le: "れ", lo: "ろ",
    lya: "りゃ", lyu: "りゅ", lyo: "りょ",

    wa: "わ", wo: "を", wi: "うぃ", we: "うぇ",

    va: "ゔぁ", vi: "ゔぃ", vu: "ゔ", ve: "ゔぇ", vo: "ゔぉ",
  };

  // Consonants that can double up before a mora to produce a small tsu
  // (っ), e.g. "kitte" -> き + っ + て.
  const SOKUON_CONSONANTS = new Set([
    "b", "c", "d", "f", "g", "h", "j", "k", "m",
    "p", "r", "s", "t", "v", "w", "z",
  ]);

  // Characters that separate mora without producing kana of their own
  // (e.g. the disambiguating apostrophe in "kon'ya").
  const ROMAJI_SEPARATORS = new Set([" ", "-", "'", "’", "."]);

  // Cap on how many segmentations romajiToHiraganaCandidates will collect,
  // so a pathological run of ambiguous "n"s can't blow up search latency.
  const MAX_ROMAJI_CANDIDATES = 8;

  /**
   * Convert a plain-ASCII romaji string into every plausible hiragana
   * segmentation. Most of the time there's exactly one, but a bare "n"
   * before a vowel is genuinely ambiguous between the な-row reading and
   * ん followed by its own vowel mora -- e.g. "enen" is both えねん and
   * えんえん (延々) -- so both are generated and left for the caller to
   * check against real haystacks rather than guessed away here.
   *
   * A segmentation is only included once it consumes the entire input;
   * partial parses (e.g. plain English words, which rarely form clean
   * mora sequences) are dropped so they don't pollute matches.
   */
  function romajiToHiraganaCandidates(value) {
    const input = String(value ?? "").trim().toLowerCase();
    if (!input) return [];

    const results = new Set();

    function walk(pos, acc) {
      if (results.size >= MAX_ROMAJI_CANDIDATES) return;

      if (pos >= input.length) {
        results.add(acc);
        return;
      }

      const ch = input[pos];

      if (ROMAJI_SEPARATORS.has(ch)) {
        walk(pos + 1, acc);
        return;
      }

      // Doubled consonant -> small tsu, then re-process the second letter.
      if (SOKUON_CONSONANTS.has(ch) && input[pos + 1] === ch) {
        walk(pos + 1, acc + SMALL_TSU);
        return;
      }

      const three = input.slice(pos, pos + 3);
      const two = input.slice(pos, pos + 2);
      let matched = false;

      if (ROMAJI_TO_HIRAGANA[three]) {
        matched = true;
        walk(pos + 3, acc + ROMAJI_TO_HIRAGANA[three]);
      }

      if (ROMAJI_TO_HIRAGANA[two]) {
        matched = true;
        walk(pos + 2, acc + ROMAJI_TO_HIRAGANA[two]);
      }

      if (!matched && ROMAJI_TO_HIRAGANA[ch]) {
        matched = true;
        walk(pos + 1, acc + ROMAJI_TO_HIRAGANA[ch]);
      }

      // "n" is independently always valid as ん on its own, even when it
      // also started a na-row match above -- try both branches.
      if (ch === "n") {
        matched = true;
        walk(pos + 1, acc + "ん");
      }

      // No branch matched -- this path has an unmapped character, so it's
      // simply abandoned (not added to results).
    }

    walk(0, "");
    return Array.from(results);
  }

  /**
   * Convert a plain-ASCII romaji string into its single most likely
   * hiragana reading (the first segmentation found), or null if it
   * doesn't parse as clean romaji at all.
   */
  function romajiToHiragana(value) {
    const [first] = romajiToHiraganaCandidates(value);
    return first ?? null;
  }

  // The topic/object/direction particles は, を, and へ are written with
  // those kana but romanized by their irregular pronunciation ("wa", "o",
  // "e") rather than the regular reading ("ha", "wo", "he") their kana
  // would otherwise get from the table above. Only applies when the whole
  // query is the particle itself -- "wa" inside "wakaru" (わかる) must
  // still convert the regular way.
  const PARTICLE_ROMAJI_ALIASES = { wa: "は", o: "を", e: "へ" };

  function normalizeSearchText(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  // Letters plus the separators romajiToHiraganaCandidates itself
  // understands (space, hyphen, apostrophe, period), so a disambiguating
  // apostrophe like "kon'nichiwa" still reaches the romaji conversion.
  function isAsciiLetters(value) {
    return /^[a-z](?:[a-z' \-.]*[a-z])?$/i.test(value);
  }

  /**
   * All normalized forms a query could plausibly appear as: the raw text,
   * its opposite kana script, and (when the text is plain ASCII letters
   * that parse as clean romaji) the hiragana/katakana it romanizes to.
   */
  function buildQueryVariants(rawQuery) {
    const query = normalizeSearchText(rawQuery);
    if (!query) return [];

    const variants = new Set([query, katakanaToHiragana(query), hiraganaToKatakana(query)]);

    if (isAsciiLetters(query)) {
      romajiToHiraganaCandidates(query).forEach((hiragana) => {
        variants.add(hiragana);
        variants.add(hiraganaToKatakana(hiragana));

        // Phrase-final は spoken "wa" (こんにちは, こんばんは, ...) is the
        // same irregular particle reading, just at the end of a longer
        // greeting rather than standing alone -- also try that spelling.
        if (hiragana.endsWith("わ")) {
          variants.add(hiragana.slice(0, -1) + "は");
        }
      });

      if (PARTICLE_ROMAJI_ALIASES[query]) {
        variants.add(PARTICLE_ROMAJI_ALIASES[query]);
      }
    }

    variants.delete("");
    return Array.from(variants);
  }

  /**
   * All normalized forms an entry's Japanese word/reading could be found
   * under: as written, and converted to the opposite kana script (so a
   * katakana reading like シーディー is also findable in hiragana, and a
   * kanji entry's hiragana reading is also findable in katakana).
   */
  function getEntryReadingHaystacks(entry) {
    const haystacks = new Set();

    [entry?.word, entry?.pronunciation].forEach((raw) => {
      const value = normalizeSearchText(raw);
      if (!value) return;
      haystacks.add(value);
      haystacks.add(katakanaToHiragana(value));
      haystacks.add(hiraganaToKatakana(value));
    });

    haystacks.delete("");
    return Array.from(haystacks);
  }

  /**
   * Whether an entry's Japanese word or reading matches a search query
   * typed as kanji, hiragana, katakana, or romaji. English matching is
   * left to callers, who already compare against entry.engelsk directly.
   */
  function matchesJapaneseQuery(entry, rawQuery) {
    const variants = buildQueryVariants(rawQuery);
    if (!variants.length) return false;

    const haystacks = getEntryReadingHaystacks(entry);
    if (!haystacks.length) return false;

    return variants.some((variant) =>
      haystacks.some((haystack) => haystack.includes(variant)),
    );
  }

  global.JapaneseSearch = {
    katakanaToHiragana,
    hiraganaToKatakana,
    romajiToHiragana,
    romajiToHiraganaCandidates,
    buildQueryVariants,
    matchesJapaneseQuery,
  };
})(window);
