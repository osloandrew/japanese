(function () {
  "use strict";

  // A small, deterministic scheduler for durable vocabulary review. The
  // previous implementation stored a timeless integer from 0-5; these
  // records instead keep enough information to answer two separate
  // questions: how stable is this memory, and is it due for retrieval now?
  const STORAGE_VERSION = 6;
  const SKILL_IDS = Object.freeze([
    "recognition",
    "production",
    "listening",
    "context",
    "semantic",
  ]);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RELEARNING_DELAY_MS = 10 * 60 * 1000;
  const TARGET_RETENTION = 0.9;
  // Reviews begin to enter the game softly before the exact 90% review
  // point. At 91% predicted recall the need is zero; it then grows
  // continuously through the due point and toward certainty as the memory
  // decays. The small preview band removes a hard due/not-due cliff without
  // making freshly reviewed words eligible again immediately.
  const REVIEW_APPROACH_RETENTION = 0.91;
  const RECALL_NEED_RANGE = 0.3;
  const MIN_STABILITY_DAYS = 0.25;
  const MAX_STABILITY_DAYS = 3650;
  const VALID_STATES = new Set(["learning", "review", "relearning"]);
  const LEGACY_STABILITY_DAYS = [0.25, 1, 3, 7, 15, 30];

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  // How often a word has been missed relative to how often it's actually
  // been tested — a self-correcting ratio, not a raw lifetime lapse count
  // (which only ever grows). A word that struggled early but has since
  // turned around dilutes back below the threshold as successful
  // repetitions accumulate, with no separate "recovered" bookkeeping
  // needed. Below CHRONIC_MIN_REPETITIONS, one early miss out of very few
  // attempts isn't evidence of a real pattern yet.
  const CHRONIC_MIN_REPETITIONS = 5;
  const CHRONIC_LAPSE_RATE = 0.34;

  function isChronicallyStruggling(record) {
    return Boolean(
      record &&
        record.repetitions >= CHRONIC_MIN_REPETITIONS &&
        record.lapses / record.repetitions >= CHRONIC_LAPSE_RATE,
    );
  }

  // Multiplies into how far a correct answer is allowed to grow the review
  // interval. A word at or under the chronic threshold regrows normally
  // (1); climbing further past it regrows more cautiously, down to a floor
  // that still lets a genuinely turned-around word recover given enough
  // consecutive correct answers, just more slowly than an ordinary word
  // would. This is what actually targets a true chronic-miss pattern:
  // `difficulty` alone (see scheduleCorrect below) saturates at its max
  // after only ~6 lapses and stops adding any further resistance, while
  // this keeps scaling with the word's whole lapse history.
  function getChronicGrowthDampening(record) {
    if (!isChronicallyStruggling(record)) return 1;

    const lapseRate = record.lapses / record.repetitions;
    const excess = clamp(
      (lapseRate - CHRONIC_LAPSE_RATE) / (1 - CHRONIC_LAPSE_RATE),
      0,
      1,
    );

    return clamp(1 - excess * 0.5, 0.5, 1);
  }

  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  }

  function isStructuredRecord(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (VALID_STATES.has(value.state) || Number.isFinite(value.dueAt)),
    );
  }

  // Version-1 strengths have no review date. Treat every migrated word as
  // due once, preserving its approximate maturity without pretending it was
  // reviewed today. The first real answer replaces updatedAt=0 with a useful
  // timestamp, so subsequent device merges can be chronological.
  function migrateLegacyStrength(value, now = Date.now()) {
    const strength = Math.round(clamp(finiteNumber(value, 0), 0, 5));
    const stabilityDays = LEGACY_STABILITY_DAYS[strength];

    return {
      state: strength === 0 ? "relearning" : strength === 1 ? "learning" : "review",
      stabilityDays,
      difficulty: clamp(6 - strength * 0.2, 1, 10),
      lastReviewedAt: now,
      dueAt: now,
      repetitions: strength,
      successes: strength,
      successEvidence: strength,
      lapses: strength === 0 ? 1 : 0,
      fastTrackConfidence: 0,
      updatedAt: 0,
    };
  }

  function normalizeRecord(value, now = Date.now()) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return migrateLegacyStrength(value, now);
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const state = VALID_STATES.has(value.state) ? value.state : "learning";
    const stabilityDays = clamp(
      finiteNumber(value.stabilityDays, 1),
      MIN_STABILITY_DAYS,
      MAX_STABILITY_DAYS,
    );
    const lastReviewedAt = Number.isFinite(value.lastReviewedAt)
      ? Math.max(0, value.lastReviewedAt)
      : null;
    const fallbackDueAt =
      lastReviewedAt === null ? now : lastReviewedAt + stabilityDays * DAY_MS;

    const successes = Math.max(
      0,
      Math.floor(finiteNumber(value.successes, 0)),
    );
    return {
      state,
      stabilityDays,
      difficulty: clamp(finiteNumber(value.difficulty, 5), 1, 10),
      lastReviewedAt,
      dueAt: Math.max(0, finiteNumber(value.dueAt, fallbackDueAt)),
      repetitions: Math.max(0, Math.floor(finiteNumber(value.repetitions, 0))),
      successes,
      successEvidence: clamp(
        finiteNumber(value.successEvidence, successes),
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      // Lapses are evidence, not merely a counter: a morphology-aware
      // "almost" answer contributes a fractional lapse while a complete
      // miss contributes one. Old integer records remain unchanged.
      lapses: Math.max(0, finiteNumber(value.lapses, 0)),
      // Non-zero only between an ability-prior head start and its one
      // delayed confirmation. Any subsequent answer clears it, so this can
      // never become a permanent interval multiplier.
      fastTrackConfidence: clamp(
        finiteNumber(value.fastTrackConfidence, 0),
        0,
        1,
      ),
      updatedAt: Math.max(
        0,
        finiteNumber(value.updatedAt, lastReviewedAt ?? 0),
      ),
    };
  }

  function isMemoryRecord(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.skills &&
        typeof value.skills === "object" &&
        !Array.isArray(value.skills),
    );
  }

  // Version 3+ stores independent evidence for each exercise skill. Every
  // earlier scalar/record becomes recognition evidence only: carrying it
  // into production, listening, or context would manufacture mastery the
  // learner never demonstrated.
  function normalizeMemory(value, now = Date.now()) {
    const skills = {};

    if (isMemoryRecord(value)) {
      for (const skill of SKILL_IDS) {
        const record = normalizeRecord(value.skills[skill], now);
        if (record) skills[skill] = record;
      }
    } else {
      const recognition = normalizeRecord(value, now);
      if (recognition) skills.recognition = recognition;
    }

    if (Object.keys(skills).length === 0) return null;
    return {
      skills,
      updatedAt: Math.max(
        0,
        ...Object.values(skills).map((record) => record.updatedAt),
      ),
    };
  }

  function normalizeCollection(records, now = Date.now()) {
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      return {};
    }

    const normalized = {};

    for (const [entryId, value] of Object.entries(records)) {
      const record = normalizeMemory(value, now);

      if (record) {
        normalized[entryId] = record;
      }
    }

    return normalized;
  }

  function cloneRecord(record) {
    return record ? { ...record } : null;
  }

  function cloneMemory(memory) {
    if (!memory) return null;
    return {
      skills: Object.fromEntries(
        Object.entries(memory.skills || {}).map(([skill, record]) => [
          skill,
          cloneRecord(record),
        ]),
      ),
      updatedAt: memory.updatedAt,
    };
  }

  function cloneCollection(records) {
    return Object.fromEntries(
      Object.entries(records || {}).map(([entryId, record]) => [
        entryId,
        cloneMemory(record),
      ]),
    );
  }

  function getRetrievability(record, now = Date.now()) {
    const normalized = normalizeRecord(record, now);

    if (!normalized || normalized.lastReviewedAt === null) {
      return 0;
    }

    const elapsedDays = Math.max(
      0,
      (now - normalized.lastReviewedAt) / DAY_MS,
    );

    // stabilityDays is the interval at which predicted recall is 90%.
    return clamp(
      Math.pow(TARGET_RETENTION, elapsedDays / normalized.stabilityDays),
      0,
      1,
    );
  }

  function getRecallNeed(record, now = Date.now()) {
    const normalized = normalizeRecord(record, now);
    if (!normalized) return 0;

    const retrievability = getRetrievability(normalized, now);
    const continuousNeed = clamp(
      (REVIEW_APPROACH_RETENTION - retrievability) / RECALL_NEED_RANGE,
      0,
      1,
    );
    // Legacy records are intentionally due once but have no trustworthy last
    // review time. Give every due record at least the need it would have at
    // the normal 90% target rather than treating migrated history as fresh.
    const dueFloor =
      normalized.dueAt <= now
        ? (REVIEW_APPROACH_RETENTION - TARGET_RETENTION) / RECALL_NEED_RANGE
        : 0;
    return clamp(Math.max(continuousNeed, dueFloor), 0, 1);
  }

  function getRecordSnapshot(record, now = Date.now()) {
    const normalized = normalizeRecord(record, now);

    if (!normalized) {
      return {
        record: null,
        queue: "new",
        isDue: false,
        isApproaching: false,
        retrievability: 0,
        recallNeed: 0,
        strength: null,
      };
    }

    const isDue = normalized.dueAt <= now;
    const retrievability = getRetrievability(normalized, now);
    const recallNeed = getRecallNeed(normalized, now);
    const isApproaching =
      !isDue &&
      normalized.state !== "relearning" &&
      retrievability < REVIEW_APPROACH_RETENTION;
    // Stability measures durable maturity; retrievability makes the visible
    // meter fall when a word has not been recalled for a long time.
    const maturity = clamp(
      Math.log2(normalized.stabilityDays + 1) / Math.log2(31),
      0,
      1,
    );
    const strength = Math.round(5 * maturity * retrievability);
    const queue = isDue
      ? normalized.state === "relearning"
        ? "relearning"
        : "due"
      : "scheduled";

    return {
      record: cloneRecord(normalized),
      queue,
      isDue,
      isApproaching,
      retrievability,
      recallNeed,
      strength: clamp(strength, 0, 5),
    };
  }

  function getSkillSnapshot(value, skill, now = Date.now()) {
    if (!SKILL_IDS.includes(skill)) {
      return getRecordSnapshot(null, now);
    }
    const memory = normalizeMemory(value, now);
    return getRecordSnapshot(memory?.skills?.[skill] ?? null, now);
  }

  function getSnapshot(value, now = Date.now()) {
    const memory = normalizeMemory(value, now);
    if (!memory) return getRecordSnapshot(null, now);

    const skillSnapshots = Object.fromEntries(
      SKILL_IDS.map((skill) => [
        skill,
        getRecordSnapshot(memory.skills[skill] ?? null, now),
      ]),
    );
    const practiced = SKILL_IDS.map((skill) => ({
      skill,
      snapshot: skillSnapshots[skill],
    })).filter(({ snapshot }) => snapshot.record);
    const queuePriority = { relearning: 0, due: 1, scheduled: 2, new: 3 };
    const mostUrgent = practiced.reduce((best, candidate) => {
      if (!best) return candidate;
      const bestPriority = queuePriority[best.snapshot.queue] ?? 3;
      const candidatePriority = queuePriority[candidate.snapshot.queue] ?? 3;
      if (candidatePriority !== bestPriority) {
        return candidatePriority < bestPriority ? candidate : best;
      }
      return candidate.snapshot.recallNeed > best.snapshot.recallNeed
        ? candidate
        : best;
    }, null);

    return {
      record: mostUrgent?.snapshot.record ?? null,
      memory: cloneMemory(memory),
      skill: mostUrgent?.skill ?? null,
      skills: skillSnapshots,
      queue: mostUrgent?.snapshot.queue ?? "new",
      isDue: practiced.some(({ snapshot }) => snapshot.isDue),
      isApproaching:
        !practiced.some(({ snapshot }) => snapshot.isDue) &&
        practiced.some(({ snapshot }) => snapshot.isApproaching),
      retrievability: Math.min(
        ...practiced.map(({ snapshot }) => snapshot.retrievability),
      ),
      recallNeed: Math.max(
        ...practiced.map(({ snapshot }) => snapshot.recallNeed),
      ),
      // A single high recognition score must not advertise overall mastery
      // once another practiced skill has exposed a weaker memory.
      strength: Math.min(
        ...practiced.map(({ snapshot }) => snapshot.strength),
      ),
    };
  }

  function scheduleCorrect(
    record,
    now,
    evidenceWeight = 1,
    {
      initialStabilityDays = null,
      minimumStabilityDays = null,
      fastTrackConfidence = 0,
    } = {},
  ) {
    const evidence = clamp(finiteNumber(evidenceWeight, 1), 0.2, 1);
    if (!record) {
      const requestedInitialStability = finiteNumber(
        initialStabilityDays,
        evidence,
      );
      const stabilityDays = clamp(
        Math.max(evidence, requestedInitialStability),
        MIN_STABILITY_DAYS,
        MAX_STABILITY_DAYS,
      );
      return {
        state: "learning",
        stabilityDays,
        difficulty: 5,
        lastReviewedAt: now,
        dueAt: now + stabilityDays * DAY_MS,
        repetitions: 1,
        successes: 1,
        successEvidence: evidence,
        lapses: 0,
        fastTrackConfidence: clamp(
          finiteNumber(fastTrackConfidence, 0),
          0,
          1,
        ),
        updatedAt: now,
      };
    }

    const difficulty = clamp(record.difficulty - 0.15 * evidence, 1, 10);
    // See getChronicGrowthDampening's own comment for why this exists
    // alongside `difficulty`: difficulty saturates at its ceiling after
    // only ~6 lapses and stops discouraging further growth, while this
    // keeps responding to the word's whole lapse history.
    const dampening = getChronicGrowthDampening(record);
    let state;
    let stabilityDays;

    if (record.state === "relearning") {
      // A successful short retry repairs the lapse but does not restore the
      // old long interval. Tomorrow's retrieval supplies the durable evidence.
      state = evidence >= 0.5 ? "learning" : "relearning";
      const fullStability = Math.max(1, record.stabilityDays);
      stabilityDays =
        record.stabilityDays +
        (fullStability - record.stabilityDays) * evidence;
    } else if (record.state === "learning") {
      state = evidence >= 0.5 ? "review" : "learning";
      const fullStability =
        Math.max(state === "review" ? 3 : 1, record.stabilityDays * 3) *
        dampening;
      stabilityDays =
        record.stabilityDays +
        (fullStability - record.stabilityDays) * evidence;
    } else {
      state = "review";
      const elapsedDays =
        record.lastReviewedAt === null
          ? record.stabilityDays
          : Math.max(0, (now - record.lastReviewedAt) / DAY_MS);
      const overdueRatio = elapsedDays / record.stabilityDays;
      const difficultyAdjustment = (5 - difficulty) * 0.12;
      const overdueBonus = clamp(overdueRatio - 1, 0, 2) * 0.15;
      const growthFactor = clamp(
        2.4 + difficultyAdjustment + overdueBonus,
        1.3,
        3.2,
      );

      const fullStability = Math.max(
        record.stabilityDays + 1,
        record.stabilityDays * growthFactor * dampening,
      );
      stabilityDays =
        record.stabilityDays +
        (fullStability - record.stabilityDays) * evidence;
    }

    const requestedMinimumStability =
      record.fastTrackConfidence > 0
        ? finiteNumber(minimumStabilityDays, MIN_STABILITY_DAYS)
        : MIN_STABILITY_DAYS;
    stabilityDays = clamp(
      Math.max(stabilityDays, requestedMinimumStability),
      MIN_STABILITY_DAYS,
      MAX_STABILITY_DAYS,
    );

    return {
      ...record,
      state,
      stabilityDays,
      difficulty,
      lastReviewedAt: now,
      dueAt: now + stabilityDays * DAY_MS,
      repetitions: record.repetitions + 1,
      successes: record.successes + 1,
      successEvidence: record.successEvidence + evidence,
      // A fast-track prior is deliberately single-use. Whether this answer
      // earns the long confirmation floor or merely follows the ordinary
      // path, it must not be available to trigger again later.
      fastTrackConfidence: 0,
      updatedAt: now,
    };
  }

  function scheduleIncorrect(
    record,
    now,
    evidenceWeight = 1,
    outcomeValue = 0,
  ) {
    const evidence = clamp(finiteNumber(evidenceWeight, 1), 0.2, 1);
    const partialSuccess = clamp(finiteNumber(outcomeValue, 0), 0, 0.99);
    const failureEvidence = evidence * (1 - partialSuccess);
    const previous =
      record ||
      ({
        state: "learning",
        stabilityDays: MIN_STABILITY_DAYS,
        difficulty: 5,
        lastReviewedAt: null,
        dueAt: now,
        repetitions: 0,
        successes: 0,
        successEvidence: 0,
        lapses: 0,
        updatedAt: 0,
      });
    const stabilityDays = clamp(
      previous.stabilityDays * (1 - 0.65 * failureEvidence),
      MIN_STABILITY_DAYS,
      MAX_STABILITY_DAYS,
    );

    return {
      ...previous,
      state: "relearning",
      stabilityDays,
      difficulty: clamp(
        previous.difficulty + 0.8 * failureEvidence,
        1,
        10,
      ),
      lastReviewedAt: now,
      dueAt: now + RELEARNING_DELAY_MS,
      repetitions: previous.repetitions + 1,
      successEvidence:
        previous.successEvidence + evidence * partialSuccess,
      lapses: previous.lapses + failureEvidence,
      fastTrackConfidence: 0,
      updatedAt: now,
    };
  }

  function recordResult(
    value,
    isCorrect,
    now = Date.now(),
    {
      evidenceWeight = 1,
      outcomeValue = isCorrect ? 1 : 0,
      initialStabilityDays = null,
      minimumStabilityDays = null,
      fastTrackConfidence = 0,
    } = {},
  ) {
    const record = normalizeRecord(value, now);

    return isCorrect
      ? scheduleCorrect(record, now, evidenceWeight, {
          initialStabilityDays,
          minimumStabilityDays,
          fastTrackConfidence,
        })
      : scheduleIncorrect(record, now, evidenceWeight, outcomeValue);
  }

  function recordSkillResult(
    value,
    skill,
    isCorrect,
    now = Date.now(),
    options = {},
  ) {
    if (!SKILL_IDS.includes(skill)) return normalizeMemory(value, now);

    const memory = normalizeMemory(value, now) ?? {
      skills: {},
      updatedAt: 0,
    };
    memory.skills[skill] = recordResult(
      memory.skills[skill] ?? null,
      isCorrect,
      now,
      options,
    );
    memory.updatedAt = Math.max(
      0,
      ...Object.values(memory.skills).map((record) => record.updatedAt),
    );
    return cloneMemory(memory);
  }

  function mergeScheduledRecordValues(
    localValue,
    remoteValue,
    now = Date.now(),
  ) {
    const localStructured = isStructuredRecord(localValue);
    const remoteStructured = isStructuredRecord(remoteValue);

    // A structured v2 record always contains more reliable evidence than a
    // legacy scalar, whose review time is unknowable.
    if (localStructured !== remoteStructured) {
      return cloneRecord(
        normalizeRecord(localStructured ? localValue : remoteValue, now),
      );
    }

    const local = normalizeRecord(localValue, now);
    const remote = normalizeRecord(remoteValue, now);

    if (!local) return cloneRecord(remote);
    if (!remote) return cloneRecord(local);
    if (local.updatedAt !== remote.updatedAt) {
      return cloneRecord(local.updatedAt > remote.updatedAt ? local : remote);
    }

    // Same-time conflicts are resolved conservatively so a lapse cannot be
    // erased by an equally recent, more optimistic copy.
    if (local.lapses !== remote.lapses) {
      return cloneRecord(local.lapses > remote.lapses ? local : remote);
    }
    if (local.dueAt !== remote.dueAt) {
      return cloneRecord(local.dueAt < remote.dueAt ? local : remote);
    }

    return cloneRecord(
      local.stabilityDays <= remote.stabilityDays ? local : remote,
    );
  }

  function mergeRecordValues(localValue, remoteValue, now = Date.now()) {
    const local = normalizeMemory(localValue, now);
    const remote = normalizeMemory(remoteValue, now);
    if (!local) return cloneMemory(remote);
    if (!remote) return cloneMemory(local);

    const skills = {};
    for (const skill of SKILL_IDS) {
      const merged = mergeScheduledRecordValues(
        local.skills[skill],
        remote.skills[skill],
        now,
      );
      if (merged) skills[skill] = merged;
    }
    return normalizeMemory({ skills }, now);
  }

  function mergeCollections(localRecords, remoteRecords, now = Date.now()) {
    const merged = {};
    const local = localRecords || {};
    const remote = remoteRecords || {};

    for (const entryId of new Set([
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const record = mergeRecordValues(local[entryId], remote[entryId], now);

      if (record) {
        merged[entryId] = record;
      }
    }

    return merged;
  }

  window.SpacedRepetition = Object.freeze({
    STORAGE_VERSION,
    SKILL_IDS,
    DAY_MS,
    RELEARNING_DELAY_MS,
    TARGET_RETENTION,
    REVIEW_APPROACH_RETENTION,
    normalizeRecord,
    normalizeMemory,
    normalizeCollection,
    cloneRecord,
    cloneMemory,
    cloneCollection,
    getRetrievability,
    getRecallNeed,
    getSkillSnapshot,
    getSnapshot,
    recordResult,
    recordSkillResult,
    mergeRecordValues,
    mergeCollections,
    isChronicallyStruggling,
  });
})();
