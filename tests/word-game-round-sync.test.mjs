import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadWordGamePolicy } from "./load-word-game-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const savedOptions = [];
const context = vm.createContext({ Math });
context.window = context;
loadWordGamePolicy(root, context);

vm.runInContext(
  `
    let abilityScore = 500;
    const ABILITY_MIN = 0;
    const ABILITY_MAX = 1000;
    const ABILITY_K_FACTOR = 24;
    const ABILITY_LOGISTIC_SCALE = 180;
    function clampAbility(value) { return Math.max(0, Math.min(1000, value)); }
    function getWordDifficultyAnchor() { return 500; }
    function saveAbilityState(options) { savedOptions.push(options); }
  `,
  Object.assign(context, { savedOptions }),
);

const abilityStart = source.indexOf("function getExpectedSuccessProbability");
const abilityEnd = source.indexOf("function toggleGameEnglish", abilityStart);
vm.runInContext(source.slice(abilityStart, abilityEnd), context);
context.updateAbilityScore({}, true);
assert.deepEqual(JSON.parse(JSON.stringify(savedOptions[0])), {
  syncRemote: false,
  cloudPending: true,
});

vm.runInContext("abilityScore = 500", context);
context.updateAbilityScore({}, false, "forward", 0);
const afterRecognitionMiss = vm.runInContext("abilityScore", context);
vm.runInContext("abilityScore = 500", context);
context.updateAbilityScore({}, false, "typed-reverse", 0);
const afterTypedProductionMiss = vm.runInContext("abilityScore", context);
assert.ok(afterTypedProductionMiss > afterRecognitionMiss);

const summaryStart = source.indexOf("function settleWordGameRoundOutcome");
const summaryEnd = source.indexOf("async function startWordGame", summaryStart);
const summarySource = source.slice(summaryStart, summaryEnd);
assert.match(summarySource, /saveAbilityState\(\);/);
assert.match(summarySource, /CustomEvent\("progress:round-complete"\)/);

const answerStart = source.indexOf("async function handleTranslationClick");
const answerEnd = source.indexOf("function enableGameControls", answerStart);
const answerSource = source.slice(answerStart, answerEnd);
assert.match(answerSource, /deferRemote: true/);
assert.match(answerSource, /const answerMode =/);
assert.match(answerSource, /learnedExerciseBiasBeforeAnswer/);

console.log("word-game round sync tests passed");
