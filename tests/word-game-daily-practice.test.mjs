import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const storage = new Map();
const context = vm.createContext({
  Date,
  JSON,
  Math,
  Object,
  Set,
  String,
  CustomEvent,
});
context.window = context;
loadWordGamePolicy(root, context);
context.window.dispatchEvent = () => {};
context.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

const runSection = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  vm.runInContext(source.slice(start, end), context, {
    filename: "wordGame.js",
  });
};

runSection("function normalizeGameWhitespace", "function uppercaseFirstJapanese");
runSection("const DAILY_PRACTICE_STORAGE_KEY", "let incorrectWordQueue");

// Real dictionary headwords: こんにちは has playable audio; the ellipsis and
// placeholder checks below are language-agnostic guards against unrecorded
// audio markers, not Japanese-specific content.
assert.equal(
  context.hasPlayableWordAudio({ ord: "こんにちは", wordAudio: "X" }),
  true,
);
assert.equal(
  context.hasPlayableWordAudio({ ord: "あの... あの", wordAudio: "X" }),
  false,
);
assert.equal(
  context.hasPlayableWordAudio({ ord: "あの … あの", wordAudio: "X" }),
  false,
);
assert.equal(
  context.hasPlayableWordAudio({ ord: "hrmf", wordAudio: "X" }),
  false,
);
assert.equal(
  context.hasPlayableWordAudio({ ord: " HRMF ", wordAudio: "X" }),
  false,
);
assert.equal(
  context.hasPlayableWordAudio({ ord: "こんにちは", wordAudio: "" }),
  false,
);

const today = context.getDailyPracticeDateKey();
const resetState = context.normalizeDailyPracticeState(
  { date: "1999-01-01", completedRounds: 2 },
  today,
);
assert.equal(resetState.date, today);
assert.equal(resetState.completedRounds, 0);
assert.deepEqual(
  [...context.getDailyQuestStates()].map((quest) => quest.unlocked),
  [true, false, false],
);

assert.equal(context.completeDailyQuestRound().reward, "emerald");
assert.equal(context.getDailyPracticeProgress(), 1);
assert.deepEqual(
  [...context.getDailyQuestStates()].map((quest) => quest.unlocked),
  [true, true, false],
);

assert.equal(context.completeDailyQuestRound().reward, "ruby");
assert.equal(context.completeDailyQuestRound().reward, "sapphire");
assert.equal(context.completeDailyQuestRound(), null);
assert.equal(context.getDailyPracticeProgress(), 3);
assert.deepEqual(
  [...context.getDailyQuestStates()].map((quest) => quest.complete),
  [true, true, true],
);

assert.equal(context.getDailyQuestQuestionMode(0, 0, true), "forward");
assert.equal(context.getDailyQuestQuestionMode(1, 0, true), "cloze");
assert.equal(context.getDailyQuestQuestionMode(2, 0, true), "reverse");
assert.equal(context.getDailyQuestQuestionMode(2, 1, true), "listening");
assert.equal(context.getDailyQuestQuestionMode(2, 1, false), "reverse");

assert.deepEqual(
  Array.from({ length: 10 }, (_, index) =>
    context.getBonusRoundQuestionMode(index, true),
  ),
  [
    "cloze",
    "listening",
    "typed-reverse",
    "cloze",
    "typed-reverse",
    "listening",
    "cloze",
    "typed-reverse",
    "listening",
    "typed-reverse",
  ],
);
assert.equal(context.getBonusRoundQuestionMode(1, false), "typed-reverse");
assert.equal(context.getBonusRoundQuestionMode(11, true), "listening");

console.log("word-game daily practice tests passed");
