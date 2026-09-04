import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const context = vm.createContext({ Math, Object });
context.window = context;

const runSection = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  vm.runInContext(source.slice(start, end), context, {
    filename: "wordGame.js",
  });
};

// CEFR_LEVEL_ORDER + CEFR_DIFFICULTY_ANCHOR, stopping well before the first
// statement that calls a function ("loadAbilityState") not included in this
// slice.
runSection("const CEFR_LEVEL_ORDER", "let abilityState");
// interpolateByAbility, the two ability-scaled probability tables, and the
// selection registry itself (selectQuestionMode is the thing under test).
runSection("function interpolateByAbility", "let previousWord");

// --- Deterministic cases: a structured round names its mode directly ----

for (const [structuredQuestionMode, expected] of [
  ["forward", "forward"],
  ["cloze", "cloze"],
  ["listening", "listening"],
  ["reverse", "reverse"],
]) {
  for (let i = 0; i < 200; i++) {
    assert.equal(
      context.selectQuestionMode({
        structuredQuestionMode,
        ability: 500,
        hasAudio: true,
      }),
      expected,
      `structuredQuestionMode "${structuredQuestionMode}" should always yield "${expected}"`,
    );
  }
}

// A requested listening slot must fall through to a non-audio mode when the
// selected word has no playable recording.
assert.equal(
  context.selectQuestionMode({
    structuredQuestionMode: "listening",
    ability: 500,
    hasAudio: false,
  }),
  "forward",
);

// A bonus-round "typed-reverse" slot resolves through forceTypedReverse,
// same as the original cascade's `forceTypedReverse ||` clause.
for (let i = 0; i < 200; i++) {
  assert.equal(
    context.selectQuestionMode({
      structuredQuestionMode: "typed-reverse",
      forceTypedReverse: true,
      ability: 500,
      hasAudio: false,
    }),
    "reverse",
  );
}

// --- Free-play distribution: compare against the analytic probabilities
// implied by the original cascade's math (0.5 cloze coin flip; listening
// and reverse each a conditional draw on the remainder). This is the
// verification the refactor promised — confirming the registry reproduces
// the old cascade's odds, not just its deterministic edge cases.
//
// Deliberately independent of the source under test: these tables/anchors
// and this interpolation function are a plain local copy of what
// REVERSE_FLASHCARD_PROBABILITY/LISTENING_PROBABILITY/interpolateByAbility
// in wordGame.js currently define, not a reference back into the vm
// context — a bug in the shared helper itself would go uncaught if this
// oracle called it too. Node's `vm` module also doesn't expose top-level
// `const` bindings as context properties (only functions/`var` do), so
// reading context.LISTENING_PROBABILITY from outside would be undefined
// regardless. If those tables are ever retuned in wordGame.js, update the
// copies below to match. ---------------------------------------------

const REVERSE_FLASHCARD_PROBABILITY_REFERENCE = {
  A1: 0.1,
  A2: 0.2,
  B1: 0.35,
  B2: 0.45,
  C: 0.5,
};
const LISTENING_PROBABILITY_REFERENCE = {
  A1: 0.2,
  A2: 0.25,
  B1: 0.3,
  B2: 0.35,
  C: 0.4,
};
const CEFR_DIFFICULTY_ANCHOR_REFERENCE = {
  A1: 100,
  A2: 300,
  B1: 500,
  B2: 700,
  C: 900,
};
const CEFR_LEVEL_ORDER_REFERENCE = ["A1", "A2", "B1", "B2", "C"];

function interpolateByAbilityReference(score, table) {
  const points = CEFR_LEVEL_ORDER_REFERENCE.map((level) => ({
    x: CEFR_DIFFICULTY_ANCHOR_REFERENCE[level],
    y: table[level],
  }));
  if (score <= points[0].x) return points[0].y;
  if (score >= points[points.length - 1].x) return points[points.length - 1].y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (score >= a.x && score <= b.x) {
      const t = (score - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return points[points.length - 1].y;
}

const N = 40000;
const TOLERANCE = 0.02; // ~6 standard deviations at this N for these p values

for (const ability of [100, 300, 500, 700, 900]) {
  for (const hasAudio of [true, false]) {
    const pListenGivenNotCloze = hasAudio
      ? interpolateByAbilityReference(ability, LISTENING_PROBABILITY_REFERENCE)
      : 0;
    const pReverseGivenRemainder = interpolateByAbilityReference(
      ability,
      REVERSE_FLASHCARD_PROBABILITY_REFERENCE,
    );

    const expected = {
      cloze: 0.5,
      listening: 0.5 * pListenGivenNotCloze,
      reverse: 0.5 * (1 - pListenGivenNotCloze) * pReverseGivenRemainder,
    };
    expected.forward = 1 - expected.cloze - expected.listening - expected.reverse;

    const counts = { cloze: 0, listening: 0, reverse: 0, forward: 0 };
    for (let i = 0; i < N; i++) {
      const mode = context.selectQuestionMode({
        structuredQuestionMode: null,
        ability,
        hasAudio,
      });
      counts[mode]++;
    }

    for (const mode of Object.keys(expected)) {
      const observed = counts[mode] / N;
      assert.ok(
        Math.abs(observed - expected[mode]) < TOLERANCE,
        `ability=${ability} hasAudio=${hasAudio} mode=${mode}: expected ~${expected[mode].toFixed(4)}, observed ${observed.toFixed(4)}`,
      );
    }
  }
}

// --- Instruction text: GAME_MODES[mode].instructionText() replaces the old
// switch in getGameInstructionText() ---------------------------------------

runSection("function getGameInstructionText", "function getGamePromptLengthClass");

for (const [mode, expected] of [
  ["typed-reverse", "Type the Japanese Word"],
  ["typed-cloze", "Type the Word That Completes the Sentence"],
  ["synonym", "Pick the Closest Match"],
  ["reverse", "Choose the Japanese Word"],
  ["listening", "Listen and Choose the Meaning"],
  ["cloze", "Choose the Missing Word"],
  ["forward", "Choose the English Meaning"],
  // Anything unrecognized falls back to the forward-flashcard text, matching
  // the old switch's `default:` case.
  [undefined, "Choose the English Meaning"],
  ["not-a-real-mode", "Choose the English Meaning"],
]) {
  assert.equal(context.getGameInstructionText(mode), expected, `mode "${mode}"`);
}

console.log("word-game mode selection tests passed");
