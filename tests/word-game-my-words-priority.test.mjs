import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");

const savedDue = { ord: "saved due" };
const savedNew = { ord: "saved new" };
const ordinaryDue = { ord: "ordinary due" };
const context = vm.createContext({ Math, Number, Set });
context.window = context;
loadWordGamePolicy(root, context);
context.localStorage = {
  getItem: () => "0.5",
  setItem: () => {},
};
context.MyWordsAPI = {
  getSavedEntries: () => [{ entry: savedDue }, { entry: savedNew }],
};
context.getGameWordWeight = () => 1;
context.pickWeightedGameWord = (entries) => entries[0] ?? null;
context.pickPrioritizedGameWord = (entries) => entries[0] ?? null;
context.buildGameWordQueues = (entries) => ({ new: entries });
context.getNextGameQueueName = () => "new";
context.getPortfolioGameQueueName = () => "new";
context.getReviewPortfolioShareForQueues = () => 0;
context.getNearestScheduledGameWords = (entries) => entries;
vm.runInContext(
  `
    let wordGameMyWordsMixQuestionCount = 0;
    let wordGameMyWordsMixSavedQuestionCount = 0;
  `,
  context,
);

const mixStart = source.indexOf("const MY_WORDS_SHARE_STORAGE_KEY");
const mixEnd = source.indexOf("function buildGameWordQueues", mixStart);
assert.notEqual(mixStart, -1);
assert.notEqual(mixEnd, -1);
vm.runInContext(source.slice(mixStart, mixEnd), context, {
  filename: "wordGame.js",
});

// The selected Mix can pick only an eligible saved word from its supplied
// exercise-compatible pool.
assert.equal(
  context.pickMyWordsQuotaWord([savedDue, ordinaryDue]),
  savedDue,
);
assert.equal(context.pickMyWordsQuotaWord([ordinaryDue]), null);

function mixPattern(share, count) {
  vm.runInContext(
    `
      wordGameMyWordsShare = ${share};
      wordGameMyWordsMixQuestionCount = 0;
      wordGameMyWordsMixSavedQuestionCount = 0;
    `,
    context,
  );
  const pattern = [];
  for (let index = 0; index < count; index++) {
    const prioritize = context.shouldPrioritizeMyWordsQuestion();
    pattern.push(prioritize);
    context.recordMyWordsMixQuestion(prioritize);
  }
  return pattern;
}

assert.deepEqual(mixPattern(0.25, 8), [
  false,
  false,
  false,
  true,
  false,
  false,
  false,
  true,
]);
assert.equal(mixPattern(0.25, 10).filter(Boolean).length, 2);
assert.equal(mixPattern(0.25, 20).filter(Boolean).length, 5);
assert.equal(mixPattern(0.5, 8).filter(Boolean).length, 4);
assert.equal(mixPattern(0.75, 8).filter(Boolean).length, 6);
assert.equal(mixPattern(0, 8).filter(Boolean).length, 0);

// A missing saved candidate can be caught up later in the same round instead
// of silently lowering the selected share.
vm.runInContext(
  `
    wordGameMyWordsShare = 0.5;
    wordGameMyWordsMixQuestionCount = 0;
    wordGameMyWordsMixSavedQuestionCount = 0;
  `,
  context,
);
context.recordMyWordsMixQuestion(false);
context.recordMyWordsMixQuestion(false);
assert.equal(context.shouldPrioritizeMyWordsQuestion(), true);
context.recordMyWordsMixQuestion(true);
assert.equal(context.shouldPrioritizeMyWordsQuestion(), true);

const fetchStart = source.indexOf("async function fetchRandomWord");
const fetchEnd = source.indexOf("function shuffleArray", fetchStart);
const fetchSource = source.slice(fetchStart, fetchEnd);
const mixChoice = fetchSource.indexOf(
  "pickMyWordsQuotaWord(",
);
const queueChoice = fetchSource.indexOf(
  "const queueName = getPortfolioGameQueueName",
  mixChoice,
);

assert.ok(mixChoice >= 0);
assert.ok(queueChoice > mixChoice);
assert.match(fetchSource, /allowIntroduced: true/);
assert.match(fetchSource, /recordMyWordsMixQuestion\(isMyWordsEntry\(selectedEntry\)\)/);
assert.match(source, /const MY_WORDS_SHARE_LEVELS = \[0, 0\.25, 0\.5, 0\.75\]/);
const beginRoundSource = source.slice(
  source.indexOf("function beginWordGameRound"),
  source.indexOf("function resetTodayPracticeRoundAfterMidnight"),
);
assert.match(
  beginRoundSource,
  /wordGameMyWordsMixQuestionCount = 0;\s*wordGameMyWordsMixSavedQuestionCount = 0;/,
);
assert.match(
  source,
  /wordGameMyWordsShare = share;\s*wordGameMyWordsMixQuestionCount = 0;\s*wordGameMyWordsMixSavedQuestionCount = 0;/,
);

console.log("word-game My Words priority tests passed");
