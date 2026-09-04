import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");

const startGameStart = source.indexOf("async function startWordGame");
const startGameEnd = source.indexOf(
  "async function renderWordIntroductionUI",
  startGameStart,
);
const startGameSource = source.slice(startGameStart, startGameEnd);

assert.match(
  startGameSource,
  /incorrectWordQueue\.find\([\s\S]*?!isPreviousGameWord\(queued\.wordObj\)/,
);
assert.match(
  startGameSource,
  /currentWord = firstWordInQueue\.wordObj\.ord;[\s\S]*?recordPresentedGameWord\(firstWordInQueue\.wordObj\)/,
);
assert.match(
  startGameSource,
  /getNextInitialRetrievalEntry\(\)/,
);

const initialStart = source.indexOf("function getNextInitialRetrievalEntry");
const initialEnd = source.indexOf(
  "function getClozeSynonymForms",
  initialStart,
);
const initialSource = source.slice(initialStart, initialEnd);
assert.match(
  initialSource,
  /isExcluded: \(entry\) => isPreviousGameWord\(entry\?\.wordObj\)/,
);

const fillerStart = source.indexOf("function excludePreviousFillerWord");
const fillerEnd = source.indexOf("function getFillerReviewCandidates", fillerStart);
const fillerSource = source.slice(fillerStart, fillerEnd);
// Real dictionary headwords: 猫 (cat) and 犬 (dog) stand in for a filler
// pool that must not immediately repeat the previous game word.
const previous = { ord: "猫" };
const different = { ord: "犬" };
const context = vm.createContext({
  isPreviousGameWord: (entry) => entry?.ord === previous.ord,
});
vm.runInContext(fillerSource, context, { filename: "wordGame.js" });

assert.deepEqual(
  Array.from(context.excludePreviousFillerWord([previous])),
  [],
  "a singleton filler pool must not permit an immediate repeat",
);
assert.deepEqual(
  Array.from(context.excludePreviousFillerWord([previous, different])),
  [different],
);

const fetchStart = source.indexOf("async function fetchRandomWord");
const fetchEnd = source.indexOf("function shuffleArray", fetchStart);
const fetchSource = source.slice(fetchStart, fetchEnd);
const budgetGate = fetchSource.indexOf(
  "wordGameSessionIntroducedWords.size >= wordGameSessionTarget",
);
const widerDictionarySelection = fetchSource.indexOf(
  "getEligibleGameWords(selectedPOS)",
);
assert.ok(budgetGate >= 0 && budgetGate < widerDictionarySelection);
assert.match(
  fetchSource.slice(budgetGate, widerDictionarySelection),
  /pickWordGameSessionFillerWord\(\)/,
  "a full round must choose its spacer from the introduced-word filler pool",
);

console.log("word-game consecutive-repeat tests passed");
