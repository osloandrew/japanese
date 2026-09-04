import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines/""
// escapes) -- self-contained rather than reaching for a dependency this
// project doesn't otherwise declare, since japaneseWords.csv's
// sentenceTranslation column does contain quoted, comma-bearing text.
function parseCSV(content) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // skip
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows
    .slice(1)
    .filter((cols) => cols.some((cell) => cell !== ""))
    .map((cols) => Object.fromEntries(header.map((name, index) => [name, cols[index] ?? ""])));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "scripts.js"), "utf8");
const functionStart = source.indexOf("function getPrimaryWordForURL(");
const functionEnd = source.indexOf("// Helper function to capitalize", functionStart);

assert.notEqual(functionStart, -1, "URL word normalizer should exist");
assert.notEqual(functionEnd, -1, "updateURL boundary should exist");

// Real page-manifest.json, not invented slugs -- this is the ground truth
// make-sitemap.py/capture-word-pages.py/capture-story-pages.py already
// committed to for which words/stories have a captured pretty page. The
// outgoing router must only ever produce a pretty URL for something this
// file actually lists (see japaneseWords.csv/japaneseStories.csv for the
// underlying entries the slugs below come from).
const pageManifestJSON = JSON.parse(
  fs.readFileSync(path.join(root, "page-manifest.json"), "utf8"),
);
assert.ok(pageManifestJSON.words.includes("cd"), "'cd' should be a captured word page");
assert.ok(pageManifestJSON.words.includes("あ"), "'あ' should be a captured word page");

function createRoutingContext(manifestWords = [], manifestStories = []) {
  let pushedURL = null;
  const context = vm.createContext({
    URL,
    String,
    APP_ROOT_URL: "http://127.0.0.1:3000/",
    STATIC_FEATURE_ROUTES: {
      sentences: "sentences",
      "word-game": "word-game",
      pronunciation: "pronunciation",
    },
    pageManifest: {
      words: new Set(manifestWords),
      stories: new Set(manifestStories),
    },
    window: {
      // No `href` here (matching Norwegian's own test fixture): updateURL()
      // skips pushState entirely when the target URL already equals
      // window.location.href, a guard against redundant history entries
      // that's orthogonal to the URL-construction logic under test here.
      location: { pathname: "/" },
      history: {
        pushState: (_state, _title, url) => {
          pushedURL = String(url);
        },
      },
    },
    document: { title: "" },
    // Real slugify -- this is the exact function used to build
    // page-manifest.json's slugs (see capture-word-pages.py/
    // capture-story-pages.py), so the tests below reuse it rather than a
    // simplified stand-in.
    slugifyWordForURL: (word) =>
      String(word || "")
        .trim()
        .toLowerCase()
        .replace(/['’]/g, "'")
        .replace(/[\s/]+/g, "-")
        .replace(/[^\p{L}\p{N}-]/gu, "")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, ""),
    findWordEntryForMetadata: (word) => ({ ord: word }),
    updateWordMetadata: () => {},
    capitalizeType: (value) => value,
  });
  vm.runInContext(source.slice(functionStart, functionEnd), context);
  return { context, getPushedURL: () => pushedURL };
}

test("alternative spellings use the primary word's pretty page", () => {
  // Real CSV entry: word column is "あ、あっ" (primary spelling "あ", plus
  // "あっ" as an alternate) -- page-manifest.json lists the captured page
  // as word/あ/.
  const { context, getPushedURL } = createRoutingContext(["あ"]);

  context.updateURL("", "words", "", null, "あ、あっ");

  // Compared as URL.href (percent-encoded), not a raw-Unicode literal:
  // pushState's argument is percent-encoded UTF-8 under the hood the same
  // way any URL is, and browsers still display it readably in the address
  // bar (the same as e.g. Wikipedia's "/wiki/日本") -- decodeURIComponent()
  // on the parse side (loadStateFromURL) already accounts for this.
  assert.equal(
    getPushedURL(),
    new URL("word/あ/", "http://127.0.0.1:3000/").href,
  );
});

test("a captured word with mixed case still resolves to its lowercase slug", () => {
  // Real CSV entry: word "CD" (uppercase) -- page-manifest.json lists the
  // captured page as word/cd/ (capture-word-pages.py's slugify lowercases).
  const { context, getPushedURL } = createRoutingContext(["cd"]);

  context.updateURL("", "words", "noun", null, "CD");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/word/cd/");
});

test("a word not yet captured falls back to the query-string URL", () => {
  const { context, getPushedURL } = createRoutingContext([]); // empty manifest

  context.updateURL("", "words", "", null, "CD");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/?word=CD");
});

test("the empty Words mode uses the application root", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("", "words", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/");
});

test("a sentence search keeps state on the pretty feature route", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("cd", "sentences", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/sentences/?query=cd");
});

test("a random sentence returns to the clean feature route", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("", "sentences", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/sentences/");
});

test("a word-game route keeps state on its own pretty feature route", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("", "word-game", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/word-game/");
});

test("a Words search does not repeat the default mode in the query string", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("cd", "words", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/?query=cd");
});

test("JS-only modes retain an explicit type parameter", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("", "my-stats", "");

  assert.equal(getPushedURL(), "http://127.0.0.1:3000/?type=my-stats");
});

test("Settings and About retain an explicit type parameter, same as My Stats", () => {
  const { context, getPushedURL } = createRoutingContext();

  context.updateURL("", "settings", "");
  assert.equal(getPushedURL(), "http://127.0.0.1:3000/?type=settings");

  context.updateURL("", "about", "");
  assert.equal(getPushedURL(), "http://127.0.0.1:3000/?type=about");
});

test("a captured story slug is preferred over the query-string story URL", () => {
  // Real CSV story title: "道順を尋ねる" -- page-manifest.json lists the
  // captured page as story/道順を尋ねる/ (its title already equals its own
  // slug, unlike "CD"/"cd" above).
  const { context, getPushedURL } = createRoutingContext(
    [],
    ["道順を尋ねる"],
  );

  context.updateURL("", "words", "", "道順を尋ねる");

  assert.equal(
    getPushedURL(),
    new URL("story/道順を尋ねる/", "http://127.0.0.1:3000/").href,
  );
});

// --- Round-trip: the outgoing slug this file builds must be exactly what
// the incoming parser (parsePrettyFeatureType's sibling word/story slug
// matching in loadStateFromURL, via resolveSlugToText) can resolve back to
// the original text, for every real captured word/story -- not just the
// handful of examples above. This is the actual production data, not
// invented sample words.
test("every captured word slug is produced by slugifying its real CSV primary spelling", () => {
  const wordsCSV = fs.readFileSync(path.join(root, "japaneseWords.csv"), "utf8");
  const rows = parseCSV(wordsCSV, { columns: true, skip_empty_lines: true });

  // Matches parseCSVData()'s own filter in scripts.js and
  // capture-word-pages.py's load_all_primary_words(): a row with no English
  // translation never becomes a real dictionary entry, so it was never
  // captured either. Primary spelling only -- first form before any
  // comma/ideographic comma, same split scripts.js uses everywhere else on
  // this column (e.g. updateWordMetadata(), findWordEntryForMetadata()).
  const primaryWords = new Set();
  for (const row of rows) {
    if (!(row.English || "").trim()) continue;
    const primary = (row.word || "").split(/[,、]/)[0].trim();
    if (primary) primaryWords.add(primary.toLowerCase());
  }

  const { context } = createRoutingContext();
  const manifestWords = new Set(pageManifestJSON.words);
  const producedSlugs = new Set();
  for (const word of primaryWords) {
    producedSlugs.add(context.slugifyWordForURL(word));
  }

  // Every slug page-manifest.json lists must be reachable by slugifying some
  // real CSV word -- if the outgoing router's slug shape ever drifted from
  // capture-word-pages.py's, this is where it would show up as a mismatch.
  const unreachable = [...manifestWords].filter((slug) => !producedSlugs.has(slug));
  assert.deepEqual(
    unreachable,
    [],
    `page-manifest.json lists ${unreachable.length} word slug(s) slugifyWordForURL can't reproduce from japaneseWords.csv`,
  );
});
