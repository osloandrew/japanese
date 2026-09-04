import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");

function slice(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return { text: source.slice(start, end), end };
}

function createContext() {
  const context = vm.createContext({
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    Set,
    String,
    Array,
    JSON,
    RegExp,
  });
  context.window = context;
  // getCefrLabel normally comes from scripts.js (loaded before wordGame.js
  // in index.html) — stubbed here rather than pulling in that whole file.
  context.getCefrLabel = (level) =>
    ({
      A1: "Beginner",
      A2: "Elementary",
      B1: "Intermediate",
      B2: "Upper-Intermediate",
      C: "Advanced",
    })[level] || level;
  return context;
}

function loadCefrAndVocabHelpers(context) {
  const anchor = slice(
    "const CEFR_LEVEL_ORDER",
    "// How quickly ability-based selection weight falls off",
  );
  vm.runInContext(anchor.text, context, { filename: "wordGame.js#cefr-anchor" });

  const cefrLabel = slice(
    "function getWordCefrLabel",
    "// How far a per-word frequency-based nudge",
  );
  vm.runInContext(cefrLabel.text, context, { filename: "wordGame.js#getWordCefrLabel" });

  const summaries = slice(
    "const CEFR_LEVEL_MIN_SAMPLE",
    "function renderLandingProgressSummary",
  );
  vm.runInContext(summaries.text, context, { filename: "wordGame.js#my-stats-summaries" });
}

// --- getVocabularyByCefrSummary -------------------------------------------

test("getVocabularyByCefrSummary: a band is reached once 5+ words are attempted and half are known", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  const entries = {};
  const records = {};
  // A word is "known" at >= 3 repetitions and >= 80% accuracy — same
  // accuracy definition as Lifetime Accuracy, deliberately not the
  // scheduler's strength/maturity score (see the CEFR_WORD_KNOWN_* comment
  // in wordGame.js). 5 A1 words: 3 known (well past both thresholds), 2 not
  // (one under-repeated, one under-accurate) — 60%, above the 50% band
  // threshold.
  const a1Fixtures = [
    { repetitions: 5, successes: 5 }, // known
    { repetitions: 4, successes: 4 }, // known
    { repetitions: 10, successes: 9 }, // known (90%)
    { repetitions: 2, successes: 2 }, // not known: under the rep floor
    { repetitions: 5, successes: 2 }, // not known: under the accuracy floor
  ];
  a1Fixtures.forEach((fixture, index) => {
    const id = `a1-${index}`;
    entries[id] = { CEFR: "A1" };
    records[id] = { skills: { recognition: fixture } };
  });

  context.window.WordListAPI = { getEntryById: (id) => entries[id] ?? null };
  context.window.WordStrengthAPI = { getAll: () => records };

  const summary = context.getVocabularyByCefrSummary();
  const a1 = summary.bands.find((band) => band.level === "A1");

  assert.equal(a1.attempted, 5);
  assert.equal(a1.known, 3);
  assert.equal(a1.reached, true);
  assert.equal(summary.estimatedLevel.level, "A1");
});

test("getVocabularyByCefrSummary: fewer than 5 attempted words never reaches the band", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  const entries = { w0: { CEFR: "A1" }, w1: { CEFR: "A1" } };
  const records = {
    w0: { skills: { recognition: { repetitions: 10, successes: 10 } } },
    w1: { skills: { recognition: { repetitions: 10, successes: 10 } } },
  };

  context.window.WordListAPI = { getEntryById: (id) => entries[id] ?? null };
  context.window.WordStrengthAPI = { getAll: () => records };

  const summary = context.getVocabularyByCefrSummary();
  assert.equal(summary.estimatedLevel, null);
});

test("getVocabularyByCefrSummary: accuracy is summed across every skill a word has been tested in", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  // 5 correct on recognition + 1 wrong on semantic: 5/6 = 83%, still counts
  // as known — a rarely-tested skill shouldn't by itself sink a word that's
  // otherwise well known.
  const entries = { w0: { CEFR: "A1" } };
  const records = {
    w0: {
      skills: {
        recognition: { repetitions: 5, successes: 5 },
        semantic: { repetitions: 1, successes: 0 },
      },
    },
  };

  context.window.WordListAPI = { getEntryById: (id) => entries[id] ?? null };
  context.window.WordStrengthAPI = { getAll: () => records };

  const summary = context.getVocabularyByCefrSummary();
  const a1 = summary.bands.find((band) => band.level === "A1");
  assert.equal(a1.known, 1);
});

test("getVocabularyByCefrSummary: estimatedLevel is the highest reached band, not necessarily contiguous from A1", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  const entries = {};
  const records = {};
  // No A1 words at all (a learner who placed straight into B1 material),
  // but B1 is solidly reached, and B2 has partial (but not threshold)
  // progress.
  for (let i = 0; i < 6; i++) {
    entries[`b1-${i}`] = { CEFR: "B1" };
    records[`b1-${i}`] = { skills: { recognition: { repetitions: 5, successes: 5 } } };
  }
  for (let i = 0; i < 6; i++) {
    entries[`b2-${i}`] = { CEFR: "B2" };
    // 1 of 6 known: above the approaching floor (0.15), below the reached
    // threshold (0.5).
    records[`b2-${i}`] = {
      skills: {
        recognition: { repetitions: 5, successes: i === 0 ? 5 : 1 },
      },
    };
  }

  context.window.WordListAPI = { getEntryById: (id) => entries[id] ?? null };
  context.window.WordStrengthAPI = { getAll: () => records };

  const summary = context.getVocabularyByCefrSummary();
  assert.equal(summary.estimatedLevel.level, "B1");
  assert.equal(summary.nextLevel.level, "B2");
});

test("getVocabularyByCefrSummary: no practiced words at all yields no estimate", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  context.window.WordListAPI = { getEntryById: () => null };
  context.window.WordStrengthAPI = { getAll: () => ({}) };

  const summary = context.getVocabularyByCefrSummary();
  assert.equal(summary.estimatedLevel, null);
  assert.equal(summary.nextLevel, null);
  assert.equal(summary.bands.every((band) => band.attempted === 0), true);
});

// --- getSkillsBreakdownSummary ---------------------------------------------

test("getSkillsBreakdownSummary: accuracy (successes/repetitions) only across words that practiced that skill", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  const records = {
    w0: {
      skills: {
        recognition: { repetitions: 5, successes: 5 },
        production: { repetitions: 4, successes: 1 },
      },
    },
    w1: { skills: { recognition: { repetitions: 5, successes: 3 } } },
  };

  context.window.WordStrengthAPI = { getAll: () => records };
  context.window.SpacedRepetition = {
    SKILL_IDS: ["recognition", "production", "listening", "context", "semantic"],
  };

  const breakdown = context.getSkillsBreakdownSummary();
  const recognition = breakdown.find((s) => s.skill === "recognition");
  const production = breakdown.find((s) => s.skill === "production");
  const listening = breakdown.find((s) => s.skill === "listening");

  assert.equal(recognition.practicedCount, 2);
  assert.equal(recognition.avgPercent, Math.round(((5 + 3) / (5 + 5)) * 100));
  assert.equal(production.practicedCount, 1);
  assert.equal(production.avgPercent, Math.round((1 / 4) * 100));
  assert.equal(listening.practicedCount, 0);
  assert.equal(listening.avgPercent, 0);
});

test("getSkillsBreakdownSummary: a lopsidedly-rare skill can still show high accuracy", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  // Only 1-2 synonym reps per word (realistic — synonym questions are a
  // small quota of total questions), but every one of them was correct.
  const records = {
    w0: { skills: { semantic: { repetitions: 1, successes: 1 } } },
    w1: { skills: { semantic: { repetitions: 2, successes: 2 } } },
  };

  context.window.WordStrengthAPI = { getAll: () => records };
  context.window.SpacedRepetition = {
    SKILL_IDS: ["recognition", "production", "listening", "context", "semantic"],
  };

  const breakdown = context.getSkillsBreakdownSummary();
  const semantic = breakdown.find((s) => s.skill === "semantic");
  assert.equal(semantic.avgPercent, 100);
});

// --- getLifetimeTotalsSummary ----------------------------------------------

test("getLifetimeTotalsSummary: sums repetitions/successes across every skill of every word", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  const records = {
    w0: {
      skills: {
        recognition: { repetitions: 4, successes: 3 },
        production: { repetitions: 2, successes: 1 },
      },
    },
    w1: { skills: { recognition: { repetitions: 1, successes: 0 } } },
  };

  context.window.WordStrengthAPI = { getAll: () => records };

  const totals = context.getLifetimeTotalsSummary();
  assert.equal(totals.questionsAnswered, 7);
  assert.equal(totals.correctAnswers, 4);
  assert.equal(totals.accuracyPercent, Math.round((4 / 7) * 100));
});

test("getLifetimeTotalsSummary: no records at all yields zeros, not NaN", () => {
  const context = createContext();
  loadCefrAndVocabHelpers(context);

  context.window.WordStrengthAPI = { getAll: () => ({}) };

  const totals = context.getLifetimeTotalsSummary();
  // Spread into a plain object literal here (this realm, not the vm's) —
  // deepStrictEqual across realms fails on prototype identity alone even
  // when the data is identical.
  assert.deepEqual(
    { ...totals },
    { questionsAnswered: 0, correctAnswers: 0, accuracyPercent: 0 },
  );
});

// --- practice-activity log --------------------------------------------------

function loadActivityLogHelpers(context) {
  const activity = slice(
    "const PRACTICE_ACTIVITY_STORAGE_KEY",
    "// Longest run of consecutive correct answers ever reached",
  );
  vm.runInContext(activity.text, context, { filename: "wordGame.js#practice-activity" });
}

function createLocalStorageStub() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    _store: store,
  };
}

test("recordPracticeActivityForToday: increments today's count on repeated calls", () => {
  const context = createContext();
  loadActivityLogHelpers(context);
  context.window.localStorage = createLocalStorageStub();

  context.recordPracticeActivityForToday();
  context.recordPracticeActivityForToday();
  context.recordPracticeActivityForToday();

  const log = context.loadPracticeActivityLog();
  const todayKey = context.getDailyPracticeDateKey();
  assert.equal(log[todayKey], 3);
});

test("savePracticeActivityLog: prunes entries older than PRACTICE_ACTIVITY_MAX_DAYS", () => {
  const context = createContext();
  loadActivityLogHelpers(context);
  context.window.localStorage = createLocalStorageStub();

  const todayKey = context.getDailyPracticeDateKey();
  const saved = context.savePracticeActivityLog({
    "2000-01-01": 5,
    [todayKey]: 2,
  });

  assert.equal(saved["2000-01-01"], undefined);
  assert.equal(saved[todayKey], 2);

  const reloaded = context.loadPracticeActivityLog();
  assert.equal(reloaded["2000-01-01"], undefined);
  assert.equal(reloaded[todayKey], 2);
});

test("loadPracticeActivityLog: ignores malformed stored data instead of throwing", () => {
  const context = createContext();
  loadActivityLogHelpers(context);
  context.window.localStorage = createLocalStorageStub();
  context.window.localStorage.setItem(
    "japanese-dictionary-practice-activity-v1",
    JSON.stringify({ "not-a-date": 5, "2026-01-01": "not-a-number", "2026-01-02": 3 }),
  );

  const log = context.loadPracticeActivityLog();
  assert.deepEqual({ ...log }, { "2026-01-02": 3 });
});
