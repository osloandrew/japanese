(function () {
  "use strict";

  // Pure adaptive-learning policy. This module deliberately knows nothing
  // about the DOM, localStorage, dictionary globals, or round UI. Callers
  // supply learner/item state and receive deterministic scores or choices.
  const DEFAULT_MODE_BIASES = Object.freeze({
    forward: 0.6,
    cloze: 0.25,
    listening: 0.1,
    reverse: -0.2,
    "typed-cloze": -0.45,
    "typed-reverse": -0.65,
    "typed-listening": -0.75,
    synonym: 0.2,
  });
  const DEFAULT_MODE_PREREQUISITES = Object.freeze({
    cloze: "forward",
    "typed-cloze": "cloze",
    reverse: "cloze",
    "typed-reverse": "reverse",
    listening: "reverse",
    "typed-listening": "listening",
    synonym: "forward",
  });
  const DEFAULT_SKILLS = Object.freeze([
    "recognition",
    "context",
    "production",
    "listening",
    "semantic",
  ]);
  const RESPONSE_TIME_TARGET_MS = Object.freeze({
    forward: 4500,
    cloze: 6500,
    listening: 6000,
    reverse: 6500,
    "typed-cloze": 10000,
    "typed-reverse": 10000,
    "typed-listening": 10000,
    synonym: 6000,
  });
  const CONTEXT_VARIATION_MIN_SUCCESSES = 3;
  const INITIAL_RETRIEVAL_GAP_TURNS = 3;
  // Two unseen words are enough to create an intervening item before the
  // first retrieval. A limit of one would either repeat the same visible
  // word immediately or, because immediate repetition is forbidden, still
  // require a second introduction. After this cold start, the queue naturally
  // tends to alternate one new word with one retrieval.
  const MAX_PENDING_INITIAL_RETRIEVALS = 2;
  const FAST_TRACK_MIN_PREDICTED_SUCCESS = 0.92;
  const FAST_TRACK_FULL_PREDICTED_SUCCESS = 0.98;
  const FAST_TRACK_MIN_ABILITY_ADVANTAGE = 300;
  const FAST_TRACK_FULL_ABILITY_ADVANTAGE = 700;
  const FAST_TRACK_MIN_EVIDENCE_WEIGHT = 0.8;
  const DEFAULT_QUEUE_PRIORITY = Object.freeze([
    "relearning",
    "due",
    "approaching",
    "new",
    "scheduled",
  ]);

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  // Definitions are rendered as semicolon-separated senses, with commas
  // separating short alternatives within a sense. Only a segment that exactly
  // matches another dictionary headword is later eligible as a synonym; this
  // helper deliberately does not try to infer synonyms from ordinary prose.
  function getDefinitionSynonymSegments(definition) {
    return String(definition ?? "")
      .split(";")
      .flatMap((line) => line.split(","))
      .map((segment) =>
        segment
          .trim()
          .replace(/^[([{"'«]+/u, "")
          .replace(/[)\]}"'».:!?]+$/u, "")
          .trim()
          .normalize("NFC")
          .toLocaleLowerCase("ja-JP"),
      )
      .filter(Boolean);
  }

  // A one-way synonym is safe only when the definition itself is a compact
  // headword list (for example, "velgjørende, menneskekjærlig"), rather than
  // one possible sense embedded in explanatory prose. The caller supplies
  // the local-headword resolver because this policy module has no dictionary
  // data of its own.
  function isDefinitionSynonymList(definition, isResolvable) {
    const segments = getDefinitionSynonymSegments(definition);
    return (
      segments.length > 0 &&
      typeof isResolvable === "function" &&
      segments.every((segment) => isResolvable(segment))
    );
  }

  function clampProbability(value) {
    return clamp(value, 0.02, 0.98);
  }

  function probabilityToLogOdds(value) {
    const probability = clampProbability(value);
    return Math.log(probability / (1 - probability));
  }

  function logOddsToProbability(value) {
    return 1 / (1 + Math.exp(-value));
  }

  function getExpectedSuccessProbability(
    wordDifficulty,
    ability,
    logisticScale,
  ) {
    return 1 / (1 + Math.exp((wordDifficulty - ability) / logisticScale));
  }

  function getExerciseAdjustedSuccessProbability(
    abilityProbability,
    exerciseBias = 0,
  ) {
    return clampProbability(
      logOddsToProbability(
        probabilityToLogOdds(abilityProbability) + exerciseBias,
      ),
    );
  }

  function getAbilityAfterAnswer({
    ability,
    wordDifficulty,
    isCorrect,
    outcomeValue = isCorrect ? 1 : 0,
    kFactor,
    logisticScale,
    exerciseBias = 0,
    minimum,
    maximum,
  }) {
    const expected = getExerciseAdjustedSuccessProbability(
      getExpectedSuccessProbability(wordDifficulty, ability, logisticScale),
      exerciseBias,
    );
    const actual = clamp(Number(outcomeValue) || 0, 0, 1);
    return clamp(ability + kFactor * (actual - expected), minimum, maximum);
  }

  // A0 support is a continuous amount of scaffolding, not a second learner
  // mode. Ability, breadth of encountered words, and retained recognition
  // each make a separate, smoothly fading contribution. Existing learners
  // with an established SRS history therefore enter at little or no support,
  // while a genuine new learner starts near 1 without needing a curriculum
  // file or a one-time "A0 complete" switch.
  function smoothstep(value) {
    const progress = clamp(Number(value) || 0, 0, 1);
    return progress * progress * (3 - 2 * progress);
  }

  function getA0SupportIntensity({
    ability,
    introducedCount = 0,
    establishedRecognitionCount = 0,
    abilityStart = 100,
    abilityEnd = 380,
    introducedTarget = 80,
    establishedTarget = 35,
  } = {}) {
    const abilityProgress = clamp(
      (Number(ability) - abilityStart) / (abilityEnd - abilityStart),
      0,
      1,
    );
    const introducedProgress = clamp(
      Number(introducedCount) / introducedTarget,
      0,
      1,
    );
    const retainedProgress = clamp(
      Number(establishedRecognitionCount) / establishedTarget,
      0,
      1,
    );
    return 1 - smoothstep(
      0.45 * abilityProgress +
        0.3 * introducedProgress +
        0.25 * retainedProgress,
    );
  }

  function getA0ReinforcementShare(supportIntensity) {
    return 0.7 * clamp(Number(supportIntensity) || 0, 0, 1);
  }

  function getA0FrequencyWeight(frequencyValue, supportIntensity) {
    const frequency = clamp(Number(frequencyValue) || 0, 0, 1);
    const support = clamp(Number(supportIntensity) || 0, 0, 1);
    // At the beginning, corpus usefulness should sharply separate genuinely
    // foundational vocabulary from the long tail inside A1. The exponent
    // keeps middling evidence from receiving the same lift as words that are
    // consistently frequent across the blended spoken/newspaper/book data.
    return 1 + 15 * support * frequency ** 1.35;
  }

  function getA0CefrWeight(cefr, supportIntensity) {
    const support = clamp(Number(supportIntensity) || 0, 0, 1);
    const fullSupportWeights = {
      A1: 1,
      A2: 0.18,
      B1: 0.05,
      B2: 0.02,
      C: 0.01,
    };
    const supportedWeight = fullSupportWeights[String(cefr).toUpperCase()] ?? 0.05;
    return 1 - support + support * supportedWeight;
  }

  function getQuestionSkill(mode) {
    if (mode === "cloze" || mode === "typed-cloze") return "context";
    if (mode === "reverse" || mode === "typed-reverse") return "production";
    if (mode === "listening" || mode === "typed-listening") return "listening";
    if (mode === "synonym") return "semantic";
    return "recognition";
  }

  function shouldIntroduceUnseenWord({
    hasMemory = false,
    alreadyIntroduced = false,
    placementCalibrationEnabled = false,
    queueName = "new",
    isPlacementRound = false,
  } = {}) {
    if (hasMemory || alreadyIntroduced || placementCalibrationEnabled) {
      return false;
    }
    return queueName === "new" || isPlacementRound;
  }

  function getInitialRetrievalAvailableTurn(
    introducedTurn,
    gapTurns = INITIAL_RETRIEVAL_GAP_TURNS,
  ) {
    const turn = Math.max(0, Math.floor(Number(introducedTurn) || 0));
    const gap = Math.max(0, Math.floor(Number(gapTurns) || 0));
    return turn + gap;
  }

  function getInitialRetrievalIndex(
    entries,
    currentTurn,
    {
      maxPending = MAX_PENDING_INITIAL_RETRIEVALS,
      forceAtRoundTail = false,
      isExcluded = () => false,
    } = {},
  ) {
    if (!Array.isArray(entries) || entries.length === 0) return -1;
    const turn = Math.max(0, Math.floor(Number(currentTurn) || 0));
    const readyIndex = entries.findIndex(
      (entry) =>
        !isExcluded(entry) &&
        turn >= Math.max(0, Number(entry?.availableAfterTurn) || 0),
    );
    if (readyIndex >= 0) return readyIndex;
    if (!forceAtRoundTail && entries.length < Math.max(1, maxPending)) {
      return -1;
    }
    return entries.findIndex((entry) => !isExcluded(entry));
  }

  // A learner-level prior should not replace retrieval evidence. It can,
  // however, keep a highly advanced learner from walking through the same
  // one-day learning steps for a very elementary word they almost certainly
  // already knew. The first clean retrieval earns only a modest head start;
  // one delayed clean confirmation is required before the long interval.
  function getAbilityFastTrackSchedule({
    ability,
    wordDifficulty,
    predictedSuccess,
    mode = "forward",
    record = null,
    queueName = "new",
    isApproaching = false,
    wasCorrect = false,
    evidenceWeight = 1,
    nearMiss = false,
    possiblyGuessed = false,
    wasScaffolded = false,
    placementCalibrationEnabled = false,
    credit = true,
  } = {}) {
    const none = {
      initialStabilityDays: null,
      minimumStabilityDays: null,
      fastTrackConfidence: 0,
    };
    if (
      !wasCorrect ||
      !credit ||
      placementCalibrationEnabled ||
      nearMiss ||
      possiblyGuessed ||
      wasScaffolded ||
      !(Number(evidenceWeight) >= FAST_TRACK_MIN_EVIDENCE_WEIGHT)
    ) {
      return none;
    }

    const typed = String(mode).startsWith("typed-");
    const storedConfidence = clamp(
      Number(record?.fastTrackConfidence) || 0,
      0,
      1,
    );
    const isCleanDelayedConfirmation = Boolean(
      record &&
        storedConfidence > 0 &&
        record.state === "learning" &&
        Number(record.repetitions) === 1 &&
        Number(record.successes) === 1 &&
        Number(record.lapses) === 0 &&
        (queueName === "due" || isApproaching),
    );
    if (isCleanDelayedConfirmation) {
      const maximumFloor = typed ? 30 : 21;
      return {
        initialStabilityDays: null,
        minimumStabilityDays:
          7 + (maximumFloor - 7) * storedConfidence,
        fastTrackConfidence: 0,
      };
    }

    if (record || queueName !== "new") return none;
    const abilityAdvantage = Number(ability) - Number(wordDifficulty);
    const prediction = Number(predictedSuccess);
    if (
      !Number.isFinite(abilityAdvantage) ||
      !Number.isFinite(prediction) ||
      abilityAdvantage <= FAST_TRACK_MIN_ABILITY_ADVANTAGE ||
      prediction <= FAST_TRACK_MIN_PREDICTED_SUCCESS
    ) {
      return none;
    }

    const abilityConfidence = smoothstep(
      (abilityAdvantage - FAST_TRACK_MIN_ABILITY_ADVANTAGE) /
        (FAST_TRACK_FULL_ABILITY_ADVANTAGE -
          FAST_TRACK_MIN_ABILITY_ADVANTAGE),
    );
    const predictionConfidence = smoothstep(
      (prediction - FAST_TRACK_MIN_PREDICTED_SUCCESS) /
        (FAST_TRACK_FULL_PREDICTED_SUCCESS -
          FAST_TRACK_MIN_PREDICTED_SUCCESS),
    );
    const confidence = Math.min(abilityConfidence, predictionConfidence);
    if (!(confidence > 0)) return none;

    const maximumInitialStability = typed ? 7 : 3;
    return {
      initialStabilityDays:
        1 + (maximumInitialStability - 1) * confidence,
      minimumStabilityDays: null,
      fastTrackConfidence: confidence,
    };
  }

  function normalizePredictorState(
    value,
    {
      version = 1,
      modeBiases = DEFAULT_MODE_BIASES,
      calibrationLimit = 1.5,
    } = {},
  ) {
    const normalizeCalibration = (stored) => ({
      attempts: Math.max(0, Math.floor(Number(stored?.attempts) || 0)),
      bias: clamp(
        Number(stored?.bias) || 0,
        -calibrationLimit,
        calibrationLimit,
      ),
      averageResponseMs:
        Number.isFinite(stored?.averageResponseMs) &&
        stored.averageResponseMs > 0
          ? stored.averageResponseMs
          : null,
      exactCorrect: Math.max(
        0,
        Math.floor(Number(stored?.exactCorrect) || 0),
      ),
      nearMisses: Math.max(0, Math.floor(Number(stored?.nearMisses) || 0)),
      misses: Math.max(0, Math.floor(Number(stored?.misses) || 0)),
      possibleGuesses: Math.max(
        0,
        Math.floor(Number(stored?.possibleGuesses) || 0),
      ),
    });
    const modes = {};
    for (const mode of Object.keys(modeBiases)) {
      modes[mode] = normalizeCalibration(value?.modes?.[mode]);
    }
    const skills = {};
    for (const skill of DEFAULT_SKILLS) {
      skills[skill] = normalizeCalibration(value?.skills?.[skill]);
    }
    return { version, modes, skills };
  }

  function getCalibrationEvidenceBias(state, mode) {
    if (!state) return 0;
    const targetResponseMs = RESPONSE_TIME_TARGET_MS[mode] ?? 6500;
    const responsePenalty = Number.isFinite(state.averageResponseMs)
      ? clamp(
          Math.log(state.averageResponseMs / targetResponseMs) * 0.18,
          0,
          0.25,
        )
      : 0;
    const gradedAttempts =
      (state.exactCorrect || 0) +
      (state.nearMisses || 0) +
      (state.misses || 0);
    const nearMissPenalty =
      gradedAttempts > 0 ? 0.15 * (state.nearMisses / gradedAttempts) : 0;
    const guessPenalty =
      gradedAttempts > 0
        ? 0.1 * ((state.possibleGuesses || 0) / gradedAttempts)
        : 0;
    return -(responsePenalty + nearMissPenalty + guessPenalty);
  }

  function getQuestionComplexityBias({
    mode,
    formLength = 0,
    formTokenCount = 1,
    sentenceTokenCount = 0,
    sentenceVocabularySuccess = null,
    targetContextCoverage = null,
    distractorSimilarity = null,
    translationAvailable = false,
    audioAvailable = false,
  }) {
    const isTyped = String(mode).startsWith("typed-");
    const formPenalty = isTyped
      ? clamp(
          Math.max(0, formLength - 7) * 0.025 +
            Math.max(0, formTokenCount - 1) * 0.08,
          0,
          0.35,
        )
      : 0;
    const contextPenalty = String(mode).includes("cloze")
      ? clamp(Math.max(0, sentenceTokenCount - 10) * 0.015, 0, 0.2)
      : 0;
    const isCloze = String(mode).includes("cloze");
    const vocabularyPenalty =
      isCloze && Number.isFinite(sentenceVocabularySuccess)
        ? clamp((0.82 - sentenceVocabularySuccess) * 0.45, 0, 0.2)
        : 0;
    const positionPenalty =
      isCloze && Number.isFinite(targetContextCoverage)
        ? clamp((1 - targetContextCoverage) * 0.1, 0, 0.1)
        : 0;
    const distractorPenalty =
      isCloze && Number.isFinite(distractorSimilarity)
        ? clamp(distractorSimilarity * 0.16, 0, 0.16)
        : 0;
    const cueSupport = isCloze
      ? (translationAvailable ? 0.18 : 0) + (audioAvailable ? 0.08 : 0)
      : 0;
    return (
      cueSupport -
      (formPenalty +
        contextPenalty +
        vocabularyPenalty +
        positionPenalty +
        distractorPenalty)
    );
  }

  function predictSuccess({
    abilityProbability,
    hasPersonalMemory = false,
    retrievability = 0,
    modeBias = 0,
    learnedBias = 0,
    memoryShare = 0.7,
  }) {
    const memoryProbability =
      hasPersonalMemory && Number.isFinite(retrievability)
        ? memoryShare * clampProbability(retrievability) +
          (1 - memoryShare) * abilityProbability
        : abilityProbability;
    return clampProbability(
      logOddsToProbability(
        probabilityToLogOdds(memoryProbability) + modeBias + learnedBias,
      ),
    );
  }

  function getChallengeFit(
    predictedSuccess,
    { targetSuccess = 0.85, sigma = 0.1, floor = 0.1 } = {},
  ) {
    const distance = predictedSuccess - targetSuccess;
    const gaussian = Math.exp(-(distance * distance) / (2 * sigma * sigma));
    return floor + (1 - floor) * gaussian;
  }

  function getProgressionWeight(
    prerequisiteSuccess,
    { floor = 0.15, start = 0.65, full = 0.9 } = {},
  ) {
    const progress = clamp(
      (prerequisiteSuccess - start) / (full - start),
      0,
      1,
    );
    const smoothProgress = progress * progress * (3 - 2 * progress);
    return floor + (1 - floor) * smoothProgress;
  }

  function getSkillUrgencyWeight(overall, skillSnapshot) {
    const hasActiveReview = Boolean(
      overall?.record &&
        (overall.queue === "relearning" ||
          overall.isDue ||
          overall.isApproaching),
    );
    if (!hasActiveReview) return 1;

    const snapshot = skillSnapshot ?? overall;
    const need = clamp(Number(snapshot?.recallNeed) || 0, 0, 1);
    if (snapshot?.queue === "relearning") return 0.65 + 0.35 * need;
    if (snapshot?.isDue || snapshot?.queue === "due") {
      return 0.5 + 0.5 * need;
    }
    if (snapshot?.isApproaching) return 0.25 + 0.5 * need;
    return 0.05;
  }

  function updateCalibrationMode(
    modeState,
    predictedSuccess,
    wasCorrect,
    {
      calibrationLimit = 1.5,
      evidenceWeight = 1,
      outcomeValue = wasCorrect ? 1 : 0,
      responseTimeMs = null,
      nearMiss = false,
      possiblyGuessed = false,
    } = {},
  ) {
    const attempts = Math.max(0, Math.floor(Number(modeState?.attempts) || 0));
    const learningRate = Math.max(0.05, 0.3 / Math.sqrt(1 + attempts / 20));
    const boundedEvidenceWeight = clamp(evidenceWeight, 0.1, 1);
    const previousResponseMs = Number(modeState?.averageResponseMs);
    const nextResponseMs =
      Number.isFinite(responseTimeMs) && responseTimeMs > 0
        ? Number.isFinite(previousResponseMs) && previousResponseMs > 0
          ? previousResponseMs * 0.8 + responseTimeMs * 0.2
          : responseTimeMs
        : Number.isFinite(previousResponseMs) && previousResponseMs > 0
          ? previousResponseMs
          : null;
    return {
      attempts: attempts + 1,
      bias: clamp(
        (Number(modeState?.bias) || 0) +
          learningRate *
            boundedEvidenceWeight *
            (clamp(outcomeValue, 0, 1) - predictedSuccess),
        -calibrationLimit,
        calibrationLimit,
      ),
      averageResponseMs: nextResponseMs,
      exactCorrect:
        Math.max(0, Math.floor(Number(modeState?.exactCorrect) || 0)) +
        (wasCorrect && !nearMiss ? 1 : 0),
      nearMisses:
        Math.max(0, Math.floor(Number(modeState?.nearMisses) || 0)) +
        (nearMiss ? 1 : 0),
      misses:
        Math.max(0, Math.floor(Number(modeState?.misses) || 0)) +
        (wasCorrect ? 0 : 1),
      possibleGuesses:
        Math.max(0, Math.floor(Number(modeState?.possibleGuesses) || 0)) +
        (possiblyGuessed ? 1 : 0),
    };
  }

  function normalizePredictionEvaluationState(value, version = 1) {
    const normalizeAggregate = (stored) => ({
      count: Math.max(0, Math.floor(Number(stored?.count) || 0)),
      predictedSum: Math.max(0, Number(stored?.predictedSum) || 0),
      correctCount: Math.max(0, Number(stored?.correctCount) || 0),
      exactCorrectCount: Math.max(
        0,
        Number(stored?.exactCorrectCount) || 0,
      ),
      nearMissCount: Math.max(0, Number(stored?.nearMissCount) || 0),
      squaredErrorSum: Math.max(
        0,
        Number(stored?.squaredErrorSum) || 0,
      ),
      absoluteErrorSum: Math.max(
        0,
        Number(stored?.absoluteErrorSum) || 0,
      ),
      logLossSum: Math.max(0, Number(stored?.logLossSum) || 0),
    });
    const normalizeGroups = (groups) =>
      Object.fromEntries(
        Object.entries(groups && typeof groups === "object" ? groups : {})
          .filter(([key]) => key)
          .map(([key, aggregate]) => [key, normalizeAggregate(aggregate)]),
      );

    return {
      version,
      total: normalizeAggregate(value?.total),
      modes: normalizeGroups(value?.modes),
      difficultyBuckets: normalizeGroups(value?.difficultyBuckets),
      modeDifficultyBuckets: normalizeGroups(value?.modeDifficultyBuckets),
      predictionBuckets: normalizeGroups(value?.predictionBuckets),
    };
  }

  function recordPredictionEvaluation(
    state,
    {
      mode = "unknown",
      difficultyBucket = "unknown",
      predictedSuccess,
      wasCorrect,
      nearMiss = false,
    },
    version = 1,
  ) {
    const next = normalizePredictionEvaluationState(state, version);
    const prediction = clamp(Number(predictedSuccess) || 0, 0, 1);
    const outcome = wasCorrect ? 1 : 0;
    const error = prediction - outcome;
    const safePrediction = clamp(prediction, 0.001, 0.999);
    const logLoss = -(
      outcome * Math.log(safePrediction) +
      (1 - outcome) * Math.log(1 - safePrediction)
    );
    const probabilityFloor = Math.min(9, Math.floor(prediction * 10)) * 10;
    const predictionBucket = `${probabilityFloor}-${probabilityFloor + 10}%`;
    const safeMode = String(mode || "unknown");
    const safeDifficulty = String(difficultyBucket || "unknown");

    const addObservation = (aggregate) => ({
      count: aggregate.count + 1,
      predictedSum: aggregate.predictedSum + prediction,
      correctCount: aggregate.correctCount + outcome,
      exactCorrectCount:
        aggregate.exactCorrectCount + (wasCorrect && !nearMiss ? 1 : 0),
      nearMissCount: aggregate.nearMissCount + (nearMiss ? 1 : 0),
      squaredErrorSum: aggregate.squaredErrorSum + error * error,
      absoluteErrorSum: aggregate.absoluteErrorSum + Math.abs(error),
      logLossSum: aggregate.logLossSum + logLoss,
    });
    const addToGroup = (groups, key) => {
      const empty = normalizePredictionEvaluationState(null, version).total;
      groups[key] = addObservation(groups[key] || empty);
    };

    next.total = addObservation(next.total);
    addToGroup(next.modes, safeMode);
    addToGroup(next.difficultyBuckets, safeDifficulty);
    addToGroup(
      next.modeDifficultyBuckets,
      `${safeMode}::${safeDifficulty}`,
    );
    addToGroup(next.predictionBuckets, predictionBucket);
    return next;
  }

  function getPredictionEvaluationReport(state, version = 1) {
    const normalized = normalizePredictionEvaluationState(state, version);
    const summarize = (aggregate) => {
      const count = aggregate?.count || 0;
      if (!count) {
        return {
          count: 0,
          meanPredicted: null,
          observedAccuracy: null,
          exactAccuracy: null,
          calibrationGap: null,
          absoluteCalibrationError: null,
          brierScore: null,
          meanAbsoluteError: null,
          logLoss: null,
          nearMissRate: null,
        };
      }
      const meanPredicted = aggregate.predictedSum / count;
      const observedAccuracy = aggregate.correctCount / count;
      const calibrationGap = meanPredicted - observedAccuracy;
      return {
        count,
        meanPredicted,
        observedAccuracy,
        exactAccuracy: aggregate.exactCorrectCount / count,
        calibrationGap,
        absoluteCalibrationError: Math.abs(calibrationGap),
        brierScore: aggregate.squaredErrorSum / count,
        meanAbsoluteError: aggregate.absoluteErrorSum / count,
        logLoss: aggregate.logLossSum / count,
        nearMissRate: aggregate.nearMissCount / count,
      };
    };
    const summarizeGroups = (groups) =>
      Object.fromEntries(
        Object.entries(groups).map(([key, aggregate]) => [
          key,
          summarize(aggregate),
        ]),
      );
    const predictionBuckets = summarizeGroups(normalized.predictionBuckets);
    const totalCount = normalized.total.count;
    const expectedCalibrationError = totalCount
      ? Object.values(predictionBuckets).reduce(
          (sum, bucket) =>
            sum +
            (bucket.count / totalCount) * bucket.absoluteCalibrationError,
          0,
        )
      : null;
    const byModeAndDifficulty = {};
    for (const [key, aggregate] of Object.entries(
      normalized.modeDifficultyBuckets,
    )) {
      const separator = key.indexOf("::");
      const mode = separator >= 0 ? key.slice(0, separator) : "unknown";
      const difficulty = separator >= 0 ? key.slice(separator + 2) : key;
      byModeAndDifficulty[mode] ||= {};
      byModeAndDifficulty[mode][difficulty] = summarize(aggregate);
    }

    return {
      version,
      overall: {
        ...summarize(normalized.total),
        expectedCalibrationError,
      },
      byMode: summarizeGroups(normalized.modes),
      byDifficulty: summarizeGroups(normalized.difficultyBuckets),
      byModeAndDifficulty,
      byPredictedProbability: predictionBuckets,
    };
  }

  function getRecoveryPlan({
    failedMode,
    predictedSuccess,
    responseTimeMs = null,
    reviewAttempts = 1,
    baseGap = 4,
  }) {
    const typed = String(failedMode).startsWith("typed-");
    const untypedMode = typed
      ? String(failedMode).slice("typed-".length)
      : failedMode;
    const veryLow = predictedSuccess < 0.55;
    const needsScaffold =
      failedMode !== "forward" &&
      (veryLow || (typed && predictedSuccess < 0.78));
    const scaffoldMode = needsScaffold
      ? typed && !veryLow
        ? untypedMode
        : "forward"
      : failedMode;
    const slowTarget = RESPONSE_TIME_TARGET_MS[failedMode] ?? 6500;
    const slowAdjustment =
      Number.isFinite(responseTimeMs) && responseTimeMs > slowTarget * 1.5
        ? -1
        : 0;
    const repeatPenalty = Math.min(2, Math.max(0, reviewAttempts - 1));
    const initialGap = clamp(
      Math.round(
        baseGap *
          (veryLow ? 0.5 : predictedSuccess < 0.78 ? 0.65 : 0.5),
      ) +
        slowAdjustment +
        repeatPenalty,
      2,
      8,
    );
    return {
      originalMode: failedMode,
      nextMode: scaffoldMode,
      requiresOriginalSuccess: scaffoldMode !== failedMode,
      initialGap,
      originalRetryGap: clamp(baseGap + 2 + slowAdjustment, 4, 8),
    };
  }

  function shouldUseVariedContext(snapshot, minimumSuccesses = CONTEXT_VARIATION_MIN_SUCCESSES) {
    const successes = Math.max(
      0,
      Number(
        snapshot?.record?.successEvidence ?? snapshot?.record?.successes,
      ) || 0,
    );
    return successes >= Math.max(1, Number(minimumSuccesses) || 1);
  }

  function getVariedContextIndex(
    snapshot,
    candidateCount,
    minimumSuccesses = CONTEXT_VARIATION_MIN_SUCCESSES,
  ) {
    const count = Math.max(0, Math.floor(Number(candidateCount) || 0));
    if (!count || !shouldUseVariedContext(snapshot, minimumSuccesses)) return -1;
    const successes = Math.max(
      0,
      Number(
        snapshot?.record?.successEvidence ?? snapshot?.record?.successes,
      ) || 0,
    );
    return Math.floor(successes - minimumSuccesses) % count;
  }

  function getSrsEvidenceWeight({
    wasCorrect,
    predictedSuccess = 0.5,
    responseTimeMs = null,
    responseTimeTargetMs = 6500,
    nearMiss = false,
    possiblyGuessed = false,
    wasScaffolded = false,
  } = {}) {
    const prediction = clamp(Number(predictedSuccess) || 0.5, 0, 1);
    if (!wasCorrect) {
      // Missing something the model already expected the learner to know is
      // stronger lapse evidence than missing a deliberately difficult item.
      // A near miss (right word, wrong grammatical form, or a typo close
      // enough to almost pass) is weaker lapse evidence than missing it
      // outright, so it still softens this weight even though it lands on
      // the incorrect path. possiblyGuessed/wasScaffolded/responseTimeMs are
      // deliberately left out here: a guessed or scaffolded miss is not
      // weaker evidence of not knowing the word — if anything it's stronger.
      let missWeight = clamp(0.55 + 0.5 * prediction, 0.55, 1);
      if (nearMiss) missWeight *= 0.85;
      return clamp(missWeight, 0.3, 1);
    }

    let weight = 0.9 + 0.2 * (1 - prediction);
    if (nearMiss) weight *= 0.7;
    // A sub-second multiple-choice answer might be a guess, but it can also
    // be fluent recognition. Discount it substantially without treating it
    // as near-zero evidence.
    if (possiblyGuessed) weight *= 0.55;
    if (wasScaffolded) weight *= 0.65;
    if (
      Number.isFinite(responseTimeMs) &&
      responseTimeMs > responseTimeTargetMs * 2.5
    ) {
      weight *= 0.65;
    } else if (
      Number.isFinite(responseTimeMs) &&
      responseTimeMs > responseTimeTargetMs * 1.5
    ) {
      weight *= 0.8;
    }
    return clamp(weight, 0.2, 1);
  }

  function getReviewPortfolioShare(
    dueCount,
    { minimum = 0.6, maximum = 0.85 } = {},
  ) {
    const backlog = Math.max(0, Number(dueCount) || 0);
    if (backlog === 0) return 0;
    return clamp(
      minimum + 0.05 * Math.log2(1 + backlog / 10),
      minimum,
      maximum,
    );
  }

  function shouldPrioritizeReview({ share, questionCount, reviewCount }) {
    if (!(share > 0)) return false;
    const targetReviewCount = Math.floor((questionCount + 1) * share);
    return reviewCount < targetReviewCount;
  }

  function getTypedRecallProbability(
    predictedSuccess,
    readiness,
    { isRelearning = false, isChronicallyStruggling = false } = {},
  ) {
    if (!readiness || isRelearning || isChronicallyStruggling) return 0;
    const readinessProgress = clamp(
      (predictedSuccess - readiness.start) /
        (readiness.full - readiness.start),
      0,
      1,
    );
    return readiness.maximum * readinessProgress;
  }

  function buildQuestionPairPlan(
    candidates,
    {
      predict,
      challengeFit = getChallengeFit,
      progressionWeight,
      urgencyWeight,
    },
  ) {
    const plannedCandidates = candidates.map((candidate) => {
      const predictedSuccess = predict(candidate.mode);
      return {
        ...candidate,
        predictedSuccess,
        pairWeight:
          candidate.weight *
          challengeFit(predictedSuccess) *
          progressionWeight(candidate.mode) *
          urgencyWeight(candidate.mode),
      };
    });
    const totalPairWeight = plannedCandidates.reduce(
      (sum, candidate) => sum + candidate.pairWeight,
      0,
    );
    return {
      candidates: plannedCandidates,
      totalPairWeight: totalPairWeight > 0 ? totalPairWeight : 1,
    };
  }

  function getAbilityProximity(distance, sigma) {
    return Math.exp(-(distance * distance) / (2 * sigma * sigma));
  }

  function getUsefulnessWeight(frequencyValue, maximumBoost = 0.7) {
    if (!Number.isFinite(frequencyValue)) return 1;
    return 1 + maximumBoost * clamp(frequencyValue, 0, 1);
  }

  function getMemoryWeight(
    { strength = 0, recallNeed = 0, useRecallNeed = false },
    {
      strengthCeiling = 6,
      strengthExponent = 2,
      recallNeedExponent = 1.5,
      recallNeedFloor = 0.02,
    } = {},
  ) {
    return useRecallNeed
      ? Math.pow(Math.max(recallNeedFloor, recallNeed), recallNeedExponent)
      : Math.pow(strengthCeiling - strength, strengthExponent);
  }

  function getWordWeight({
    memoryWeight,
    abilityWeight = 1,
    usefulnessWeight = 1,
  }) {
    return memoryWeight * abilityWeight * usefulnessWeight;
  }

  function getWeightedIndex(weights, randomValue = Math.random()) {
    if (!Array.isArray(weights) || weights.length === 0) return -1;
    const totalWeight = weights.reduce(
      (sum, weight) => sum + Math.max(0, Number(weight) || 0),
      0,
    );
    if (!(totalWeight > 0)) return weights.length - 1;

    let target = clamp(randomValue, 0, 1) * totalWeight;
    for (let index = 0; index < weights.length; index++) {
      target -= Math.max(0, Number(weights[index]) || 0);
      if (target < 0) return index;
    }
    return weights.length - 1;
  }

  function buildQueues(entries, getQueue) {
    const queues = Object.fromEntries(
      DEFAULT_QUEUE_PRIORITY.map((queue) => [queue, []]),
    );
    for (const entry of entries) {
      const queue = getQueue(entry);
      queues[queue]?.push(entry);
    }
    return queues;
  }

  function getNextQueueName(queues) {
    return DEFAULT_QUEUE_PRIORITY.find(
      (queueName) => queues[queueName]?.length > 0,
    );
  }

  function getCoreCandidatePool(
    entries,
    {
      frequencyDataAvailable,
      hasFrequency,
      getDifficulty,
      ability,
      getProximity,
      minimumProximity,
    },
  ) {
    if (!frequencyDataAvailable || entries.length === 0) return entries;
    const coreEntries = entries.filter(hasFrequency);
    if (coreEntries.length === 0) return entries;
    const suitablyChallenging = coreEntries.filter(
      (entry) =>
        getDifficulty(entry) >= ability ||
        getProximity(entry) >= minimumProximity,
    );
    return suitablyChallenging.length > 0 ? suitablyChallenging : entries;
  }

  function shouldPrioritizeQuota({ share, questionCount, savedCount }) {
    if (!(share > 0)) return false;
    const targetSavedCount = Math.floor((questionCount + 1) * share);
    return savedCount < targetSavedCount;
  }

  window.WordGamePolicy = Object.freeze({
    DEFAULT_MODE_BIASES,
    DEFAULT_MODE_PREREQUISITES,
    DEFAULT_SKILLS,
    RESPONSE_TIME_TARGET_MS,
    CONTEXT_VARIATION_MIN_SUCCESSES,
    INITIAL_RETRIEVAL_GAP_TURNS,
    MAX_PENDING_INITIAL_RETRIEVALS,
    DEFAULT_QUEUE_PRIORITY,
    clamp,
    clampProbability,
    getDefinitionSynonymSegments,
    isDefinitionSynonymList,
    getExpectedSuccessProbability,
    getExerciseAdjustedSuccessProbability,
    getAbilityAfterAnswer,
    smoothstep,
    getA0SupportIntensity,
    getA0ReinforcementShare,
    getA0FrequencyWeight,
    getA0CefrWeight,
    getQuestionSkill,
    shouldIntroduceUnseenWord,
    getInitialRetrievalAvailableTurn,
    getInitialRetrievalIndex,
    getAbilityFastTrackSchedule,
    normalizePredictorState,
    getCalibrationEvidenceBias,
    getQuestionComplexityBias,
    predictSuccess,
    getChallengeFit,
    getProgressionWeight,
    getSkillUrgencyWeight,
    updateCalibrationMode,
    normalizePredictionEvaluationState,
    recordPredictionEvaluation,
    getPredictionEvaluationReport,
    getRecoveryPlan,
    shouldUseVariedContext,
    getVariedContextIndex,
    getSrsEvidenceWeight,
    getReviewPortfolioShare,
    shouldPrioritizeReview,
    getTypedRecallProbability,
    buildQuestionPairPlan,
    getAbilityProximity,
    getUsefulnessWeight,
    getMemoryWeight,
    getWordWeight,
    getWeightedIndex,
    buildQueues,
    getNextQueueName,
    getCoreCandidatePool,
    shouldPrioritizeQuota,
  });
})();
