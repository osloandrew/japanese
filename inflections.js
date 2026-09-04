// Japanese verb/adjective conjugation for the learner-facing "Word forms"
// table. Unlike Norwegian's inflections.js (which looks up whole paradigms
// in a lexical corpus, since Bokmål noun/verb forms are irregular), Japanese
// conjugation is fully regular *given the correct conjugation class* -- the
// engine below computes every form from the dictionary headword + class at
// runtime. The one thing that can't be derived from spelling alone is the
// class itself (famous "fake ichidan" godan verbs like 帰る are spelled
// exactly like a real ichidan verb 食べる), which is why there is still a
// small precomputed data file: inflections-data.json, resolved against
// JMdict by scripts/build-inflections.py. See INFLECTIONS_DATA.md.
(function () {
  "use strict";

  const DATA_VERSION = 1;
  const DATA_URL = `inflections-data.json?v=${DATA_VERSION}`;
  const MAX_PENDING_ENTRIES = 100;

  // `self` rather than `window` so this module also runs unmodified inside
  // inflectionsWorker.js (no `window` exists in a worker).
  let snapshot = self.__JAPANESE_INFLECTIONS_DATA__ || null;
  let snapshotPromise = snapshot ? Promise.resolve(snapshot) : null;
  let loadFailed = false;
  let reverseIndex = null;
  let reverseIndexPromise = null;
  let nextRequestId = 1;
  const pendingEntries = new Map();

  // ---- Conjugation engine -------------------------------------------

  const GODAN_ROWS = {
    // final kana -> [a-row, i-row, e-row, o-row]
    う: ["わ", "い", "え", "お"],
    く: ["か", "き", "け", "こ"],
    ぐ: ["が", "ぎ", "げ", "ご"],
    す: ["さ", "し", "せ", "そ"],
    つ: ["た", "ち", "て", "と"],
    ぬ: ["な", "に", "ね", "の"],
    ぶ: ["ば", "び", "べ", "ぼ"],
    む: ["ま", "み", "め", "も"],
    る: ["ら", "り", "れ", "ろ"],
  };

  // Te/ta-form sound change (onbin) by final kana: [stem suffix, te
  // particle, voiced?]. く/ぐ's exception (行く/行って, not 行いて) is
  // handled by the caller via the v5k-s class rather than here.
  const GODAN_ONBIN = {
    う: ["っ", "て", false],
    つ: ["っ", "て", false],
    る: ["っ", "て", false],
    く: ["い", "て", false],
    ぐ: ["い", "で", true],
    す: ["し", "て", false],
    ぬ: ["ん", "で", true],
    ぶ: ["ん", "で", true],
    む: ["ん", "で", true],
  };

  const GODAN_CLASSES = new Set([
    "v5u", "v5k", "v5g", "v5s", "v5t", "v5n", "v5b", "v5m", "v5r",
    "v5aru", "v5r-i", "v5k-s", "v5u-s",
  ]);

  // Pre-noun adjectivals (この/その/いわゆる, ...) and the rare
  // taru-/noun-prenominal classes do not predicate-conjugate at all --
  // "これはこのだ" is not a sentence. No Word Forms table is generated for
  // these; the CSV headword is the only form there is.
  //
  // な/の-adjectives (adj-na, adj-no) are grammatically nominal -- 穏やか
  // never changes; だ/です/じゃない/だった are the copula attaching to it,
  // exactly as they attach to any noun (学生だ/学生です/学生じゃない). A
  // Word Forms table would misrepresent that copula conjugation as if it
  // were the word inflecting the way a true い-adjective does, so these are
  // treated the same as a noun: no table, no computed forms.
  const NO_CONJUGATION_CLASSES = new Set(["adj-pn", "adj-t", "adj-f", "adj-na", "adj-no"]);

  // Te-form of an already-ichidan-shaped derived form. Potential, passive,
  // causative, and causative-passive all end in ~れる or ~せる regardless of
  // the base verb's own class (a godan verb's derived forms conjugate as
  // ichidan words even though the verb itself doesn't) -- so their te-form
  // is the same drop-る/add-て rule as any ichidan verb's own te-form.
  // 囲む -> passive 囲まれる -> 囲まれて; 書く -> causative 書かせる ->
  // 書かせて.
  function ichidanTe(form) {
    return form ? `${form.slice(0, -1)}て` : form;
  }

  // Mutates `forms` in place, adding compound forms that aren't worth a
  // dedicated branch in every conjugateVerb class since they're derived
  // the same way regardless of class:
  //
  // - A `_te` sibling for each of the four derived voice/potential forms --
  //   the compound continuative forms learners need for clauses like
  //   "having been surrounded, ..." (囲まれて) that a bare voice-form table
  //   can't show on its own.
  // - The たい ("want to") desiderative and its plain negative. Every
  //   class's `masu` is already the correct ren'youkei/masu-stem + ます,
  //   irregularities (v5aru's い-stem, vk's き/来) included, so
  //   stripping ます and appending たい is both simpler and more reliably
  //   correct than re-deriving that stem per class. Only the plain
  //   affirmative/negative are added -- たい itself conjugates exactly like
  //   an い-adjective (たかった, たくて, ...), which would just duplicate
  //   the い-adjective table's own pattern for no new information.
  // - The ないで negative te-form ("without doing", "please don't" before
  //   ください) -- unlike the plain te-form, this is not a sound change on
  //   the verb stem at all, just で appended straight after the already-
  //   computed `negative` (itself already correct per class, suppletive
  //   ある included), so no per-class handling is needed here either.
  function addDerivedForms(forms) {
    forms.potential_te = ichidanTe(forms.potential);
    forms.passive_te = ichidanTe(forms.passive);
    forms.causative_te = ichidanTe(forms.causative);
    forms.causative_passive_te = ichidanTe(forms.causative_passive);
    forms.tai = `${forms.masu.slice(0, -2)}たい`;
    forms.tai_negative = `${forms.tai.slice(0, -1)}くない`;
    forms.negative_te = `${forms.negative}で`;
    return forms;
  }

  function conjugateVerb(word, cls) {
    if (cls === "vk") {
      // 来る is always fully irregular; kanji stays 来, only okurigana/
      // reading changes. A kana-only headword ("くる") changes the same way
      // in kana; anything preceding the 来る/くる (e.g. a compound like
      // 帰って来る) is preserved as a literal prefix.
      // A kanji headword's varying reading is carried entirely by the
      // okurigana attached directly after 来 (来ます, 来ない, 来た, ...);
      // a kana-only headword has to spell out the same vowel change in
      // kana instead (きます, こない, きた, ...). Either way, anything
      // before the 来る/くる itself (a compound like 帰って来る) is kept
      // as a literal, unconjugated prefix.
      const isKanaOnly = !word.includes("来");
      const prefix = word.slice(0, -2);
      const stem = isKanaOnly ? "" : "来";
      const ki = isKanaOnly ? "き" : "";
      const ko = isKanaOnly ? "こ" : "";
      const ku = isKanaOnly ? "く" : "";
      return addDerivedForms({
        dictionary: word,
        masu: `${prefix}${stem}${ki}ます`,
        negative: `${prefix}${stem}${ko}ない`,
        past: `${prefix}${stem}${ki}た`,
        te: `${prefix}${stem}${ki}て`,
        polite_past: `${prefix}${stem}${ki}ました`,
        polite_negative: `${prefix}${stem}${ki}ません`,
        polite_past_negative: `${prefix}${stem}${ki}ませんでした`,
        past_negative: `${prefix}${stem}${ko}なかった`,
        potential: `${prefix}${stem}${ko}られる`,
        passive: `${prefix}${stem}${ko}られる`,
        causative: `${prefix}${stem}${ko}させる`,
        causative_passive: `${prefix}${stem}${ko}させられる`,
        volitional: `${prefix}${stem}${ko}よう`,
        volitional_polite: `${prefix}${stem}${ki}ましょう`,
        conditional: `${prefix}${stem}${ku}れば`,
        imperative: `${prefix}${stem}${ko}い`,
      });
    }

    if (cls === "vs-i" || cls === "vs-s") {
      let stem;
      if (word === "する") stem = "";
      else if (word.endsWith("する")) stem = word.slice(0, -2);
      else return null;
      return addDerivedForms({
        dictionary: word,
        masu: `${stem}します`,
        negative: `${stem}しない`,
        past: `${stem}した`,
        te: `${stem}して`,
        polite_past: `${stem}しました`,
        polite_negative: `${stem}しません`,
        polite_past_negative: `${stem}しませんでした`,
        past_negative: `${stem}しなかった`,
        potential: `${stem}できる`,
        // する's passive/causative are irregular (される/させる), not the
        // godan -aRow formula -- both happen to be spelled exactly like an
        // ichidan verb's passive/causative.
        passive: `${stem}される`,
        causative: `${stem}させる`,
        causative_passive: `${stem}させられる`,
        volitional: `${stem}しよう`,
        volitional_polite: `${stem}しましょう`,
        conditional: `${stem}すれば`,
        imperative: `${stem}しろ`,
      });
    }

    if (cls === "vz") {
      // zuru verb (命ずる etc.): an alternative form of an ichidan -jiru
      // verb -- drop ずる, conjugate the じ-stem exactly like ichidan. The
      // dictionary-form row keeps the citation spelling (ずる), since
      // that's the actual CSV headword; every other row uses the じ-stem.
      if (!word.endsWith("ずる")) return null;
      const stem = `${word.slice(0, -2)}じ`;
      return addDerivedForms({
        dictionary: word,
        masu: `${stem}ます`,
        negative: `${stem}ない`,
        past: `${stem}た`,
        te: `${stem}て`,
        polite_past: `${stem}ました`,
        polite_negative: `${stem}ません`,
        polite_past_negative: `${stem}ませんでした`,
        past_negative: `${stem}なかった`,
        potential: `${stem}られる`,
        passive: `${stem}られる`,
        causative: `${stem}させる`,
        causative_passive: `${stem}させられる`,
        volitional: `${stem}よう`,
        volitional_polite: `${stem}ましょう`,
        conditional: `${stem}れば`,
        imperative: `${stem}ろ`,
      });
    }

    if (cls === "v1" || cls === "v1-s") {
      if (!word.endsWith("る")) return null;
      const stem = word.slice(0, -1);
      return addDerivedForms({
        dictionary: word,
        masu: `${stem}ます`,
        negative: `${stem}ない`,
        past: `${stem}た`,
        te: `${stem}て`,
        polite_past: `${stem}ました`,
        polite_negative: `${stem}ません`,
        polite_past_negative: `${stem}ませんでした`,
        past_negative: `${stem}なかった`,
        // Potential and passive are homophonous for every ichidan verb
        // (both stem+られる) -- context, not spelling, disambiguates them.
        potential: `${stem}られる`,
        passive: `${stem}られる`,
        causative: `${stem}させる`,
        causative_passive: `${stem}させられる`,
        volitional: `${stem}よう`,
        volitional_polite: `${stem}ましょう`,
        conditional: `${stem}れば`,
        // くれる (v1-s) has one genuine irregularity: the imperative is
        // the bare stem くれ, not the regular ichidan stem+ろ (くれろ is
        // not used).
        imperative: cls === "v1-s" ? stem : `${stem}ろ`,
      });
    }

    if (GODAN_CLASSES.has(cls)) {
      const final = word.slice(-1);
      const rows = GODAN_ROWS[final];
      if (!rows) return null;
      const stem = word.slice(0, -1);
      const [aRow, iRow, eRow, oRow] = rows;

      const irregularIku = cls === "v5k-s";
      const [onbinSuffix, teParticle, voiced] = irregularIku
        ? ["っ", "て", false]
        : GODAN_ONBIN[final];
      const da = voiced ? "だ" : "た";
      const de = voiced ? "で" : "て";

      const forms = { dictionary: word };

      if (cls === "v5aru") {
        // -aru special class (いらっしゃる、下さる、なさる、おっしゃる):
        // the polite/imperative stem is い, not the regular り.
        forms.masu = `${stem}います`;
        forms.polite_past = `${stem}いました`;
        forms.polite_negative = `${stem}いません`;
        forms.polite_past_negative = `${stem}いませんでした`;
        forms.volitional_polite = `${stem}いましょう`;
        forms.imperative = `${stem}い`;
      } else {
        forms.masu = `${stem}${iRow}ます`;
        forms.polite_past = `${stem}${iRow}ました`;
        forms.polite_negative = `${stem}${iRow}ません`;
        forms.polite_past_negative = `${stem}${iRow}ませんでした`;
        forms.volitional_polite = `${stem}${iRow}ましょう`;
        forms.imperative = `${stem}${eRow}`;
      }

      if (cls === "v5r-i") {
        // ある: the plain negative is always suppletive ない, never the
        // regular あらない.
        forms.negative = "ない";
        forms.past_negative = "なかった";
      } else {
        forms.negative = `${stem}${aRow}ない`;
        forms.past_negative = `${stem}${aRow}なかった`;
      }

      forms.past = `${stem}${onbinSuffix}${da}`;
      forms.te = `${stem}${onbinSuffix}${teParticle}`;
      forms.potential = `${stem}${eRow}る`;
      forms.passive = `${stem}${aRow}れる`;
      forms.causative = `${stem}${aRow}せる`;
      forms.causative_passive = `${stem}${aRow}せられる`;
      forms.volitional = `${stem}${oRow}う`;
      forms.conditional = `${stem}${eRow}ば`;
      return addDerivedForms(forms);
    }

    return null;
  }

  function conjugateAdjective(word, cls) {
    if (cls === "adj-ix") {
      // いい/良い, and any compound built on it (格好良い "kakko ii" ==
      // "cool", 気持ちいい == "feels good"): only the dictionary-form row
      // keeps the bare い/良い; every other form is built on the よい/良
      // stem (格好良くない, not 格好良いくない), with the compound's own
      // prefix carried through unchanged.
      const isKanjiForm = word.endsWith("良い");
      const isKanaForm = word.endsWith("いい");
      if (!isKanjiForm && !isKanaForm) return null;
      const prefix = word.slice(0, -2);
      const stem = `${prefix}${isKanjiForm ? "良" : "よ"}`;
      return {
        dictionary: word,
        negative: `${stem}くない`,
        past: `${stem}かった`,
        te: `${stem}くて`,
        adverbial: `${stem}く`,
        polite_negative: `${stem}くないです`,
        polite_past: `${stem}かったです`,
        past_negative: `${stem}くなかった`,
        polite_past_negative: `${stem}くなかったです`,
        conditional: `${stem}ければ`,
      };
    }

    if (cls === "adj-i") {
      if (!word.endsWith("い")) return null;
      const stem = word.slice(0, -1);
      return {
        dictionary: word,
        negative: `${stem}くない`,
        past: `${stem}かった`,
        te: `${stem}くて`,
        adverbial: `${stem}く`,
        polite_negative: `${stem}くないです`,
        polite_past: `${stem}かったです`,
        past_negative: `${stem}くなかった`,
        polite_past_negative: `${stem}くなかったです`,
        conditional: `${stem}ければ`,
      };
    }

    return null;
  }

  // ---- Labeled tables for the UI -------------------------------------

  // Row order follows a beginner-to-advanced teaching progression rather
  // than the order the forms were added to the engine in:
  //  1. The plain/polite x non-past/past affirmative-negative paradigm
  //     (8 rows) -- the first thing any course covers.
  //  2. The te-form family: plain te, its negative ないで, then たい/
  //     たくない -- all still core early material, built directly off the
  //     masu-stem/te-form the learner already has by this point.
  //  3. Volitional, conditional, imperative -- the other core "moods",
  //     still beginner (N5) material but distinct enough from the above to
  //     group on their own.
  //  4. The four derived voice/potential forms (potential, passive,
  //     causative, causative-passive) as a block at the end, each
  //     immediately followed by its own te-form -- these are the most
  //     grammatically advanced (N4-N3) forms in the table, and the ones
  //     most likely to overwhelm if interleaved earlier.
  function verbFormsTable(forms) {
    return {
      wordClass: "verb",
      forms: [
        { label: "Dictionary form", value: forms.dictionary },
        { label: "Polite (ます)", value: forms.masu },
        { label: "Negative", value: forms.negative },
        { label: "Polite negative (ません)", value: forms.polite_negative },
        { label: "Past", value: forms.past },
        { label: "Polite past (ました)", value: forms.polite_past },
        { label: "Past negative", value: forms.past_negative },
        { label: "Polite past negative (ませんでした)", value: forms.polite_past_negative },
        { label: "Te-form", value: forms.te },
        { label: "Te-form negative (ないで)", value: forms.negative_te },
        { label: "Want to (たい)", value: forms.tai },
        { label: "Don't want to (たくない)", value: forms.tai_negative },
        { label: "Volitional", value: forms.volitional },
        { label: "Volitional (polite; ましょう)", value: forms.volitional_polite },
        { label: "Conditional (ば)", value: forms.conditional },
        { label: "Imperative", value: forms.imperative },
        { label: "Potential", value: forms.potential },
        { label: "Potential te-form", value: forms.potential_te },
        { label: "Passive", value: forms.passive },
        { label: "Passive te-form", value: forms.passive_te },
        { label: "Causative", value: forms.causative },
        { label: "Causative te-form", value: forms.causative_te },
        { label: "Causative-passive", value: forms.causative_passive },
        { label: "Causative-passive te-form", value: forms.causative_passive_te },
      ],
    };
  }

  function iAdjectiveFormsTable(forms) {
    return {
      wordClass: "adjective",
      forms: [
        { label: "Dictionary form", value: forms.dictionary },
        { label: "Negative", value: forms.negative },
        { label: "Polite negative", value: forms.polite_negative },
        { label: "Past", value: forms.past },
        { label: "Polite past", value: forms.polite_past },
        { label: "Past negative", value: forms.past_negative },
        { label: "Polite past negative", value: forms.polite_past_negative },
        { label: "Te-form", value: forms.te },
        { label: "Adverbial", value: forms.adverbial },
        { label: "Conditional (ば)", value: forms.conditional },
      ],
    };
  }

  // ---- Classification lookup + snapshot loading -----------------------

  function classificationKey(entry) {
    const wordClass = String(entry?.gender || "").trim();
    if (wordClass !== "verb" && wordClass !== "adjective") return "";
    const primaryWord = String(entry?.ord || "").split(/[,、]/)[0].trim();
    if (!primaryWord) return "";
    return `${wordClass[0]}:${primaryWord}`;
  }

  function getClassification(entry) {
    const key = classificationKey(entry);
    if (!key || !snapshot?.classifications) return null;
    return snapshot.classifications[key] || null;
  }

  // Unlike classificationKey above (verb/adjective only -- the only classes
  // with a conjugation to look up), this keys *any* dictionary entry, for
  // the word-linking reverse index below: a noun or particle has no
  // conjugation, but it's still a real headword a story or definition can
  // cite and a reader can click. Keyed by the full class name (not a
  // single-letter prefix) since "adjective"/"adverb" and "noun"/"numeral"
  // would otherwise collide on their first letter.
  function entryKey(entry) {
    const wordClass = String(entry?.gender || "").trim();
    const primaryWord = String(entry?.ord || "").split(/[,、]/)[0].trim();
    if (!wordClass || !primaryWord) return "";
    return `${wordClass}:${primaryWord}`;
  }

  function parseEntryKey(key) {
    const separator = String(key || "").indexOf(":");
    if (separator < 0) return null;
    return {
      wordClass: key.slice(0, separator),
      lemma: key.slice(separator + 1),
    };
  }

  function computeFormsAndTable(entry, classification) {
    const wordClass = String(entry?.gender || "").trim();
    const primaryWord = String(entry?.ord || "").split(/[,、]/)[0].trim();
    if (!primaryWord || !classification) return null;
    const cls = classification.class;
    if (NO_CONJUGATION_CLASSES.has(cls)) return null;

    const forms =
      wordClass === "verb"
        ? conjugateVerb(primaryWord, cls)
        : conjugateAdjective(primaryWord, cls);
    if (!forms) return null;

    const table =
      wordClass === "verb" ? verbFormsTable(forms) : iAdjectiveFormsTable(forms);

    return { forms, table };
  }

  function createForms(entry) {
    const classification = getClassification(entry);
    if (!classification) return null;
    const computed = computeFormsAndTable(entry, classification);
    if (!computed) return null;

    return {
      ...computed.table,
      lemma: String(entry.ord || "").split(/[,、]/)[0].trim(),
      isAuthoritative: classification.source === "jmdict",
      source: classification.source === "jmdict" ? "JMdict" : "estimated",
      sourceType: classification.source === "jmdict" ? "jmdict" : "estimated",
      conjugationClass: classification.class,
    };
  }

  function loadSnapshot() {
    if (snapshot) return Promise.resolve(snapshot);
    if (loadFailed) return Promise.resolve(null);
    if (snapshotPromise) return snapshotPromise;

    snapshotPromise = fetch(new URL(DATA_URL, APP_ROOT_URL), { cache: "default" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Inflection data request failed (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (!data || typeof data.classifications !== "object") {
          throw new Error("Inflection data has an invalid format");
        }
        snapshot = data;
        return snapshot;
      })
      .catch((error) => {
        loadFailed = true;
        console.warn("Word forms could not be loaded.", error);
        return null;
      });

    return snapshotPromise;
  }

  function rememberPendingEntry(entry) {
    const requestId = String(nextRequestId++);
    pendingEntries.set(requestId, {
      ord: entry.ord,
      gender: entry.gender,
    });
    while (pendingEntries.size > MAX_PENDING_ENTRIES) {
      pendingEntries.delete(pendingEntries.keys().next().value);
    }
    return requestId;
  }

  function getForms(entry) {
    const wordClass = String(entry?.gender || "").trim();
    if (wordClass !== "verb" && wordClass !== "adjective") return null;
    if (!entry?.ord) return null;

    if (snapshot || loadFailed) return createForms(entry);

    return {
      wordClass,
      pending: true,
      requestId: rememberPendingEntry(entry),
      forms: [],
    };
  }

  async function resolvePending(requestId) {
    const entry = pendingEntries.get(String(requestId));
    pendingEntries.delete(String(requestId));
    if (!entry) return null;
    await loadSnapshot();
    return createForms(entry);
  }

  // ---- Reverse index (surface form -> dictionary entry) ----
  //
  // Powers word-linking in both definitions and stories: resolving any
  // known word (in whatever inflected form it actually appears in, e.g.
  // 食べた, 忙しかった) back to the dictionary entry it belongs to, the
  // same way Norwegian's clickable words already work. Built lazily, off
  // the main thread when possible -- see inflectionsWorker.js.

  // Every literal surface form a given entry can appear as: for a verb or
  // adjective, its full conjugated paradigm; for every other class (which
  // has no conjugation), just its own headword(s) -- still a real word a
  // story or definition can cite verbatim.
  function collectAllSurfaceForms(entry) {
    const headwords = String(entry?.ord || "")
      .split(/[,、]/)
      .map((word) => word.trim())
      .filter(Boolean);

    const wordClass = String(entry?.gender || "").trim();
    if (wordClass !== "verb" && wordClass !== "adjective") return headwords;

    const classification = getClassification(entry);
    if (!classification) return headwords;
    const computed = computeFormsAndTable(entry, classification);
    if (!computed) return headwords;
    return [...headwords, ...Object.values(computed.forms).filter(Boolean)];
  }

  // Word forms to search the example-sentence corpus with and highlight in
  // matches -- the definition page's Sentence Search fallback (see
  // fetchAndRenderSentences in scripts.js). Mirrors Norwegian's
  // getSentenceForms, but simpler: Japanese conjugation is derived purely
  // from the headword's own spelling and class, so (unlike Bokmål nouns,
  // which look up a shared paradigm keyed by lemma) two different dictionary
  // entries never contend over the same computed forms.
  async function getSentenceForms(entry) {
    if (!entry?.ord) return [];
    const wordClass = String(entry?.gender || "").trim();
    if ((wordClass === "verb" || wordClass === "adjective") && !snapshot && !loadFailed) {
      await loadSnapshot();
    }
    return collectAllSurfaceForms(entry);
  }

  // Norwegian's counterpart reallocates shared forms away from a homograph's
  // competing noun-gender paradigm; no such reallocation is needed here (see
  // getSentenceForms above), so this is a thin pass-through kept for call-site
  // parity with the Norwegian-derived callers in scripts.js and wordGame.js.
  async function getSupplementalSentenceForms(entry, _dictionaryEntries = []) {
    return getSentenceForms(entry);
  }

  function addReverseMapping(index, surface, lemmaKey) {
    if (!surface) return;
    const existing = index.get(surface);
    if (!existing) {
      index.set(surface, lemmaKey);
    } else if (typeof existing === "string") {
      if (existing !== lemmaKey) index.set(surface, [existing, lemmaKey]);
    } else if (!existing.includes(lemmaKey)) {
      existing.push(lemmaKey);
    }
  }

  function indexReverseForms(entries) {
    const index = new Map();
    for (const entry of entries || []) {
      const key = entryKey(entry);
      if (!key) continue;
      for (const form of collectAllSurfaceForms(entry)) {
        addReverseMapping(index, form, key);
      }
    }
    return index;
  }

  // Generous upper bound on a single surface form's character length, for
  // the maximum-matching text segmenter below. Comfortably longer than any
  // real conjugated form (the longest, an -aru-class polite past negative
  // like いらっしゃいませんでした, is 12) or realistic compound headword --
  // cheap to over-allocate since it only bounds a per-position inner loop,
  // not memory.
  const MAX_SURFACE_FORM_LENGTH = 16;

  // Called from inflectionsWorker.js (via self.Inflections) -- the worker
  // has its own module-level `snapshot`, populated by its own
  // loadSnapshot() call here, independent of the main thread's copy.
  async function computeReverseIndexData(entries) {
    if (!(await loadSnapshot())) return new Map();
    return indexReverseForms(entries);
  }

  let inflectionsWorker = null;
  let inflectionsWorkerFailed = false;

  function getInflectionsWorker() {
    if (inflectionsWorkerFailed) return null;
    if (inflectionsWorker) return inflectionsWorker;
    if (typeof Worker !== "function") {
      inflectionsWorkerFailed = true;
      return null;
    }
    try {
      inflectionsWorker = new Worker(
        new URL("inflectionsWorker.js?v=1", APP_ROOT_URL),
      );
    } catch (error) {
      inflectionsWorkerFailed = true;
      inflectionsWorker = null;
    }
    return inflectionsWorker;
  }

  function buildReverseIndexOffMainThread(entries) {
    return new Promise((resolve, reject) => {
      const worker = getInflectionsWorker();
      if (!worker) {
        reject(new Error("Web Worker unavailable"));
        return;
      }

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };
      const handleMessage = (event) => {
        cleanup();
        if (event.data?.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.index);
        }
      };
      const handleError = (event) => {
        cleanup();
        inflectionsWorkerFailed = true;
        inflectionsWorker = null;
        reject((event && event.error) || new Error("Reverse-index worker failed"));
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage({ entries });
    });
  }

  async function buildReverseIndex(entries) {
    if (reverseIndex) return reverseIndex;
    if (reverseIndexPromise) return reverseIndexPromise;

    reverseIndexPromise = buildReverseIndexOffMainThread(entries)
      .then((index) => {
        reverseIndex = index;
        return reverseIndex;
      })
      .catch((error) => {
        console.warn(
          "Reverse-index worker unavailable, building on the main thread instead.",
          error,
        );
        return loadSnapshot().then(() => {
          reverseIndex = indexReverseForms(entries);
          return reverseIndex;
        });
      });
    return reverseIndexPromise;
  }

  function readReverseMappings(index, surface) {
    const value = index?.get(surface);
    if (!value) return [];
    return typeof value === "string" ? [value] : value;
  }

  // Finds every dictionary entry (by its entryKey) whose surface forms
  // include `surface`. `entries` is the full CSV dictionary (only needed
  // the first time -- the index is cached after).
  async function findLemmas(surface, entries) {
    const normalizedSurface = String(surface ?? "").trim();
    if (!normalizedSurface) return [];
    const index = await buildReverseIndex(entries);
    return readReverseMappings(index, normalizedSurface);
  }

  // True once the reverse index is already built and can be used
  // synchronously (segmentText below, in its sync fast path). Also true
  // once index-building has failed outright (loadFailed) -- there's
  // nothing more to wait for, sync callers should just treat that as "no
  // known words" rather than stall forever.
  function isReverseIndexReady() {
    return Boolean(reverseIndex) || (loadFailed && !reverseIndexPromise);
  }

  // Cost of leaving one character out of any dictionary match, relative to
  // the flat cost of 1 per matched token below. Set well above any
  // plausible token-count difference so the DP always prefers a
  // segmentation that fully covers the text in known words over one that
  // strands characters unmatched, even when the latter's matches are
  // individually longer. See segmentText for why that matters.
  const UNMATCHED_CHAR_PENALTY = 3;

  // Segments a run of Japanese text (a definition, a story sentence -- text
  // with no spaces between words) into known-word spans plus the plain
  // text between them.
  //
  // This is dictionary lookup, not real morphological analysis -- there's
  // no POS grammar or trained cost model behind it (unlike MeCab and
  // friends). But it's more than a greedy longest-match scan: greedy
  // matching picks whatever candidate is longest *at the current
  // position* with no regard for what that leaves behind, and a shorter
  // but still real dictionary entry can straddle a word boundary and win
  // by accident. E.g. in 時間がちょっと長い ("...the time is a little
  // long"), が is the topic particle and ちょっと ("a little") is its own
  // indexed word -- but がち is *also* a real indexed entry (a "tend to"
  // suffix), and it's longer than が alone, so greedy matching takes it,
  // consuming が's character and ちょっと's first character together and
  // leaving ょっ behind as orphaned, unmatched, hint-less text.
  //
  // To avoid that, this runs a shortest-path DP over the string instead:
  // every position is a node, every dictionary match starting there is an
  // edge to (position + match length) costing 1, and every single
  // unmatched character is a fallback edge costing UNMATCHED_CHAR_PENALTY.
  // The lowest-cost path from 0 to text.length is the segmentation with
  // the fewest leftover unmatched characters (checked first, since it
  // dominates the cost), tie-broken by the fewest tokens -- which is what
  // naturally prefers a real indexed compound (尊重する) over splitting it
  // into unrelated shorter words it happens to contain. Because がち + [ょ]
  // + [っ] + と leaves two characters unmatched while が + ちょっと leaves
  // none, the DP takes the full-coverage path even though がち is the
  // longer individual match. A real (if unindexed) compound like 見つける
  // still degrades the same way it always did: if no full-coverage path
  // exists, the DP falls back to whatever combination of shorter known
  // words and unmatched characters minimizes the cost.
  //
  // Returns [{ start, end, text, wordClass, lemma }, ...] for each known
  // span, in left-to-right order. Callers render the gaps between spans
  // (and before/after all of them, including every unmatched-character
  // edge on the winning path) as plain text.
  function segmentText(text, index) {
    const n = text.length;
    // bestCost[i] / bestEdge[i]: cheapest way to reach position i from 0,
    // and the edge taken into it ({ from, length }, length 0 = an
    // unmatched-character skip). Filled in increasing order of i, so every
    // edge out of i is only considered once bestCost[i] is final.
    const bestCost = new Array(n + 1).fill(Infinity);
    const bestEdge = new Array(n + 1).fill(null);
    bestCost[0] = 0;

    for (let i = 0; i < n; i++) {
      if (bestCost[i] === Infinity) continue;
      const upperBound = Math.min(MAX_SURFACE_FORM_LENGTH, n - i);
      for (let length = upperBound; length >= 1; length--) {
        if (!index.has(text.slice(i, i + length))) continue;
        const target = i + length;
        const cost = bestCost[i] + 1;
        if (cost < bestCost[target]) {
          bestCost[target] = cost;
          bestEdge[target] = { from: i, length };
        }
      }
      const skipCost = bestCost[i] + UNMATCHED_CHAR_PENALTY;
      if (skipCost < bestCost[i + 1]) {
        bestCost[i + 1] = skipCost;
        bestEdge[i + 1] = { from: i, length: 0 };
      }
    }

    const path = [];
    for (let pos = n; pos > 0; ) {
      const edge = bestEdge[pos];
      path.push(edge);
      pos = edge.from;
    }
    path.reverse();

    const spans = [];
    for (const edge of path) {
      if (edge.length === 0) continue;
      const start = edge.from;
      const end = edge.from + edge.length;
      const matchedText = text.slice(start, end);
      const keys = readReverseMappings(index, matchedText);
      const parsed = parseEntryKey(Array.isArray(keys) ? keys[0] : keys);
      spans.push({
        start,
        end,
        text: matchedText,
        wordClass: parsed?.wordClass || "",
        lemma: parsed?.lemma || "",
      });
    }
    return spans;
  }

  // Synchronous fast path for a render that can't wait on a promise (the
  // first paint of a definition/story). Returns [] before the index is
  // ready -- callers render plain text in that case and upgrade once
  // segmentTextAsync resolves (mirrors Norwegian's
  // upgradeDefinitionExpressionSpans two-pass render).
  function segmentTextSync(text) {
    if (!text || !reverseIndex) return [];
    return segmentText(text, reverseIndex);
  }

  async function segmentTextAsync(text, entries) {
    if (!text) return [];
    const index = await buildReverseIndex(entries);
    return segmentText(text, index);
  }

  self.Inflections = Object.freeze({
    computeReverseIndexData,
    conjugateVerb,
    conjugateAdjective,
    getForms,
    getSentenceForms,
    getSupplementalSentenceForms,
    resolvePending,
    findLemmas,
    isReverseIndexReady,
    segmentTextSync,
    segmentTextAsync,
    preload: loadSnapshot,
    isReady: () => Boolean(snapshot),
  });
})();
