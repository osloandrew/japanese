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
  /pickReadyQueueEntry\(\s*incorrectWordQueue\.filter\(/,
);
assert.match(
  startGameSource,
  /currentWord = firstWordInQueue\.wordObj\.word;[\s\S]*?recordPresentedGameWord\(firstWordInQueue\.wordObj\)/,
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
const previous = { word: "猫" };
const different = { word: "犬" };
const context = vm.createContext({
  isPreviousGameWord: (entry) => entry?.word === previous.word,
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

// The relearning ready-queue draw must not always hand back the same
// (e.g. first-queued) ready entry the instant its own timer allows it — see
// pickReadyQueueEntry's comment for why incorrectWordQueue.find() used to do
// exactly that.
const readyQueueStart = source.indexOf("const RELEARNING_RECENT_TURN_GAP");
const readyQueueEnd = source.indexOf(
  "// Bounded rounds use their selected size as the cap",
  readyQueueStart,
);
const readyQueueSource = source.slice(readyQueueStart, readyQueueEnd);
const readyQueueContext = vm.createContext({
  isPreviousGameWord: (entry) => entry?.word === previous.word,
  wordGameSessionWordLastShownTurn: new Map(),
  wordGameSessionTurnCounter: 0,
});
vm.runInContext(readyQueueSource, readyQueueContext, {
  filename: "wordGame.js",
});

const stale = { word: "鳥" }; // never shown this session
readyQueueContext.wordGameSessionTurnCounter = 10;
readyQueueContext.wordGameSessionWordLastShownTurn.set(different, 9); // shown last turn
assert.equal(
  readyQueueContext.pickReadyQueueEntry([
    { wordObj: different },
    { wordObj: stale },
  ]).wordObj,
  stale,
  "a ready entry shown just now must lose to a ready entry that's waited longer",
);

readyQueueContext.wordGameSessionWordLastShownTurn.set(previous, 10);
assert.equal(
  readyQueueContext.pickReadyQueueEntry([{ wordObj: previous }]),
  null,
  "the literal previous word is never re-shown even as the only ready candidate",
);
assert.equal(
  readyQueueContext.pickReadyQueueEntry([{ wordObj: different }]).wordObj,
  different,
  "a lone non-previous candidate still resolves even though it was recently shown",
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
