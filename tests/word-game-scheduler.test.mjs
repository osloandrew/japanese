import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const start = source.indexOf("function getGameEntryQueue");
const end = source.indexOf("// Once a session round", start);

assert.notEqual(start, -1);
assert.notEqual(end, -1);

const queueByEntry = new Map();
const approachingEntries = new Set();
const context = vm.createContext({
  Date,
  Map,
  Math,
  Number,
  window: {
    WordStrengthAPI: {
      getSnapshot: (entry) => ({
        queue: queueByEntry.get(entry),
        isApproaching: approachingEntries.has(entry),
      }),
      getRecord: () => null,
    },
  },
});
loadWordGamePolicy(root, context);
context.wordGameReviewPortfolioQuestionCount = 0;
context.wordGameReviewPortfolioReviewCount = 0;

vm.runInContext(source.slice(start, end), context, {
  filename: "wordGame.js",
});

const relearning = { word: "relearning" };
const due = { word: "due" };
const fresh = { word: "new" };
const scheduled = { word: "scheduled" };
const approaching = { word: "approaching" };

queueByEntry.set(relearning, "relearning");
queueByEntry.set(due, "due");
queueByEntry.set(fresh, "new");
queueByEntry.set(scheduled, "scheduled");
queueByEntry.set(approaching, "scheduled");
approachingEntries.add(approaching);

const queues = context.buildGameWordQueues([
  scheduled,
  fresh,
  due,
  relearning,
  approaching,
]);

assert.deepEqual([...queues.relearning], [relearning]);
assert.deepEqual([...queues.due], [due]);
assert.deepEqual([...queues.approaching], [approaching]);
assert.deepEqual([...queues.new], [fresh]);
assert.deepEqual([...queues.scheduled], [scheduled]);

assert.equal(
  context.getReviewPortfolioShareForQueues({
    relearning: [],
    due: Array.from({ length: 10 }, () => due),
    approaching: [],
  }),
  0.65,
);
const portfolioQueues = {
  relearning: [relearning],
  due: [due],
  approaching: [approaching],
  new: [fresh],
  scheduled: [scheduled],
};
assert.equal(context.getPortfolioGameQueueName(portfolioQueues, 0.5), "new");
context.recordReviewPortfolioQuestion("new");
assert.equal(
  context.getPortfolioGameQueueName(portfolioQueues, 0.5),
  "relearning",
);
context.recordReviewPortfolioQuestion("relearning");
assert.equal(context.getPortfolioGameQueueName(portfolioQueues, 0.5), "new");
assert.equal(context.wordGameReviewPortfolioQuestionCount, 2);
assert.equal(context.wordGameReviewPortfolioReviewCount, 1);

assert.equal(context.getNextGameQueueName(queues), "relearning");
queues.relearning = [];
assert.equal(context.getNextGameQueueName(queues), "due");
queues.due = [];
assert.equal(context.getNextGameQueueName(queues), "approaching");
queues.approaching = [];
assert.equal(context.getNextGameQueueName(queues), "new");
queues.new = [];
assert.equal(context.getNextGameQueueName(queues), "scheduled");
queues.scheduled = [];
assert.equal(context.getNextGameQueueName(queues), undefined);

console.log("word-game scheduler tests passed");
