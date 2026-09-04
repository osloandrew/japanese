import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const snapshots = new Map();
const strengths = new Map();
const context = vm.createContext({ Math, Number, Object });
context.window = context;
loadWordGamePolicy(root, context);
context.WordStrengthAPI = {
  get: (entry) => strengths.get(entry) ?? 0,
  getSnapshot: (entry) => snapshots.get(entry) ?? null,
};
context.getAbilityProximityWeight = () => 1;
context.getVocabularyUsefulnessWeight = () => 1;

const start = source.indexOf("const STRENGTH_WEIGHT_CEILING");
const end = source.indexOf("/*\n * Favors low-strength", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
vm.runInContext(source.slice(start, end), context, {
  filename: "wordGame.js",
});

const fragile = { ord: "fragile" };
const stable = { ord: "stable" };
snapshots.set(fragile, { recallNeed: 0.8 });
snapshots.set(stable, { recallNeed: 0.1 });
// Deliberately give the fragile word a stronger coarse meter. Continuous
// need—not the old integer—must decide review urgency.
strengths.set(fragile, 5);
strengths.set(stable, 0);

const fragileReviewWeight = context.getGameWordWeight(fragile, {
  useAbilityWeight: false,
  useRecallNeedWeight: true,
});
const stableReviewWeight = context.getGameWordWeight(stable, {
  useAbilityWeight: false,
  useRecallNeedWeight: true,
});
assert.ok(fragileReviewWeight > stableReviewWeight);
assert.ok(
  Math.abs(fragileReviewWeight - Math.pow(0.8, 1.5)) < 1e-12,
);

// Outside review queues, the existing strength weighting remains available
// for filler and other non-SRS pools.
assert.ok(
  context.getGameWordWeight(stable, { useAbilityWeight: false }) >
    context.getGameWordWeight(fragile, { useAbilityWeight: false }),
);

assert.deepEqual([...context.WordGamePolicy.DEFAULT_QUEUE_PRIORITY], [
  "relearning",
  "due",
  "approaching",
  "new",
  "scheduled",
]);
assert.match(
  source,
  /useRecallNeedWeight: \[\s*"relearning",\s*"due",\s*"approaching",\s*\]\.includes\(queueName\)/,
);
assert.match(
  source,
  /currentWordQueueType = getGameEntryQueue\(myWordsQuotaEntry\)/,
);

console.log("word-game continuous review tests passed");
