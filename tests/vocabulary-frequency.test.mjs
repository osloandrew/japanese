import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const payload = JSON.parse(
  await readFile(new URL("../vocabulary-frequency.json", import.meta.url), "utf8"),
);

test("Japanese frequency data is populated from the official BCCWJ source", () => {
  assert.equal(payload.version, 5);
  assert.equal(payload.method, "exact-primary-lemma-match");
  assert.match(payload.sources.bccwj.source, /doi\.org\/10\.15084\/00003214/);
  assert.ok(payload.matchedDictionaryEntries > 8500);

  const person = payload.entries["人|noun"];
  assert.ok(person);
  assert.ok(Number.isFinite(person.rank) && person.rank > 0);
  assert.ok(person.weight > 0 && person.weight <= 1);
  assert.ok(Number.isFinite(person.bandPercentiles.A1));
});
