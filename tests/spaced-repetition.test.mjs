import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console, Date, Math, Number, Object, Set });
context.window = context;

vm.runInContext(
  fs.readFileSync(path.join(root, "spacedRepetition.js"), "utf8"),
  context,
  { filename: "spacedRepetition.js" },
);

const scheduler = context.SpacedRepetition;
const NOW = Date.UTC(2026, 7, 16, 12);
const DAY = scheduler.DAY_MS;
assert.equal(scheduler.TARGET_RETENTION, 0.9);
assert.equal(scheduler.REVIEW_APPROACH_RETENTION, 0.91);
assert.equal(scheduler.STORAGE_VERSION, 6);
assert.deepEqual([...scheduler.SKILL_IDS], [
  "recognition",
  "production",
  "listening",
  "context",
  "semantic",
]);

// Legacy scalar strengths retain approximate maturity but are due once,
// because version 1 never recorded when the learner last saw them.
const legacyMastered = scheduler.normalizeRecord(5, NOW);
assert.equal(legacyMastered.state, "review");
assert.equal(legacyMastered.stabilityDays, 30);
assert.equal(legacyMastered.dueAt, NOW);
assert.equal(legacyMastered.fastTrackConfidence, 0);
assert.equal(scheduler.getSnapshot(legacyMastered, NOW).queue, "due");
const migratedMemory = scheduler.normalizeMemory(legacyMastered, NOW);
assert.deepEqual(Object.keys(migratedMemory.skills), ["recognition"]);
assert.equal(
  scheduler.getSkillSnapshot(migratedMemory, "production", NOW).queue,
  "new",
);
assert.equal(
  scheduler.getSkillSnapshot(migratedMemory, "semantic", NOW).queue,
  "new",
);

const legacyFailed = scheduler.normalizeRecord(0, NOW);
assert.equal(legacyFailed.state, "relearning");
assert.equal(scheduler.getSnapshot(legacyFailed, NOW).queue, "relearning");

// New knowledge enters a one-day learning step, then graduates to a longer
// review interval only after another due success.
const firstSuccess = scheduler.recordResult(null, true, NOW);
assert.equal(firstSuccess.state, "learning");
assert.equal(firstSuccess.dueAt, NOW + DAY);
assert.equal(scheduler.getSnapshot(firstSuccess, NOW).strength, 1);
assert.equal(scheduler.getSnapshot(firstSuccess, NOW).queue, "scheduled");
assert.equal(scheduler.getSnapshot(firstSuccess, NOW + DAY).queue, "due");

const secondSuccess = scheduler.recordResult(firstSuccess, true, NOW + DAY);
assert.equal(secondSuccess.state, "review");
assert.equal(secondSuccess.stabilityDays, 3);
assert.equal(secondSuccess.dueAt, NOW + 4 * DAY);

// A caller-supplied learner prior can modestly bootstrap a first memory, but
// its long floor is single-use and requires the stored confirmation marker.
const fastTrackedFirst = scheduler.recordResult(null, true, NOW, {
  initialStabilityDays: 3,
  fastTrackConfidence: 1,
});
assert.equal(fastTrackedFirst.state, "learning");
assert.equal(fastTrackedFirst.stabilityDays, 3);
assert.equal(fastTrackedFirst.dueAt, NOW + 3 * DAY);
assert.equal(fastTrackedFirst.fastTrackConfidence, 1);
const fastTrackedConfirmation = scheduler.recordResult(
  fastTrackedFirst,
  true,
  fastTrackedFirst.dueAt,
  { minimumStabilityDays: 21 },
);
assert.equal(fastTrackedConfirmation.state, "review");
assert.equal(fastTrackedConfirmation.stabilityDays, 21);
assert.equal(fastTrackedConfirmation.fastTrackConfidence, 0);
const cannotFastTrackAgain = scheduler.recordResult(
  fastTrackedConfirmation,
  true,
  fastTrackedConfirmation.dueAt,
  { minimumStabilityDays: 365 },
);
assert.ok(cannotFastTrackAgain.stabilityDays < 365);
const failedFastTrack = scheduler.recordResult(
  fastTrackedFirst,
  false,
  fastTrackedFirst.dueAt,
);
assert.equal(failedFastTrack.fastTrackConfidence, 0);

// Correct answers carry graded evidence. A likely guess remains a useful
// exposure, but it neither earns the full interval nor graduates a learning
// record as confidently as an effortful exact retrieval.
const guessedFirstSuccess = scheduler.recordResult(null, true, NOW, {
  evidenceWeight: 0.3,
});
assert.equal(guessedFirstSuccess.successes, 1);
assert.equal(guessedFirstSuccess.successEvidence, 0.3);
assert.ok(guessedFirstSuccess.stabilityDays < firstSuccess.stabilityDays);
const guessedSecondSuccess = scheduler.recordResult(
  guessedFirstSuccess,
  true,
  guessedFirstSuccess.dueAt,
  { evidenceWeight: 0.3 },
);
assert.equal(guessedSecondSuccess.state, "learning");
assert.ok(guessedSecondSuccess.stabilityDays < secondSuccess.stabilityDays);

const mildLapse = scheduler.recordResult(secondSuccess, false, NOW + 5 * DAY, {
  evidenceWeight: 0.55,
});
const strongLapse = scheduler.recordResult(secondSuccess, false, NOW + 5 * DAY, {
  evidenceWeight: 1,
});
assert.ok(mildLapse.stabilityDays > strongLapse.stabilityDays);
assert.ok(mildLapse.difficulty < strongLapse.difficulty);
const morphologyNearMiss = scheduler.recordResult(
  secondSuccess,
  false,
  NOW + 5 * DAY,
  { evidenceWeight: 1, outcomeValue: 0.4 },
);
assert.equal(morphologyNearMiss.state, "relearning");
assert.ok(Math.abs(morphologyNearMiss.lapses - 0.6) < 1e-12);
assert.ok(
  Math.abs(
    morphologyNearMiss.successEvidence -
      (secondSuccess.successEvidence + 0.4),
  ) < 1e-12,
);
assert.ok(morphologyNearMiss.stabilityDays > strongLapse.stabilityDays);
assert.ok(morphologyNearMiss.difficulty < strongLapse.difficulty);

// Recall need grows continuously as memory decays. A review becomes softly
// eligible shortly before the exact 90% target, rather than changing from
// wholly unavailable to mandatory at one timestamp.
const comfortablyEarly = scheduler.getSnapshot(secondSuccess, NOW + 3.5 * DAY);
assert.equal(comfortablyEarly.isApproaching, false);
assert.equal(comfortablyEarly.recallNeed, 0);
const approaching = scheduler.getSnapshot(secondSuccess, NOW + 3.8 * DAY);
assert.equal(approaching.queue, "scheduled");
assert.equal(approaching.isApproaching, true);
assert.ok(approaching.recallNeed > 0);
const exactlyDue = scheduler.getSnapshot(secondSuccess, secondSuccess.dueAt);
assert.equal(exactlyDue.queue, "due");
assert.equal(exactlyDue.isApproaching, false);
assert.ok(exactlyDue.recallNeed > approaching.recallNeed);
const substantiallyForgotten = scheduler.getRecallNeed(
  secondSuccess,
  NOW + 8 * DAY,
);
assert.ok(substantiallyForgotten > exactlyDue.recallNeed);

// Visible strength is time-sensitive rather than permanent.
const freshStrength = scheduler.getSnapshot(secondSuccess, NOW + DAY).strength;
const forgottenStrength = scheduler.getSnapshot(
  secondSuccess,
  NOW + 120 * DAY,
).strength;
assert.ok(forgottenStrength < freshStrength);

// A lapse becomes a durable, timestamped relearning record and is due after
// the short retry delay. A successful retry returns only to learning.
const lapseTime = NOW + 5 * DAY;
const lapsed = scheduler.recordResult(secondSuccess, false, lapseTime);
assert.equal(lapsed.state, "relearning");
assert.equal(lapsed.lapses, 1);
assert.equal(lapsed.dueAt, lapseTime + scheduler.RELEARNING_DELAY_MS);
assert.equal(
  scheduler.getSnapshot(lapsed, lapsed.dueAt - 1).queue,
  "scheduled",
);
assert.equal(scheduler.getSnapshot(lapsed, lapsed.dueAt).queue, "relearning");
assert.equal(
  scheduler.getSnapshot(lapsed, lapsed.dueAt - 1).isApproaching,
  false,
);

const repaired = scheduler.recordResult(lapsed, true, lapsed.dueAt);
assert.equal(repaired.state, "learning");
assert.ok(repaired.stabilityDays <= 3);

// Each exercise skill owns independent durable evidence. Recognition success
// neither creates nor schedules production/listening/context mastery.
const recognized = scheduler.recordSkillResult(
  null,
  "recognition",
  true,
  NOW,
);
assert.deepEqual(Object.keys(recognized.skills), ["recognition"]);
const produced = scheduler.recordSkillResult(
  recognized,
  "production",
  false,
  NOW + DAY,
);
assert.equal(produced.skills.recognition.successes, 1);
assert.equal(produced.skills.production.lapses, 1);
assert.equal(produced.skills.listening, undefined);
const composite = scheduler.getSnapshot(
  produced,
  NOW + DAY + scheduler.RELEARNING_DELAY_MS,
);
assert.equal(composite.strength, 0);
assert.equal(composite.skill, "production");
assert.equal(
  scheduler.getSkillSnapshot(produced, "recognition", NOW + DAY).queue,
  "due",
);
assert.equal(
  scheduler.getSkillSnapshot(produced, "context", NOW + DAY).queue,
  "new",
);

// Device reconciliation follows the newest answer, not the highest historic
// score. Thus a later lapse survives an older mastered copy.
const olderMastery = {
  ...secondSuccess,
  stabilityDays: 30,
  dueAt: NOW + 30 * DAY,
  updatedAt: NOW + DAY,
};
const newerLapse = {
  ...lapsed,
  updatedAt: NOW + 5 * DAY,
};
const merged = scheduler.mergeRecordValues(olderMastery, newerLapse, NOW);
assert.equal(merged.skills.recognition.state, "relearning");
assert.equal(merged.skills.recognition.updatedAt, newerLapse.updatedAt);

// A structured record also wins over an unmigrated scalar from an older
// client, regardless of that scalar's nominal strength.
const structuredWins = scheduler.mergeRecordValues(newerLapse, 5, NOW);
assert.equal(structuredWins.skills.recognition.state, "relearning");
assert.equal(
  structuredWins.skills.recognition.updatedAt,
  newerLapse.updatedAt,
);

// Cloud/device merges reconcile each skill separately instead of selecting
// one whole-word record and discarding newer evidence in another direction.
const localSkills = scheduler.recordSkillResult(
  recognized,
  "context",
  true,
  NOW + 2 * DAY,
);
const remoteSkills = scheduler.recordSkillResult(
  recognized,
  "listening",
  false,
  NOW + 3 * DAY,
);
const mergedSkills = scheduler.mergeRecordValues(
  localSkills,
  remoteSkills,
  NOW + 3 * DAY,
);
assert.equal(mergedSkills.skills.context.successes, 1);
assert.equal(mergedSkills.skills.listening.lapses, 1);
assert.equal(mergedSkills.skills.recognition.successes, 1);

console.log("spaced-repetition tests passed");
