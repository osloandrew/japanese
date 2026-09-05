import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console, Map, Promise, Set });
context.window = context;
context.self = context;
context.__JAPANESE_INFLECTIONS_DATA__ = JSON.parse(
  fs.readFileSync(path.join(root, "inflections-data.json"), "utf8"),
);

vm.runInContext(fs.readFileSync(path.join(root, "inflections.js"), "utf8"), context, {
  filename: "inflections.js",
});

// だ/です/ます have their own closed copula/polite-auxiliary paradigm --
// none of it derivable from the regular verb/adjective conjugation classes
// -- and are tagged gender "auxiliary" in the CSV, which
// resolveConjugationRecipe must still recognize via AUXILIARY_CLASSIFICATIONS
// rather than the JMdict-derived snapshot (which only ever classifies
// "verb"/"adjective" rows).
const da = await context.Inflections.getSentenceForms({ ord: "だ", gender: "auxiliary" });
for (const form of ["だ", "じゃない", "ではない", "だった", "じゃなかった", "ではなかった"]) {
  assert.ok(da.includes(form), `だ forms should include ${form}`);
}

const desu = await context.Inflections.getSentenceForms({ ord: "です", gender: "auxiliary" });
for (const form of ["です", "ではありません", "じゃありません", "でした"]) {
  assert.ok(desu.includes(form), `です forms should include ${form}`);
}

const masu = await context.Inflections.getSentenceForms({ ord: "ます", gender: "auxiliary" });
assert.deepEqual(
  Array.from(masu),
  ["ます", "ません", "ました", "ませんでした", "ましょう"],
);

// せる/れる/たい conjugate exactly like an ordinary ichidan verb / い-adjective
// -- AUXILIARY_CLASSIFICATIONS routes them through the *existing* engine
// (no new conjugation code) even though their CSV row is tagged "auxiliary",
// not "verb"/"adjective".
const seru = await context.Inflections.getSentenceForms({ ord: "せる", gender: "auxiliary" });
assert.ok(seru.includes("せない") && seru.includes("せた") && seru.includes("せます"));

const tai = await context.Inflections.getSentenceForms({ ord: "たい", gender: "auxiliary" });
assert.ok(tai.includes("たくない") && tai.includes("たかった"));

// An auxiliary with no known recipe (それでは, ではない, ...) stays exactly
// as before: its own literal spelling only, no attempted conjugation.
const sore = await context.Inflections.getSentenceForms({
  ord: "それでは",
  gender: "auxiliary",
});
assert.deepEqual(Array.from(sore), ["それでは"]);

// The Word Forms table (getForms/createForms) renders a two-alternative
// slot (じゃない/ではない) as one joined display string, while
// getSentenceForms above still sees both as separately searchable forms.
const daTable = context.Inflections.getForms({ ord: "だ", gender: "auxiliary" });
assert.equal(daTable.wordClass, "auxiliary");
assert.equal(daTable.sourceType, "estimated");
const negativeRow = daTable.forms.find((form) => form.label === "Negative");
assert.equal(negativeRow.value, "じゃない / ではない");

// Regression: ordinary verbs, adjectives, and last session's multi-spelling
// fix (いる、居る) are unaffected by routing everything through
// resolveConjugationRecipe.
const taberu = await context.Inflections.getSentenceForms({ ord: "食べる", gender: "verb" });
assert.ok(taberu.includes("食べた") && taberu.length > 15);

const iru = await context.Inflections.getSentenceForms({ ord: "いる、居る", gender: "verb" });
assert.ok(iru.includes("いた") && iru.includes("居た"));

// getParadigmForLemma feeds the Word Game's cloze-distractor and typed-
// answer-near-miss code (wordGame.js), which walks `.slots` by index and
// expects slot 0 to always be the lemma's own dictionary form. Unlike
// Norwegian's lexical-paradigm lookup, this is built from the same
// conjugation engine/table as getForms, so slot order must match
// verbFormsTable/iAdjectiveFormsTable's own row order exactly.
const taberuParadigm = context.Inflections.getParadigmForLemma("食べる", "verb");
assert.equal(taberuParadigm.wordClass, "verb");
assert.deepEqual(Array.from(taberuParadigm.slots[0]), ["食べる"]);
assert.deepEqual(Array.from(taberuParadigm.slots[4]), ["食べた"]); // past, per verbFormsTable order
assert.ok(Array.from(taberuParadigm.slots.flat()).includes("食べます"));
assert.ok(Array.from(taberuParadigm.slots.flat()).includes("食べられる")); // potential/passive slots

const isogashiiParadigm = context.Inflections.getParadigmForLemma("忙しい", "adjective");
assert.equal(isogashiiParadigm.wordClass, "adjective");
assert.deepEqual(Array.from(isogashiiParadigm.slots[0]), ["忙しい"]);
assert.deepEqual(Array.from(isogashiiParadigm.slots[3]), ["忙しかった"]); // past, per iAdjectiveFormsTable order

// いい/良い is the one adjective class whose every non-dictionary form is
// built on a different stem (よい/良) than the dictionary row itself.
const iiParadigm = context.Inflections.getParadigmForLemma("いい", "adjective");
assert.deepEqual(Array.from(iiParadigm.slots[0]), ["いい"]);
assert.deepEqual(Array.from(iiParadigm.slots[1]), ["よくない"]);

// A noun has exactly one slot: Japanese nouns do not inflect at all, unlike
// Bokmål's definite/indefinite x singular/plural paradigm.
const nounParadigm = context.Inflections.getParadigmForLemma("猫", "noun");
assert.deepEqual(Array.from(nounParadigm.slots, (slot) => Array.from(slot)), [["猫"]]);

// No classification available (word not in the JMdict-derived snapshot and
// not a known AUXILIARY_CLASSIFICATIONS override) -- returns null exactly
// like every other Inflections lookup does for an unrecognized word, so
// call sites' existing `if (!paradigm) return ...` guards keep working.
assert.equal(context.Inflections.getParadigmForLemma("存在しない単語", "verb"), null);

// Non-conjugatable classes (predicate adjectivals) never got a Word Forms
// table either -- getParadigmForLemma must not silently claim they do.
assert.equal(context.Inflections.getParadigmForLemma("いわゆる", "adjective"), null);

// findLemmas must return the { lemmas, matches, matchType } shape wordGame.js
// and scripts.js actually consume -- it used to return a bare array of
// entryKey strings, silently breaking every caller that reads
// resolution.matchType/resolution.matches (they always saw `undefined` and
// no-opped). `entries` here is the (small, synthetic) CSV dictionary used to
// build the reverse index -- only needed on this first call, since the index
// is cached for every findLemmas call after.
const findLemmasEntries = [
  { ord: "食べる", gender: "verb" },
  { ord: "test1", gender: "noun" },
  { ord: "test1", gender: "adjective" },
];

// findLemmas runs inside the vm context above, so its return values are
// built from that context's own Array/Object realm -- assert.deepEqual
// (strict) rejects those against main-realm literals as "not
// reference-equal" even when the contents match. Round-tripping through
// JSON strips the foreign realm and leaves plain, comparable data (safe here
// since every findLemmas field is JSON-safe).
const plain = (value) => JSON.parse(JSON.stringify(value));

const taberuResolution = plain(
  await context.Inflections.findLemmas("食べた", findLemmasEntries),
);
assert.deepEqual(taberuResolution.lemmas, ["食べる"]);
assert.deepEqual(taberuResolution.matches, [{ lemma: "食べる", wordClass: "verb" }]);
assert.equal(taberuResolution.matchType, "exact");

// A surface form shared by two dictionary senses of different word classes
// (a homograph) must surface both matches -- conflating them into a single
// lemma string is exactly what the richer `matches` shape (over the plain
// `lemmas` list) exists to prevent for callers disambiguating by word class.
const homographResolution = plain(await context.Inflections.findLemmas("test1"));
assert.deepEqual(homographResolution.lemmas, ["test1"]);
assert.deepEqual(
  new Set(homographResolution.matches.map((match) => match.wordClass)),
  new Set(["noun", "adjective"]),
);
assert.equal(homographResolution.matchType, "exact");

// No dictionary entry has this surface form at all.
assert.deepEqual(plain(await context.Inflections.findLemmas("存在しない単語探索")), {
  lemmas: [],
  matches: [],
  matchType: "none",
});

// Empty/whitespace-only surface short-circuits without touching the index.
assert.deepEqual(plain(await context.Inflections.findLemmas("   ")), {
  lemmas: [],
  matches: [],
  matchType: "none",
});

console.log("inflections.test.mjs passed");
