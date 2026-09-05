import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "japaneseSearch.js"), "utf8");

const windowObject = {};
const context = vm.createContext({ window: windowObject, String, Array, Set });
vm.runInContext(source, context, { filename: "japaneseSearch.js" });

const { JapaneseSearch } = windowObject;

test("katakanaToHiragana / hiraganaToKatakana convert the whole kana block", () => {
  assert.equal(JapaneseSearch.katakanaToHiragana("シーディー"), "しーでぃー");
  assert.equal(JapaneseSearch.hiraganaToKatakana("たべる"), "タベル");
  // Non-kana characters (kanji, ASCII, punctuation) pass through untouched.
  assert.equal(JapaneseSearch.katakanaToHiragana("食べる"), "食べる");
});

test("romajiToHiragana converts plain mora sequences", () => {
  assert.equal(JapaneseSearch.romajiToHiragana("taberu"), "たべる");
  assert.equal(JapaneseSearch.romajiToHiragana("miru"), "みる");
  assert.equal(JapaneseSearch.romajiToHiragana("sushi"), "すし");
  assert.equal(JapaneseSearch.romajiToHiragana("arigatou"), "ありがとう");
});

test("romajiToHiragana handles sokuon (doubled consonants)", () => {
  assert.equal(JapaneseSearch.romajiToHiragana("kitte"), "きって");
  assert.equal(JapaneseSearch.romajiToHiragana("zasshi"), "ざっし");
});

test("romajiToHiragana handles the disambiguating apostrophe", () => {
  assert.equal(JapaneseSearch.romajiToHiragana("kon'ya"), "こんや");
});

test("romajiToHiragana rejects input that doesn't parse as clean romaji", () => {
  // "eat" leaves an unmapped trailing "t" with no following vowel.
  assert.equal(JapaneseSearch.romajiToHiragana("eat"), null);
  assert.equal(JapaneseSearch.romajiToHiragana(""), null);
});

test("romajiToHiraganaCandidates generates every valid segmentation of an ambiguous 'n'", () => {
  const candidates = JapaneseSearch.romajiToHiraganaCandidates("enen");
  assert.deepEqual(new Set(candidates), new Set(["えねん", "えんえん"]));
});

test("buildQueryVariants includes the irregular は/を/へ particle readings", () => {
  assert.ok(JapaneseSearch.buildQueryVariants("wa").includes("は"));
  assert.ok(JapaneseSearch.buildQueryVariants("o").includes("を"));
  assert.ok(JapaneseSearch.buildQueryVariants("e").includes("へ"));
});

test("buildQueryVariants includes phrase-final は spoken as \"wa\"", () => {
  assert.ok(JapaneseSearch.buildQueryVariants("konnichiwa").includes("こんにちは"));
});

test("matchesJapaneseQuery finds a kanji entry by its hiragana reading", () => {
  const entry = { word: "食べる", pronunciation: "たべる" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "たべる"), true);
});

test("matchesJapaneseQuery finds a kanji entry by romaji", () => {
  const entry = { word: "食べる", pronunciation: "たべる" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "taberu"), true);
});

test("matchesJapaneseQuery finds an entry by katakana even when the reading is stored in hiragana", () => {
  const entry = { word: "食べる", pronunciation: "たべる" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "タベル"), true);
});

test("matchesJapaneseQuery finds a katakana loanword reading by hiragana or romaji", () => {
  const entry = { word: "CD", pronunciation: "シーディー" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "しーでぃー"), true);
});

test("matchesJapaneseQuery matches on kanji itself, unaffected by kana conversion", () => {
  const entry = { word: "食べる", pronunciation: "たべる" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "食べる"), true);
});

test("matchesJapaneseQuery returns false for unrelated queries", () => {
  const entry = { word: "食べる", pronunciation: "たべる" };
  assert.equal(JapaneseSearch.matchesJapaneseQuery(entry, "miru"), false);
});
