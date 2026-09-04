(function () {
  "use strict";

  // Was 64, then 16 — see git history for the read/write-quota reasoning
  // behind both drops. Measured empirically (see the per-skill record shape
  // in spacedRepetition.js, ~1050 bytes/word when every one of the 4 skill
  // types has been drilled): at 8 shards a single shard doesn't approach
  // Firestore's 900KB-per-shard rule cap (firestore.rules) until roughly
  // 5,500 words have all been fully drilled on every skill — well beyond
  // anything realistic even for the heaviest user, while roughly halving
  // the read/write fan-out from 16 for everyone's actual usage. Going lower
  // than this (e.g. 4) starts costing real safety margin: that crosses the
  // cap around ~2,800 fully-drilled words, which a genuinely dedicated
  // multi-year user could plausibly reach. SCHEMA_VERSION bumps in lockstep
  // so mergeRemoteData's existing migration path re-shards each account
  // onto the new layout the next time they sign in.
  const SHARD_COUNT = 8;
  const SCHEMA_VERSION = 4;

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  // FNV-1a is small, stable across browsers, and distributes the dictionary's
  // human-readable entry IDs evenly enough that no single Firestore document
  // grows disproportionately. The number of possible documents never exceeds
  // SHARD_COUNT, regardless of how many words a learner studies.
  function hashEntryId(entryId) {
    const value = String(entryId ?? "");
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    // Avalanche the upper bits back into the low six used by modulo 64.
    // Plain FNV's lowest bit tracks input parity too closely for sequential
    // dictionary IDs, which would leave half the shards unused.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }

  function getShardId(entryId) {
    return String(hashEntryId(entryId) % SHARD_COUNT).padStart(2, "0");
  }

  function emptyPayload() {
    return { version: SCHEMA_VERSION, entries: {}, strengths: {} };
  }

  function normalizeEntry(value) {
    if (!isObject(value) || !Number.isFinite(value.updatedAt)) return null;
    return {
      present: Boolean(value.present),
      updatedAt: Math.max(0, value.updatedAt),
    };
  }

  function parsePayload(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!isObject(parsed)) return emptyPayload();

      const payload = emptyPayload();
      if (isObject(parsed.entries)) {
        for (const [entryId, entry] of Object.entries(parsed.entries)) {
          const normalized = normalizeEntry(entry);
          if (normalized) payload.entries[entryId] = normalized;
        }
      }
      if (isObject(parsed.strengths)) {
        for (const [entryId, record] of Object.entries(parsed.strengths)) {
          if (isObject(record) || Number.isFinite(record)) {
            payload.strengths[entryId] = record;
          }
        }
      }
      return payload;
    } catch (error) {
      return emptyPayload();
    }
  }

  function serializePayload(payload) {
    return JSON.stringify(parsePayload(payload));
  }

  function getStrengthTimestamp(record) {
    if (isObject(record) && Number.isFinite(record.updatedAt)) {
      return Math.max(0, record.updatedAt);
    }
    // Legacy scalar strengths have no chronological timestamp. They are
    // intentionally older than every structured review record.
    return 0;
  }

  function chooseStrength(localValue, remoteValue, mergeStrengthRecord) {
    if (localValue === undefined) return remoteValue;
    if (remoteValue === undefined) return localValue;
    if (typeof mergeStrengthRecord === "function") {
      return mergeStrengthRecord(localValue, remoteValue);
    }
    return getStrengthTimestamp(remoteValue) > getStrengthTimestamp(localValue)
      ? remoteValue
      : localValue;
  }

  function mergePayload(baseValue, incomingValue, mergeStrengthRecord) {
    const base = parsePayload(baseValue);
    const incoming = parsePayload(incomingValue);
    const merged = emptyPayload();

    for (const entryId of new Set([
      ...Object.keys(base.entries),
      ...Object.keys(incoming.entries),
    ])) {
      const local = base.entries[entryId];
      const remote = incoming.entries[entryId];
      merged.entries[entryId] =
        !local || (remote && remote.updatedAt > local.updatedAt) ? remote : local;
    }

    for (const entryId of new Set([
      ...Object.keys(base.strengths),
      ...Object.keys(incoming.strengths),
    ])) {
      merged.strengths[entryId] = chooseStrength(
        base.strengths[entryId],
        incoming.strengths[entryId],
        mergeStrengthRecord,
      );
    }

    return merged;
  }

  function buildShardPatches({
    entryIds = [],
    entryTimestamps = {},
    strengths = {},
    changedEntryIds = null,
    changedStrengthIds = null,
  } = {}) {
    const presentIds = new Set(Array.isArray(entryIds) ? entryIds : []);
    const entryKeys = Array.isArray(changedEntryIds)
      ? changedEntryIds
      : [...new Set([...presentIds, ...Object.keys(entryTimestamps || {})])];
    const strengthKeys = Array.isArray(changedStrengthIds)
      ? changedStrengthIds
      : Object.keys(strengths || {});
    const patches = {};

    function patchFor(entryId) {
      const shardId = getShardId(entryId);
      if (!patches[shardId]) patches[shardId] = emptyPayload();
      return patches[shardId];
    }

    for (const entryId of entryKeys) {
      const updatedAt = entryTimestamps?.[entryId];
      if (!Number.isFinite(updatedAt)) continue;
      patchFor(entryId).entries[entryId] = {
        present: presentIds.has(entryId),
        updatedAt: Math.max(0, updatedAt),
      };
    }

    for (const entryId of strengthKeys) {
      const record = strengths?.[entryId];
      if (record === undefined) continue;
      patchFor(entryId).strengths[entryId] = record;
    }

    return patches;
  }

  function combineShardDocuments(documents, mergeStrengthRecord) {
    let combined = emptyPayload();
    for (const document of documents || []) {
      combined = mergePayload(combined, document, mergeStrengthRecord);
    }

    const entryIds = [];
    const entryTimestamps = {};
    for (const [entryId, entry] of Object.entries(combined.entries)) {
      entryTimestamps[entryId] = entry.updatedAt;
      if (entry.present) entryIds.push(entryId);
    }

    return {
      entryIds,
      entryTimestamps,
      strengths: { ...combined.strengths },
      payload: combined,
    };
  }

  window.ProgressSharding = Object.freeze({
    SHARD_COUNT,
    SCHEMA_VERSION,
    getShardId,
    emptyPayload,
    parsePayload,
    serializePayload,
    mergePayload,
    buildShardPatches,
    combineShardDocuments,
    getStrengthTimestamp,
  });
})();
