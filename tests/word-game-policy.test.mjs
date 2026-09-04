import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ Math, Number, Object, Array });
context.window = context;
const policy = loadWordGamePolicy(root, context);
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
assert.ok(
  html.indexOf("wordGamePolicy.js") < html.indexOf("wordGame.js?v="),
  "The pure policy must load before the browser integration.",
);

assert.equal(policy.getQuestionSkill("forward"), "recognition");
assert.equal(policy.getQuestionSkill("typed-cloze"), "context");
assert.equal(policy.getQuestionSkill("reverse"), "production");
assert.equal(policy.getQuestionSkill("typed-listening"), "listening");
// Real dictionary headwords: 優しい/親切 both mean "kind", 速い/早い both
// mean "fast" — the kind of compact synonym list this parser must split on
// commas/semicolons into individually resolvable segments.
assert.deepEqual(
  Array.from(policy.getDefinitionSynonymSegments("優しい, 親切")),
  ["優しい", "親切"],
  "Comma-separated linked headwords are individual synonym candidates.",
);
assert.deepEqual(
  Array.from(
    policy.getDefinitionSynonymSegments("危険の反対の様子, 安全"),
  ),
  ["危険の反対の様子", "安全"],
  "The exact linked headword 安全 remains available after descriptive text.",
);
assert.deepEqual(
  Array.from(policy.getDefinitionSynonymSegments("仲がよく心が近いこと; 親しい")),
  ["仲がよく心が近いこと", "親しい"],
  "A definition can offer a semantically appropriate cross-word-class alternative.",
);
assert.deepEqual(
  Array.from(
    policy.getDefinitionSynonymSegments(
      "速度が大きいこと; 速い, 早い",
    ),
  ),
  ["速度が大きいこと", "速い", "早い"],
  "Definition prose is retained for later exact-headword filtering; short alternatives remain separate.",
);
assert.equal(
  policy.isDefinitionSynonymList(
    "優しい, 親切",
    (segment) => ["優しい", "親切"].includes(segment),
  ),
  true,
  "A definition made entirely of resolvable headwords can support a one-way synonym.",
);
assert.equal(
  policy.isDefinitionSynonymList(
    "抽象的な考えや計画を具体的にすること; 具体化, 明確化; 実現",
    (segment) => ["具体化", "実現"].includes(segment),
  ),
  false,
  "A synonym buried among explanatory senses is not a one-way exercise.",
);

assert.ok(
  policy.getExpectedSuccessProbability(300, 700, 220) >
    policy.getExpectedSuccessProbability(900, 700, 220),
);
assert.ok(
  policy.getAbilityAfterAnswer({
    ability: 500,
    wordDifficulty: 500,
    isCorrect: true,
    kFactor: 24,
    logisticScale: 220,
    minimum: 0,
    maximum: 1000,
  }) > 500,
);
const abilityUpdateFor = (isCorrect, exerciseBias) =>
  policy.getAbilityAfterAnswer({
    ability: 500,
    wordDifficulty: 500,
    isCorrect,
    kFactor: 24,
    logisticScale: 220,
    exerciseBias,
    minimum: 0,
    maximum: 1000,
  });
const forwardBias = policy.DEFAULT_MODE_BIASES.forward;
const typedProductionBias = policy.DEFAULT_MODE_BIASES["typed-reverse"];
assert.ok(
  abilityUpdateFor(false, typedProductionBias) >
    abilityUpdateFor(false, forwardBias),
  "A difficult production miss should lower general ability less.",
);
assert.ok(
  abilityUpdateFor(true, typedProductionBias) >
    abilityUpdateFor(true, forwardBias),
  "A difficult production success should provide stronger ability evidence.",
);
const partialAbilityUpdate = policy.getAbilityAfterAnswer({
  ability: 500,
  wordDifficulty: 500,
  isCorrect: false,
  outcomeValue: 0.4,
  kFactor: 24,
  logisticScale: 220,
  minimum: 0,
  maximum: 1000,
});
assert.ok(partialAbilityUpdate > abilityUpdateFor(false, 0));
assert.ok(partialAbilityUpdate < abilityUpdateFor(true, 0));
assert.ok(
  policy.getExerciseAdjustedSuccessProbability(0.5, forwardBias) >
    policy.getExerciseAdjustedSuccessProbability(0.5, typedProductionBias),
);

const brandNewA0Support = policy.getA0SupportIntensity({
  ability: 60,
  introducedCount: 0,
  establishedRecognitionCount: 0,
});
const transitioningA0Support = policy.getA0SupportIntensity({
  ability: 240,
  introducedCount: 35,
  establishedRecognitionCount: 12,
});
const establishedA1Support = policy.getA0SupportIntensity({
  ability: 420,
  introducedCount: 100,
  establishedRecognitionCount: 45,
});
assert.ok(brandNewA0Support > transitioningA0Support);
assert.ok(transitioningA0Support > establishedA1Support);
assert.ok(establishedA1Support < 0.05);
assert.ok(
  policy.getA0ReinforcementShare(brandNewA0Support) >
    policy.getA0ReinforcementShare(transitioningA0Support),
);
assert.ok(
  policy.getA0FrequencyWeight(0.9, brandNewA0Support) >
    policy.getA0FrequencyWeight(0.1, brandNewA0Support),
);
assert.ok(
  policy.getA0FrequencyWeight(1, brandNewA0Support) >= 15,
  "maximum beginner support should make top-frequency words dominant",
);
assert.ok(
  policy.getA0CefrWeight("A1", brandNewA0Support) >
    policy.getA0CefrWeight("B2", brandNewA0Support),
);
assert.equal(policy.getA0CefrWeight("B2", 0), 1);

const predictor = policy.normalizePredictorState({
  modes: { forward: { attempts: 3.9, bias: 99 } },
});
assert.equal(predictor.modes.forward.attempts, 3);
assert.equal(predictor.modes.forward.bias, 1.5);
assert.equal(predictor.modes.reverse.attempts, 0);
assert.equal(predictor.skills.production.attempts, 0);

let evaluation = policy.normalizePredictionEvaluationState(null);
evaluation = policy.recordPredictionEvaluation(evaluation, {
  mode: "cloze",
  difficultyBucket: "400-599",
  predictedSuccess: 0.8,
  wasCorrect: true,
});
evaluation = policy.recordPredictionEvaluation(evaluation, {
  mode: "cloze",
  difficultyBucket: "400-599",
  predictedSuccess: 0.8,
  wasCorrect: false,
});
evaluation = policy.recordPredictionEvaluation(evaluation, {
  mode: "typed-cloze",
  difficultyBucket: "600-799",
  predictedSuccess: 0.6,
  wasCorrect: true,
  nearMiss: true,
});
const evaluationReport = policy.getPredictionEvaluationReport(evaluation);
assert.equal(evaluationReport.overall.count, 3);
assert.equal(evaluationReport.byMode.cloze.count, 2);
assert.equal(evaluationReport.byDifficulty["400-599"].count, 2);
assert.equal(
  evaluationReport.byModeAndDifficulty.cloze["400-599"].count,
  2,
);
assert.equal(evaluationReport.byMode["typed-cloze"].nearMissRate, 1);
assert.equal(evaluationReport.byMode["typed-cloze"].exactAccuracy, 0);
assert.ok(Math.abs(evaluationReport.byMode.cloze.brierScore - 0.34) < 1e-12);
assert.ok(
  Math.abs(evaluationReport.byMode.cloze.absoluteCalibrationError - 0.3) <
    1e-12,
);
assert.ok(evaluationReport.overall.expectedCalibrationError >= 0);
assert.equal(
  policy.normalizePredictionEvaluationState({
    total: { count: -4, squaredErrorSum: "bad" },
  }).total.count,
  0,
);

const abilityOnly = policy.predictSuccess({ abilityProbability: 0.6 });
const remembered = policy.predictSuccess({
  abilityProbability: 0.6,
  hasPersonalMemory: true,
  retrievability: 0.95,
});
assert.ok(remembered > abilityOnly);
assert.ok(policy.getChallengeFit(0.85) > policy.getChallengeFit(0.45));
assert.ok(policy.getProgressionWeight(0.95) > policy.getProgressionWeight(0.4));

const dueOverall = { record: {}, queue: "due", isDue: true };
const dueSkill = { queue: "due", isDue: true, recallNeed: 0.7 };
const quietSkill = { queue: "scheduled", recallNeed: 0 };
assert.ok(
  policy.getSkillUrgencyWeight(dueOverall, dueSkill) >
    policy.getSkillUrgencyWeight(dueOverall, quietSkill) * 10,
);

const calibratedCorrect = policy.updateCalibrationMode(
  { attempts: 0, bias: 0 },
  0.8,
  true,
);
const calibratedMiss = policy.updateCalibrationMode(
  calibratedCorrect,
  0.8,
  false,
);
assert.ok(calibratedCorrect.bias > 0);
assert.ok(calibratedMiss.bias < calibratedCorrect.bias);
assert.equal(calibratedMiss.attempts, 2);
const fluentEvidence = policy.updateCalibrationMode(
  { attempts: 0, bias: 0 },
  0.8,
  true,
  { responseTimeMs: 4000 },
);
const hesitantNearMiss = policy.updateCalibrationMode(
  fluentEvidence,
  0.8,
  true,
  {
    responseTimeMs: 16000,
    nearMiss: true,
    possiblyGuessed: true,
    outcomeValue: 0.8,
  },
);
assert.equal(hesitantNearMiss.exactCorrect, 1);
assert.equal(hesitantNearMiss.nearMisses, 1);
assert.equal(hesitantNearMiss.possibleGuesses, 1);
assert.ok(
  policy.getCalibrationEvidenceBias(hesitantNearMiss, "typed-reverse") < 0,
);
assert.ok(
  policy.getQuestionComplexityBias({
    mode: "typed-reverse",
    formLength: 15,
    formTokenCount: 2,
  }) <
    policy.getQuestionComplexityBias({
      mode: "typed-reverse",
      formLength: 4,
      formTokenCount: 1,
    }),
);

const supportedClozeBias = policy.getQuestionComplexityBias({
  mode: "typed-cloze",
  formLength: 5,
  sentenceTokenCount: 8,
  sentenceVocabularySuccess: 0.92,
  targetContextCoverage: 1,
  translationAvailable: true,
});
const difficultRenderedClozeBias = policy.getQuestionComplexityBias({
  mode: "typed-cloze",
  formLength: 11,
  sentenceTokenCount: 18,
  sentenceVocabularySuccess: 0.45,
  targetContextCoverage: 0.2,
  distractorSimilarity: 0.9,
  translationAvailable: false,
});
assert.ok(supportedClozeBias > difficultRenderedClozeBias);
assert.ok(
  policy.getQuestionComplexityBias({
    mode: "cloze",
    distractorSimilarity: 0.1,
  }) >
    policy.getQuestionComplexityBias({
      mode: "cloze",
      distractorSimilarity: 0.9,
    }),
);

assert.equal(
  policy.getTypedRecallProbability(
    0.9,
    { start: 0.7, full: 0.9, maximum: 1 },
  ),
  1,
);
assert.equal(
  policy.getTypedRecallProbability(
    0.9,
    { start: 0.7, full: 0.9, maximum: 1 },
    { isRelearning: true },
  ),
  0,
);

const pairPlan = policy.buildQuestionPairPlan(
  [
    { mode: "forward", weight: 0.5 },
    { mode: "reverse", weight: 0.5 },
  ],
  {
    predict: (mode) => (mode === "forward" ? 0.85 : 0.4),
    progressionWeight: () => 1,
    urgencyWeight: () => 1,
  },
);
assert.ok(pairPlan.candidates[0].pairWeight > pairPlan.candidates[1].pairWeight);
assert.ok(pairPlan.totalPairWeight > 0);

assert.equal(policy.getUsefulnessWeight(1, 0.7), 1.7);
assert.equal(policy.getUsefulnessWeight(Number.NaN, 0.7), 1);
assert.ok(policy.getAbilityProximity(0, 140) > policy.getAbilityProximity(300, 140));
assert.ok(
  policy.getMemoryWeight({ recallNeed: 0.8, useRecallNeed: true }) >
    policy.getMemoryWeight({ recallNeed: 0.2, useRecallNeed: true }),
);
assert.equal(
  policy.getWordWeight({
    memoryWeight: 2,
    abilityWeight: 3,
    usefulnessWeight: 1.5,
  }),
  9,
);
assert.equal(policy.getWeightedIndex([1, 3], 0), 0);
assert.equal(policy.getWeightedIndex([1, 3], 0.99), 1);

const entries = [{ queue: "scheduled" }, { queue: "due" }, { queue: "new" }];
const queues = policy.buildQueues(entries, (entry) => entry.queue);
assert.equal(policy.getNextQueueName(queues), "due");
assert.deepEqual([...queues.new], [entries[2]]);

const nearby = { core: true, difficulty: 500, proximity: 1 };
const distantEasy = { core: true, difficulty: 100, proximity: 0.01 };
const rare = { core: false, difficulty: 500, proximity: 1 };
assert.deepEqual(
  [...policy.getCoreCandidatePool([nearby, distantEasy, rare], {
    frequencyDataAvailable: true,
    hasFrequency: (entry) => entry.core,
    getDifficulty: (entry) => entry.difficulty,
    ability: 500,
    getProximity: (entry) => entry.proximity,
    minimumProximity: 0.25,
  })],
  [nearby],
);

assert.equal(
  policy.shouldPrioritizeQuota({ share: 0.25, questionCount: 3, savedCount: 0 }),
  true,
);
assert.equal(
  policy.shouldPrioritizeQuota({ share: 0.25, questionCount: 3, savedCount: 1 }),
  false,
);

const lowConfidenceRecovery = policy.getRecoveryPlan({
  failedMode: "typed-listening",
  predictedSuccess: 0.4,
  baseGap: 4,
});
assert.equal(lowConfidenceRecovery.nextMode, "forward");
assert.equal(lowConfidenceRecovery.requiresOriginalSuccess, true);
const moderateRecovery = policy.getRecoveryPlan({
  failedMode: "typed-listening",
  predictedSuccess: 0.7,
  baseGap: 4,
});
assert.equal(moderateRecovery.nextMode, "listening");
const readyRecovery = policy.getRecoveryPlan({
  failedMode: "typed-listening",
  predictedSuccess: 0.85,
  baseGap: 4,
});
assert.equal(readyRecovery.nextMode, "typed-listening");
assert.ok(lowConfidenceRecovery.originalRetryGap >= 4);

const earlyContext = { record: { successes: 2 } };
const establishedContext = { record: { successes: 3 } };
assert.equal(policy.shouldUseVariedContext(earlyContext), false);
assert.equal(policy.shouldUseVariedContext(establishedContext), true);
assert.equal(
  policy.shouldUseVariedContext({
    record: { successes: 3, successEvidence: 1.5 },
  }),
  false,
);
assert.equal(policy.getVariedContextIndex(establishedContext, 4), 0);
assert.equal(
  policy.getVariedContextIndex({ record: { successes: 6 } }, 4),
  3,
);
assert.equal(policy.getVariedContextIndex(earlyContext, 4), -1);
assert.equal(policy.getVariedContextIndex(establishedContext, 0), -1);

const fullRecallEvidence = policy.getSrsEvidenceWeight({
  wasCorrect: true,
  predictedSuccess: 0.7,
  responseTimeMs: 4000,
  responseTimeTargetMs: 6500,
});
const guessedRecallEvidence = policy.getSrsEvidenceWeight({
  wasCorrect: true,
  predictedSuccess: 0.7,
  responseTimeMs: 500,
  responseTimeTargetMs: 6500,
  possiblyGuessed: true,
});
const scaffoldRecallEvidence = policy.getSrsEvidenceWeight({
  wasCorrect: true,
  predictedSuccess: 0.7,
  wasScaffolded: true,
});
assert.ok(Math.abs(fullRecallEvidence - 0.96) < 1e-12);
assert.ok(guessedRecallEvidence < fullRecallEvidence * 0.7);
assert.ok(scaffoldRecallEvidence < fullRecallEvidence);
assert.ok(
  policy.getSrsEvidenceWeight({ wasCorrect: false, predictedSuccess: 0.9 }) >
    policy.getSrsEvidenceWeight({ wasCorrect: false, predictedSuccess: 0.2 }),
);

assert.equal(policy.getReviewPortfolioShare(0), 0);
assert.equal(policy.getReviewPortfolioShare(10), 0.65);
assert.ok(policy.getReviewPortfolioShare(100) > 0.77);
assert.equal(policy.getReviewPortfolioShare(1e9), 0.85);
assert.equal(
  policy.shouldPrioritizeReview({ share: 0.7, questionCount: 1, reviewCount: 0 }),
  true,
);
assert.equal(
  policy.shouldPrioritizeReview({ share: 0.7, questionCount: 1, reviewCount: 1 }),
  false,
);

assert.equal(policy.shouldIntroduceUnseenWord(), true);
assert.equal(
  policy.shouldIntroduceUnseenWord({ hasMemory: true }),
  false,
);
assert.equal(
  policy.shouldIntroduceUnseenWord({ alreadyIntroduced: true }),
  false,
);
assert.equal(
  policy.shouldIntroduceUnseenWord({ placementCalibrationEnabled: true }),
  false,
);
assert.equal(
  policy.shouldIntroduceUnseenWord({ queueName: "due" }),
  false,
);
assert.equal(
  policy.shouldIntroduceUnseenWord({
    queueName: "placement",
    isPlacementRound: true,
  }),
  true,
);
assert.equal(policy.getInitialRetrievalAvailableTurn(7), 10);
assert.equal(policy.MAX_PENDING_INITIAL_RETRIEVALS, 2);
const pendingIntroductions = [
  { availableAfterTurn: 6 },
  { availableAfterTurn: 8 },
];
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions.slice(0, 1), 5),
  -1,
);
assert.equal(policy.getInitialRetrievalIndex(pendingIntroductions, 5), 0);
assert.equal(policy.getInitialRetrievalIndex(pendingIntroductions, 6), 0);
assert.equal(
  policy.getInitialRetrievalIndex(
    Array.from({ length: 2 }, () => ({ availableAfterTurn: 99 })),
    5,
  ),
  0,
);
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions, 5, {
    forceAtRoundTail: true,
  }),
  0,
);
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions.slice(0, 1), 6, {
    isExcluded: () => true,
  }),
  -1,
);
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions, 6, {
    isExcluded: (entry) => entry === pendingIntroductions[0],
  }),
  1,
);
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions, 5, {
    forceAtRoundTail: true,
    isExcluded: (entry) => entry === pendingIntroductions[0],
  }),
  1,
);
assert.equal(
  policy.getInitialRetrievalIndex(pendingIntroductions, 99, {
    forceAtRoundTail: true,
    isExcluded: () => true,
  }),
  -1,
);

const highAbilityChoiceFastTrack = policy.getAbilityFastTrackSchedule({
  ability: 900,
  wordDifficulty: 100,
  predictedSuccess: 0.98,
  mode: "forward",
  queueName: "new",
  wasCorrect: true,
  evidenceWeight: 0.9,
});
assert.equal(highAbilityChoiceFastTrack.initialStabilityDays, 3);
assert.equal(highAbilityChoiceFastTrack.minimumStabilityDays, null);
assert.equal(highAbilityChoiceFastTrack.fastTrackConfidence, 1);
const highAbilityTypedFastTrack = policy.getAbilityFastTrackSchedule({
  ability: 900,
  wordDifficulty: 100,
  predictedSuccess: 0.98,
  mode: "typed-reverse",
  queueName: "new",
  wasCorrect: true,
  evidenceWeight: 0.9,
});
assert.equal(highAbilityTypedFastTrack.initialStabilityDays, 7);
assert.equal(
  policy.getAbilityFastTrackSchedule({
    ability: 300,
    wordDifficulty: 100,
    predictedSuccess: 0.98,
    queueName: "new",
    wasCorrect: true,
  }).initialStabilityDays,
  null,
);
for (const disqualifier of [
  { possiblyGuessed: true },
  { nearMiss: true },
  { wasScaffolded: true },
  { placementCalibrationEnabled: true },
  { credit: false },
  { evidenceWeight: 0.79 },
]) {
  assert.equal(
    policy.getAbilityFastTrackSchedule({
      ability: 900,
      wordDifficulty: 100,
      predictedSuccess: 0.98,
      queueName: "new",
      wasCorrect: true,
      evidenceWeight: 0.9,
      ...disqualifier,
    }).initialStabilityDays,
    null,
  );
}
const fastTrackCandidate = {
  state: "learning",
  repetitions: 1,
  successes: 1,
  lapses: 0,
  fastTrackConfidence: 1,
};
assert.equal(
  policy.getAbilityFastTrackSchedule({
    record: fastTrackCandidate,
    queueName: "due",
    mode: "forward",
    wasCorrect: true,
    evidenceWeight: 0.9,
  }).minimumStabilityDays,
  21,
);
assert.equal(
  policy.getAbilityFastTrackSchedule({
    record: fastTrackCandidate,
    queueName: "due",
    mode: "typed-listening",
    wasCorrect: true,
    evidenceWeight: 0.9,
  }).minimumStabilityDays,
  30,
);
assert.equal(
  policy.getAbilityFastTrackSchedule({
    record: fastTrackCandidate,
    queueName: "scheduled",
    isApproaching: false,
    wasCorrect: true,
    evidenceWeight: 0.9,
  }).minimumStabilityDays,
  null,
);
assert.equal(
  policy.getAbilityFastTrackSchedule({
    record: { ...fastTrackCandidate, lapses: 0.2 },
    queueName: "due",
    wasCorrect: true,
    evidenceWeight: 0.9,
  }).minimumStabilityDays,
  null,
);

console.log("word-game policy tests passed");
