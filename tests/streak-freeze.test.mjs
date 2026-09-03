import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "streak.js"), "utf8");

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function nextDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

test("a Japanese learner can spend a sapphire on tomorrow's streak freeze", () => {
  const today = localDateKey();
  const writes = new Map();
  const spendCalls = [];
  const initialState = JSON.stringify({
    version: 1,
    streak: {
      count: 7,
      longestCount: 7,
      lastActiveDate: today,
      graceUsed: false,
      freezeDate: null,
    },
  });

  const context = vm.createContext({
    console,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Object,
    String,
  });
  context.window = context;
  context.document = {
    addEventListener() {},
    documentElement: { clientWidth: 1024 },
    getElementById() {
      return null;
    },
  };
  context.localStorage = {
    getItem(key) {
      assert.equal(key, "japanese-dictionary-streak-v1");
      return initialState;
    },
    setItem(key, value) {
      writes.set(key, value);
    },
  };
  context.dispatchEvent = () => {};
  context.addEventListener = () => {};
  context.DailyQuestAPI = {
    getGemBalance: () => 1,
    spendGem(reward, cost) {
      spendCalls.push({ reward, cost });
      return true;
    },
  };

  vm.runInContext(source, context, { filename: "streak.js" });
  assert.equal(context.StreakAPI.buyFreeze("sapphire"), undefined);
  assert.deepEqual(spendCalls, [{ reward: "sapphire", cost: 1 }]);

  const saved = JSON.parse(writes.get("japanese-dictionary-streak-v1"));
  assert.equal(saved.streak.freezeDate, nextDateKey(today));
  assert.equal(saved.streak.count, 7);
});
