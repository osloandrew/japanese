import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordList.js"), "utf8");

// wordList.js runs inside its own vm context (see createSandbox), which has
// its own realm-local Array/Object constructors — assert/strict's
// deepEqual considers a vm-native array/object "not reference-equal" to a
// host-native literal of the same shape. Round-tripping through JSON
// rebuilds the value with the host realm's constructors before comparing.
function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Reproduces the real regression this guards against: a word saved to My
// Words before japaneseWords.csv's `definition` column was last regenerated
// by scripts/build-definitions.py (see git commit "Regenerate stale
// definitions in japaneseWords.csv") used to vanish from the My Words list
// — its id was a hash that included `definisjon`, so any definition edit
// silently orphaned it. getMyWordsEntryId now keys on the CSV's stable `id`
// column instead, and migrateMyWordsEntryIds() moves any pre-existing
// legacy-hash-keyed save over to that new key on load.
function createSandbox({ results = [], localStorageData = {} } = {}) {
  const localStorageStore = { ...localStorageData };
  const dispatchedEvents = [];

  const context = {
    console,
    results,
    getCurrentMode: () => "word-game", // keeps renderWordList() untouched
    renderWordList: () => {
      throw new Error("renderWordList should not run in this test");
    },
    WordClass: {
      formatWordClassLabel: (gender) => gender,
      matchesWordClass: () => true,
      stripNounPrefix: (gender) => gender,
    },
  };
  context.window = context;
  context.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
    }),
  };
  context.localStorage = {
    getItem: (key) =>
      Object.prototype.hasOwnProperty.call(localStorageStore, key)
        ? localStorageStore[key]
        : null,
    setItem: (key, value) => {
      localStorageStore[key] = value;
    },
  };
  context.window.dispatchEvent = (event) => dispatchedEvents.push(event);
  context.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  context.SpacedRepetition = {
    STORAGE_VERSION: 1,
    normalizeCollection: (records) => records,
    mergeCollections: (local) => local,
    mergeRecordValues: (localValue, remoteValue) => {
      const localTs = localValue?.lastReviewedAt ?? 0;
      const remoteTs = remoteValue?.lastReviewedAt ?? 0;
      return remoteTs > localTs ? remoteValue : localValue;
    },
    cloneCollection: (records) => ({ ...records }),
    cloneMemory: (record) => (record ? { ...record } : null),
    getSnapshot: () => ({ strength: null }),
    getSkillSnapshot: () => ({ strength: null }),
  };
  context.window.SpacedRepetition = context.SpacedRepetition;
  context.window.WordClass = context.WordClass;
  context.window.localStorage = context.localStorage;

  vm.createContext(context);
  vm.runInContext(source, context, { filename: "wordList.js" });

  return { context, localStorageStore, dispatchedEvents };
}

test("getMyWordsEntryId uses the CSV's stable id, not a content hash", () => {
  const { context } = createSandbox();
  const entry = {
    id: "abc123",
    ord: "犬",
    engelsk: "dog",
    gender: "noun",
    definisjon: "a domesticated animal",
  };

  assert.equal(context.window.MyWordsAPI.getEntryIds().length, 0);
  // Not directly exposed, but toggling and re-checking isSaved proves the
  // id used for storage is stable regardless of definisjon.
  context.window.MyWordsAPI.toggle(entry);
  assert.equal(context.window.MyWordsAPI.isSaved(entry), true);

  const changedDefinitionEntry = { ...entry, definisjon: "totally rewritten" };
  assert.equal(
    context.window.MyWordsAPI.isSaved(changedDefinitionEntry),
    true,
    "changing the definition must not change which id the word is saved under",
  );
});

test("migrateMyWordsEntryIds moves a legacy-keyed saved word onto its stable id", () => {
  // The word's definisjon here matches what getLegacyMyWordsEntryId would
  // compute from the *current* entry — i.e. this word was saved under the
  // legacy scheme but hasn't had its definition edited since, so the old id
  // is still reconstructible. This is the case migrateMyWordsEntryIds can
  // actually recover: a word saved before this fix shipped, protected here
  // proactively, before some future definition edit would otherwise orphan
  // it exactly like the original bug did.
  const entry = {
    id: "stable-1",
    ord: "猫",
    engelsk: "cat",
    gender: "noun",
    definisjon: "a small domesticated feline",
  };
  const legacyId = ["猫", "cat", "noun", "a small domesticated feline"].join(
    String.fromCharCode(31),
  );

  const { context, localStorageStore, dispatchedEvents } = createSandbox({
    results: [entry],
    localStorageData: {
      "japanese-dictionary-my-words-v1": JSON.stringify({
        version: 2,
        entryIds: [legacyId],
        entryTimestamps: { [legacyId]: 1000 },
      }),
    },
  });

  // Before migration: the word is invisible under the new key scheme even
  // though it is (per the stored legacy id) definitely saved.
  assert.equal(context.window.MyWordsAPI.isSaved(entry), false);

  context.window.MyWordsAPI.migrateEntryIds();

  assert.equal(
    context.window.MyWordsAPI.isSaved(entry),
    true,
    "the word must be recognized as saved again after migration",
  );
  assert.deepEqual(toPlain(context.window.MyWordsAPI.getEntryIds()), ["stable-1"]);
  assert.equal(
    context.window.MyWordsAPI.getEntryTimestamps()["stable-1"],
    1000,
    "the word's original saved-at timestamp should carry over",
  );

  const persisted = JSON.parse(
    localStorageStore["japanese-dictionary-my-words-v1"],
  );
  assert.deepEqual(persisted.entryIds, ["stable-1"]);
  assert.equal(
    persisted.entryTimestamps[legacyId] !== undefined,
    true,
    "the legacy id must be tombstoned (kept, but marked removed) so a " +
      "signed-in account's remote copy converges instead of resurrecting it",
  );

  const pushed = dispatchedEvents.find((e) => e.type === "my-words:updated");
  assert.ok(pushed, "migration must sync the remap to Firestore, not just localStorage");
  assert.equal(pushed.detail.syncRemote, true);
  assert.ok(pushed.detail.changedEntryIds.includes(legacyId));
  assert.ok(pushed.detail.changedEntryIds.includes("stable-1"));
});

test("migrateMyWordsEntryIds drops a legacy id for a word no longer in the dictionary", () => {
  const legacyId = ["消えた単語", "vanished word", "noun", "old definition"].join(
    String.fromCharCode(31),
  );

  const { context } = createSandbox({
    results: [{ id: "unrelated", ord: "他", engelsk: "other", gender: "noun" }],
    localStorageData: {
      "japanese-dictionary-my-words-v1": JSON.stringify({
        version: 2,
        entryIds: [legacyId],
        entryTimestamps: { [legacyId]: 500 },
      }),
    },
  });

  assert.equal(context.window.MyWordsAPI.getEntryIds().length, 1);

  context.window.MyWordsAPI.migrateEntryIds();

  assert.deepEqual(
    toPlain(context.window.MyWordsAPI.getEntryIds()),
    [],
    "a word no longer in the dictionary has nothing to migrate to and is dropped",
  );
});

// This is the known, accepted limitation: a word already orphaned by a
// past edit (its definition changed since it was saved, exactly like the
// September 2026 "Regenerate stale definitions" incident) can't be
// resurrected, because the legacy id was computed from a definition value
// that no longer exists anywhere to recompute from. It's dropped, same as
// a word removed from the dictionary outright — consistent with treating
// already-orphaned saves as acceptable to lose, in exchange for saved
// words never silently orphaning again going forward.
test("migrateMyWordsEntryIds drops an already-orphaned legacy id (its content changed since saving)", () => {
  const entry = {
    id: "stable-3",
    ord: "犬",
    engelsk: "dog",
    gender: "noun",
    definisjon: "a regenerated, current definition",
  };
  const legacyId = ["犬", "dog", "noun", "the original definition, since replaced"].join(
    String.fromCharCode(31),
  );

  const { context } = createSandbox({
    results: [entry],
    localStorageData: {
      "japanese-dictionary-my-words-v1": JSON.stringify({
        version: 2,
        entryIds: [legacyId],
        entryTimestamps: { [legacyId]: 500 },
      }),
    },
  });

  context.window.MyWordsAPI.migrateEntryIds();

  assert.equal(context.window.MyWordsAPI.isSaved(entry), false);
  assert.deepEqual(toPlain(context.window.MyWordsAPI.getEntryIds()), []);
});

test("migrateMyWordsEntryIds moves word-strength records onto the stable id too", () => {
  const entry = {
    id: "stable-2",
    ord: "話す",
    engelsk: "to speak",
    gender: "verb",
    definisjon: "to communicate through speech",
  };
  const legacyId = [
    "話す",
    "to speak",
    "verb",
    "to communicate through speech",
  ].join(String.fromCharCode(31));

  const { context } = createSandbox({
    results: [entry],
    localStorageData: {
      "japanese-dictionary-word-strength-v1": JSON.stringify({
        version: 1,
        records: { [legacyId]: { lastReviewedAt: 42 } },
      }),
    },
  });

  context.window.MyWordsAPI.migrateEntryIds();

  const all = context.window.WordStrengthAPI.getAll();
  assert.equal(all[legacyId], undefined);
  assert.deepEqual(toPlain(all["stable-2"]), { lastReviewedAt: 42 });
});
