let storyResults = []; // Global variable to store the stories
let currentSpeed = 1.0; // default speed
// isEnglishVisible/setEnglishVisible live in englishVisibility.js, shared
// with scripts.js and pronunciation.js.

// The last few stories actually opened this session (oldest first), used
// only to keep a "next" chain from ping-ponging around a short loop (e.g.
// A -> B -> A -> B). Deliberately in-memory/session-only rather than
// persisted -- it only needs to interrupt a loop happening right now, not
// remember it forever. Ported from Norwegian's stories.js.
let recentStoryChain = [];
const RECENT_STORY_CHAIN_LIMIT = 5;

function recordStoryChainVisit(titleJapanese) {
  recentStoryChain.push(titleJapanese);
  if (recentStoryChain.length > RECENT_STORY_CHAIN_LIMIT) {
    recentStoryChain.shift();
  }
}

// Titles (titleJapanese) the learner has opened before. Used only to
// softly deprioritize already-seen stories in the weighted list ordering
// below (see READ_STORY_WEIGHT_PENALTY) -- never to hide them, since
// rereading a story is still a normal thing to want to do.
const READ_STORIES_STORAGE_KEY = "japanese-dictionary-read-stories-v1";

function loadReadStoryTitles() {
  try {
    const storedValue = window.localStorage.getItem(READ_STORIES_STORAGE_KEY);
    if (!storedValue) {
      return new Set();
    }
    const parsedValue = JSON.parse(storedValue);
    return new Set(Array.isArray(parsedValue) ? parsedValue : []);
  } catch (error) {
    console.warn("Read stories could not be loaded.", error);
    return new Set();
  }
}

let readStoryTitles = loadReadStoryTitles();

function markStoryAsRead(titleJapanese) {
  if (!titleJapanese || readStoryTitles.has(titleJapanese)) {
    return;
  }

  readStoryTitles.add(titleJapanese);
  cachedStoryOrder = null; // Invalidate: the read penalty now applies to it.

  try {
    window.localStorage.setItem(
      READ_STORIES_STORAGE_KEY,
      JSON.stringify(Array.from(readStoryTitles)),
    );
  } catch (error) {
    console.warn("Read stories could not be saved.", error);
  }
}

// Cache of the current ability/read-weighted story ordering (see
// getStoryOrder). Reused across re-renders -- typing in the search box,
// switching CEFR/genre filters, returning from a story to the list -- so
// the list doesn't visibly reshuffle for reasons other than the learner's
// own choice (the explicit reshuffle gesture; see reshuffleStoryOrder) or
// a genuine change in ability/read state.
let cachedStoryOrder = null; // { cacheKey, order: Map<titleJapanese, rank> }

// Define an object mapping genres to Font Awesome icons
const genreIcons = {
  action: '<i class="fas fa-bolt"></i>', // Action genre icon
  adventure: '<i class="fas fa-compass"></i>', // Adventure genre icon
  biography: '<i class="fas fa-user"></i>', // Biography genre icon
  business: '<i class="fas fa-briefcase"></i>', // Business genre icon
  children: '<i class="fas fa-child"></i>', // Children’s genre icon
  comedy: '<i class="fas fa-laugh"></i>', // Comedy genre icon
  crime: '<i class="fas fa-gavel"></i>', // Crime genre icon
  culture: '<i class="fas fa-globe"></i>', // Culture genre icon
  dialogue: '<i class="fas fa-comments"></i>', // Dialogue genre icon
  drama: '<i class="fas fa-theater-masks"></i>', // Drama genre icon
  economics: '<i class="fas fa-chart-line"></i>', // Economics genre icon
  education: '<i class="fas fa-book-reader"></i>', // Education genre icon
  fantasy: '<i class="fas fa-dragon"></i>', // Fantasy genre icon
  food: '<i class="fas fa-utensils"></i>', // Food genre icon
  health: '<i class="fas fa-heartbeat"></i>', // Health genre icon
  history: '<i class="fas fa-landmark"></i>', // History genre icon
  horror: '<i class="fas fa-ghost"></i>', // Horror genre icon
  language: '<i class="fas fa-language"></i>', // Language genre icon
  "manga and anime": '<i class="fas fa-film"></i>',
  monologue: '<i class="fas fa-microphone-alt"></i>', // Monologue genre icon
  music: '<i class="fas fa-music"></i>', // Music genre icon
  mystery: '<i class="fas fa-search"></i>', // Mystery genre icon
  nature: '<i class="fas fa-leaf"></i>', // Nature genre icon
  philosophy: '<i class="fas fa-brain"></i>', // Philosophy genre icon
  poetry: '<i class="fas fa-feather-alt"></i>', // Poetry genre icon
  politics: '<i class="fas fa-balance-scale"></i>', // Politics genre icon
  psychology: '<i class="fas fa-user-md"></i>', // Psychology genre icon
  religion: '<i class="fas fa-praying-hands"></i>', // Religion genre icon
  romance: '<i class="fas fa-heart"></i>', // Romance genre icon
  science: '<i class="fas fa-flask"></i>', // Science genre icon
  "science fiction": '<i class="fas fa-rocket"></i>', // Sci-Fi genre icon
  "self-help": '<i class="fas fa-hands-helping"></i>', // Self-help genre icon
  sports: '<i class="fas fa-football-ball"></i>', // Sports genre icon
  technology: '<i class="fas fa-microchip"></i>', // Technology genre icon
  thriller: '<i class="fas fa-skull"></i>', // Thriller genre icon
  travel: '<i class="fas fa-plane"></i>', // Travel genre icon
};

const CSV_URL = "japaneseStories.csv";
const STORY_CACHE_KEY = "storyDataJa";
const STORY_CACHE_TIME_KEY = "storyDataTimestampJa";

// 74, not a rounder number: displayStoryList() below already subtracts one
// slot when a recommended-story card is present (regularVisibleCount =
// visibleCount - recommendedSlots), so this needs to itself be even for the
// no-recommendation case (74 regular cards = 37 complete two-column rows)
// and odd once the recommendation's own slot is subtracted -- otherwise the
// last row is short one card. Ported from Norwegian's stories.js.
const STORY_LIST_INITIAL_SIZE = 74;
const STORY_LIST_BATCH_SIZE = 24;
// A genuine title search should feel complete, not like browsing a paginated
// catalogue. This cap still protects the initial view when a broad term
// happens to match much of the library.
const STORY_LIST_SHOW_ALL_MATCHES_THRESHOLD = 48;

// Norwegian estimates reading time from a words-per-minute rate, since
// Bokmål text is whitespace-segmented into words. Japanese text has no
// spaces, so word count isn't a meaningful unit here -- reading speed for
// Japanese (native or learner) is conventionally measured in characters per
// minute instead. These rates are deliberately on the slow end (a fraction
// of native adult reading speed, which runs several times faster) since
// this estimate is for learners working through a graded reader, not
// fluent native reading.
const STORY_READING_CHARS_PER_MINUTE_FAST = 400;
const STORY_READING_CHARS_PER_MINUTE_LEISURELY = 250;

function formatStoryGenre(genre) {
  const value = String(genre || "").trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

// Counts Japanese script characters (kanji/hiragana/katakana), excluding
// whitespace and punctuation -- the Japanese analog of Norwegian's
// getStoryWordCount (which counts \p{L}\p{M}+ letter runs).
function getStoryCharCount(story) {
  return (
    String(story.japanese || "").match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    ) || []
  ).length;
}

function getStoryReadingTimeLabel(story) {
  const charCount = getStoryCharCount(story);
  const shortestMinutes = Math.max(
    1,
    Math.ceil(charCount / STORY_READING_CHARS_PER_MINUTE_FAST),
  );
  const longestMinutes = Math.max(
    shortestMinutes + 1,
    Math.ceil(charCount / STORY_READING_CHARS_PER_MINUTE_LEISURELY),
  );
  return `${shortestMinutes}–${longestMinutes} min read`;
}

// ---- List/story SEO metadata -----------------------------------------
// Reuses setWordMetaTag/setWordCanonicalURL (scripts.js) -- both are
// already fully generic (not word-specific despite the name), so a
// separate copy here would just be duplicate code with the exact same
// body. Unlike Norwegian, there's no captured static /stories/ or
// /story/<slug>/ page to point the canonical at, so these use the same
// query-string-URL convention updateWordMetadata() established.

function updateStoriesListMetadata() {
  const storiesURL = new URL(APP_ROOT_URL);
  storiesURL.search = "";
  storiesURL.hash = "";
  storiesURL.searchParams.set("type", "stories");

  const pageTitle = "Japanese Stories with English Translations";
  const description =
    "Read free Japanese stories organized by CEFR level and genre, " +
    "with English translations and audio.";
  const socialImageURL = new URL(
    "Resources/Icons/android-chrome-512x512.png",
    APP_ROOT_URL,
  ).href;

  document.title = pageTitle;
  setWordMetaTag("name", "description", description);
  setWordMetaTag("property", "og:title", pageTitle);
  setWordMetaTag("property", "og:description", description);
  setWordMetaTag("property", "og:type", "website");
  setWordMetaTag("property", "og:url", storiesURL.href);
  setWordMetaTag("property", "og:image", socialImageURL);
  setWordCanonicalURL(storiesURL.href);
}

function updateStoryMetadata(story) {
  const titleJapanese = (story.titleJapanese || "").trim();
  const titleEnglish = (story.titleEnglish || "").trim();
  const cefrLevel = (story.CEFR || "").trim().toUpperCase();
  const genre = (story.genre || "").trim().toLowerCase();

  const levelText = cefrLevel ? `${cefrLevel} ` : "";
  const genreText = genre ? `${genre} ` : "";
  const translatedTitle =
    titleEnglish && titleEnglish !== titleJapanese ? ` (${titleEnglish})` : "";

  const pageTitle = `${titleJapanese}: ${levelText}Japanese Story`;
  const description =
    `Read "${titleJapanese}"${translatedTitle}, ` +
    `a free ${levelText}Japanese ${genreText}story ` +
    `with an English translation.`;

  const storyURL = new URL(APP_ROOT_URL);
  storyURL.search = "";
  storyURL.hash = "";
  storyURL.searchParams.set("type", "story");
  storyURL.searchParams.set("story", titleJapanese);

  const socialImageURL = new URL(
    "Resources/Icons/android-chrome-512x512.png",
    APP_ROOT_URL,
  ).href;

  document.title = pageTitle;
  setWordMetaTag("name", "description", description);
  setWordMetaTag("property", "og:title", pageTitle);
  setWordMetaTag("property", "og:description", description);
  setWordMetaTag("property", "og:type", "article");
  setWordMetaTag("property", "og:url", storyURL.href);
  setWordMetaTag("property", "og:image", socialImageURL);
  setWordCanonicalURL(storyURL.href);
}

// ---- Ability-weighted, stable story ordering ---------------------------
// Ported from Norwegian's stories.js. See the comments there (and repeated
// here) for why this exists: a plain reshuffle-on-every-render would make
// the list visibly reorder for reasons that have nothing to do with the
// learner's own choices (typing, switching a filter, coming back from a
// story).

// How tightly the story ordering clusters around the learner's ability.
// Wider than the word-selection sigma in wordGame.js -- there are far fewer
// stories than words per CEFR band, so a tighter radius would leave many
// learners with nothing nearby.
const STORY_RECOMMENDATION_SIGMA = 150;

// Ability drifts by a point or two after almost every word-game answer;
// caching on its exact value would reorder the list on nearly every
// render. Bucketing to the nearest 25 keeps it stable across that noise
// while still updating once ability has genuinely moved.
function getStoryRecommendationCacheKey(ability) {
  return Math.round(ability / 25) * 25;
}

// Proximity weight of a single story for a given ability estimate -- a soft
// draw, not an exact CEFR match, so a thin band still surfaces its nearest
// neighbors. A small floor (+0.001) keeps every story in the running,
// however faintly, so a learner whose ability sits far from every
// available story still sees something instead of nothing.
function getStoryDifficultyWeight(story, ability) {
  if (!Number.isFinite(ability) || !story.CEFR) {
    return 1;
  }

  const anchors = window.WordGameHelpers?.getCefrAnchors?.() ?? {};
  const anchor = anchors[story.CEFR.trim().toUpperCase()] ?? 500;
  const distance = anchor - ability;

  return (
    Math.exp(
      -(distance * distance) /
        (2 * STORY_RECOMMENDATION_SIGMA * STORY_RECOMMENDATION_SIGMA),
    ) + 0.001
  );
}

// Already-read stories aren't excluded from the list (rereading is a
// normal thing to want to do) but shouldn't keep competing for the top of
// a fresh draw once they've been opened.
const READ_STORY_WEIGHT_PENALTY = 0.15;

const STORY_SHUFFLE_SEED_KEY = "japanese-dictionary-story-shuffle-seed-v1";

// Deterministic PRNG (mulberry32). The *seed* is what makes a draw random;
// the function itself always reproduces the same sequence for the same
// seed, which is what lets getStoryOrder stay stable across re-renders
// that shouldn't reshuffle anything (see cachedStoryOrder above).
function createSeededRandom(seed) {
  let state = seed >>> 0;

  return function seededRandom() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getStoryShuffleSeed() {
  try {
    const stored = window.localStorage.getItem(STORY_SHUFFLE_SEED_KEY);
    const parsed = stored ? Number(stored) : NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall through to drawing a fresh seed below.
  }
  return reshuffleStoryOrder();
}

// The explicit "reshuffle" gesture (magnifying glass / clear button on the
// Stories tab). Every other re-render of the story list reuses the
// existing seed instead of calling this, so the list only visibly
// reshuffles when the learner actually asked for a fresh draw.
function reshuffleStoryOrder() {
  const seed = Math.floor(Math.random() * 2 ** 31);

  try {
    window.localStorage.setItem(STORY_SHUFFLE_SEED_KEY, String(seed));
  } catch (error) {
    // Best-effort only -- the in-memory seed below still applies for the
    // rest of this session even if it can't be persisted.
  }

  cachedStoryOrder = null;
  return seed;
}

// Builds a full ability-weighted, read-penalized ranking of every story in
// the corpus for one seed, using the Efraimidis-Spirakis exponential-key
// form of weighted sampling without replacement (see Norwegian's stories.js
// for the full derivation comment). Stories are enumerated in a fixed,
// filter-independent order (title) so a given story always draws the same
// tap for a given seed regardless of which filters are applied when the
// list is rendered.
function buildStoryOrder(seed) {
  const ability = window.WordGameHelpers?.getAbilityScore?.();
  const random = createSeededRandom(seed);

  const stableStories = [...storyResults].sort((a, b) =>
    a.titleJapanese.localeCompare(b.titleJapanese),
  );

  const scored = stableStories.map((story) => {
    const weight =
      getStoryDifficultyWeight(story, ability) *
      (readStoryTitles.has(story.titleJapanese) ? READ_STORY_WEIGHT_PENALTY : 1);
    // Clamp away from 0 so a (vanishingly unlikely) tap of exactly 0
    // can't produce -ln(0) = Infinity.
    const tap = Math.max(random(), 1e-12);
    const key = -Math.log(tap) / Math.max(weight, 0.0001);
    return { titleJapanese: story.titleJapanese, key };
  });

  scored.sort((a, b) => a.key - b.key);

  const order = new Map();
  scored.forEach(({ titleJapanese }, index) => {
    order.set(titleJapanese, index);
  });
  return order;
}

// Returns (and caches) the current story ordering: a Map from
// titleJapanese to rank, lower = drawn earlier. Recomputed only when the
// seed, the learner's ability bucket, or the read-story count actually
// changes -- anything else re-rendering the list just re-filters this same
// ranking, which is what keeps it stable.
function getStoryOrder() {
  const ability = window.WordGameHelpers?.getAbilityScore?.();
  const cacheKey = [
    getStoryShuffleSeed(),
    getStoryRecommendationCacheKey(Number.isFinite(ability) ? ability : 0),
    readStoryTitles.size,
  ].join(":");

  if (cachedStoryOrder && cachedStoryOrder.cacheKey === cacheKey) {
    return cachedStoryOrder.order;
  }

  const order = buildStoryOrder(getStoryShuffleSeed());
  cachedStoryOrder = { cacheKey, order };
  return order;
}

// Picking pool[0] every time would show the exact same story to every
// new/anonymous visitor forever, since nothing about them varies the sort.
// Instead pick randomly among the easiest/shortest few, and remember the
// pick in sessionStorage so it stays put across re-renders within one
// visit (switching filters, returning from a story) rather than reshuffling
// underneath the learner -- a new tab/session gets a fresh random pick.
const SESSION_RECOMMENDATION_POOL_SIZE = 8;
const SESSION_RECOMMENDATION_KEY = "japanese-dictionary-session-recommendation-v1";

function pickSessionRecommendation(sortedCandidates) {
  const pool = sortedCandidates.slice(0, SESSION_RECOMMENDATION_POOL_SIZE);

  try {
    const storedTitle = window.sessionStorage.getItem(SESSION_RECOMMENDATION_KEY);
    const stillEligible = pool.find((story) => story.titleJapanese === storedTitle);
    if (stillEligible) return stillEligible;
  } catch (error) {
    // sessionStorage unavailable (private browsing, etc.) -- fall through
    // to a fresh pick below; it just won't stay stable across re-renders.
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  try {
    window.sessionStorage.setItem(SESSION_RECOMMENDATION_KEY, pick.titleJapanese);
  } catch (error) {
    // Non-fatal -- the pick just won't persist across re-renders.
  }
  return pick;
}

// The single best-ranked story for the learner right now -- same ordering
// that drives the full list below, so the "Recommended for you" banner and
// the list it sits above are always consistent with each other. Returns
// null only if no ability estimate exists yet (placement not completed) or
// there are no CEFR-tagged stories at all.
function getRecommendedStory() {
  const ability = window.WordGameHelpers?.getAbilityScore?.();

  const candidates = storyResults.filter((story) => story.CEFR && story.titleJapanese);
  if (!candidates.length) {
    return null;
  }

  if (!Number.isFinite(ability)) {
    // No ability estimate yet (placement not completed) -- a brand-new
    // visitor still gets a starting point instead of undifferentiated
    // options, just an objective one rather than a personalized one:
    // easiest CEFR level, then shortest read among those.
    const easiestShortest = candidates.slice().sort((a, b) => {
      const cefrDiff = (CEFR_ORDER[a.CEFR] ?? Infinity) - (CEFR_ORDER[b.CEFR] ?? Infinity);
      return cefrDiff !== 0 ? cefrDiff : getStoryCharCount(a) - getStoryCharCount(b);
    });
    return pickSessionRecommendation(easiestShortest);
  }

  const order = getStoryOrder();
  candidates.sort(
    (a, b) =>
      (order.get(a.titleJapanese) ?? Infinity) - (order.get(b.titleJapanese) ?? Infinity),
  );

  return candidates[0];
}

/*
 * Build the shared title+detail markup for a story card. Used by both the
 * regular story list and the recommendation banner, so they always stay
 * visually consistent.
 */
function createStoryCardLink(story) {
  const storyLink = document.createElement("a");
  storyLink.className = "story-card-link";
  storyLink.href = `?type=story&story=${encodeURIComponent(story.titleJapanese)}`;
  storyLink.dataset.storyTitle = story.titleJapanese;

  const titleContainer = document.createElement("div");
  titleContainer.classList.add("title-container");

  const japaneseTitle = document.createElement("div");
  japaneseTitle.classList.add("japanese-title");
  japaneseTitle.textContent = story.titleJapanese;
  titleContainer.appendChild(japaneseTitle);

  if (story.titleJapanese !== story.titleEnglish) {
    const englishTitle = document.createElement("div");
    englishTitle.classList.add("english-title", "stories-subtitle");
    englishTitle.textContent = story.titleEnglish || "";
    titleContainer.appendChild(englishTitle);
  }

  const readingTime = document.createElement("p");
  readingTime.className = "story-reading-time";
  readingTime.textContent = getStoryReadingTimeLabel(story);
  titleContainer.appendChild(readingTime);

  const detailContainer = document.createElement("div");
  detailContainer.classList.add("stories-detail-container");

  const genreDiv = document.createElement("div");
  genreDiv.classList.add("stories-genre");
  genreDiv.innerHTML = (story.genre && genreIcons[story.genre.toLowerCase()]) || "";
  const genreLabel = formatStoryGenre(story.genre);
  if (genreLabel) {
    genreDiv.title = genreLabel;
    // role="img" first: a bare div's implicit role is "generic", which per
    // the ARIA spec prohibits aria-label/aria-labelledby outright.
    genreDiv.setAttribute("role", "img");
    genreDiv.setAttribute("aria-label", genreLabel);
  }

  const cefrDiv = document.createElement("div");
  cefrDiv.classList.add("cefr-value", getStoryCefrClass(story.CEFR));
  cefrDiv.textContent = story.CEFR || "N/A";
  if (story.CEFR) cefrDiv.title = getCefrTooltip(story.CEFR);

  detailContainer.appendChild(genreDiv);
  detailContainer.appendChild(cefrDiv);

  storyLink.appendChild(titleContainer);
  storyLink.appendChild(detailContainer);

  return storyLink;
}

/*
 * Shared card shape (eyebrow label, title/genre/CEFR link, favorite star)
 * used by the browse-list "Recommended for you" banner.
 */
function createStoryPromoCard(story, labelHTML, extraClassName) {
  const wrapper = document.createElement("div");
  wrapper.className = extraClassName
    ? `story-recommendation ${extraClassName}`
    : "story-recommendation";

  const label = document.createElement("div");
  label.className = "story-recommendation-label";
  label.innerHTML = labelHTML;

  const storyLink = createStoryCardLink(story);

  // On the wrapper, not just storyLink, so the whole card is a click
  // target. The favorite star is a real sibling button inside this same
  // wrapper, so it's explicitly excluded here (its own handler also stops
  // propagation -- this check is just a second, cheap line of defense).
  wrapper.addEventListener("click", (event) => {
    if (event.target.closest(".story-card-favorite-button")) return;

    const modifiedClick =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modifiedClick) return;

    event.preventDefault();
    displayStory(story.titleJapanese, { userNavigation: true });
  });

  wrapper.appendChild(label);
  wrapper.appendChild(storyLink);
  wrapper.appendChild(createStoryFavoriteButton(story));

  return wrapper;
}

/*
 * Build the highlighted "recommended for your level" banner shown at the
 * top of the Stories page.
 */
function createStoryRecommendationElement(story) {
  // No "your level: X" claim here -- the story's own CEFR badge (rendered
  // by createStoryCardLink below) already carries that as descriptive
  // metadata. The learner's ability estimate is otherwise invisible.
  const isPersonalized = Number.isFinite(window.WordGameHelpers?.getAbilityScore?.());
  const labelHTML = isPersonalized
    ? `<i class="fas fa-star" aria-hidden="true"></i> Recommended for You`
    : `<i class="fas fa-star" aria-hidden="true"></i> New to Japanese? Start Here`;

  return createStoryPromoCard(story, labelHTML);
}

async function fetchAndLoadStoryData() {
  showSpinner();
  try {
    // 1) Always bypass caches: unique param + no-store
    const bust = Date.now(); // guarantees a new URL each request
    const response = await fetch(`${CSV_URL}?bust=${bust}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const csvText = await response.text();

    // 2) Parse fresh CSV
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    }).data;
    storyResults = parsed.map((entry) => ({
      ...entry,
      titleJapanese: (entry.titleJapanese || "").trim(),
    }));

    // 3) Optional: store for offline fallback (not used on next run)
    localStorage.setItem(STORY_CACHE_KEY, JSON.stringify(storyResults));
    localStorage.setItem(STORY_CACHE_TIME_KEY, String(Date.now()));
  } catch (err) {
    console.error("Live fetch failed, falling back to cache:", err);
    const cached = localStorage.getItem(STORY_CACHE_KEY);
    if (cached) {
      storyResults = JSON.parse(cached);
    } else {
      storyResults = [];
    }
  } finally {
    hideSpinner();
  }
}
// Parse the CSV data for stories
function parseStoryCSVData(data) {
  const parsed = Papa.parse(data, { header: true, skipEmptyLines: true }).data;
  storyResults = parsed.map((entry) => ({
    ...entry,
    titleJapanese: (entry.titleJapanese || "").trim(),
  }));
}

// Helper function to determine CEFR class
function getStoryCefrClass(cefrLevel) {
  if (!cefrLevel) return "cefr-unknown"; // Fallback for missing CEFR levels
  const level = cefrLevel.toUpperCase();
  if (["A1"].includes(level)) return "a1";
  if (["A2"].includes(level)) return "a2";
  if (["B1"].includes(level)) return "b1";
  if (["B2"].includes(level)) return "b2";
  if (["C"].includes(level)) return "c1";
  if (["C1"].includes(level)) return "c1";
  if (["C2"].includes(level)) return "c2";

  return "cefr-unknown"; // Default
}

function isFavoriteStoriesFilterActive() {
  return (
    document.getElementById("story-favorites-select")?.value === "favorites"
  );
}

function updateStoryFavoriteButton(button, titleJapanese) {
  const isSaved = Boolean(window.StoryFavoritesAPI?.isSaved?.(titleJapanese));
  const action = isSaved ? "Remove" : "Add";
  const destination = isSaved ? "from favorite stories" : "to favorite stories";

  button.classList.toggle("is-saved", isSaved);
  button.setAttribute("aria-pressed", String(isSaved));
  button.setAttribute("aria-label", `${action} ${titleJapanese} ${destination}`);
  button.title = `${action} ${titleJapanese} ${destination}`;
  button.querySelector("i").className = `${isSaved ? "fas" : "far"} fa-star`;
}

function createStoryFavoriteButton(story) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "word-list-favorite-button story-card-favorite-button";
  button.dataset.storyTitle = story.titleJapanese;
  button.innerHTML = '<i aria-hidden="true"></i>';

  updateStoryFavoriteButton(button, story.titleJapanese);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.StoryFavoritesAPI?.toggle?.(story.titleJapanese);
  });

  return button;
}

window.addEventListener("story-favorites:updated", () => {
  document
    .querySelectorAll(".story-card-favorite-button")
    .forEach((button) =>
      updateStoryFavoriteButton(button, button.dataset.storyTitle || "")
    );

  // An unfavorited card should leave a Favorites-only view immediately.
  if (isStoriesTabActive() && isFavoriteStoriesFilterActive()) {
    displayStoryList();
  }
});

function handleStoryFavoritesFilterChange() {
  displayStoryList();
}

function updateEnglishVisibility() {
  const englishSentences = document.querySelectorAll(".english-sentence");
  const toggleEnglishBtn = document.getElementById("toggle-english-btn"); // Dynamically find the button
  if (isEnglishVisible) {
    englishSentences.forEach((sentence) => {
      sentence.style.display = "block";
    });
    if (toggleEnglishBtn) toggleEnglishBtn.textContent = "Hide English";
  } else {
    englishSentences.forEach((sentence) => {
      sentence.style.display = "none";
    });
    if (toggleEnglishBtn) toggleEnglishBtn.textContent = "Show English";
  }
}

async function displayStoryList(
  filteredStories = storyResults,
  { visibleCount = STORY_LIST_INITIAL_SIZE } = {},
) {
  showSpinner(); // Show spinner before rendering story list
  restoreSearchContainerInner();
  removeStoryHeader();
  clearContainer(); // Clear previous results

  // Reset the page title/URL/metadata to the main list view.
  const listURL = new URL(APP_ROOT_URL);
  listURL.search = "";
  listURL.hash = "";
  history.replaceState({}, "", listURL);
  updateURL(null, "stories", null);
  updateStoriesListMetadata();

  // Retrieve selected CEFR and genre filter values
  const selectedCEFR = document
    .getElementById("cefr-select")
    .value.toUpperCase()
    .trim();
  const selectedGenre = document
    .getElementById("genre-select")
    .value.toLowerCase()
    .trim();
  const showFavoritesOnly = isFavoriteStoriesFilterActive();

  // Stories search only changes after a deliberate submit (Enter / the
  // search button, see search()'s "stories" branch in scripts.js) -- the
  // input can hold a new unfinished query while this list retains the last
  // submitted one, matching Norwegian's behavior.
  const searchInput =
    document.getElementById("search-bar") ||
    document.getElementById("stories-search") ||
    document.getElementById("global-search");
  const searchText = (searchInput?.dataset.submittedStoryQuery || "")
    .toLowerCase()
    .trim();

  // Filter stories based on selected CEFR and genre
  let filtered = filteredStories.filter((story) => {
    const genreMatch = selectedGenre
      ? story.genre && story.genre.trim().toLowerCase() === selectedGenre
      : true;
    const cefrMatch = selectedCEFR
      ? story.CEFR && story.CEFR.trim().toUpperCase() === selectedCEFR
      : true;
    const hasJapanese = story.japanese && story.japanese.trim() !== "";
    const matchesSearch =
      !searchText ||
      (story.titleJapanese && story.titleJapanese.toLowerCase().includes(searchText)) ||
      (story.titleEnglish && story.titleEnglish.toLowerCase().includes(searchText));
    const matchesFavorites =
      !showFavoritesOnly || Boolean(window.StoryFavoritesAPI?.isSaved?.(story.titleJapanese));

    return genreMatch && cefrMatch && hasJapanese && matchesSearch && matchesFavorites;
  });

  // Ability-weighted, read-penalized, deterministic-per-seed ordering (see
  // getStoryOrder) -- not a fresh shuffle on every render.
  const storyOrder = getStoryOrder();
  filtered.sort(
    (a, b) =>
      (storyOrder.get(a.titleJapanese) ?? Infinity) -
      (storyOrder.get(b.titleJapanese) ?? Infinity),
  );

  const totalMatchingStories = filtered.length;

  // Keep the recommendation inside the active search/filter result set.
  // Otherwise a focused lookup could surface an unrelated story above its
  // one matching result.
  const candidateRecommendation = getRecommendedStory();
  const recommendedStory = filtered.includes(candidateRecommendation)
    ? candidateRecommendation
    : null;
  const regularStories = recommendedStory
    ? filtered.filter((story) => story !== recommendedStory)
    : filtered;

  // A narrow search is most useful when all of its results are immediately
  // visible. The regular browse path is intentionally progressive so the
  // page does not build hundreds of cards before the learner sees a choice.
  const showAllSearchMatches =
    Boolean(searchText) && totalMatchingStories <= STORY_LIST_SHOW_ALL_MATCHES_THRESHOLD;
  const regularVisibleCount = showAllSearchMatches
    ? regularStories.length
    : Math.min(regularStories.length, visibleCount);
  const visibleStories = regularStories.slice(0, regularVisibleCount);

  const container = document.getElementById("results-container");
  const hasActiveStoryFilter = Boolean(
    searchText || selectedCEFR || selectedGenre || showFavoritesOnly,
  );

  if (hasActiveStoryFilter) {
    const activeFilterChips = [
      showFavoritesOnly
        ? `<span class="story-results-filter-summary story-results-favorites-filter"><span class="story-results-genre-icon" aria-hidden="true"><i class="fas fa-star" aria-hidden="true"></i></span><span class="story-results-filter-name">Favorites</span></span>`
        : "",
      selectedGenre
        ? `<span class="story-results-filter-summary story-results-genre-filter" title="${escapeHTML(formatStoryGenre(selectedGenre))}"><span class="story-results-genre-icon" aria-hidden="true">${
            genreIcons[selectedGenre] || '<i class="fas fa-tag" aria-hidden="true"></i>'
          }</span><span class="story-results-filter-name">${escapeHTML(formatStoryGenre(selectedGenre))}</span></span>`
        : "",
      selectedCEFR
        ? `<span class="story-results-filter-summary story-results-cefr-filter" title="CEFR ${escapeHTML(selectedCEFR)}"><span class="cefr-value ${getStoryCefrClass(selectedCEFR)}" aria-hidden="true">${escapeHTML(selectedCEFR)}</span><span class="story-results-filter-name">${escapeHTML(getCefrLabel(selectedCEFR) || selectedCEFR)}</span></span>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const resultsHeader = document.createElement("div");
    resultsHeader.className = "result-header story-results-header";
    resultsHeader.innerHTML = `
      <div class="story-results-header-copy">
        <p class="story-results-eyebrow">${searchText ? "Story Search" : "Story Library"}</p>
        <h2>${
          searchText
            ? `Results for <span class="story-results-query">"${escapeHTML(searchText)}"</span>`
            : "Filtered Stories"
        }</h2>
        ${activeFilterChips ? `<div class="story-results-filters">${activeFilterChips}</div>` : ""}
      </div>
      <strong class="story-results-count">${totalMatchingStories} stor${totalMatchingStories === 1 ? "y" : "ies"}</strong>
    `;
    container.appendChild(resultsHeader);
  }

  let storyList = document.getElementById("stories");
  if (!storyList) {
    storyList = document.createElement("ul");
    storyList.id = "stories";
    storyList.className = "stories-list";
  }
  storyList.innerHTML = ""; // clear old list items
  const storyItems = document.createDocumentFragment();

  visibleStories.forEach((story) => {
    const li = document.createElement("li");
    li.className = "stories-list-item";
    li.appendChild(createStoryCardLink(story));
    li.appendChild(createStoryFavoriteButton(story));
    storyItems.appendChild(li);
  });

  // One delegated listener replaces hundreds of identical per-card
  // listeners while preserving normal modified-click behavior (opening a
  // new tab).
  storyList.addEventListener("click", (event) => {
    const storyLink = event.target.closest(".story-card-link");
    if (!storyLink || !storyList.contains(storyLink)) return;

    const modifiedClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modifiedClick) return;

    event.preventDefault();
    displayStory(storyLink.dataset.storyTitle, { userNavigation: true });
  });

  storyList.appendChild(storyItems);

  if (recommendedStory) {
    container.appendChild(createStoryRecommendationElement(recommendedStory));
  }

  if (totalMatchingStories > 0) {
    container.appendChild(storyList);
  } else {
    const emptyState = document.createElement("div");
    emptyState.className = "definition story-list-empty-state";
    emptyState.innerHTML = showFavoritesOnly
      ? `<h2>No Favorite Stories Yet</h2><p>Use the star on a story card to save it for later.</p>`
      : `<h2>No Stories Found</h2><p>Try a different search or filter.</p>`;
    container.appendChild(emptyState);
  }

  if (regularVisibleCount < regularStories.length) {
    const loadMore = document.createElement("div");
    loadMore.className = "stories-load-more";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "stories-load-more-button";
    button.textContent = "Show More Stories";
    button.addEventListener("click", () => {
      displayStoryList(filteredStories, {
        visibleCount: visibleCount + STORY_LIST_BATCH_SIZE,
      });
    });

    loadMore.appendChild(button);
    container.appendChild(loadMore);
  }

  // show list / hide reader (unchanged behavior)
  const storyViewer = document.getElementById("story-viewer");
  const storyContent = document.getElementById("story-content");
  const stickyHeader = document.getElementById("sticky-header");

  container.style.display = "block";
  if (storyViewer) storyViewer.style.display = "none";
  if (storyContent) storyContent.innerHTML = "";
  if (stickyHeader) stickyHeader.classList.add("hidden");

  hideSpinner();
}

// Re-segments every sentence in a just-rendered story once Inflections'
// reverse index is ready (building it on first call), replacing each
// .japanese-sentence's plain-text sync render with the clickable version.
// Mirrors upgradeDefinitionClickableWords in scripts.js -- see there for
// why this two-pass render exists at all.
async function upgradeStoryClickableWords(container) {
  if (!window.Inflections || window.Inflections.isReverseIndexReady()) return;

  const sentenceEls = Array.from(
    container.querySelectorAll(".japanese-sentence"),
  );
  if (sentenceEls.length === 0) return;

  for (const el of sentenceEls) {
    const text = el.dataset.jpText;
    if (!text) continue;
    const spans = await window.Inflections.segmentTextAsync(text, results);
    if (!el.isConnected) return; // learner left the story mid-upgrade
    el.innerHTML = renderSegmentedText(text, spans, "story-word");
  }
}

// ---- Click-to-define popover -----------------------------------------
//
// Unlike scripts.js's clickable-definition-word (which replaces the whole
// results pane with the clicked word's full card -- appropriate when
// you're already browsing definitions), clicking a word mid-story opens a
// small popover instead: replacing the reader with a search result would
// lose your place in the story. Reuses the .story-word-popover CSS already
// shared with Norwegian (see styles/10-shell-landing-and-stats.css).
//
// Segmentation already resolved each story word to its dictionary lemma at
// render time (see renderSegmentedText/data-word above), so -- unlike
// Norwegian's version, which can't presegment its space-delimited text and
// so resolves each click's surface form lazily -- there's no async lookup
// needed here at all: the entries are just an exact results filter away.
let activeStoryWordPopover = null;

function closeStoryWordPopover() {
  if (!activeStoryWordPopover) return;
  activeStoryWordPopover.remove();
  activeStoryWordPopover = null;
  window.removeEventListener("scroll", closeStoryWordPopover, true);
  window.removeEventListener("resize", closeStoryWordPopover);
}

function positionStoryWordPopover(popover, wordSpan) {
  const wordRect = wordSpan.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const gap = 8;

  let top = wordRect.top - popoverRect.height - gap;
  if (top < 8) {
    top = wordRect.bottom + gap; // Not enough room above -- show below instead.
  }

  const maxLeft = window.innerWidth - popoverRect.width - 8;
  const left = Math.max(8, Math.min(wordRect.left, maxLeft));

  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
}

function updateStoryWordPopoverStar(button, entry, isSaved) {
  const word = String(entry.ord || "").split(/[,、]/)[0].trim();
  const action = isSaved ? "Remove" : "Add";
  const destination = isSaved ? "from My Words" : "to My Words";

  button.classList.toggle("is-saved", isSaved);
  button.setAttribute("aria-pressed", String(isSaved));
  button.setAttribute("aria-label", `${action} ${word} ${destination}`);
  button.title = button.getAttribute("aria-label");
  button.querySelector("i").className = `${isSaved ? "fas" : "far"} fa-star`;
}

function renderStoryWordPopoverContent(popover, entries, surfaceWord) {
  popover.innerHTML = "";
  popover.classList.remove("story-word-popover-empty");

  if (entries.length === 0) {
    // Shouldn't normally happen -- a .story-word span only exists because
    // segmentation already found a matching entry -- but stays defensive
    // (e.g. results reloading between render and click) rather than
    // showing a dead popover.
    popover.classList.add("story-word-popover-empty");

    const emptyText = document.createElement("span");
    emptyText.textContent = "No definition found";

    const flagButton = document.createElement("button");
    flagButton.type = "button";
    flagButton.className = "story-word-popover-flag-btn";
    flagButton.textContent = "Flag Missing Word";
    flagButton.addEventListener("click", (event) => {
      event.stopPropagation();
      flagMissingWordEntry(surfaceWord);
      closeStoryWordPopover();
    });

    popover.append(emptyText, flagButton);
    return;
  }

  const seenGlosses = new Set();
  // Lower CEFR (more likely the sense a beginner clicking mid-story wants)
  // first, same ordering Norwegian's popover uses.
  const cefrOrder = { A1: 0, A2: 1, B1: 2, B2: 3, C: 4 };
  const orderedEntries = [...entries].sort(
    (a, b) =>
      (cefrOrder[String(a.CEFR).toUpperCase()] ?? 99) -
      (cefrOrder[String(b.CEFR).toUpperCase()] ?? 99),
  );

  orderedEntries.slice(0, 5).forEach((entry) => {
    const gloss = entry.engelsk || "";
    const glossKey = gloss.toLowerCase();
    if (seenGlosses.has(glossKey)) return;
    seenGlosses.add(glossKey);

    const row = document.createElement("div");
    row.className = "story-word-popover-row";

    const translationEl = document.createElement("span");
    translationEl.className = "story-word-popover-translation";
    translationEl.textContent = gloss;

    const starButton = document.createElement("button");
    starButton.type = "button";
    starButton.className = "word-list-favorite-button story-word-popover-star";
    starButton.innerHTML = '<i aria-hidden="true"></i>';
    updateStoryWordPopoverStar(
      starButton,
      entry,
      window.MyWordsAPI?.isSaved?.(entry) ?? false,
    );

    starButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const nowSaved = Boolean(window.MyWordsAPI?.toggle?.(entry));
      updateStoryWordPopoverStar(starButton, entry, nowSaved);
    });

    row.append(translationEl, starButton);
    popover.appendChild(row);
  });
}

function showStoryWordPopover(wordSpan) {
  const lemma = wordSpan.dataset.word;
  if (!lemma) return;

  closeStoryWordPopover();

  const entries = results.filter((r) =>
    String(r.ord || "")
      .split(/[,、]/)
      .map((form) => form.trim())
      .includes(lemma),
  );

  const popover = document.createElement("div");
  popover.className = "story-word-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `Definition of ${lemma}`);

  renderStoryWordPopoverContent(popover, entries, lemma);

  document.body.appendChild(popover);
  positionStoryWordPopover(popover, wordSpan);
  activeStoryWordPopover = popover;

  window.addEventListener("scroll", closeStoryWordPopover, true);
  window.addEventListener("resize", closeStoryWordPopover);
}

document.addEventListener("click", (event) => {
  const wordSpan = event.target.closest(
    "#story-content .story-word",
  );
  if (wordSpan) {
    event.stopPropagation();
    showStoryWordPopover(wordSpan);
    return;
  }

  if (activeStoryWordPopover && !event.target.closest(".story-word-popover")) {
    closeStoryWordPopover();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeStoryWordPopover();
  }
});

async function displayStory(titleJapanese, { userNavigation = false } = {}) {
  document.documentElement.classList.add("reading");
  showSpinner(); // Show spinner at the start of story loading
  const searchContainer = document.getElementById("search-container");
  const searchContainerInner = document.getElementById(
    "search-container-inner"
  );
  const selectedStory = storyResults.find(
    (story) => story.titleJapanese === titleJapanese
  );

  if (!selectedStory) {
    console.error(`No story found with the title: ${titleJapanese}`);
    return;
  }

  markStoryAsRead(selectedStory.titleJapanese);
  recordStoryChainVisit(selectedStory.titleJapanese);

  updateURL(null, "story", null, titleJapanese); // Update URL with story parameter
  updateStoryMetadata(selectedStory);

  clearContainer();

  // This button lives permanently in the site header (shown/hidden via
  // html.reading in CSS), not regenerated per story, so its handler is
  // overwritten via assignment rather than addEventListener — otherwise
  // navigating between stories would stack another listener bound to a
  // now-stale story.
  const reportIssueButton = document.getElementById("story-report-issue");
  if (reportIssueButton) {
    reportIssueButton.onclick = () => {
      openFeedbackDialog({
        source: "Story",
        word: selectedStory.titleJapanese,
        pos: selectedStory.genre,
        cefr: selectedStory.CEFR,
        categories: STORY_FEEDBACK_CATEGORIES,
        triggerElement: reportIssueButton,
      });
    };
  }

  // Check for the image (mirror JP: EN title only)
  const imageFileURL = await hasImageByEnglishTitle(selectedStory.titleEnglish);

  // Check for the audio file
  const audioFileURL = await hasAudio(selectedStory.titleEnglish);
  const audioHTML = audioFileURL
    ? `<audio controls src="${audioFileURL}" class="stories-audio-player"></audio>`
    : "";
  // Build sticky header here, just before audio is constructed
  const genreIcon = genreIcons[selectedStory.genre.toLowerCase()] || "";
  const cefrClass = getStoryCefrClass(selectedStory.CEFR);

  const sticky = document.getElementById("sticky-header");
  sticky.classList.remove("hidden");

  // 1) Render a stable skeleton with fixed slots so layout never reflows
  sticky.innerHTML = `
  <div class="sticky-detail-container">
    <div class="sticky-row">
      <div class="sticky-favorite-slot" id="sticky-favorite-slot"></div>
      <div class="sticky-genre" id="sticky-genre-slot"></div>
      <div class="sticky-cefr-label ${cefrClass}" id="sticky-cefr-slot">
        ${selectedStory.CEFR || "N/A"}
      </div>
    </div>
    <button id="back-button" class="back-button">
      <i class="fas fa-chevron-left"></i> Back
    </button>
  </div>
  <div id="sticky-audio-slot"></div>
  <div id="right-controls" class="right-controls"></div>
`;

  const stickyHeaderEl = document.getElementById("sticky-header");
  const audioSlot = document.getElementById("sticky-audio-slot");

  const favoriteSlot = document.getElementById("sticky-favorite-slot");
  if (favoriteSlot) {
    favoriteSlot.appendChild(createStoryFavoriteButton(selectedStory));
  }

  stickyHeaderEl.style.display = "flex";
  stickyHeaderEl.style.alignItems = "center";

  // Let left and right stay their natural size, middle (audioSlot) expand
  const left = stickyHeaderEl.querySelector(".sticky-detail-container");
  const right = document.getElementById("right-controls");
  if (left) left.style.flex = "0 0 auto";
  if (right) right.style.flex = "0 0 auto";
  if (audioSlot) {
    audioSlot.style.flex = "1 1 auto"; // flex-grow so it fills available width
    audioSlot.style.maxWidth = "100%"; // never overflow
    const audioEl = audioSlot.querySelector("audio");
    if (audioEl) {
      audioEl.style.width = "100%"; // make the <audio> itself fill its slot
    }
  }
  // 2) Fill the left-side genre slot immediately
  const genreSlot = document.getElementById("sticky-genre-slot");
  if (genreSlot) genreSlot.innerHTML = genreIcon;

  // 3) Create the English toggle once, in its fixed slot (no later moves)
  const rc = document.getElementById("right-controls");
  if (rc) {
    rc.innerHTML = `
    <button id="toggle-english-btn" class="toggle-english-btn">
      ${isEnglishVisible ? "Hide English" : "Show English"}
    </button>
  `;
  }

  // Insert a Speed button *above* the English toggle, with identical styling
  (function addSpeedButton() {
    const rc = document.getElementById("right-controls");
    const engBtn = document.getElementById("toggle-english-btn");
    if (!rc || !engBtn) return;

    const speedBtn = document.createElement("button");
    speedBtn.id = "speed-btn";
    speedBtn.type = "button";
    // Clone the *exact* classes from the English button for identical styling
    speedBtn.className = engBtn.className;
    speedBtn.textContent = "1.0×";
    // Small vertical spacing without touching your CSS
    speedBtn.style.marginBottom = "5px";

    // Insert above the English button
    rc.insertBefore(speedBtn, engBtn);

    const rates = [0.7, 0.8, 0.9, 1];
    let i = rates.indexOf(currentSpeed);
    if (i === -1) i = 3; // default to 1.0×

    function label(r) {
      return "Speed: " + r.toFixed(1).replace(/\.0$/, "");
    }
    function applyRate(r) {
      currentSpeed = r; // update global
      const audio = document.querySelector("#sticky-audio-slot audio");
      if (audio) {
        audio.playbackRate = r;
        audio.preservesPitch = true;
        audio.mozPreservesPitch = true;
        audio.webkitPreservesPitch = true;
      }
      speedBtn.textContent = label(r);
      speedBtn.setAttribute("aria-label", `Playback speed ${r} times`);
    }

    speedBtn.addEventListener("click", () => {
      i = (i + 1) % rates.length;
      applyRate(rates[i]);
    });

    // initialize button + audio to current global speed
    applyRate(rates[i]);

    // Expose helpers so newly-created audio can reuse the current rate
    speedBtn._getRate = () => rates[i];
    speedBtn._applyRate = () => applyRate(rates[i]);

    // Initialize
    applyRate(rates[i]);
  })();

  document
    .getElementById("toggle-english-btn")
    ?.addEventListener("click", () => {
      setEnglishVisible(!isEnglishVisible);
      updateEnglishVisibility();
      const b = document.getElementById("toggle-english-btn");
      if (b) b.textContent = isEnglishVisible ? "Hide English" : "Show English";
    });

  // DIAG 2: force a visible audio control even if the real file is missing
  // REAL AUDIO: sanitize title and set src; fallback mp3 if m4a fails
  {
    const slot = document.getElementById("sticky-audio-slot");
    if (slot) {
      // Build a sanitized filename: strip trailing '?', trim, collapse spaces
      const rawTitle = (selectedStory.titleEnglish || "")
        .replace(/\?+$/, "")
        .trim()
        .replace(/\s+/g, " ");
      const enc = encodeURIComponent(rawTitle);
      const player = document.createElement("audio");
      player.controls = true;
      player.className = "stories-audio-player";
      player.preload = "metadata";
      player.src = `Resources/Audio/${enc}.m4a`;
      player.onerror = () => {
        // try mp3, then give up quietly
        if (player.src.endsWith(".m4a")) {
          player.onerror = () =>
            console.warn("[AUDIO]", "mp3 also missing for:", rawTitle);
          player.src = `Resources/Audio/${enc}.mp3`;
        }
      };
      slot.innerHTML = "";
      slot.appendChild(player);
      player.playbackRate = currentSpeed; // ensure it starts at the saved speed
      console.log("[AUDIO] trying:", player.src);
    }
  }

  if (searchContainer) searchContainer.style.display = "none";

  document
    .getElementById("back-button")
    ?.addEventListener("click", storiesBackBtn);

  const imageHTML = imageFileURL
    ? `<img src="${imageFileURL}" alt="${selectedStory.titleEnglish}" class="story-image">`
    : "";
  let contentHTML = imageHTML;
  // Function to finalize and display the story content, with or without audio
  const finalizeContent = (includeAudio = false) => {
    if (includeAudio) {
      contentHTML = audioHTML + contentHTML;
    }

    for (let i = 0; i < japaneseSentences.length; i++) {
      const japaneseSentence = japaneseSentences[i].trim();
      const englishSentence = englishSentences[i]
        ? englishSentences[i].trim()
        : "";

      // Sync fast path (renders plain text before the reverse index is
      // warm) + async upgrade below, same split as makeDefinitionClickable/
      // upgradeDefinitionClickableWords in scripts.js -- see there for why.
      const spans = window.Inflections?.isReverseIndexReady()
        ? window.Inflections.segmentTextSync(japaneseSentence)
        : [];

      contentHTML += `
    <div class="couplet">
      <div class="japanese-sentence" data-jp-text="${escapeHTML(japaneseSentence)}">${renderSegmentedText(japaneseSentence, spans, "story-word")}</div>
      <div class="english-sentence">${englishSentence}</div>
    </div>
  `;
    }

    const storyViewer = document.getElementById("story-viewer");
    const storyContent = document.getElementById("story-content");
    const listEl = document.getElementById("results-container");

    if (storyContent) {
      storyContent.innerHTML = contentHTML; // render story body into the reader pane
      upgradeStoryClickableWords(storyContent);
      // Insert the sticky title above the first child (mirror JP order)
      const titleNode = document.createElement("div");
      titleNode.className = "sticky-title-container";
      titleNode.innerHTML = `
  <h1 class="sticky-title-japanese">${selectedStory.titleJapanese}</h1>
  ${
    selectedStory.titleJapanese !== selectedStory.titleEnglish
      ? `<p class="sticky-title-english">${selectedStory.titleEnglish}</p>`
      : ""
  }
`;
      storyContent.insertBefore(titleNode, storyContent.firstChild);
    }
    // JP mirror: enforce current visibility state on first render
    updateEnglishVisibility();
    if (storyViewer) {
      storyViewer.style.display = "block"; // show the reader pane
    }
    if (listEl) {
      listEl.style.display = "none"; // hide the list while reading
    }
    hideSpinner(); // Hide spinner after story content is displayed
    if (userNavigation) {
      focusViewAfterNavigation?.(".sticky-title-japanese");
    }
  };

  // Process story text into sentences
  const standardizedJapanese = selectedStory.japanese.replace(/[“”«»]/g, '"');
  const standardizedHiragana = (selectedStory.hiragana || "").replace(
    /[“”«»]/g,
    '"'
  );
  const standardizedEnglish = selectedStory.english.replace(/[“”«»]/g, '"');
  const englishSentenceEndings =
    /(?:(["]?.+?(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bDr)(?<!\bProf)(?<!\bJr)(?<!\bSr)(?<!\bSt)(?<!\bMt)[.!?]["]?)(?=\s|$)|(?:\.\.\."))/g;
  const japaneseSentenceEndings = /[^。！？]+[。！？](?:」|』|”|")?/g;

  let japaneseSentences = standardizedJapanese.match(
    japaneseSentenceEndings
  ) || [standardizedJapanese];
  let japaneseSentencesHiragana = standardizedHiragana.match(
    japaneseSentenceEndings
  ) || [standardizedHiragana];
  let englishSentences = standardizedEnglish.match(englishSentenceEndings) || [
    standardizedEnglish,
  ];

  const combineSentences = (sentences, combineIfContains) => {
    return sentences.reduce((acc, sentence) => {
      const trimmedSentence = sentence.trim();
      const lastSentence = acc[acc.length - 1] || "";

      // Check if the previous sentence ends with a quote and the current sentence contains 'asked'
      if (
        acc.length > 0 &&
        combineIfContains &&
        combineIfContains.test(trimmedSentence) &&
        /["”']$/.test(lastSentence)
      ) {
        acc[acc.length - 1] += " " + trimmedSentence;
      } else if (acc.length > 0 && /^[a-zæøå]/.test(trimmedSentence)) {
        acc[acc.length - 1] += " " + trimmedSentence;
      } else {
        acc.push(trimmedSentence);
      }
      return acc;
    }, []);
  };

  japaneseSentences = combineSentences(japaneseSentences);
  englishSentences = combineSentences(englishSentences, /\basked\b/i);

  finalizeContent(false);
}

// Function to toggle the visibility of English sentences and update Japanese box styles
function toggleEnglishSentences() {
  const englishEls = document.querySelectorAll(".english-sentence");
  const englishBtn = document.querySelector(".stories-english-btn");
  if (!englishBtn) return;

  const desktopText = englishBtn.querySelector(".desktop-text");
  const mobileText = englishBtn.querySelector(".mobile-text");
  const isCurrentlyHidden =
    desktopText && desktopText.textContent === "Show English";

  englishEls.forEach((el) => {
    el.style.display = isCurrentlyHidden ? "" : "none";
  });

  if (desktopText)
    desktopText.textContent = isCurrentlyHidden
      ? "Hide English"
      : "Show English";
  if (mobileText) mobileText.textContent = "ENG";
}

function handleGenreChange() {
  const selectedGenre = document
    .getElementById("genre-select")
    .value.trim()
    .toLowerCase();
  const selectedCEFR = document
    .getElementById("cefr-select")
    .value.toUpperCase();

  // Filter the stories based on both the selected genre and CEFR level
  const filteredStories = storyResults.filter((story) => {
    const genreMatch = selectedGenre
      ? story.genre.trim().toLowerCase() === selectedGenre
      : true;
    const cefrMatch = selectedCEFR
      ? story.CEFR && story.CEFR.toUpperCase() === selectedCEFR
      : true;

    return genreMatch && cefrMatch;
  });

  // Call displayStoryList with the filtered stories
  displayStoryList(filteredStories);
}

// Every navigation path away from the story reader OTHER than the in-page
// "Back to Stories" button (storiesBackBtn) needs to call this too --
// switching mode-nav tabs, the header, browser back/forward -- otherwise
// the reader (audio included) is left sitting on screen under the new
// view. See syncModeNav() in scripts.js, which calls this unconditionally
// on every navigation.
function resetStoryReaderView() {
  const stickyHeader = document.getElementById("sticky-header");
  if (stickyHeader) {
    stickyHeader
      .querySelectorAll("audio, .stories-audio-player")
      .forEach((p) => {
        if (typeof p.pause === "function") p.pause();
        try {
          p.currentTime = 0;
        } catch (_) {}
        p.remove();
      });
    stickyHeader.querySelector(".toggle-buttons-container")?.remove();
    stickyHeader.classList.add("hidden");
  }
  const storyViewer = document.getElementById("story-viewer");
  const storyContent = document.getElementById("story-content");
  const resultsContainer = document.getElementById("results-container");
  if (storyViewer) storyViewer.style.display = "none";
  if (storyContent) storyContent.innerHTML = "";
  // displayStory() hides the shared results area while the reader is open.
  // Every other core mode renders into it, so navigation away from a story
  // must restore it before the destination view is drawn.
  if (resultsContainer) resultsContainer.style.display = "block";
  document.documentElement.classList.remove("reading");
}
window.resetStoryReaderView = resetStoryReaderView;

function storiesBackBtn() {
  // JP parity: stop and remove any playing audio from the sticky header
  const stickyHeader = document.getElementById("sticky-header");
  if (stickyHeader) {
    const players = stickyHeader.querySelectorAll(
      "audio, .stories-audio-player"
    );
    players.forEach((p) => {
      if (typeof p.pause === "function") p.pause();
      try {
        p.currentTime = 0;
      } catch (_) {}
      p.remove();
    });
    const toggles = stickyHeader.querySelector(".toggle-buttons-container");
    if (toggles) toggles.remove();
  }

  // 1) Capture current CEFR/Genre/Favorites BEFORE changing the UI
  const cefrElBefore = document.getElementById("cefr-select");
  const genreElBefore = document.getElementById("genre-select");
  const favoritesElBefore = document.getElementById("story-favorites-select");
  const savedCEFR = cefrElBefore ? cefrElBefore.value : "";
  const savedGenre = genreElBefore ? genreElBefore.value : "";
  const savedFavorites = favoritesElBefore ? favoritesElBefore.value : "";

  // 2) Clear ONLY the search box (mirror JP)
  const searchEl =
    document.getElementById("search-bar") ||
    document.getElementById("stories-search") ||
    document.getElementById("global-search");
  if (searchEl) searchEl.value = "";

  // 3) If you must switch the type tab, do it now (this may rebuild the filters)
  const typeSel = document.getElementById("type-select");
  if (typeSel) typeSel.value = "stories";
  if (typeof handleTypeChange === "function") handleTypeChange("stories");

  // 4) Re-grab the (possibly re-rendered) selects and restore values
  const cefrElAfter = document.getElementById("cefr-select");
  const genreElAfter = document.getElementById("genre-select");
  const favoritesElAfter = document.getElementById("story-favorites-select");
  if (cefrElAfter) cefrElAfter.value = savedCEFR;
  if (genreElAfter) genreElAfter.value = savedGenre;
  if (favoritesElAfter) favoritesElAfter.value = savedFavorites;

  // 5) Render the list using the restored dropdowns
  displayStoryList();

  // 6) Exit reading mode
  document.documentElement.classList.remove("reading");
}

// Helper function to remove the story header
function removeStoryHeader() {
  const searchContainer = document.getElementById("search-container"); // The container to update
  const storyHeader = document.querySelector(".stories-story-header");
  searchContainer.style.display = "";
  if (storyHeader) {
    storyHeader.remove();
  }
}

// Helper function to restore the inner
function restoreSearchContainerInner() {
  const searchContainerInner = document.getElementById(
    "search-container-inner"
  ); // The container to update
  searchContainerInner.style.display = "";
}

// Check if an audio file exists based on the English title
async function hasAudio(titleEnglish) {
  const encodedTitleEnglish = encodeURIComponent(titleEnglish);
  const audioFileURLs = [
    `Resources/Audio/${encodedTitleEnglish}.m4a`,
    `Resources/Audio/${encodedTitleEnglish}.mp3`,
  ];

  for (const audioFileURL of audioFileURLs) {
    try {
      // Check if the audio file exists
      const response = await fetch(audioFileURL, {
        method: "HEAD",
        cache: "no-cache",
      });
      if (response.ok) {
        console.log(`Audio found: ${audioFileURL}`);
        return audioFileURL;
      }
    } catch (error) {
      console.error(`Error checking audio for ${audioFileURL}:`, error);
    }
  }

  console.log(`No audio found for title: ${titleEnglish}`);
  return null; // Return null if no audio file is found
}

// Check if an image exists based on the EN title (mirror JP logic)
async function hasImageByEnglishTitle(titleEnglish) {
  const sanitized = titleEnglish.endsWith("?")
    ? titleEnglish.slice(0, -1)
    : titleEnglish;

  const encodedTitles = [
    encodeURIComponent(titleEnglish),
    encodeURIComponent(sanitized),
  ];

  const imageExtensions = ["webp", "jpg", "jpeg", "avif", "png", "gif"];
  const imagePaths = encodedTitles.flatMap((encoded) =>
    imageExtensions.map((ext) => `Resources/Images/${encoded}.${ext}`)
  );

  for (const path of imagePaths) {
    try {
      const res = await fetch(path, { method: "HEAD", cache: "no-cache" });
      if (res.ok) return path;
    } catch (e) {
      console.warn("Error checking image for", path, e);
    }
  }
  return null;
}

function isStoriesTabActive() {
  const typeSelect = document.getElementById("type-select");
  return typeSelect && typeSelect.value === "stories";
}

// Initialization on page load
window.addEventListener("DOMContentLoaded", async () => {
  // Load the story data and wait for it to complete
  await fetchAndLoadStoryData();
  // Now that the data is loaded, check the URL and display based on the URL parameters
  loadStateFromURL();

  // The shared toolbar's Enter/search-button handlers submit Story search
  // (see search()'s "stories" branch in scripts.js). There is intentionally
  // no input listener here -- see displayStoryList's searchText comment.
  const cefrEl = document.getElementById("cefr-select");
  if (cefrEl) {
    cefrEl.addEventListener("change", () => {
      if (isStoriesTabActive()) {
        displayStoryList();
      }
    });
  }

  const genreEl = document.getElementById("genre-select");
  if (genreEl) {
    genreEl.addEventListener("change", () => {
      if (isStoriesTabActive()) {
        displayStoryList();
      }
    });
  }
});
