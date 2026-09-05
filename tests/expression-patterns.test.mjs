import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console, Map, Promise, Set, RegExp });
context.window = context;
context.self = context;
context.__JAPANESE_INFLECTIONS_DATA__ = JSON.parse(
  fs.readFileSync(path.join(root, "inflections-data.json"), "utf8"),
);

// A small, self-contained dictionary rather than the full ~9,700-row CSV, so
// shadow-guarding and tail lookup behave predictably and the test doesn't
// depend on the live word list's exact contents.
context.results = [
  { ord: "くれる", gender: "verb", eksempel: "友達が誕生日に本をくれた。" },
  { ord: "てくれる", gender: "expression", eksempel: "駅まで送ってくれてありがとう。" },
  { ord: "について", gender: "expression", eksempel: "来年度の予算について話し合った。" },
  {
    ord: "のだ、んだ",
    gender: "expression",
    eksempel: "明日の朝は始発に乗らないといけないから、今日は早く帰るんだ。",
  },
  { ord: "仕方が無い", gender: "expression", eksempel: "" },
];

for (const file of [
  "wordClass.js",
  "inflections.js",
  "expressionPatterns.js",
  "sentenceFormMatching.js",
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
    filename: file,
  });
}

const [kureruEntry, teKureruEntry, nitsuiteEntry, nodaEntry, shikataEntry] =
  context.results;

// てくれる: fixed prefix + くれる's own conjugation, glued directly with no
// gap -- くれた alone (no preceding て) must NOT count as an occurrence.
const teKureru = await context.ExpressionPatterns.getAnalysis(teKureruEntry);
assert.ok(teKureru, "てくれる should produce an analysis");
assert.equal(teKureru.matcher.test(teKureruEntry.eksempel), true);
assert.equal(teKureru.matcher.test(kureruEntry.eksempel), false);
assert.equal(teKureru.matcher.test("今日は天気がいい。"), false);

const teKureruMatch = teKureru.matcher.find(teKureruEntry.eksempel);
assert.equal(teKureruMatch.matchedText, "てくれて");
assert.equal(
  teKureruEntry.eksempel.slice(teKureruMatch.start, teKureruMatch.end),
  "てくれて",
);

const teKureruHighlight = teKureru.matcher.highlight(teKureruEntry.eksempel);
assert.match(teKureruHighlight, />てくれて<\/span>/u);

// について: a fixed particle pattern with no conjugating tail of its own --
// still just a literal substring match, no token/span alignment needed.
const nitsuite = await context.ExpressionPatterns.getAnalysis(nitsuiteEntry);
assert.equal(nitsuite.matcher.test(nitsuiteEntry.eksempel), true);
assert.equal(nitsuite.matcher.test("今日は天気がいい。"), false);
const nitsuiteMatch = nitsuite.matcher.find(nitsuiteEntry.eksempel);
assert.equal(nitsuiteMatch.matchedText, "について");

// のだ、んだ: two citation forms for one entry, split on the Japanese comma
// rather than requiring either to inflect into the other.
const noda = await context.ExpressionPatterns.getAnalysis(nodaEntry);
assert.equal(noda.matcher.test(nodaEntry.eksempel), true, "んだ form");
assert.equal(noda.matcher.test("彼は忙しいのだ。"), true, "のだ form");
assert.equal(noda.matcher.test("彼は忙しい。"), false);

// 仕方が無い: the CSV cites the kanji spelling, but real sentences overwhelm-
// ingly write it in kana (仕方がない) -- both must match the same entry.
const shikata = await context.ExpressionPatterns.getAnalysis(shikataEntry);
assert.equal(shikata.matcher.test("雨で試合が中止なら仕方がない。"), true);
assert.equal(shikata.matcher.test("仕方が無いことだ。"), true);

// getAnalysis is memoized per entry so repeated lookups (e.g. across game
// rounds) don't re-run tail lookup/conjugation or rebuild the matcher.
assert.equal(
  await context.ExpressionPatterns.getAnalysis(teKureruEntry),
  await context.ExpressionPatterns.getAnalysis(teKureruEntry),
);

assert.equal(await context.ExpressionPatterns.getAnalysis({ ord: "" }), null);

console.log("expression-patterns.test.mjs passed");
