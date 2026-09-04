import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameSource = fs.readFileSync(path.join(root, "wordGame.js"), "utf8");
const wordListSource = fs.readFileSync(path.join(root, "wordList.js"), "utf8");

assert.match(
  gameSource,
  /const abilityFastTrack =\s*window\.WordGamePolicy\.getAbilityFastTrackSchedule/,
);
assert.match(
  gameSource,
  /placementCalibrationEnabled: wordGamePlacementCalibrationEnabled/,
);
assert.match(gameSource, /credit: srsCredit/);
assert.match(
  gameSource,
  /initialStabilityDays: abilityFastTrack\.initialStabilityDays/,
);
assert.match(
  gameSource,
  /minimumStabilityDays: abilityFastTrack\.minimumStabilityDays/,
);
assert.match(
  gameSource,
  /fastTrackConfidence: abilityFastTrack\.fastTrackConfidence/,
);

for (const option of [
  "initialStabilityDays",
  "minimumStabilityDays",
  "fastTrackConfidence",
]) {
  assert.match(wordListSource, new RegExp(`${option}: options\\.${option}`));
}

console.log("word-game ability fast-track checks passed");
