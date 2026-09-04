import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ JSON, Math, Number, Object, Set, String });
context.window = context;

vm.runInContext(
  fs.readFileSync(path.join(root, "progressSharding.js"), "utf8"),
  context,
  { filename: "progressSharding.js" },
);

const sharding = context.ProgressSharding;
assert.equal(sharding.SHARD_COUNT, 8);

// Large collections remain permanently bounded and distribute across every
// available shard instead of creating one document per word.
const ids = Array.from({ length: 20_000 }, (_, index) => `word-${index}entry-${index}`);
const shardIds = new Set(ids.map(sharding.getShardId));
assert.equal(shardIds.size, sharding.SHARD_COUNT);
assert.equal(sharding.getShardId(ids[123]), sharding.getShardId(ids[123]));

const entryId = "猫catnoun__proto__";
const olderPresent = sharding.buildShardPatches({
  entryIds: [entryId],
  entryTimestamps: { [entryId]: 100 },
});
const newerRemoval = sharding.buildShardPatches({
  entryIds: [],
  entryTimestamps: { [entryId]: 200 },
  changedEntryIds: [entryId],
});
const shardId = sharding.getShardId(entryId);
const removed = sharding.mergePayload(olderPresent[shardId], newerRemoval[shardId]);
assert.equal(removed.entries[entryId].present, false);
assert.equal(removed.entries[entryId].updatedAt, 200);

// Chronological strength merging preserves a newer lapse over stale mastery.
const mastered = { state: "review", stabilityDays: 30, updatedAt: 300 };
const lapsed = { state: "relearning", stabilityDays: 1, updatedAt: 400 };
const strengthA = sharding.buildShardPatches({ strengths: { [entryId]: mastered } });
const strengthB = sharding.buildShardPatches({ strengths: { [entryId]: lapsed } });
const mergedStrength = sharding.mergePayload(
  strengthA[shardId],
  strengthB[shardId],
);
assert.equal(mergedStrength.strengths[entryId].state, "relearning");

// A single changed word produces exactly one shard patch, and survives the
// compact JSON storage round trip without mangling Unicode/control characters.
const incremental = sharding.buildShardPatches({
  entryIds: [entryId, ids[0]],
  entryTimestamps: { [entryId]: 500, [ids[0]]: 100 },
  changedEntryIds: [entryId],
});
assert.equal(Object.keys(incremental).length, 1);
const serialized = sharding.serializePayload(incremental[shardId]);
const roundTripped = sharding.combineShardDocuments([serialized]);
assert.deepEqual([...roundTripped.entryIds], [entryId]);
assert.equal(roundTripped.entryTimestamps[entryId], 500);

// Corrupt/old payloads fail closed to an empty shard rather than breaking sync.
assert.deepEqual(
  JSON.parse(JSON.stringify(sharding.parsePayload("not-json"))),
  { version: 4, entries: {}, strengths: {} },
);

console.log("progress sharding tests passed");
