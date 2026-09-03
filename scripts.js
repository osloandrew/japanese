// Global Variables
// Used by wordList.js for crawlable definition-URL construction, ported
// from Norwegian. This app has no pretty-path/pushState navigation for
// document.baseURI to drift from, so a plain APP_ROOT_URL constant is
// safe here without Norwegian's anchorAppNavigationLinks() machinery.
const APP_ROOT_URL = document.baseURI;
let results = [];

// Used by wordList.js's PDF export (ported from Norwegian). This file
// runs after wordList.js at load time (non-deferred vs. deferred), but by
// the time any of wordList.js's functions actually run (in response to
// user interaction), the page has finished loading and this is already
// defined.
const VOCABULARY_LOADING_COPY = {
  words: {
    title: "Preparing Dictionary Results",
    description: "Loading the vocabulary needed for this lookup…",
  },
  sentences: {
    title: "Preparing Sentence Search",
    description: "Loading the vocabulary needed to find examples…",
  },
  "word-game": {
    title: "Preparing Word Game",
    description: "Loading your vocabulary so practice can begin…",
  },
  "word-list": {
    title: "Preparing My Words",
    description: "Loading your vocabulary and saved words…",
  },
  pronunciation: {
    title: "Preparing Pronunciation Practice",
    description: "Loading the vocabulary used for listening practice…",
  },
};

function routeNeedsVocabularyLoadingShell(type, url = new URL(window.location)) {
  if (type !== "words") return Boolean(VOCABULARY_LOADING_COPY[type]);

  // The ordinary dictionary landing page is already useful before the CSV
  // arrives, so reserve this shell for a direct lookup or shared word link.
  return Boolean(url.searchParams.get("query") || url.searchParams.get("word"));
}

function showVocabularyLoadingShell(type) {
  const copy = VOCABULARY_LOADING_COPY[type] || VOCABULARY_LOADING_COPY.words;
  const main = document.getElementById("main-content");

  showLandingCard(false);
  clearContainer();

  const shell = document.createElement("section");
  shell.id = "vocabulary-loading-shell";
  shell.className = "definition vocabulary-loading-shell";
  shell.setAttribute("role", "status");
  shell.setAttribute("aria-live", "polite");
  shell.setAttribute("aria-busy", "true");

  const heading = document.createElement("h2");
  heading.textContent = copy.title;

  const description = document.createElement("p");
  description.className = "vocabulary-loading-description";
  description.textContent = copy.description;

  const skeleton = document.createElement("div");
  skeleton.className = "vocabulary-loading-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const line = document.createElement("span");
    line.className = "vocabulary-loading-skeleton-line";
    skeleton.appendChild(line);
  }

  shell.append(heading, description, skeleton);
  resultsContainer.appendChild(shell);
  main?.setAttribute("aria-busy", "true");
}

function clearVocabularyLoadingState() {
  document.getElementById("main-content")?.removeAttribute("aria-busy");
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function prefersReducedData() {
  const connection = navigator.connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return ["slow-2g", "2g"].includes(connection.effectiveType);
}

// Used by wordGame.js to put off fetching vocabulary-frequency.json (a
// large corpus-ranking file) until there's real reason to believe it'll
// actually be used -- idle time, or the visitor interacting with search/
// #mode-nav/the landing cards -- rather than on every single page load.
function deferUntilNeeded(loader) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    loader();
  };

  if (!prefersReducedData()) {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(start, { timeout: 2000 });
    } else {
      window.setTimeout(start, 1000);
    }
  }

  const searchBar = document.getElementById("search-bar");
  searchBar?.addEventListener("focus", start, { once: true });
  searchBar?.addEventListener("input", start, { once: true });
  document
    .getElementById("mode-nav")
    ?.addEventListener("click", start, { once: true, capture: true });
  document
    .querySelector(".landing-card-button-grid")
    ?.addEventListener("click", start, { once: true, capture: true });
}
// isEnglishVisible/setEnglishVisible live in englishVisibility.js, shared
// with stories.js and pronunciation.js.
let latestMultipleResults = null;
const resultsContainer = document.getElementById("results-container");

// Numeric rank for sorting/comparing CEFR levels -- lower is easier.
const CEFR_ORDER = { A1: 1, A2: 2, B1: 3, B2: 4, C: 5 };

// --- Sentences index globals ---
let sentenceCorpus = []; // Flat array of { id, no, en, noNorm, enNorm, cefr, audio }
let sentenceIndex = null; // Map<string, Uint32Array | number[]>

// Map incoming CSV headers to the app’s canonical keys
const SCHEMA_MAP = {
  ord: "word",
  wordAudio: "wordAudio",
  engelsk: "English",
  CEFR: "CEFR",
  gender: "gender",
  uttale: "pronunciation",
  etymologi: "region",
  definisjon: "definition",
  eksempel: "example",
  sentenceAudio: "sentenceAudio",
  sentenceTranslation: "sentenceTranslation",
  transliteration: "transliteration", // optional extra; stored for future use
};

// Function to show or hide the landing card
function showLandingCard(show) {
  const landingCard = document.getElementById("landing-card");
  const main = document.querySelector("main");

  if (!landingCard || !main) return;

  if (show) {
    // Move the card back into main, if it’s inside resultsContainer
    if (landingCard.parentNode !== main) {
      landingCard.remove();
      main.insertBefore(
        landingCard,
        document.getElementById("results-container")
      );
    }
    landingCard.style.display = "block";
  } else {
    landingCard.style.display = "none";
  }
}

// Function to navigate back to the landing card when the site title is clicked
function returnToLandingPage() {
  const searchBar = document.getElementById("search-bar");
  if (searchBar) searchBar.value = "";
  selectType("words");
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

// Debounce function to limit how often search is triggered
function debounceSearchTrigger(func, delay) {
  clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(func, delay);
}

// Handle the key input, performing a search on 'Enter' or debouncing otherwise
function handleKey(event) {
  // Call search function when 'Enter' is pressed or debounce it otherwise
  debounceSearchTrigger(() => {
    if (event.key === "Enter") {
      search();
      console.log("Enter key detected, search triggered.");
    }
  }, 300); // Delay of 300ms before calling search()
}

function clearContainer() {
  const landingCard = document.getElementById("landing-card");
  const main = document.querySelector("main");

  // Park the landing card as resultsContainer's sibling in <main> -- the
  // same spot showLandingCard(true) itself puts it -- rather than inside
  // resultsContainer. Parking it inside only works as long as every later
  // render goes through a `+=`; the many spots that instead do a plain
  // `resultsContainer.innerHTML = ...` (error messages, random-sentence
  // rendering, ...) replace their *own* children, but a landing card
  // sitting inside as one of those children was being replaced right along
  // with them -- silently deleting it from the document for the rest of
  // the session, with no code path left that ever re-creates it. That's
  // what made switching to Words after Sentences render blank.
  if (landingCard && main && landingCard.parentNode !== main) {
    landingCard.remove();
    main.insertBefore(landingCard, resultsContainer);
  }

  resultsContainer.innerHTML = ""; // Clear everything else in the container
  clearVocabularyLoadingState();
}

function appendToContainer(content) {
  resultsContainer.innerHTML += content;
}

function formatDefinitionWithMultipleSentences(definition) {
  return definition
    .split(/(?<=[.!?])\s+/) // Split by sentence delimiters
    .map((sentence) => `<p class="example">${sentence}</p>`) // Wrap each sentence in a <p> tag
    .join(""); // Join them together into a string
}

function splitIntoSentences(text) {
  if (!text) return [];
  const arr = text.match(/[^.!?]+[.!?]*/g);
  return arr ? arr.map((s) => s.trim()) : [text.trim()];
}
function normalize(str) {
  return (str || "").toLowerCase().trim();
}

// Filter results based on selected part of speech (POS). The CSV's
// "gender" column actually holds the part of speech itself (noun, verb,
// adjective, ...) for this Japanese data, not grammatical gender.
function filterResultsByPOS(results, selectedPOS) {
  if (!selectedPOS) return results;

  return results.filter(
    (r) =>
      r.gender && r.gender.toLowerCase().startsWith(selectedPOS.toLowerCase())
  );
}

// Helper function to format the 'gender' column for display. It's named
// for grammatical gender (a leftover from this app's Spanish-language
// version), but here it just holds the part of speech.
function formatGender(gender) {
  return gender || "";
}

// Clear the search input field
function clearInput() {
  const searchEl = document.getElementById("search-bar");
  if (searchEl) {
    searchEl.value = "";
    searchEl.dataset.submittedStoryQuery = "";
  }

  const typeSelect = document.getElementById("type-select");
  if (typeSelect && typeSelect.value === "stories") {
    // Reset CEFR, Genre, and Favorites filters too
    const cefrEl = document.getElementById("cefr-select");
    const genreEl = document.getElementById("genre-select");
    const favoritesEl = document.getElementById("story-favorites-select");
    if (cefrEl) cefrEl.value = "";
    if (genreEl) genreEl.value = "";
    if (favoritesEl) favoritesEl.value = "";

    // Clearing filters/search on the Stories tab is the deliberate "give
    // me a fresh draw" gesture, so it's the one place that should actually
    // reroll the weighted ordering rather than just re-filtering it.
    reshuffleStoryOrder();
    displayStoryList();
  }
}

// Click handler for the magnifying-glass search button: search when there's
// a query, otherwise double as the random word/sentence generator the
// standalone Random button used to be. Ported from Norwegian's
// handleSearchButtonClick(), which removed that separate button entirely.
function handleSearchButtonClick() {
  const query = document.getElementById("search-bar").value.trim();

  if (query) {
    search();
    return;
  }

  const type = getCurrentMode();

  if (type === "word-list") {
    // Nothing to search or randomize here when the field is empty.
    return;
  }

  if (type === "stories") {
    // Same as clicking the clear (X) button: reset the filters and
    // reshuffle the story list, rather than searching for a word.
    clearInput();
    return;
  }

  randomWord();
  popChime.currentTime = 0;
  popChime.play();
}

// Fetch the dictionary data from the file or server
async function fetchAndLoadDictionaryData() {
  try {
    console.log("Attempting to load data from local CSV file...");
    const localResponse = await fetch("japaneseWords.csv");
    if (!localResponse.ok)
      throw new Error(`HTTP error! Status: ${localResponse.status}`);
    const localData = await localResponse.text();
    console.log("Data successfully loaded from local file.");
    parseCSVData(localData);
  } catch (localError) {
    console.error(
      "Error fetching or parsing data from local CSV file:",
      localError
    );
    console.log("Falling back to Google Sheets.");

    // Fallback to Google Sheets CSV
    try {
      const response = await fetch(
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vSl2GxGiiO3qfEuVM6EaAbx_AgvTTKfytLxI1ckFE6c35Dv8cfYdx30vLbPPxadAjeDaSBODkiMMJ8o/pub?output=csv"
      );
      if (!response.ok)
        throw new Error(`HTTP error! Status: ${response.status}`);
      const data = await response.text();
      parseCSVData(data); // Use PapaParse for CSV parsing
    } catch (googleSheetsError) {
      console.error(
        "Error fetching or parsing data from Google Sheets:",
        googleSheetsError
      );
    }
  }
}

// Parse the CSV data using PapaParse
function parseCSVData(data) {
  Papa.parse(data, {
    header: true,
    skipEmptyLines: true,
    complete: function (resultsFromParse) {
      const rows = resultsFromParse.data || [];

      results = rows.map((raw) => {
        const get = (canon) => {
          const key = SCHEMA_MAP[canon];
          if (!key) return "";
          return (raw[key] ?? "").toString().trim();
        };

        // Base object in canonical shape the rest of the app expects
        const entry = {
          ord: get("ord"),
          engelsk: get("engelsk"),
          CEFR: get("CEFR").toUpperCase(),
          gender: get("gender"), // will be formatted later
          uttale: get("uttale"), // empty for ES
          etymologi: get("etymologi"), // empty for ES
          definisjon: get("definisjon"),
          eksempel: get("eksempel"),
          sentenceTranslation: get("sentenceTranslation"),
          wordAudio: get("wordAudio"),
          sentenceAudio: get("sentenceAudio"),
          region: get("region"),
        };

        // Defensive trims
        entry.ord = entry.ord.trim();

        return entry;
      });
      buildSentenceCorpus();
      buildSentenceIndex();
      console.log("Parsed and cleaned data:", results);
    },
    error: function (error) {
      console.error("Error parsing CSV:", error);
    },
  });
}

function buildSentenceCorpus() {
  sentenceCorpus = [];
  let id = 0;
  for (const r of results) {
    const noList = splitIntoSentences(r.eksempel);
    const enList = splitIntoSentences(r.sentenceTranslation || "");
    const n = Math.max(noList.length, enList.length);
    for (let i = 0; i < n; i++) {
      const no = noList[i] || "";
      const en = enList[i] || "";
      if (!no && !en) continue;
      sentenceCorpus.push({
        id: id++,
        no,
        en,
        noNorm: normalize(no),
        enNorm: normalize(en),
        cefr: (r.CEFR || "").toUpperCase(),
        audio: r.sentenceAudio === "X",
      });
    }
  }
  console.log(
    `[Sentences] Corpus built: ${sentenceCorpus.length} sentence rows`
  );
}

function tokenize(text) {
  // Unicode letters.
  const m = text.match(/\p{L}+/gu);
  return m ? m.map((w) => w.toLowerCase()) : [];
}

function buildSentenceIndex() {
  console.time("[Sentences] build index");
  const idx = new Map();
  for (const row of sentenceCorpus) {
    const seen = new Set();
    for (const tok of [...tokenize(row.noNorm), ...tokenize(row.enNorm)]) {
      if (tok.length === 0) continue;
      if (seen.has(tok)) continue; // avoid dup adds for same row
      seen.add(tok);
      let postings = idx.get(tok);
      if (!postings) {
        postings = [];
        idx.set(tok, postings);
      }
      postings.push(row.id);
    }
  }
  // Optionally compact to typed arrays if large
  for (const [k, list] of idx) {
    if (list.length > 1024) idx.set(k, Uint32Array.from(list));
  }
  sentenceIndex = idx;
  console.timeEnd("[Sentences] build index");
  console.log(`[Sentences] index terms: ${idx.size}`);
}

// Shared feedback-form config -- exact same Google Form/field this app's
// own flagMissingWordEntry (below) already used, before this ported,
// larger system replaced its body. One shared inbox across every
// language-app sibling, apparently by design (see noRandom.js's original
// leftover-Spanish-list situation earlier this session for the flip side
// of that convention -- copy/paste across siblings, not always kept in
// sync -- but this specific form/field was already correct here).
const FEEDBACK_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdMpnbI2DyUo6SWBRR53ZnYucDPdAYXK9rksP3AhMrC7b91Dw/formResponse";
const FEEDBACK_FORM_FIELD_ID = "entry.279285583";

const FEEDBACK_CATEGORIES = [
  "Japanese word or spelling",
  "English translation",
  "Part of speech / word class",
  "Word inflections",
  "CEFR level seems wrong",
  "Japanese example sentence",
  "English sentence translation",
  "Word audio",
  "Sentence audio",
  "Something else",
];

const STORY_FEEDBACK_CATEGORIES = [
  "Japanese story text",
  "English translation",
  "Story audio",
  "Story image",
  "CEFR level seems wrong",
  "Something else",
];

const GENERAL_FEEDBACK_CATEGORIES = [
  "Bug or technical issue",
  "Feature request or suggestion",
  "Something is confusing",
  "General feedback or compliment",
  "Something else",
];

// The form/field above is shared with the Norwegian app (and any future
// language sibling) — one inbox, every language's reports mixed together.
// A leading language tag is the only thing that lets a reviewer tell them
// apart in the responses sheet, so it's prepended here, at the single
// point every report (missing-word flags and full feedback-dialog
// submissions alike) funnels through, rather than in each caller.
function submitUserFeedback(message) {
  const formData = new FormData();
  formData.append(FEEDBACK_FORM_FIELD_ID, `JA - ${message}`);

  return fetch(FEEDBACK_FORM_URL, {
    method: "POST",
    body: formData,
    mode: "no-cors", // Necessary to avoid CORS issues
  });
}

function buildFeedbackMessage({
  source,
  word,
  pos,
  cefr,
  prompt,
  category,
  userAnswer,
  details,
}) {
  const parts = [];

  if (word) {
    const attributes = [pos, cefr].filter(Boolean).join(", ");
    // Reports tied to an existing entry start with its headword so they sort
    // naturally in form responses. The -update marker distinguishes these
    // reports from bare missing-word submissions.
    const entryPrefix = source ? `${word}-update ${source}` : word;
    parts.push(attributes ? `${entryPrefix} (${attributes})` : entryPrefix);
  } else if (source) {
    parts.push(source);
  }

  if (prompt) {
    // What the learner actually saw and had to translate/complete — the
    // English meaning for a reverse-typed question, or the sentence with
    // its blank for a cloze one. "word" above is the target Japanese
    // answer, which for a reverse question isn't itself what was shown, so
    // a reviewer judging "should this answer have been accepted" needs
    // this to know what prompted it in the first place.
    parts.push(`— Shown: "${prompt}"`);
  }

  if (category) {
    // "Category" rather than "Issue" — general feedback covers things
    // like feature requests and compliments, not just problems.
    parts.push(`— Category: ${category}`);
  }

  if (userAnswer) {
    parts.push(`— Learner answered: "${userAnswer}"`);
  }

  if (details) {
    parts.push(`— "${details}"`);
  }

  return parts.join(" ");
}

function flagMissingWordEntry(word) {
  // Unlike every other report type, this goes to the form as the bare
  // word — no brackets, category, or quoting — since the form's one
  // field is otherwise treated as a simple "missing word" list.
  submitUserFeedback(word)
    .then(() => {
      alert(`The word "${word}" has been flagged successfully!`);
    })
    .catch((error) => {
      console.error("Error flagging the word:", error);
      alert("There was an issue flagging this word. Please try again later.");
    });
}

function openWordCardFeedbackDialog(
  triggerElement,
  word,
  pos,
  cefr,
  initialCategory,
) {
  openFeedbackDialog({
    source: "Word Card",
    word,
    pos,
    cefr,
    initialCategory,
    triggerElement,
  });
}

// Site-wide feedback, not scoped to any one word/story/question — reachable
// from the footer on every page.
function openGeneralFeedbackDialog(triggerElement) {
  openFeedbackDialog({
    source: "General Feedback",
    categories: GENERAL_FEEDBACK_CATEGORIES,
    dialogTitle: "Share Your Feedback",
    categoryQuestion: "What's This About?",
    detailsPlaceholder: "Tell us more (optional)",
    successMessage: "Thanks — your feedback was sent.",
    triggerElement,
  });
}

let feedbackDialogTriggerElement = null;

function handleFeedbackDialogKeydown(event) {
  if (event.key === "Escape") {
    closeFeedbackDialog();
    return;
  }

  // aria-modal="true" claims background content is inert to assistive tech,
  // but nothing enforced that for a sighted keyboard user — Tab could walk
  // straight past the dialog's own controls into the page behind it. Cycle
  // focus between the dialog's first and last focusable elements instead.
  if (event.key === "Tab") {
    const dialog = document.querySelector(".feedback-dialog");
    if (!dialog) return;

    const focusable = dialog.querySelectorAll(
      "button:not([disabled]), select, textarea, input, [tabindex]:not([tabindex='-1'])",
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function closeFeedbackDialog() {
  const overlay = document.querySelector(".feedback-dialog-overlay");
  if (!overlay) return;

  overlay.remove();
  document.removeEventListener("keydown", handleFeedbackDialogKeydown);

  if (
    feedbackDialogTriggerElement &&
    typeof feedbackDialogTriggerElement.focus === "function"
  ) {
    feedbackDialogTriggerElement.focus();
  }
  feedbackDialogTriggerElement = null;
}

// One shared "report an issue" dialog, reused by the word card, the word
// game, and individual stories. `source` identifies where the report came
// from (e.g. "Word Card", "Word Game · Cloze", "Story") and, along with
// `word`/`pos`/`cefr`, is folded into the single message string sent to
// the form. `categories` lets each caller show issue types relevant to
// its own content (a story has no "word audio" to report, for instance).
function openFeedbackDialog({
  source,
  word,
  pos,
  cefr,
  prompt,
  showWordInTitle = true,
  categories = FEEDBACK_CATEGORIES,
  dialogTitle,
  categoryQuestion = "What's the Issue?",
  detailsPlaceholder = "What's wrong, exactly?",
  successMessage = "Thanks — your report was sent.",
  initialCategory,
  userAnswer,
  triggerElement,
}) {
  // Only one report dialog should ever be open at a time.
  closeFeedbackDialog();

  feedbackDialogTriggerElement = triggerElement || null;

  const overlay = document.createElement("div");
  overlay.className = "feedback-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "feedback-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "feedback-dialog-title");
  dialog.tabIndex = -1;

  const title = document.createElement("h3");
  title.id = "feedback-dialog-title";
  title.textContent =
    dialogTitle ||
    (word && showWordInTitle
      ? `Report an Issue With "${word}"`
      : "Report an Issue With This Question");
  dialog.appendChild(title);

  const categoryLabel = document.createElement("label");
  categoryLabel.className = "feedback-dialog-label";
  categoryLabel.htmlFor = "feedback-dialog-category";
  categoryLabel.textContent = categoryQuestion;
  dialog.appendChild(categoryLabel);

  const categorySelect = document.createElement("select");
  categorySelect.id = "feedback-dialog-category";
  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categorySelect.appendChild(option);
  });
  if (initialCategory && categories.includes(initialCategory)) {
    categorySelect.value = initialCategory;
  }
  dialog.appendChild(categorySelect);

  const detailsLabel = document.createElement("label");
  detailsLabel.className = "feedback-dialog-label";
  detailsLabel.htmlFor = "feedback-dialog-details";
  detailsLabel.textContent = "Details (Optional)";
  dialog.appendChild(detailsLabel);

  const detailsTextarea = document.createElement("textarea");
  detailsTextarea.id = "feedback-dialog-details";
  detailsTextarea.rows = 3;
  detailsTextarea.placeholder = detailsPlaceholder;
  dialog.appendChild(detailsTextarea);

  const status = document.createElement("p");
  status.className = "feedback-dialog-status";
  dialog.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "feedback-dialog-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "feedback-dialog-cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", closeFeedbackDialog);

  const submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "feedback-dialog-submit";
  submitButton.textContent = "Send";

  submitButton.addEventListener("click", () => {
    const category = categorySelect.value;
    const details = detailsTextarea.value.trim();

    if (category === "Something else" && !details) {
      status.textContent = "Please add a few details.";
      status.classList.add("feedback-dialog-status-error");
      detailsTextarea.focus();
      return;
    }

    submitButton.disabled = true;
    cancelButton.disabled = true;
    status.classList.remove("feedback-dialog-status-error");
    status.textContent = "Sending…";

    submitUserFeedback(
      buildFeedbackMessage({
        source,
        word,
        pos,
        cefr,
        prompt,
        category,
        userAnswer,
        details,
      }),
    )
      .then(() => {
        status.textContent = successMessage;
        setTimeout(closeFeedbackDialog, 1400);
      })
      .catch((error) => {
        console.error("Error sending feedback:", error);
        status.textContent = "Something went wrong. Please try again.";
        status.classList.add("feedback-dialog-status-error");
        submitButton.disabled = false;
        cancelButton.disabled = false;
      });
  });

  actions.appendChild(cancelButton);
  actions.appendChild(submitButton);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeFeedbackDialog();
    }
  });

  document.body.appendChild(overlay);
  document.addEventListener("keydown", handleFeedbackDialogKeydown);

  // Programmatically focusing a native <select> can immediately open its
  // full-screen picker on mobile, making the report button appear to skip
  // past the dialog. Put initial focus on the dialog itself at the same
  // compact breakpoint used by the Word Game toolbar; desktop keeps the
  // convenient direct focus on the category field.
  const usesCompactFeedbackDialog = window.matchMedia?.(
    "(max-width: 1024px)",
  ).matches;
  (usesCompactFeedbackDialog ? dialog : categorySelect).focus();
}

// Generate and display a random word or sentence
async function randomWord() {
  const now = Date.now();
  const cooldownPeriod = 250; // Cooldown period in milliseconds (0.25 seconds)

  // Initialize lastCallTimestamp as a property of randomWord if it doesn't exist
  if (!randomWord.lastCallTimestamp) {
    randomWord.lastCallTimestamp = 0;
  }

  // Check if enough time has passed since the last call
  if (now - randomWord.lastCallTimestamp < cooldownPeriod) {
    console.warn("Please wait a moment before trying again.");
    return; // Exit the function if the cooldown period hasn't passed
  }

  randomWord.lastCallTimestamp = now; // Update the timestamp for the last call

  const type = document.getElementById("type-select").value;
  const selectedPOS = document.getElementById("pos-select")
    ? document.getElementById("pos-select").value.toLowerCase()
    : "";
  const selectedCEFR = document.getElementById("cefr-select")
    ? document.getElementById("cefr-select").value.toUpperCase()
    : "";

  // Ensure that the 'results' array is populated
  if (!results || !results.length) {
    console.warn("No results available to pick a random word or sentence.");
    document.getElementById("results-container").innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">Unavailable Entry</span>
                </h2>
                <p>No random entries available. Please try again later.</p>
            </div>
        `;
    hideSpinner();
    return;
  }

  showSpinner();
  clearInput(); // Clear search bar when generating a random word or sentence
  showLandingCard(false);
  clearContainer();

  let filteredResults;

  if (type === "sentences") {
    // Filter results that contain example sentences (for the 'sentences' type)
    filteredResults = results.filter((r) => r.eksempel); // Assuming sentences are stored under the 'eksempel' key

    // Additionally, filter by the selected CEFR level if applicable
    filteredResults = filteredResults.filter(
      (r) => !selectedCEFR || (r.CEFR && r.CEFR.toUpperCase() === selectedCEFR)
    );
  } else if (type === "pronunciation") {
    initPronunciation();
    hideSpinner();
    return; // ✅ stop here, pronunciation handles itself
  } else {
    // Filter results by the selected part of speech (for 'words' type)
    filteredResults = filterResultsByPOS(results, selectedPOS);

    // Additionally, filter by the selected CEFR level if applicable
    filteredResults = filteredResults.filter(
      (r) => !selectedCEFR || (r.CEFR && r.CEFR.toUpperCase() === selectedCEFR)
    );

    // Exclude certain words here
    filteredResults = filteredResults.filter(
      (r) => !noRandom.includes(r.ord.toLowerCase())
    );
  }

  if (!filteredResults.length) {
    console.warn("No random entries available for the selected type.");
    document.getElementById("results-container").innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">Unavailable Entry</span>
                </h2>
                <p>No random entries available. Try selecting another type or part of speech.</p>
            </div>
        `;
    return;
  }

  // Randomly select a result from the filtered results
  const randomResult =
    filteredResults[Math.floor(Math.random() * filteredResults.length)];

  // Reset old highlights by removing any previous span tags
  randomResult.eksempel = randomResult.eksempel
    ? randomResult.eksempel.replace(/<span[^>]*>(.*?)<\/span>/gi, "$1")
    : "";

  // Generate CEFR label based on the result's CEFR value
  let cefrLabel = "";
  if (randomResult.CEFR === "A1") {
    cefrLabel = '<div class="sentence-cefr-label easy">A1</div>';
  } else if (randomResult.CEFR === "A2") {
    cefrLabel = '<div class="sentence-cefr-label easy">A2</div>';
  } else if (randomResult.CEFR === "B1") {
    cefrLabel = '<div class="sentence-cefr-label medium">B1</div>';
  } else if (randomResult.CEFR === "B2") {
    cefrLabel = '<div class="sentence-cefr-label medium">B2</div>';
  } else if (randomResult.CEFR === "C") {
    cefrLabel = '<div class="sentence-cefr-label hard">C</div>';
  } else {
    console.warn("CEFR value is missing for this entry:", randomResult);
  }

  if (type === "sentences") {
    // Split the Japanese and English sentences
    const sentences = randomResult.eksempel.split(/(?<=[.!?])\s+/); // Split by sentence delimiters
    const translations = randomResult.sentenceTranslation
      ? randomResult.sentenceTranslation.split(/(?<=[.!?])\s+/)
      : [];

    // Randomly select one sentence and its translation
    const randomIndex = Math.floor(Math.random() * sentences.length);
    const selectedSentence = sentences[randomIndex];
    const selectedTranslation = translations[randomIndex] || "";

    // Clear any existing highlights in the sentence
    const cleanedSentence = selectedSentence.replace(
      /<span style="color: #3c88d4;">(.*?)<\/span>/gi,
      "$1"
    );

    // Build the sentence HTML
    let sentenceHTML = `
            <div class="result-header">
                <h2>Random Sentence</h2>
            </div>
            <button class="sentence-btn english-toggle-btn" onclick="toggleEnglishTranslations(this)">
                ${isEnglishVisible ? "Hide English" : "Show English"}
            </button>
            <div class="sentence-container">
                <div class="sentence-box-norwegian ${
                  !isEnglishVisible ? "sentence-box-norwegian-hidden" : ""
                }">
            <div class="sentence-content">
            <div class="cefr-audio-block">
              ${cefrLabel}
              ${
                randomResult.sentenceAudio === "X"
                  ? `<i class="fas fa-volume-up sentence-audio-icon"
                        data-sentence="${cleanedSentence
                          .replace(/<[^>]*>/g, "")
                          .trim()}"></i>`
                  : ""
              }
            </div>
              <p class="sentence">${cleanedSentence}</p>
            </div>
                </div>
        `;

    if (selectedTranslation) {
      sentenceHTML += `
        <div class="sentence-box-english ${isEnglishVisible ? "" : "hidden"}">
                    <p class="sentence">${selectedTranslation}</p>
                </div>
            `;
    }
    sentenceHTML += "</div>"; // Close the sentence-container div
    document.getElementById("results-container").innerHTML = sentenceHTML;
  } else if (type === "pronunciation") {
    initPronunciation();
    hideSpinner();
    return; // ✅ stop here, pronunciation handles itself
  } else {
    // Update the URL to include the random word's info
    updateURL("", type, randomResult.gender, null, randomResult.ord);
    // If it's a word, render it with highlighting (if needed)
    displaySearchResults([randomResult], randomResult.ord);
  }
  hideSpinner(); // Hide the spinner
}

// Comprehensive Japanese inexact-match generator
function generateInexactMatches(query) {
  const q = query.toLowerCase().trim();
  const variations = new Set([q]);

  // --- 1. Inflectional suffixes (nouns, adjectives, verbs) ---
  const suffixes = [
    // singular noun/adjective endings
    "a",
    "e",
    "i",
    "o",
    "u",
    "om",
    "em",
    "u",
    "om",
    "omu",
    "oga",
    "ega",
    // plural endings
    "ama",
    "ima",
    "ovima",
    "evima",
    "ovima",
    "ima",
    "ovi",
    "evi",
    "i",
    "e",
    // genitive/locative endings
    "ih",
    "ama",
    "ima",
    "ima",
    "ima",
    "ama",
    "ima",
    // verb person/tense endings
    "m",
    "š",
    "mo",
    "te",
    "ju",
    "ći",
    "la",
    "lo",
    "li",
    "le",
    "o",
    "ao",
    "eo",
    "io",
  ];
  suffixes.forEach((suf) => {
    if (q.endsWith(suf) && q.length > suf.length + 2) {
      variations.add(q.slice(0, -suf.length));
    }
  });

  // --- 2. Derivational adjective alternations ---
  // Map of frequent adjectival endings → stem alternations
  const alternations = [
    // --- Adjective/adverb alternations ---
    { from: "nih", to: "an" }, // spolnih → spolan, glavnih → glavan
    { from: "ni", to: "an" }, // spolni → spolan
    { from: "ni", to: "en" }, // javni → javen
    { from: "no", to: "an" }, // sustavno → sustavan, glasno → glasan
    { from: "no", to: "en" }, // mirno → miren
    { from: "no", to: "in" }, // tiho → tih / tišin- (approximates)
    // --- Other derivational adjective endings ---
    { from: "ski", to: "ak" }, // ljudski → ljudak
    { from: "ski", to: "an" }, // morski → moran
    { from: "ški", to: "aš" }, // bošnjački → bošnjak
    { from: "čki", to: "ak" }, // dječački → dječak
    { from: "asti", to: "ast" }, // robustni → robustan
    // --- Verb stems ---
    { from: "ati", to: "" }, // raditi → rad
    { from: "jeti", to: "je" }, // htjeti → htje
    { from: "ći", to: "" }, // ići → i
    { from: "oga", to: "" }, // genitive adjectives (novoga → nov)
  ];
  alternations.forEach(({ from, to }) => {
    if (q.endsWith(from) && q.length > from.length + 2) {
      variations.add(q.slice(0, -from.length) + to);
    }
  });

  // --- 3. Final vowel normalization (broad recall) ---
  // Handles cases like "spoln" → "spolan", "glavn" → "glavan"
  const withFinal = Array.from(variations);
  withFinal.forEach((base) => {
    if (base.endsWith("n")) variations.add(base + "an");
    if (base.endsWith("r")) variations.add(base + "ar");
    if (base.endsWith("v")) variations.add(base + "an");
  });

  // --- 4. Deduplication and return ---
  return Array.from(variations);
}
// Perform a search based on the input query and selected POS
async function search(queryOverride = null, options = {}) {
  const { updateHistory = true, sentenceResultSubtitle = "" } = options;
  const originalQuery =
    queryOverride ||
    document.getElementById("search-bar").value.toLowerCase().trim();

  document.getElementById("search-bar").dataset.originalQuery = originalQuery; // 👈 this line
  // Try to find a base form in the dataset
  const variations = generateInexactMatches(originalQuery);
  const selector = document.getElementById("type-select").value;
  const query =
    selector === "sentences"
      ? originalQuery
      : variations.find((base) =>
          results.some((r) => {
            const ordList = r.ord
              .toLowerCase()
              .split(",")
              .map((s) => s.trim());
            const engelskList = r.engelsk
              .toLowerCase()
              .split(",")
              .map((s) => s.trim());
            return ordList.includes(base) || engelskList.includes(base);
          })
        ) || originalQuery;
  const isInexactMatch = originalQuery !== query;

  console.log("Search triggered with query:", query);
  const selectedPOS = document.getElementById("pos-select")
    ? document.getElementById("pos-select").value.toLowerCase()
    : "";
  const selectedCEFR = document.getElementById("cefr-select")
    ? document.getElementById("cefr-select").value.toUpperCase()
    : ""; // Fetch the selected CEFR level
  const type = document.getElementById("type-select").value; // Get the search type (words or sentences)
  const normalizedQueries = [query.toLowerCase().trim()]; // Use only the base query for matching

  // Build the "No Matches" message based on filters
  const filterMessage = [];
  if (selectedPOS) filterMessage.push(`word class of "${selectedPOS}"`);
  if (selectedCEFR) filterMessage.push(`CEFR level "${selectedCEFR}"`);
  const filtersText =
    filterMessage.length > 0 ? ` with the ${filterMessage.join(" and ")}` : "";

  // Clear any previous highlights by resetting the `query`
  let cleanResults = results.map((result) => {
    if (result.eksempel) {
      result.eksempel = result.eksempel.replace(
        /<span[^>]*>(.*?)<\/span>/gi,
        "$1"
      ); // Remove old highlights
    }
    return result;
  });

  cleanURL(type);

  // Update the URL with the search parameters
  if (updateHistory) {
    updateURL(query, type, selectedPOS); // <--- Trigger URL update
  }

  // Show the spinner at the start of the search
  showSpinner();

  showLandingCard(false);
  clearContainer(); // Clear previous results

  let matchingResults;

  if (type === "stories") {
    // Keep an explicit submitted value. The Stories input can hold a new
    // query while the current list remains stable until Enter/search (see
    // displayStoryList's searchText, stories.js).
    document.getElementById("search-bar").dataset.submittedStoryQuery = query;

    // If query is empty, display all stories
    if (!query) {
      matchingResults = storyResults;
    } else {
      // Filter stories based on the query in both 'titleJapanese' and 'titleEnglish'
      matchingResults = storyResults.filter((story) => {
        const japaneseTitleMatch = story.titleJapanese
          .toLowerCase()
          .includes(query);
        const englishTitleMatch = story.titleEnglish
          .toLowerCase()
          .includes(query);
        return japaneseTitleMatch || englishTitleMatch;
      });
    }

    // Render the matching stories
    displayStoryList(matchingResults);
  } else if (type === "sentences") {
    if (!query) {
      resultsContainer.innerHTML = `
      <div class="definition error-message">
        <h2 class="word-gender">Error <div class="gender">Empty Search</div></h2>
        <p>Please enter a word in the search field before searching.</p>
      </div>`;
      hideSpinner();
      return;
    }

    // Safety: ensure index exists
    if (!sentenceIndex || !sentenceCorpus.length) {
      buildSentenceCorpus();
      buildSentenceIndex();
    }

    console.time("[Sentences] query");
    const terms = normalize(query).split(/\s+/).filter(Boolean);

    let ids = null;
    for (const t of terms) {
      const indexedMatch = sentenceIndex.get(t) || [];
      let asArray = ArrayBuffer.isView(indexedMatch)
        ? Array.from(indexedMatch)
        : indexedMatch;

      // Japanese normally has no spaces between words, so the token index
      // contains a whole sentence such as「あそこに立っている人」rather
      // than a separate posting for「人」. Fall back to a lightweight
      // substring scan when a term has no direct posting. This keeps English
      // searches on the fast token index while making kanji, hiragana, and
      // katakana searches behave as learners expect.
      if (asArray.length === 0) {
        asArray = sentenceCorpus
          .filter((row) => row.noNorm.includes(t) || row.enNorm.includes(t))
          .map((row) => row.id);
      }
      ids =
        ids === null
          ? new Set(asArray)
          : new Set(asArray.filter((x) => ids.has(x)));
    }

    // If nothing matched, default to empty
    if (!ids || ids.size === 0) {
      ids = [];
    }

    // Materialize rows
    const rowsAll = [];
    for (const sid of ids) rowsAll.push(sentenceCorpus[sid]);

    // Apply CEFR filter if set
    const selectedCEFR = document.getElementById("cefr-select")
      ? document.getElementById("cefr-select").value.toUpperCase()
      : "";
    const rowsFiltered = selectedCEFR
      ? rowsAll.filter((r) => r.cefr === selectedCEFR)
      : rowsAll;

    // Prefer exact phrase matches first, then multi-word partials
    const exact = [];
    const partial = [];
    for (const r of rowsFiltered) {
      const inOrder =
        r.noNorm.includes(normalize(query)) ||
        r.enNorm.includes(normalize(query));
      if (inOrder) {
        exact.push(r);
      } else {
        // fallback: all words must still appear somewhere
        const matchesAll = terms.every(
          (t) => r.noNorm.includes(t) || r.enNorm.includes(t)
        );
        if (matchesAll) {
          partial.push(r);
        }
      }
    } // CEFR order for sorting
    const cefrOrder = { A1: 1, A2: 2, B1: 3, B2: 4, C: 5 };

    // Sort helper: lower CEFR first, then leave relative order intact
    function sortByCEFR(arr) {
      return arr.sort((a, b) => {
        const aVal = cefrOrder[a.cefr] || 99;
        const bVal = cefrOrder[b.cefr] || 99;
        return aVal - bVal;
      });
    }

    // Exact matches first, then partials, each CEFR-ordered. Rendering caps
    // how many show at once (SEARCH_RESULTS_BATCH_SIZE) behind a "Show More
    // Results" button rather than capping the match set itself here.
    let combined = [];
    if (exact.length) {
      combined = sortByCEFR(exact).concat(sortByCEFR(partial));
    } else {
      combined = sortByCEFR(partial);
    }

    renderSentenceMatchesFromCorpus(combined, query, terms, {
      sentenceResultSubtitle,
    });

    console.timeEnd("[Sentences] query");
    hideSpinner();
    return;
  } else {
    // Handle empty search query
    if (!query) {
      resultsContainer.innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">Empty Search</span>
                </h2>
                <p>Please enter a word in the search field before searching.</p>
            </div>
        `;
      hideSpinner();
      return;
    }

    // Filter results by query and selected POS for words
    matchingResults = cleanResults.filter((r) => {
      // Exact and partial match logic
      const matchesQuery = normalizedQueries.some((variation) => {
        const exactRegex = new RegExp(`\\b${variation}\\b`, "i"); // Exact match regex for whole word
        const partialRegex = new RegExp(variation, "i"); // Partial match for larger words like "bevegelsesfrihet"
        const wordMatch =
          exactRegex.test(r.ord.toLowerCase()) ||
          partialRegex.test(r.ord.toLowerCase());
        const englishValues = r.engelsk
          .toLowerCase()
          .split(",")
          .map((e) => e.trim());
        const englishMatch = englishValues.some(
          (eng) => exactRegex.test(eng) || partialRegex.test(eng)
        );
        return wordMatch || englishMatch;
      });

      // Handle POS filtering
      return (
        matchesQuery &&
        (!selectedPOS || r.gender.toLowerCase().includes(selectedPOS)) &&
        (!selectedCEFR || r.CEFR === selectedCEFR)
      );
    });

    matchingResults = prioritizeResults(matchingResults, query, "ord");

    if (matchingResults.length === 1) {
      // Update URL and title for a single result
      const singleResult = matchingResults[0];
      updateURL(null, type, selectedPOS, null, singleResult.ord); // Set word parameter with the result's Japanese term
      // Display this single result directly
      displaySearchResults([singleResult]); // Display only this single result
      hideSpinner(); // Hide the spinner
      return;
    }

    if (matchingResults.length > 1) {
      latestMultipleResults = query;
      console.log("Stored latestMultipleResults:", latestMultipleResults);
    } else {
      latestMultipleResults = null;
    }

    // Check if there are **no exact matches**
    const noExactMatches = matchingResults.length === 0;

    // If no exact matches are found, find inexact matches
    if (noExactMatches || isInexactMatch) {
      // Generate inexact matches based on transformations
      const inexactWordQueries = generateInexactMatches(query);
      console.log(`Inexact Queries Generated: ${inexactWordQueries}`);

      // Now search for results using these inexact queries
      let inexactWordMatches = results.filter((r) => {
        const matchesInexact = inexactWordQueries.some(
          (inexactQuery) =>
            r.ord.toLowerCase().includes(inexactQuery) ||
            r.engelsk.toLowerCase().includes(inexactQuery)
        );
        return (
          matchesInexact &&
          (!selectedPOS || r.gender.toLowerCase().includes(selectedPOS)) &&
          (!selectedCEFR || r.CEFR === selectedCEFR)
        );
      });

      // 🧠 Sort the inexact matches using the same prioritization logic
      inexactWordMatches = prioritizeResults(inexactWordMatches, query, "ord");

      // ✂️ Limit to 10 results after sorting
      inexactWordMatches = inexactWordMatches.slice(0, 10);

      // Display the "No Exact Matches" message
      resultsContainer.innerHTML = `
                <div class="definition error-message">
                    <h2 class="word-gender">
                        No Exact Matches Found
                    </h2>
                    <p>We couldn't find exact matches for "${originalQuery}"${filtersText}. Here are some inexact results:</p>
                      ${
                        !selectedPOS && !selectedCEFR
                          ? `
                        <button class="landing-card-btn">
                          <i class="fas fa-flag"></i> Flag Missing Word Entry
                        </button>`
                          : ""
                      }
                </div>
            `;

      // Add flag button functionality
      const flagButton = document.querySelector(".landing-card-btn");
      if (flagButton) {
        flagButton.addEventListener("click", function () {
          const searchBar = document.getElementById("search-bar");
          const wordToFlag = searchBar.dataset.originalQuery || searchBar.value;
          flagMissingWordEntry(wordToFlag);
        });
      }

      // If inexact matches are found, display them below the message
      if (inexactWordMatches.length > 0) {
        displaySearchResults(inexactWordMatches);

        // Reattach the flag button functionality AFTER rendering the search results
        const flagButton = document.querySelector(".landing-card-btn");
        if (flagButton) {
          flagButton.addEventListener("click", function () {
            const searchBar = document.getElementById("search-bar");
            const wordToFlag =
              searchBar.dataset.originalQuery || searchBar.value;
            flagMissingWordEntry(wordToFlag);
          });
        }
      } else {
        clearContainer();
        appendToContainer(`
            <div class="definition error-message">
                <h2 class="word-gender">No Matches Found</h2>
                <p>We couldn't find any matches for "${query}"${filtersText}.</p>
                    ${
                      !selectedPOS && !selectedCEFR
                        ? `
                      <button class="landing-card-btn">
                        <i class="fas fa-flag"></i> Flag Missing Word Entry
                      </button>`
                        : ""
                    }
            </div>`);

        const flagButton = document.querySelector(".landing-card-btn");
        if (flagButton) {
          flagButton.addEventListener("click", function () {
            const searchBar = document.getElementById("search-bar");
            const wordToFlag =
              searchBar.dataset.originalQuery || searchBar.value;
            flagMissingWordEntry(wordToFlag);
          });
        }
      }

      hideSpinner();
      return;
    }

    // Prioritization logic for words (preserving the exact behavior)
    matchingResults = matchingResults.sort((a, b) => {
      const queryLower = query.toLowerCase();

      // 1. Prioritize exact match in the Japanese or English term
      const isExactMatchA =
        a.ord
          .toLowerCase()
          .split(",")
          .map((str) => str.trim())
          .includes(queryLower) ||
        a.engelsk
          .toLowerCase()
          .split(",")
          .map((str) => str.trim())
          .includes(queryLower);
      const isExactMatchB =
        b.ord.toLowerCase() === queryLower ||
        b.engelsk
          .toLowerCase()
          .split(",")
          .map((str) => str.trim())
          .includes(queryLower);
      if (isExactMatchA && !isExactMatchB) {
        return -1;
      }
      if (!isExactMatchA && isExactMatchB) {
        return 1;
      }

      // 2. Prioritize by CEFR level if both English translations or Japanese words are identical
      const cefrOrder = { A1: 1, A2: 2, B1: 3, B2: 4, C: 5 };
      const aCEFRValue = cefrOrder[a.CEFR] || 99; // Use high default if CEFR is missing
      const bCEFRValue = cefrOrder[b.CEFR] || 99;

      // Check for identical English translations
      const aEngelskSet = new Set(
        a.engelsk
          .toLowerCase()
          .split(",")
          .map((e) => e.trim())
      );
      const bEngelskSet = new Set(
        b.engelsk
          .toLowerCase()
          .split(",")
          .map((e) => e.trim())
      );
      const commonTranslations = [...aEngelskSet].filter((eng) =>
        bEngelskSet.has(eng)
      );

      if (commonTranslations.length > 0) {
        if (aCEFRValue !== bCEFRValue) {
          return aCEFRValue - bCEFRValue; // Lower CEFR value appears first
        }
      }

      // Check for identical Japanese words
      if (a.ord.toLowerCase() === b.ord.toLowerCase()) {
        if (aCEFRValue !== bCEFRValue) {
          return aCEFRValue - bCEFRValue; // Lower CEFR value appears first
        }
      }

      // 3. Prioritize whole word match (even if part of a phrase or longer sentence)
      const aWords = a.ord
        .toLowerCase()
        .split(",")
        .map((s) => s.trim());
      const bWords = b.ord
        .toLowerCase()
        .split(",")
        .map((s) => s.trim());

      const aHasExactWord = aWords.includes(queryLower);
      const bHasExactWord = bWords.includes(queryLower);
      if (aHasExactWord && !bHasExactWord) {
        return -1;
      }
      if (!aHasExactWord && bHasExactWord) {
        return 1;
      }

      // 4. Prioritize exact match in the comma-separated list of English definitions
      const aIsInCommaList = a.engelsk
        .toLowerCase()
        .split(",")
        .map((str) => str.trim())
        .includes(queryLower);
      const bIsInCommaList = b.engelsk
        .toLowerCase()
        .split(",")
        .map((str) => str.trim())
        .includes(queryLower);
      if (aIsInCommaList && !bIsInCommaList) {
        return -1;
      }
      if (!aIsInCommaList && bIsInCommaList) {
        return 1;
      }

      // 5. Deprioritize compound words where the query appears in a larger word
      const aContainsInWord =
        a.ord.toLowerCase().includes(queryLower) &&
        a.ord.toLowerCase() !== queryLower;
      const bContainsInWord =
        b.ord.toLowerCase().includes(queryLower) &&
        b.ord.toLowerCase() !== queryLower;
      if (aContainsInWord && !bContainsInWord) {
        return 1;
      }
      if (!aContainsInWord && bContainsInWord) {
        return -1;
      }

      // 6. Sort by the position of the query in the word (earlier is better)
      const aIndex = a.ord.toLowerCase().indexOf(queryLower);
      const bIndex = b.ord.toLowerCase().indexOf(queryLower);
      return aIndex - bIndex;
    });

    displaySearchResults(matchingResults); // Render word-specific results
  }
  hideSpinner(); // Hide the spinner
}

// Sentence Search's empty-state landing (arriving with no query typed):
// a real search for "apple" — English, so it reads regardless of how much
// Japanese the visitor already knows — with a one-line explainer added into
// the same "Sentence Results for ..." card. Deliberately not the visitor's
// own search: updateHistory:false keeps the URL, title, and search bar
// exactly as an untouched landing page, so this reads as "here's what the
// feature does" rather than something the visitor appears to have typed
// themselves. Ported from Norwegian's showSentencesSearchExample().
async function showSentencesSearchExample() {
  await search("apple", {
    updateHistory: false,
    sentenceResultSubtitle:
      "Type any Japanese or English word to find sentences that use it.",
  });
}

// Check if any sentences exist for a word or its variations
function checkForSentences(word, pos) {
  const lowerCaseWord = word.trim().toLowerCase();
  const wordParts = lowerCaseWord.split(/[,、]/).map((w) => w.trim());
  let sentenceFound = false;

  // Iterate through each part of the comma-separated list
  wordParts.forEach((wordPart) => {
    // Find matching word entry by both word and POS
    const matchingWordEntry = results.find((result) => {
      const wordMatch = result.ord.toLowerCase().includes(wordPart);
      const posMatch = result.gender.toLowerCase().includes(pos.toLowerCase());
      return wordMatch && posMatch; // Ensure both word and POS match
    });

    if (!matchingWordEntry) {
      console.log(`No matching word entry for '${wordPart}' with POS '${pos}'`);
      return;
    }

    // Generate word variations
    const wordVariations = generateWordVariationsForSentences(wordPart, pos);

    // Check if any sentences in the data include this word or its variations in the 'eksempel' field
    if (
      results.some(
        (result) =>
          result.eksempel &&
          wordVariations.some((variation) => {
            if (
              pos === "adverb" ||
              pos === "conjunction" ||
              pos === "preposition" ||
              pos === "interjection" ||
              pos === "numeral"
            ) {
              // Apply the strict match logic for these POS types (perfect match, no special endings)
              const regex = new RegExp(
                `(^|\\s)${variation}($|[\\s.,!?;])`,
                "gi"
              );
              const match = regex.test(result.eksempel);
              return match;
            } else {
              const regex = new RegExp(`\\b${variation}`, "i"); // Match word boundaries
              const match = regex.test(result.eksempel.toLowerCase().trim());
              return match;
            }
          })
      )
    ) {
      sentenceFound = true; // If a sentence is found for any variation, mark as true
    }
  });
  return sentenceFound;
}

// Handle change in part of speech (POS) filter
function handlePOSChange() {
  const query = document
    .getElementById("search-bar")
    .value.toLowerCase()
    .trim();
  const selectedPOS = document.getElementById("pos-select").value.toLowerCase(); // Fetch POS
  if (
    gameActive &&
    document.getElementById("type-select").value === "word-game"
  ) {
    // Adjust the word game instead of triggering a dictionary search
    startWordGame(); // Re-fetch a new word for the game based on the new POS filter
  } else {
    // Update the URL with the search parameters
    updateURL(query, "words", selectedPOS); // <--- Trigger URL update with type 'words'

    // If the search field is empty, generate a random word based on the POS
    if (!query) {
      console.log(
        "Search field is empty. Generating random word based on selected POS."
      );
      randomWord();
    } else {
      search(); // If there is a query, perform the search with the selected POS
    }
  }
}

function selectType(type) {
  // Set the dropdown value to match the selected type
  document.getElementById("type-select").value = type;
  // Call handleTypeChange with the type
  handleTypeChange(type, { userNavigation: true });
}

// Ported from Norwegian: the one place body.dataset.mode gets set, which
// getCurrentMode() below reads and which wordList.js's renderWordList()/
// reconcileMyWordsEntryIds() etc. check to decide whether the Word List
// tab is the one currently visible.
function getCurrentMode() {
  return document.body.dataset.mode || "words";
}
window.getCurrentMode = getCurrentMode;

// Marks the #mode-nav tab matching the current mode as active. Called from
// handleTypeChange() itself, so every navigation path stays in sync
// automatically instead of needing to be updated at each entry point.
function syncModeNav(type) {
  document.body.dataset.mode = type;
  document.body.classList.toggle("word-game-mode", type === "word-game");
  document.body.classList.toggle("stories-mode", type === "stories");
  // My Stats uses a dedicated page layout with no search toolbar.
  document.body.classList.toggle("my-stats-mode", type === "my-stats");
  document.body.classList.toggle(
    "word-list-mode",
    type === "word-list"
  );
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === type;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  });
  // Settings/About share the same "nothing to search or filter" toolbar
  // treatment (the empty #search-container band, #results-container
  // width, #mode-nav's own bottom border once that band is hidden — see
  // body.account-page-mode in the adopted stylesheets) without being My
  // Stats/Word List themselves, hence the separate class.
  document.body.classList.toggle(
    "account-page-mode",
    type === "settings" || type === "about"
  );

  // Every navigation path (mode-tab clicks, the dropdown, browser
  // back/forward, a direct word URL) calls this function. displayStory()
  // never calls it, so it's safe to unconditionally undo reader state here:
  // stop its audio, hide the reader, drop html.reading -- otherwise leaving
  // a story any way other than its own "Back to Stories" button leaves the
  // whole reader (audio included) sitting on screen under the new tab.
  window.resetStoryReaderView?.();
}

function isPlainLeftClick(event) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// #mode-nav's tabs ship real hrefs (?type=words etc.) so crawlers/no-JS
// visitors/middle-click all get a working destination directly from the
// attribute. A plain left-click is intercepted here to run the same
// instant, no-reload selectType() transition the old type-select dropdown
// always used, instead of a full page load.
function initializeModeNav() {
  // #site-title ships a real href="./" (see index.html) so crawlers/no-JS
  // visitors/middle-click get a working destination directly from the
  // attribute; a plain left-click is intercepted to run the same instant,
  // no-reload transition every other nav link uses.
  const siteTitle = document.getElementById("site-title");
  siteTitle?.addEventListener("click", (event) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    returnToLandingPage();
  });

  document
    .querySelectorAll(".mode-tab[data-mode], .button-container[data-mode]")
    .forEach((tab) => {
    tab.addEventListener("click", (event) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      // My Words goes through goToMyWords() (wordList.js) rather than a
      // plain selectType(), matching its existing dedicated "My Words"
      // default view -- see the comment at handleTypeChange's word-list
      // branch. Every other tab just switches directly.
      if (tab.dataset.mode === "word-list") {
        window.goToMyWords?.();
      } else {
        selectType(tab.dataset.mode);
      }
    });
    });

  // Match Norwegian's landing-page behavior: the Words card demonstrates a
  // real Japanese lookup instead of opening an otherwise empty search view.
  document
    .querySelectorAll('[data-navigation-action="sample-word"]')
    .forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        const searchBar = document.getElementById("search-bar");
        if (searchBar) searchBar.value = link.dataset.sampleWord || "人";
        selectType("words");
      });
    });
}

// Toggleable dropdown for the account menu (#account-menu-btn/
// #account-menu-panel). It shares the compact header space with the streak
// panel, so the app-menu:open event keeps the two mutually exclusive.
function positionAccountMenuPanel(button, panel) {
  const viewportGutter = 8;
  panel.classList.remove("account-menu-panel--opens-right");
  panel.style.removeProperty("--account-menu-available-width");

  const buttonRect = button.getBoundingClientRect();
  const panelWidth = panel.getBoundingClientRect().width;
  const viewportWidth = document.documentElement.clientWidth;
  const wouldOverflowLeft = buttonRect.right - panelWidth < viewportGutter;
  const availableWidth = wouldOverflowLeft
    ? viewportWidth - buttonRect.left - viewportGutter
    : buttonRect.right - viewportGutter;

  panel.classList.toggle("account-menu-panel--opens-right", wouldOverflowLeft);
  panel.style.setProperty(
    "--account-menu-available-width",
    `${Math.max(0, availableWidth)}px`
  );
}

function initializeAccountMenu() {
  const button = document.getElementById("account-menu-btn");
  const panel = document.getElementById("account-menu-panel");
  if (!button || !panel) return;

  const isOpen = () => !panel.classList.contains("hidden");

  const closeMenu = () => {
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    panel.classList.remove("hidden");
    positionAccountMenuPanel(button, panel);
    button.setAttribute("aria-expanded", "true");
    document.dispatchEvent(
      new CustomEvent("app-menu:open", { detail: { id: "account" } })
    );
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    isOpen() ? closeMenu() : openMenu();
  });

  panel.addEventListener("click", (event) => {
    if (event.target.closest(".account-menu-item")) closeMenu();
  });

  document.addEventListener("click", (event) => {
    if (isOpen() && !event.target.closest(".account-menu")) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      closeMenu();
      button.focus();
    }
  });

  document.addEventListener("app-menu:open", (event) => {
    if (event.detail?.id !== "account") closeMenu();
  });

  window.addEventListener("resize", () => {
    if (isOpen()) positionAccountMenuPanel(button, panel);
  });

  // Same click-interception every other #mode-nav-style link uses:
  // a real href for crawlers/middle-click, a plain left-click runs the
  // in-page transition instead of a full reload.
  panel.querySelectorAll(".account-menu-item[data-mode]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      selectType(link.dataset.mode);
    });
  });
}

// A short, static page describing the app. No vocabulary data, no
// personal state -- renders immediately regardless of dictionary-load
// state. Reuses .definition, the same card styling as a word result,
// rather than inventing new layout classes for a one-off page.
function renderAboutPage() {
  const section = document.createElement("section");
  section.className = "definition about-page";
  section.innerHTML = `
    <h2>About</h2>
    <p>
      Japanese Dictionary is a free, browser-based tool for learning
      Japanese — word and sentence search with audio, short stories at
      every CEFR level, and a Word Game that adapts to your level as you
      practice.
    </p>
    <p>
      Found a word that's missing? A word search with no exact match
      offers a "Flag Missing Word Entry" button. For anything else, reach
      out via the links in the footer below.
    </p>
    <p>
      Frequency-aware sorting and practice use the
      <a href="https://clrd.ninjal.ac.jp/bccwj/en/freq-list.html" target="_blank" rel="noopener noreferrer">Balanced Corpus of Contemporary Written Japanese word list</a>
      from the National Institute for Japanese Language and Linguistics.
    </p>
  `;
  resultsContainer.appendChild(section);
}

// Real counts from the loaded dictionary/story data, not a hardcoded
// number that would silently go stale as content grows. Both `results`
// (this file) and `storyResults` (stories.js) load asynchronously and
// independently, so this polls briefly rather than assuming either is
// ready by the time the landing page first paints.
function updateLandingProofLine() {
  const el = document.getElementById("landing-proof-line");
  if (!el) return;

  const tryRender = () => {
    if (results.length === 0) return false;
    if (typeof storyResults === "undefined" || storyResults.length === 0) {
      return false;
    }
    el.innerHTML = `${results.length.toLocaleString("en-US")} dictionary entries <span aria-hidden="true">·</span> ${storyResults.length.toLocaleString("en-US")} stories <span aria-hidden="true">·</span> Free to use`;
    return true;
  };

  if (tryRender()) return;
  const poll = setInterval(() => {
    if (tryRender()) clearInterval(poll);
  }, 200);
}

function enableSearchControls() {
  const searchBar = document.getElementById("search-bar");
  const searchBtn = document.getElementById("search-btn");
  const clearBtn = document.getElementById("clear-btn");

  if (!searchBar || !searchBtn || !clearBtn) return;

  searchBar.disabled = false;
  searchBtn.disabled = false;
  clearBtn.disabled = false;

  searchBar.style.color = "";
  searchBar.style.cursor = "text";
  searchBtn.style.color = "";
  searchBtn.style.cursor = "pointer";
  clearBtn.style.color = "";
  clearBtn.style.cursor = "pointer";
}

function disableSearchControls() {
  const searchBar = document.getElementById("search-bar");
  const searchBtn = document.getElementById("search-btn");
  const clearBtn = document.getElementById("clear-btn");

  if (!searchBar || !searchBtn || !clearBtn) return;

  searchBar.disabled = true;
  searchBtn.disabled = true;
  clearBtn.disabled = true;

  searchBar.style.color = "#ccc";
  searchBar.style.cursor = "not-allowed";
  searchBtn.style.color = "#ccc";
  searchBtn.style.cursor = "not-allowed";
  clearBtn.style.color = "#ccc";
  clearBtn.style.cursor = "not-allowed";
}

// Handle change in search type (words/sentences)
function handleTypeChange(type, options = {}) {
  // If type is not passed in (e.g., called from dropdown), get it from the dropdown
  type = type || document.getElementById("type-select").value;

  // Keep #mode-nav's active tab in sync regardless of how this was
  // triggered (the dropdown, a landing-page card, or a #mode-nav tab
  // itself) -- one call site here instead of updating it at every
  // navigation entry point separately.
  syncModeNav(type);

  const query = document
    .getElementById("search-bar")
    .value.toLowerCase()
    .trim();

  // Clear any remnants from other types in the URL
  cleanURL(type);

  // Container to update and other UI elements
  const searchContainerInner = document.getElementById(
    "search-container-inner"
  ); // The container to update
  const searchBarWrapper = document.getElementById("search-bar-wrapper");
  const gameEnglishFilterContainer = document.querySelector(
    ".game-english-filter"
  );
  const gameEnglishSelect = document.getElementById("game-english-select");

  // Retrieve selected part of speech (POS) if available
  const selectedPOS = document.getElementById("pos-select")
    ? document.getElementById("pos-select").value.toLowerCase()
    : "";

  // Filter containers for POS, Genre, and CEFR
  const posFilterContainer = document.querySelector(".pos-filter");
  const genreFilterContainer = document.getElementById("genre-filter"); // Get the Genre filter container
  const storyFavoritesFilterContainer = document.getElementById(
    "story-favorites-filter"
  );
  const cefrFilterContainer = document.querySelector(".cefr-filter"); // Get the CEFR filter container

  // Filter dropdowns for POS, Genre, and CEFR
  const posSelect = document.getElementById("pos-select");
  const genreSelect = document.getElementById("genre-select");
  const cefrSelect = document.getElementById("cefr-select"); // Get the CEFR filter dropdown
  const cefrLock = document.getElementById("lock-icon");
  const strengthFilterContainer = document.getElementById("strength-filter"); // Word List-only filter by word strength
  const strengthSelect = document.getElementById("strength-select");

  removeStoryHeader();
  gameEnglishFilterContainer.style.display = "none";
  gameEnglishSelect.style.display = "none"; // Hide random button
  // Word List is the only tab with a Strength filter — reset it to hidden
  // before any type-specific branch runs, same as Genre/Favorites above.
  if (strengthFilterContainer) strengthFilterContainer.style.display = "none";

  // Update the URL with the selected type, query, and POS
  updateURL(query, type, selectedPOS); // This ensures the type is reflected in the URL

  // Add logic for the "Stories" type
  if (type === "stories") {
    genreFilterContainer.style.display = "inline-flex"; // Show genre dropdown in story mode
    genreSelect.value = ""; // Reset to default genre
    storyFavoritesFilterContainer.style.display = "inline-flex";
    document.getElementById("story-favorites-select").value = "";

    searchBarWrapper.style.display = "inline-flex"; // Hide search-bar-wrapper
    posFilterContainer.style.display = "none";
    cefrLock.style.display = "none";

    searchContainerInner.classList.remove("word-game-active");

    showLandingCard(false);
    clearInput();

    cefrSelect.disabled = false; // Enable CEFR filter
    cefrFilterContainer.classList.remove("disabled"); // Visually enable the CEFR filter
    cefrSelect.value = ""; // Reset to default "CEFR Level"

    enableSearchControls();

    // Load stories data if not already loaded
    if (!storyResults.length) {
      fetchAndLoadStoryData().then(() => {
        displayStoryList(); // Display the list of stories
      });
    } else {
      displayStoryList(); // Display the list of stories if already loaded
    }
  } else if (type === "sentences") {
    setEnglishVisible(true);
    // Hide Genre dropdown
    genreFilterContainer.style.display = "none"; // Hide genre dropdown in sentences mode
    storyFavoritesFilterContainer.style.display = "none";

    searchBarWrapper.style.display = "inline-flex";

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    // Word class isn't a meaningful filter for sentence search, so hide it
    // entirely rather than showing it grayed out.
    posFilterContainer.style.display = "none";
    posSelect.disabled = true;
    cefrLock.style.display = "none";
    posSelect.value = ""; // Reset to "Part of Speech" option

    // Enable the CEFR dropdown
    cefrSelect.disabled = false; // Enable CEFR filter when sentences are selected
    cefrSelect.value = ""; // Reset to "CEFR Level" option
    cefrFilterContainer.classList.remove("disabled"); // Visually enable the CEFR filter

    enableSearchControls();

    // If the search bar is not empty, perform a sentence search
    if (query) {
      search(); // This will trigger a search for sentences based on the search bar query
    } else {
      showSentencesSearchExample(); // Landing state: real "apple" results, not a random sentence
    }
  } else if (type === "word-game") {
    // Every explicit entry into the word game shows the mode-picker intro
    // again -- this is a fresh visit, not a continuation of whatever round
    // (if any) was previously active. startWordGame() itself becomes a
    // no-op past the "show the intro" gate until beginWordGameRound() sets
    // this back to true.
    wordGameRoundActive = false;
    resetGame();
    startWordGame(); // Call the word game function
  } else if (type === "my-stats") {
    // My Stats is a personal report, so it has no search or filter controls.
    genreFilterContainer.style.display = "none";
    storyFavoritesFilterContainer.style.display = "none";
    searchBarWrapper.style.display = "none";
    posFilterContainer.style.display = "none";
    cefrFilterContainer.style.display = "none";
    cefrLock.style.display = "none";

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    clearInput();
    disableSearchControls();
    document.title = "My Stats - Japanese Dictionary";
    window.initMyStats?.();
  } else if (type === "about") {
    genreFilterContainer.style.display = "none";
    storyFavoritesFilterContainer.style.display = "none";
    searchBarWrapper.style.display = "none";
    posFilterContainer.style.display = "none";
    cefrLock.style.display = "none";

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    showLandingCard(false);
    clearInput();
    clearContainer();
    disableSearchControls();

    document.title = "About - Japanese Dictionary";
    renderAboutPage();
  } else if (type === "settings") {
    genreFilterContainer.style.display = "none";
    storyFavoritesFilterContainer.style.display = "none";
    searchBarWrapper.style.display = "none";
    posFilterContainer.style.display = "none";
    cefrLock.style.display = "none";

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    document.title = "Settings - Japanese Dictionary";
    window.initSettings?.();
  } else if (type === "word-list") {
    genreFilterContainer.style.display = "none";
    storyFavoritesFilterContainer.style.display = "none";

    searchBarWrapper.style.display = "inline-flex";
    enableSearchControls();

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    posFilterContainer.style.display = "inline-flex";
    posSelect.disabled = false;
    posSelect.value = "";
    posFilterContainer.classList.remove("disabled");

    cefrFilterContainer.classList.remove("disabled");
    cefrSelect.disabled = false;
    cefrSelect.value = "";
    cefrLock.style.display = "none";

    // Show the Strength filter — the one filter that's only meaningful here.
    if (strengthFilterContainer) {
      strengthFilterContainer.style.display = "inline-flex";
    }
    if (strengthSelect) strengthSelect.value = "";

    showLandingCard(false);

    // Reaching this via the account menu's plain "My Words" entry, the
    // dropdown, or a bookmarked ?type=word-list link should default to
    // the My Words tab, not the underlying All Words table.
    // goToAllWords()/goToMyWords() (wordList.js, used by the two landing
    // cards) pass an explicit override instead, so they aren't affected
    // by this default.
    window.WordListAPI?.setActiveView?.(options.wordListView ?? "my");
    window.initWordList?.();
  } else {
    // Handle default case (e.g., "Words" type)
    genreFilterContainer.style.display = "none"; // Hide genre dropdown
    storyFavoritesFilterContainer.style.display = "none";

    searchBarWrapper.style.display = "inline-flex"; // Show search-bar-wrapper

    cefrLock.style.display = "none";
    gameActive = false;
    searchContainerInner.classList.remove("word-game-active");

    // Enable the POS dropdown and restore color
    posFilterContainer.style.display = "inline-flex";
    posSelect.disabled = false;
    posSelect.value = ""; // Reset to "Part of Speech" option
    posFilterContainer.classList.remove("disabled"); // Remove the 'disabled' class

    // Enable the CEFR dropdown and restore color
    cefrSelect.disabled = false;
    cefrSelect.value = ""; // Reset to "CEFR Level" option
    cefrFilterContainer.classList.remove("disabled");

    enableSearchControls();

    if (query) {
      console.log("Searching for words with query:", query);
      showLandingCard(false);
      search(); // Trigger a word search if the search bar has a value
    } else {
      // Same landing experience a fresh visit to ?type=words gets (see
      // loadStateFromURL's own "words" branch above) -- welcome message,
      // daily quests, vocabulary profile, and the mode grid -- rather than
      // dropping straight into an unexplained random word.
      clearContainer();
      showLandingCard(true);
    }
  }

  if (options.userNavigation) {
    focusViewAfterNavigation();
  }
}

// After a user-initiated navigation (nav tab, landing card, header link),
// scroll to top and move keyboard focus to the new view's heading -- a
// screen-reader/keyboard user shouldn't be left focused on an element that
// just got replaced. Async views can pass a selector and call this again
// once their content arrives.
function focusViewAfterNavigation(selector = "") {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const main = document.getElementById("main-content");
      if (!main) return;

      const requestedTarget = selector ? document.querySelector(selector) : null;
      const target =
        requestedTarget ||
        Array.from(main.querySelectorAll("h1, h2")).find(
          (heading) => heading.getClientRects().length > 0,
        ) ||
        main;

      const suppliedTabIndex = target.hasAttribute("tabindex");
      if (!suppliedTabIndex) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });

      if (!suppliedTabIndex) {
        target.addEventListener(
          "blur",
          () => target.removeAttribute("tabindex"),
          { once: true },
        );
      }
    });
  });
}

// Helper function to clear the URL of remnants from other types
function cleanURL(type) {
  const url = new URL(window.location);
  url.searchParams.delete("query");
  url.searchParams.delete("pos");
  url.searchParams.delete("story");
  url.searchParams.delete("word");
  url.searchParams.set("type", type);
  window.history.pushState({}, "", url);
}

// Handle change in CEFR filter
function handleCEFRChange() {
  const query = document
    .getElementById("search-bar")
    .value.toLowerCase()
    .trim();
  const type = document.getElementById("type-select").value;
  const selectedCEFR = document
    .getElementById("cefr-select")
    .value.toUpperCase();
  const selectedGenre = document
    .getElementById("genre-select")
    .value.trim()
    .toLowerCase();

  // Check if the 'stories' tab is active
  if (type === "stories") {
    // Filter the stories by the selected CEFR level
    const filteredStories = storyResults.filter((story) => {
      const genreMatch = selectedGenre
        ? story.genre.trim().toLowerCase() === selectedGenre
        : true;
      const cefrMatch = selectedCEFR
        ? story.CEFR && story.CEFR.toUpperCase() === selectedCEFR
        : true;

      return genreMatch && cefrMatch;
    });

    // Display the filtered list of stories
    displayStoryList(filteredStories);
  } else if (type === "pronunciation") {
    // Pronunciation: regenerate a sentence with the selected CEFR
    initPronunciation();
  }

  // Handle the word game logic or dictionary search when 'word-game' or 'words' are selected
  else if (gameActive && type === "word-game") {
    startWordGame(); // Adjust the word game based on the new CEFR filter
  } else {
    // If the search field is empty, generate a random word based on the CEFR level
    if (!query) {
      console.log(
        "Search field is empty. Generating random word based on selected CEFR."
      );
      randomWord(); // Ensure randomWord() applies the CEFR filter
    } else {
      search(); // Perform a search with the selected CEFR
    }
  }
}

// Renders `text` with every span Inflections found a dictionary entry for
// (in whatever form it actually appears in -- a bare headword or an
// inflected verb/adjective form) wrapped as a clickable link to that
// entry's lemma; everything between spans (particles, punctuation, an
// unindexed word) stays plain, escaped text. `spans` comes from
// Inflections.segmentTextSync/segmentTextAsync -- see inflections.js for
// how the matching itself works (forward maximum matching over the full
// dictionary + conjugated-form index).
// `className` defaults to the definition-card link style; stories.js
// passes "story-word" instead -- a different class on purpose, not just a
// different look: a story word opens an in-place popover (so a reader
// never loses their place), while clickable-definition-word navigates the
// whole results pane to the clicked word's own card, which is only right
// when that pane is already what's on screen. Sharing one class would
// make both click handlers (scripts.js's and stories.js's) fire for every
// story click.
function renderSegmentedText(text, spans, className = "clickable-definition-word") {
  if (spans.length === 0) return escapeHTML(text);

  let html = "";
  let lastIndex = 0;
  for (const span of spans) {
    html += escapeHTML(text.slice(lastIndex, span.start));
    html += `<span class="${className}" data-word="${escapeHTML(
      span.lemma,
    )}">${escapeHTML(span.text)}</span>`;
    lastIndex = span.end;
  }
  html += escapeHTML(text.slice(lastIndex));
  return html;
}

// Renders a single-word card's definition. Segmentation depends on
// Inflections' reverse index, which takes a moment to build the first time
// it's needed (see inflections.js) -- this sync path uses it if already
// warm and otherwise renders plain text immediately, so the definition
// never waits on it; upgradeDefinitionClickableWords (called right after
// the initial render, see displaySearchResults) fills in the clickable
// spans once the index resolves. Mirrors Norwegian's two-pass
// makeDefinitionClickable/upgradeDefinitionExpressionSpans split, for the
// same reason: Norwegian's version doesn't need this at all for a single
// word (its whitespace-tokenized definitions are clickable synchronously),
// only for the later async multi-word expression upgrade -- here, no
// Japanese definition is clickable at all until segmentation is possible.
function makeDefinitionClickable(defText) {
  if (!defText) return "";

  const spans = window.Inflections?.isReverseIndexReady()
    ? window.Inflections.segmentTextSync(defText)
    : [];

  if (defText.includes(";")) {
    const items = defText
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    return (
      `<ul class="definition-list">` +
      items
        .map((item) => `<li>${renderSegmentedText(item, spans.filter(
          (span) => item.includes(span.text),
        ))}</li>`)
        .join("") +
      `</ul>`
    );
  }

  return renderSegmentedText(defText, spans);
}

// Async upgrade pass: re-segments `defText` once Inflections' reverse
// index is ready (building it on first call) and replaces `container`'s
// content with the fully clickable version. A no-op if the container's
// text no longer matches `defText` by the time this resolves (the learner
// navigated away and a different definition is now showing there).
async function upgradeDefinitionClickableWords(container, defText) {
  if (!defText || !window.Inflections) return;
  if (window.Inflections.isReverseIndexReady()) return; // already rendered clickable

  const spans = await window.Inflections.segmentTextAsync(defText, results);
  // No staleness re-check beyond this: if the learner has navigated away,
  // `container` is simply a detached node by now and writing to it is
  // harmless (mirrors Norwegian's upgradeDefinitionExpressionSpans, which
  // has the same property for the same reason).
  if (!container.isConnected) return;

  if (defText.includes(";")) {
    const items = defText
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    container.innerHTML =
      `<ul class="definition-list">` +
      items
        .map(
          (item) =>
            `<li>${renderSegmentedText(
              item,
              spans.filter((span) => item.includes(span.text)),
            )}</li>`,
        )
        .join("") +
      `</ul>`;
  } else {
    container.innerHTML = renderSegmentedText(defText, spans);
  }
}

// Above this length, a single-word card's definition gets clamped to a few
// lines with an "Expand definition" toggle rather than shown in full.
// Ported verbatim from Norwegian (character count, not word/token count --
// the definitions themselves are the same kind of prose in either
// language, unlike the tokenization makeDefinitionClickable needs above).
const DEFINITION_TRUNCATE_THRESHOLD = 200;

// Collapsed-by-default "Expand definition" toggle, rendered directly after
// a clamped .definition-text paragraph so toggleDefinitionText can flip the
// clamp on its previous sibling. Returns "" when the definition is short
// enough to show in full already, so no empty toggle ever renders.
function renderDefinitionToggleButton(definisjon) {
  if (!definisjon || definisjon.length <= DEFINITION_TRUNCATE_THRESHOLD)
    return "";
  return `
    <button
      type="button"
      class="definition-toggle-btn"
      aria-expanded="false"
      onclick="event.stopPropagation(); toggleDefinitionText(this)"
      onkeydown="event.stopPropagation()"
    ><i class="fas fa-chevron-down" aria-hidden="true"></i> Expand Definition</button>`;
}

// Collapsed-by-default "Word forms" toggle, sitting next to "Report an
// issue" in .definition-actions-row. Returns "" when the word doesn't
// conjugate (window.Inflections.getForms returned null -- e.g. a pre-noun
// adjectival like この, which cannot predicate-conjugate at all), so no
// empty toggle ever renders. Ported from Norwegian's equivalent.
function renderInflectionsToggleButton(inflections) {
  if (!inflections) return "";
  return `
    <button
      type="button"
      class="inflections-toggle-btn"
      aria-expanded="false"
      onclick="event.stopPropagation(); toggleInflectionsTable(this)"
      onkeydown="event.stopPropagation()"
    ><i class="fas fa-chevron-down" aria-hidden="true"></i> Word forms</button>`;
}

function renderInflectionRows(forms) {
  return forms
    .map((form) => {
      const label = escapeHTML(form.label);
      const value = escapeHTML(form.value);
      return `
        <tr>
          <th>${label}</th>
          <td data-label="${label}">${value}</td>
        </tr>`;
    })
    .join("");
}

function renderInflectionsSource(inflections) {
  if (inflections?.sourceType === "jmdict") {
    return `<p class="inflections-hint">Conjugation class from <a href="https://www.edrdg.org/jmdict/j_jmdict.html" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">JMdict</a></p>`;
  }
  if (inflections?.sourceType === "estimated") {
    return `<p class="inflections-hint">This entry's conjugation class could not be verified against JMdict; forms are regular estimates.</p>`;
  }
  return "";
}

function renderInflectionsTableWrapper(inflections) {
  if (!inflections) return "";

  const requestAttribute = inflections.pending
    ? ` data-inflections-request-id="${escapeHTML(inflections.requestId)}"`
    : "";
  const rowsHTML = inflections.pending
    ? `<tr><td colspan="2">Loading word forms…</td></tr>`
    : renderInflectionRows(inflections.forms);

  return `
    <div class="inflections-table-wrapper hidden"${requestAttribute}>
      <table class="inflections-table">
        <tbody>${rowsHTML}</tbody>
      </table>
      <div class="inflections-source">${renderInflectionsSource(inflections)}</div>
    </div>`;
}

async function loadPendingInflections(wrapper) {
  const requestId = wrapper.dataset.inflectionsRequestId;
  if (!requestId) return;

  const inflections = await window.Inflections?.resolvePending(requestId);
  delete wrapper.dataset.inflectionsRequestId;

  const tableBody = wrapper.querySelector(".inflections-table tbody");
  const source = wrapper.querySelector(".inflections-source");
  if (!tableBody) return;

  if (!inflections) {
    tableBody.innerHTML = `<tr><td colspan="2">No word forms are available for this entry.</td></tr>`;
    if (source) source.innerHTML = "";
    return;
  }

  tableBody.innerHTML = renderInflectionRows(inflections.forms);
  if (source) source.innerHTML = renderInflectionsSource(inflections);
}

// The toggle button and its table live in separate DOM positions (button
// inside .definition-actions-row, table right after it) so the button can
// sit next to "Report an issue" in its own column -- walk back up to the
// shared row, then to its next sibling, rather than assuming adjacency.
async function toggleInflectionsTable(button) {
  const row = button.closest(".definition-actions-row");
  const wrapper = row ? row.nextElementSibling : null;
  if (!wrapper) return;
  const isExpanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!isExpanded));
  button.classList.toggle("inflections-toggle-expanded", !isExpanded);
  wrapper.classList.toggle("hidden", isExpanded);

  if (!isExpanded && wrapper.dataset.inflectionsRequestId) {
    button.disabled = true;
    try {
      await loadPendingInflections(wrapper);
    } finally {
      button.disabled = false;
    }
  }
}

// The toggle button is the clamped .definition-text-block's next sibling,
// so we flip the clamp on its previous sibling directly.
function toggleDefinitionText(button) {
  const wrapperEl = button.previousElementSibling;
  if (!wrapperEl) return;
  const isExpanded = button.getAttribute("aria-expanded") === "true";
  const nowExpanded = !isExpanded;
  button.setAttribute("aria-expanded", String(nowExpanded));
  button.classList.toggle("definition-toggle-expanded", nowExpanded);
  wrapperEl.classList.toggle("definition-text-expanded", nowExpanded);
  button.innerHTML = `<i class="fas fa-chevron-down" aria-hidden="true"></i> ${
    nowExpanded ? "Collapse Definition" : "Expand Definition"
  }`;
}

// Render a list of results (words)
function displaySearchResults(
  results,
  query = "",
  { primaryHeading = false } = {},
) {
  query = query.toLowerCase().trim(); // Ensure the query is lowercased and trimmed
  const defaultResult = results.length <= 1; // Determine if there are multiple results
  const multipleResults = results.length > 1; // Determine if there are multiple results

  let htmlString = "";

  // Limit to a maximum of 10 results
  results.slice(0, 10).forEach((result, resultIndex) => {
    result.gender = formatGender(result.gender);
    result.pos = (result.gender || "").toLowerCase();

    // null for word classes that don't inflect (noun, adverb, particle, ...)
    // or a pre-noun adjectival that cannot predicate-conjugate at all.
    const inflections = window.Inflections?.getForms(result) || null;

    // Convert the word to lowercase and trim spaces when generating the ID
    const normalizedWord = result.ord.toLowerCase().trim();

    // Highlight the word being defined (result.ord) in the example sentence
    const highlightedExample = result.eksempel
      ? highlightQuery(result.eksempel, query || result.ord.toLowerCase())
      : "";

    // Determine whether to initially hide the content for multiple results
    const multipleResultsExposedContent = defaultResult
      ? "default-hidden-content"
      : "";

    const multipleResultsDefinition = multipleResults
      ? "multiple-results-definition"
      : "single-result-definition"; // Hide content if multiple results
    const multipleResultsEnglish = multipleResults
      ? "multiple-results-english"
      : ""; // Hide content if multiple results
    const multipleResultsHiddenContent = multipleResults
      ? "multiple-results-hidden-content"
      : ""; // Hide content if multiple results
    const multipleResultsDefinitionHeader = multipleResults
      ? "multiple-results-definition-header"
      : "";
    const multipleResultsWordgender = multipleResults
      ? "multiple-results-word-gender"
      : "";
    const multipleResultsDefinitionText = multipleResults
      ? "multiple-results-definition-text"
      : "";
    const multipleResultsgenderClass = multipleResults
      ? "multiple-results-gender-class"
      : "";

    // Safely escape the word in JavaScript by replacing special characters
    const escapedWord = result.ord
      .replace(/'/g, "\\'")
      .replace(/"/g, "&quot;")
      .replace(/\r?\n|\r/g, ""); // Escapes single quotes, double quotes, and removes newlines
    const hasSentencesPlaceholder = `<button class="sentence-btn english-toggle-btn" style="display: none;" onclick="event.stopPropagation(); toggleEnglishTranslations('${normalizedWord}')">Show English</button>`;

    const escapedGender = result.gender.replace(/'/g, "\\'").trim();
    const escapedEngelsk = result.engelsk.replace(/'/g, "\\'").trim();
    // Embedded directly rather than read back from the rendered DOM via
    // .textContent (which is what this used to do): the multi-result
    // summary can render semicolon-separated senses as separate <span>
    // elements (see formatMultiResultDefinition), and .textContent
    // concatenates them with no separator, which no longer matches
    // result.definisjon and silently breaks handleCardClick's exact
    // string match below.
    const escapedDefinisjon = (result.definisjon || "")
      .replace(/'/g, "\\'")
      .replace(/"/g, "&quot;")
      .replace(/\r?\n|\r/g, " ");
    const handleCardClickArgs = `'${escapedWord}', '${escapedGender}', '${escapedEngelsk}', '${escapedDefinisjon}'`;
    // A result card expands into a definition containing real controls
    // (save and report buttons). Keep the card itself a neutral container
    // and put its keyboard/click activation on the compact header only.
    // Giving the outer card an onclick/role="button" would nest those
    // controls inside an interactive ancestor, which is invalid and
    // confusing to assistive technology. A single result is already open,
    // so it needs no activator.
    const cardActivationAttributes = multipleResults
      ? `
          tabindex="0"
          role="button"
          onclick="if (!window.getSelection().toString()) handleCardClick(event, ${handleCardClickArgs})"
          onkeydown="if ((event.key === 'Enter' || event.key === ' ') && !window.getSelection().toString()) { event.preventDefault(); handleCardClick(event, ${handleCardClickArgs}) }"`
      : "";

    const headingTag = primaryHeading && resultIndex === 0 ? "h1" : "h2";

    htmlString += `
<div
  class="definition ${multipleResultsDefinition}"
  data-word="${escapedWord}"
  data-pos="${result.pos}"
  data-engelsk="${result.engelsk}"
>
                <div class="${multipleResultsDefinitionHeader}"${cardActivationAttributes}>
                <${headingTag} class="word-gender ${multipleResultsWordgender}">
                  <div lang="ja" class="word-text-block">
                    ${
                      /[,、]/.test(result.ord)
                        ? (() => {
                            const [first, ...rest] = result.ord.split(/[,、]/);
                            return `${first.trim()}<br><span class="alt-spelling">${rest
                              .join("、")
                              .trim()}</span>`;
                          })()
                        : result.ord
                    }
                  </div>

                    ${
                      result.gender
                        ? `<div class="gender ${multipleResultsgenderClass}">${result.gender}</div>`
                        : ""
                    }
                    ${
                      result.engelsk
                        ? `<p class="english ${multipleResultsExposedContent} ${multipleResultsEnglish}">${result.engelsk}</p>`
                        : ""
                    }
                    ${
                      result.CEFR
                        ? `<div class="game-cefr-label ${multipleResultsExposedContent} ${getCefrClass(
                            result.CEFR
                          )}" title="${getCefrTooltip(result.CEFR)}">${result.CEFR}</div>`
                        : ""
                    }
                </${headingTag}>
                ${
                  result.definisjon
                    ? defaultResult
                      ? // makeDefinitionClickable can render a multi-sense
                        // definition as <ul class="definition-list">, which a
                        // <p> can't contain -- the browser would auto-close
                        // the <p> right before it, leaving the clamp on an
                        // empty element. Clamping this wrapper div instead
                        // works for both the plain-text and <ul> shapes it
                        // can return.
                        `<div class="definition-text-block${
                          result.definisjon.length > DEFINITION_TRUNCATE_THRESHOLD
                            ? " definition-text-clamped"
                            : ""
                        }"><p class="definition-text">${makeDefinitionClickable(
                          result.definisjon,
                        )}</p></div>${renderDefinitionToggleButton(result.definisjon)}`
                      : `<p class="definition-text ${multipleResultsDefinitionText}">${formatMultiResultDefinition(
                          result.definisjon,
                        )}</p>`
                    : ""
                }
                </div>
                <div class="definition-content ${multipleResultsHiddenContent}"> <!-- Apply the hidden class conditionally -->
                    ${
                      result.engelsk
                        ? `<p class="english"><i class="fas fa-language" aria-hidden="true"></i> ${result.engelsk}</p>`
                        : ""
                    }
                    ${
                      result.wordAudio === "X"
                        ? `<p class="pronunciation">
                            <i class="fas fa-volume-up sentence-audio-icon"
                        role="button" tabindex="0" aria-label="Play word pronunciation"
                        data-sentence="${result.ord
                          .split(",")[0]
                          .trim()}"></i>                            ${
                            result.uttale || ""
                          }
                          </p>`
                        : result.uttale
                        ? `<p class="pronunciation"><i class="fas fa-volume-up" aria-hidden="true"></i> ${result.uttale}</p>`
                        : ""
                    }
                    ${
                      result.etymologi
                        ? `<p class="etymology"><i class="fa-solid fa-flag" aria-hidden="true"></i> ${result.etymologi}</p>`
                        : ""
                    }
                    ${
                      result.CEFR
                        ? `<p style="display: inline-flex; align-items: center; font-family: 'Noto Sans', sans-serif; font-weight: bold; text-transform: uppercase; font-size: 12px; color: #4F4F4F;"><i class="fa-solid fa-signal" style="margin-right: 5px;" aria-hidden="true"></i><span style="text-align: center; min-width: 15px; display: inline-block; padding: 3px 7px; border-radius: 4px; background-color: ${getCefrColor(
                            result.CEFR
                          )};">${result.CEFR}</span><span style="margin-left: 6px; font-family: 'Noto Sans', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.03em; text-transform: uppercase; color: #6B6B6B;">${getCefrLabel(
                            result.CEFR,
                          )}</span></p>`
                        : ""
                    }
                    <div class="definition-actions-row">
                      <button
                        type="button"
                        class="report-issue-btn"
                        onclick="event.stopPropagation(); openWordCardFeedbackDialog(this, '${escapedWord}', '${result.pos}', '${result.CEFR || ""}')"
                        onkeydown="event.stopPropagation()"
                      ><i class="fas fa-flag" aria-hidden="true"></i> Report an Issue</button>
                      ${renderInflectionsToggleButton(inflections)}
                    </div>
                    ${renderInflectionsTableWrapper(inflections)}
                </div>
                <!-- OLD: Check if example sentence exists -->
                <!-- <div class="${multipleResultsHiddenContent}">${
      highlightedExample
        ? `<p class="example">${formatDefinitionWithMultipleSentences(
            highlightedExample
          )}</p>`
        : ""
    }</div> -->

                </div>
                                <!-- Show "Show Sentences" button only if sentences exist -->
                    <div class="${multipleResultsHiddenContent}">
                        ${hasSentencesPlaceholder}
                    </div>
            <!-- Sentences container is now outside the definition block -->
            <div class="sentences-container" id="sentences-container-${normalizedWord}"></div>
        `;
  });
  appendToContainer(htmlString);

  if (defaultResult && results[0]?.definisjon) {
    const definitionEl = resultsContainer.querySelector(".definition-text");
    if (definitionEl) {
      upgradeDefinitionClickableWords(
        definitionEl,
        results[0].definisjon,
      ).catch((error) => {
        console.error("Could not resolve known words in definition.", error);
      });
    }
  }

  if (
    defaultResult &&
    results[0] &&
    typeof window.attachSingleResultMyWordsControls === "function"
  ) {
    window.attachSingleResultMyWordsControls(results[0]);
  }

  if (
    multipleResults &&
    typeof window.attachMultipleResultMyWordsStars === "function"
  ) {
    window.attachMultipleResultMyWordsStars(results.slice(0, 10));
  }

  // Automatically load sentences for a single result, regardless of whether sentences exist in `eksempel`
  if (defaultResult && results[0]) {
    console.log("Auto-loading sentences for:", results[0].ord);
    const singleResult = results[0];
    // Exposed on window so scripts/capture-word-pages.py can await this
    // fire-and-forget auto-load directly instead of polling DOM attributes
    // for a heuristic "done" signal (data-fetched gets set true along more
    // than one code path inside fetchAndRenderSentences, not all of which
    // mean the sentences actually rendered).
    window.__lastSentencesLoadPromise = fetchAndRenderSentences(
      singleResult.ord,
      singleResult.pos,
      isEnglishVisible
    );
  } else {
    console.log("No sentences to load for:", results[0]?.ord || "No results");
  }
}

// Function to toggle the visibility of English sentences and update Japanese box styles
function toggleEnglishTranslations(wordId = null) {
  // Determine if wordId is a button element
  const isButton = wordId instanceof HTMLElement;
  const safeWordId = isButton ? null : CSS.escape(wordId);

  // Determine target elements based on the presence of wordId or button context
  const sentenceContainerSelector = safeWordId
    ? `#sentences-container-${safeWordId}`
    : ".sentence-container";
  const sentenceContainer = isButton
    ? wordId.nextElementSibling // Update to directly select the next sibling after the button
    : wordId
    ? document.querySelector(sentenceContainerSelector)
    : document; // Global context if no wordId

  if (!sentenceContainer) return;

  const englishSentenceDivs = wordId
    ? sentenceContainer.querySelectorAll(".sentence-box-english")
    : document.querySelectorAll(".sentence-box-english"); // Global if no wordId
  const japaneseSentenceDivs = wordId
    ? sentenceContainer.querySelectorAll(".sentence-box-norwegian")
    : document.querySelectorAll(".sentence-box-norwegian"); // Global if no wordId

  // Locate the button within the correct container
  const englishBtns = wordId
    ? [
        isButton
          ? wordId
          : sentenceContainer.previousElementSibling.querySelector(
              ".english-toggle-btn"
            ),
      ]
    : document.querySelectorAll(".english-toggle-btn"); // Global if no wordId

  // Toggle visibility based on the shared isEnglishVisible state
  setEnglishVisible(!isEnglishVisible);

  englishSentenceDivs.forEach((div) => {
    div.classList.toggle("hidden", !isEnglishVisible);
  });

  japaneseSentenceDivs.forEach((div) => {
    div.classList.toggle("sentence-box-norwegian-hidden", !isEnglishVisible);
  });

  // Update all button texts to match the new state
  englishBtns.forEach((btn) => {
    btn.textContent = isEnglishVisible ? "Hide English" : "Show English";
  });
}

// Function to find the gender of a word
function getWordGender(word) {
  const matchingWord = results.find(
    (result) => result.ord.toLowerCase() === word.toLowerCase()
  );
  return matchingWord ? matchingWord.gender : "unknown"; // Default to 'unknown' if not found
}

function getCefrClass(cefrLevel) {
  if (cefrLevel === "A1" || cefrLevel === "A2") {
    return "easy";
  } else if (cefrLevel === "B1" || cefrLevel === "B2") {
    return "medium";
  } else if (cefrLevel === "C") {
    return "hard";
  }
  return "";
}

const CEFR_LEVEL_INFO = {
  A1: { label: "Beginner", description: "Basic words and phrases for everyday needs" },
  A2: { label: "Elementary", description: "Simple, familiar topics and routine information" },
  B1: { label: "Intermediate", description: "Everyday topics, opinions, and plans" },
  B2: { label: "Upper-Intermediate", description: "Complex topics and more abstract ideas" },
  C: { label: "Advanced", description: "Nuanced, precise, and specialized language" },
};

function getCefrLabel(cefrLevel) {
  return CEFR_LEVEL_INFO[cefrLevel]?.label || "";
}

// "Label (Code): description" — for use as a title tooltip on compact badges
// that don't have room to show the plain label directly.
function getCefrTooltip(cefrLevel) {
  const info = CEFR_LEVEL_INFO[cefrLevel];
  return info ? `${info.label} (${cefrLevel}): ${info.description}` : "";
}

function getCefrColor(cefrLevel) {
  switch (cefrLevel) {
    case "A1":
    case "A2":
      return "#C7E3B6"; // Green for 'easy'
    case "B1":
    case "B2":
      return "#F2D96B"; // Yellow for 'medium'
    case "C":
      return "#E9A895"; // Red for 'hard'
    default:
      return "#ccc"; // Default background color
  }
}

function generateWordVariationsForSentences(word, pos) {
  // Purpose: cast a wide net for surface-form matching in Japanese example sentences.
  // NOTE: This is NOT a full morphological engine—it's a high-coverage heuristic set.

  const v = new Set([word]); // always include lemma/base as given
  const w = String(word || "").toLowerCase();

  // --- IRREGULAR EXCEPTIONS ---
  // Hard-coded lists for the most common irregulars
  const irregulars = {
    biti: [
      "sam",
      "si",
      "je",
      "smo",
      "ste",
      "su",
      "bio",
      "bila",
      "bilo",
      "bili",
      "bile",
    ],
    htjeti: [
      "ću",
      "ćeš",
      "će",
      "ćemo",
      "ćete",
      "će",
      "htio",
      "htjela",
      "htjeli",
    ],
    moći: [
      "mogu",
      "možeš",
      "može",
      "možemo",
      "možete",
      "mogu",
      "mogao",
      "mogla",
      "mogli",
    ],
    ići: [
      "idem",
      "ideš",
      "ide",
      "idemo",
      "idete",
      "idu",
      "išao",
      "išla",
      "išli",
    ],
    doći: [
      "dođem",
      "dođeš",
      "dođe",
      "dođemo",
      "dođete",
      "dođu",
      "došao",
      "došla",
      "došli",
    ],
    dati: ["dam", "daš", "da", "damo", "date", "daju", "dao", "dala", "dali"],
    jesti: [
      "jedem",
      "jedeš",
      "jede",
      "jedemo",
      "jedete",
      "jedu",
      "jeo",
      "jela",
      "jeli",
    ],
    vidjeti: [
      "vidim",
      "vidiš",
      "vidi",
      "vidimo",
      "vidite",
      "vide",
      "vidio",
      "vidjela",
      "vidjeli",
    ],
    teći: [
      "tečem",
      "tečeš",
      "teče",
      "tečemo",
      "tečete",
      "teku",
      "tekao",
      "tekla",
      "tekli",
    ],
    čovjek: ["ljudi"], // irregular plural
    dijete: ["djeca", "djeteta", "djeci", "djecu"],
    otac: ["očevi", "oca", "ocu", "ocem"],
    majka: ["majke", "majci", "majkom"],
  };

  if (irregulars[w]) {
    irregulars[w].forEach((f) => v.add(f));
  }

  // --- crude stems for Japanese (heuristic, not full morphology) ---
  let verbStem = w;
  let adjStem = w;
  let nounStem = w;

  // --- VERBS ---
  // infinitive -ti → bare stem
  if (verbStem.endsWith("ti")) {
    verbStem = verbStem.replace(/ti$/, ""); // učiti → uči-
  }
  // catch a few irregular infinitives (just broaden recall, not perfect)
  if (/ći$/.test(w)) {
    // ići, doći, moći → strip -ći
    verbStem = w.replace(/ći$/, "");
  }
  if (/jeti$/.test(w)) {
    // htjeti → htje- (approximate)
    verbStem = w.replace(/jeti$/, "je");
  }

  // --- ADJECTIVES ---
  if (/(an|en|in)$/.test(adjStem)) {
    // važan → važn, sretan → sretn, jedinstven → jedinstven
    adjStem = adjStem.replace(/(an|en|in)$/, "n");
  } else if (/(ak|ek|ik)$/.test(adjStem)) {
    // težak → tešk-, lagan → lagan/lag-, velik → velik/velik-
    adjStem = adjStem.replace(/(ak|ek|ik)$/, "k");
  } else if (/d$/.test(adjStem)) {
    // mlad → mlad- (don’t strip vowel)
    adjStem = adjStem;
  } else {
    // regular endings: mali/mala/malo, dobar/dobra/dobro
    adjStem = adjStem.replace(/(i|a|o|e)$/, "");
  }

  // --- NOUNS ---
  // default: strip final vowel (žena → žen-, selo → sel-)
  nounStem = w.replace(/(a|o|e|i)$/, "");

  // special noun patterns
  if (/ac$/.test(w)) {
    // otac → očev-, mladić/vojnik handled elsewhere
    nounStem = w.replace(/ac$/, "c");
  }
  if (/ik$/.test(w)) {
    // vojnik → vojnici
    nounStem = w.replace(/ik$/, "k");
  }
  if (/ost$/.test(w)) {
    // mladost → mladost(i)
    nounStem = w; // leave whole, since stem doesn’t shorten
  }
  if (/et$/.test(w)) {
    // dijete → djece (irregular, approximate only)
    nounStem = w.replace(/et$/, "ec");
  }

  if (pos === "noun") {
    // Frequent noun endings across genders (sg/pl, common cases).
    // This is purposely redundant across genders to maximize recall.
    [
      "a", // gen sg (žena → žene; selo → sela (also nom/acc pl neuter))
      "e", // nom/acc pl fem; voc sg masc; acc sg fem
      "i", // dat sg fem; nom pl masc
      "u", // loc sg; acc sg masc/neut (many)
      "o", // nom sg neuter (selo)
      "om", // instr sg masc/neut
      "em", // dat/loc sg masc (soft stems)
      "ama", // dat/loc/instr pl fem
      "ima", // dat/loc/instr pl masc/neut
      "ovi", // nom pl masc (grad → gradovi)
      "evima", // dat/loc/instr pl masc alt pattern
      "ovima", // dat/loc/instr pl masc alt (gradovima)
      "ih", // gen pl (many paradigms)
    ].forEach((end) => v.add(nounStem + end));
  } else if (pos === "adjective") {
    // Core agreement + oblique + degrees.
    // Key fix: include neuter sg "-o" (e.g., selo je malo).
    [
      "i", // masc pl (dobri)
      "a", // fem sg (dobra)
      "e", // fem pl (dobre)
      "o", // neut sg (dobro)  ← critical fix for "malo"
      "og", // gen/acc (anim) masc sg (dobrog)
      "ega", // alt gen/acc masc sg (dobroga)
      "om", // dat/loc masc/neut sg (dobrom)
      "oj", // dat/loc fem sg (dobroj)
      "im", // dat/loc/inst pl (dobrim)  ← adjectives take -im (not -ima)
      "ih", // gen pl (dobrih)
    ].forEach((end) => v.add(adjStem + end));

    // Special case: adjectives ending in -an / -en / -in
    // These often keep the whole "an/en/in" before endings.
    if (/(an|en|in)$/.test(w)) {
      ["a", "o", "i", "e", "og", "ega", "om", "oj", "im", "ih"].forEach(
        (end) => {
          v.add(w.replace(/(an|en|in)$/, "$1") + end);
        }
      );
    }

    // Comparative patterns (cover common alternations)
    v.add(adjStem + "ji");
    v.add(adjStem + "iji");
    v.add(adjStem + "ši"); // e.g., lak → lakši (irregular class)

    // Superlative = "naj-" + comparative
    v.add("naj" + adjStem + "ji");
    v.add("naj" + adjStem + "iji");
    v.add("naj" + adjStem + "ši");
  } else if (pos === "verb") {
    // PRESENT: cover all three theme-vowel classes (-a-, -e-, -i-)
    // 1sg
    v.add(verbStem + "m"); // generic (if theme vowel already present)
    v.add(verbStem + "am"); // radim/radam (cover -a- class)
    v.add(verbStem + "em"); // pišem (-e- class)
    v.add(verbStem + "im"); // učim (-i- class)
    // 2sg
    v.add(verbStem + "š");
    v.add(verbStem + "aš");
    v.add(verbStem + "eš");
    v.add(verbStem + "iš");
    // 3sg
    v.add(verbStem); // some lemmatizers yield bare stem—keep it
    v.add(verbStem + "a");
    v.add(verbStem + "e");
    v.add(verbStem + "i");
    // 1pl
    v.add(verbStem + "mo");
    v.add(verbStem + "amo");
    v.add(verbStem + "emo");
    v.add(verbStem + "imo");
    // 2pl
    v.add(verbStem + "te");
    v.add(verbStem + "ate");
    v.add(verbStem + "ete");
    v.add(verbStem + "ite");
    // 3pl
    v.add(verbStem + "u");
    v.add(verbStem + "ju");
    v.add(verbStem + "e");
    v.add(verbStem + "aju");

    // PAST (L-participle) — cover gender/number
    v.add(verbStem + "o"); // masc sg (radio/jeo pattern varies by lemma, but -o helps matching)
    v.add(verbStem + "la"); // fem sg
    v.add(verbStem + "lo"); // neut sg
    v.add(verbStem + "li"); // masc/mixed pl
    v.add(verbStem + "le"); // fem pl
    v.add(verbStem + "la"); // neut pl

    // IMPERATIVE (common shapes)
    v.add(verbStem + "j"); // dođi-type often surfaces as -j after palatalization
    v.add(verbStem + "jte"); // pl
    v.add(verbStem + "i"); // piši / uči
    v.add(verbStem + "imo"); // pišimo
    v.add(verbStem + "ite"); // pišite
    v.add(verbStem + "aj"); // -ati class: radi → radi / (radi!) ~ rad(i)/rad(i)!; many -aj imperatives surface
    v.add(verbStem + "ajte"); // -ajte

    // FUTURE I (periphrastic) — keep separated with space
    ["ću", "ćeš", "će", "ćemo", "ćete", "će"].forEach((aux) =>
      v.add(w + " " + aux)
    );

    // CONDITIONAL (bih/bi/bismo/biste/bi)
    ["bih", "bi", "bismo", "biste", "bi"].forEach((aux) =>
      v.add(w + " " + aux)
    );
  } else {
    // other POS: just return base
    v.add(word);
  }

  return Array.from(v);
}

// How many sentence rows render at once before "Show More Results" reveals
// the next batch. Mirrors Norwegian's SEARCH_RESULTS_BATCH_SIZE.
const SEARCH_RESULTS_BATCH_SIZE = 10;

// "a1"/"a2"/.../"c1" (C maps to "c1" -- there's no separate C1/C2 split in
// this app's CEFR data) for the badge color classes in 00-foundations-and-
// game.css. Ported from Norwegian's getCefrBadgeClass().
function getCefrBadgeClass(cefrLevel) {
  const normalizedLevel = String(cefrLevel || "").toUpperCase();
  if (normalizedLevel === "C") return "c1";
  return ["A1", "A2", "B1", "B2", "C1", "C2"].includes(normalizedLevel)
    ? normalizedLevel.toLowerCase()
    : "cefr-unknown";
}

// Keep the active Level filter visible in the sentence results header once
// the search toolbar has scrolled away -- an informational summary rather
// than another control. Ported from Norwegian's
// getSearchResultFilterSummaryHTML(); Word Class isn't included since
// sentences search hides that filter entirely (see handleTypeChange's
// "sentences" branch).
function getSearchResultFilterSummaryHTML() {
  const cefrSelect = document.getElementById("cefr-select");
  const selectedCEFR = String(cefrSelect?.value || "").toUpperCase().trim();

  const activeFilters = selectedCEFR
    ? `<span class="search-results-filter-summary search-results-cefr-filter" title="CEFR ${escapeHTML(selectedCEFR)}"><span class="cefr-value ${getCefrBadgeClass(selectedCEFR)}" aria-hidden="true">${escapeHTML(selectedCEFR)}</span><span class="search-results-filter-name">${escapeHTML(getCefrLabel(selectedCEFR) || selectedCEFR)}</span></span>`
    : "";

  return activeFilters
    ? `<div class="search-results-filters">${activeFilters}</div>`
    : "";
}

function renderSentenceMatchesFromCorpus(
  rows,
  query,
  highlightTerms = null,
  { visibleCount = SEARCH_RESULTS_BATCH_SIZE, sentenceResultSubtitle = "" } = {}
) {
  clearContainer();
  const safeQuery = escapeHTML(query);
  const matcher = window.SentenceFormMatching.createMatcher(
    highlightTerms && highlightTerms.length ? highlightTerms : [query]
  );

  if (!rows.length) {
    document.getElementById("results-container").innerHTML = `
      <div class="definition error-message">
        <h2 class="word-gender">Error <span class="gender">No Matching Sentences</span></h2>
        <p>No sentences found containing "${safeQuery}".</p>
      </div>`;
    return;
  }

  let html = `
    <div class="result-header sentence-results-header">
      <div class="sentence-results-header-copy">
        <p class="sentence-results-eyebrow">Sentence Search</p>
        <h2>Results for <span class="sentence-results-query">"${safeQuery}"</span></h2>
        ${
          sentenceResultSubtitle
            ? `<p class="result-header-subtitle">${escapeHTML(sentenceResultSubtitle)}</p>`
            : ""
        }
        ${getSearchResultFilterSummaryHTML()}
      </div>
      <div class="sentence-results-header-side">
        <strong class="sentence-results-count">${rows.length} example${rows.length === 1 ? "" : "s"}</strong>
        <div class="sentence-results-actions">
          <button class="sentence-btn english-toggle-btn" onclick="toggleEnglishTranslations()">
            ${isEnglishVisible ? "Hide English" : "Show English"}
          </button>
        </div>
      </div>
    </div>
  `;

  const visibleRows = rows.slice(0, visibleCount);

  for (const row of visibleRows) {
    const cefrLabel = getSentenceCefrLabelHTML(row.cefr);

    const noHTML = matcher.highlight(row.no);
    const enHTML = row.en ? matcher.highlight(row.en) : "";

    html += `
      <div class="sentence-container">
        <div class="sentence-box-norwegian ${
          !isEnglishVisible ? "sentence-box-norwegian-hidden" : ""
        }">
          <div class="sentence-content">
            <div class="cefr-audio-block">
              ${cefrLabel}
              ${
                row.audio
                  ? `<i class="fas fa-volume-up sentence-audio-icon" role="button" tabindex="0" aria-label="Play sentence audio" data-sentence="${row.no
                      .replace(/<[^>]*>/g, "")
                      .trim()}"></i>`
                  : ""
              }
            </div>
            <p class="sentence">${noHTML}</p>
          </div>
        </div>
        ${
          row.en
            ? `
          <div class="sentence-box-english ${isEnglishVisible ? "" : "hidden"}">
            <p class="sentence">${enHTML}</p>
          </div>`
            : ""
        }
      </div>
    `;
  }

  if (visibleRows.length < rows.length) {
    html += `
      <div class="search-results-load-more">
        <button type="button" class="search-results-load-more-button">Show More Results</button>
      </div>
    `;
  }

  document.getElementById("results-container").innerHTML = html;

  const loadMoreButton = resultsContainer.querySelector(
    ".search-results-load-more-button"
  );
  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", () => {
      renderSentenceMatchesFromCorpus(rows, query, highlightTerms, {
        visibleCount: visibleRows.length + SEARCH_RESULTS_BATCH_SIZE,
        sentenceResultSubtitle,
      });
    });
  }
}

// Highlight search query in text, accounting for Japanese characters (å, æ, ø) and verb variations
function highlightQuery(sentence, query) {
  if (!query) return sentence; // If no query, return sentence as is.

  // Always remove any existing highlights by replacing the <span> tags to avoid persistent old highlights
  let cleanSentence = sentence.replace(
    /<span style="color: #3c88d4;">(.*?)<\/span>/gi,
    "$1"
  );

  // Define a regex pattern that includes Japanese characters and dynamically inserts the query
  const japaneseLetters = "[\\wčćđšžČĆĐŠŽ]"; // Include Japanese letters in the pattern
  const regex = new RegExp(
    `(${japaneseLetters}*${query}${japaneseLetters}*)`,
    "gi"
  );

  // Highlight all occurrences of the query in the sentence
  cleanSentence = cleanSentence.replace(
    regex,
    '<span style="color: #3c88d4;">$1</span>'
  );

  // Split the query by commas to handle multiple spelling variations
  const queries = query.split(",").map((q) => q.trim());

  // Highlight each query variation in the sentence
  queries.forEach((q) => {
    // Define a regex pattern that includes Japanese characters and dynamically inserts the query
    const regex = new RegExp(`(\\b${q}\\b|\\b${q}(?![\\wčćđšžČĆĐŠŽ]))`, "gi");

    // Highlight all occurrences of the query variation in the sentence
    cleanSentence = cleanSentence.replace(
      regex,
      '<span style="color: #3c88d4;">$1</span>'
    );
  });

  // Get part of speech (POS) for the query to pass into `generateWordVariationsForSentences`
  const matchingWordEntry = results.find((result) =>
    result.ord.toLowerCase().includes(query)
  );
  const pos = matchingWordEntry ? matchingWordEntry.gender.toLowerCase() : "";

  // Generate word variations using the external function
  const wordVariations = generateWordVariationsForSentences(query, pos);

  // Apply highlighting for all word variations in sequence
  wordVariations.forEach((variation) => {
    const japaneseWordBoundary = `\\b${variation}\\b`;
    const regex = new RegExp(japaneseWordBoundary, "gi");
    cleanSentence = cleanSentence.replace(
      regex,
      '<span style="color: #3c88d4;">$&</span>'
    );
  });

  return cleanSentence; // Return the fully updated sentence
}

function renderSentencesHTML(sentenceResults, wordVariations) {
  let htmlString = ""; // String to accumulate the generated HTML
  let exactMatches = [];
  let inexactMatches = [];
  let uniqueSentences = new Set(); // Track unique sentences

  sentenceResults.forEach((result) => {
    // Strip out any existing <span> tags from the example sentence
    const rawSentence = result.eksempel.replace(/<[^>]*>/g, "");

    // Split the example sentence into individual sentences, handling sentence delimiters correctly
    const sentences = rawSentence.match(/[^.!?]+[.!?]*/g) || [rawSentence];

    sentences.forEach((sentence) => {
      const trimmedSentence = sentence.trim();
      if (!uniqueSentences.has(trimmedSentence)) {
        // Only add unique sentences
        uniqueSentences.add(trimmedSentence);

        // Check if the sentence contains any of the word variations
        let matchedVariation = wordVariations.find((variation) =>
          sentence.toLowerCase().includes(variation)
        );

        if (matchedVariation) {
          // Use a regular expression to match the full word containing any of the variations
          const japanesePattern = "[\\wčćđšžČĆĐŠŽ]"; // Pattern including Japanese letters
          const regex = new RegExp(
            `(${japanesePattern}*${matchedVariation}${japanesePattern}*)`,
            "gi"
          );

          const highlightedSentence = sentence.replace(
            regex,
            '<span style="color: #3c88d4;">$1</span>'
          );

          // Determine if it's an exact match (contains the exact search term as a full word)
          const exactMatchRegex = new RegExp(
            `\\b${matchedVariation.replace(
              /[-\/\\^$*+?.()|[\]{}]/g,
              "\\$&"
            )}\\b`,
            "i"
          );

          if (exactMatchRegex.test(sentence)) {
            exactMatches.push(highlightedSentence); // Exact match
          } else {
            inexactMatches.push(highlightedSentence); // Inexact match
          }
        } else {
        }
      }
    });
  });

  // Combine exact matches first, then inexact matches, respecting the 10 sentence limit
  const combinedMatches = [...exactMatches, ...inexactMatches].slice(0, 10);

  if (combinedMatches.length === 0) {
    console.warn("No sentences found for the word variations.");
  }

  // Generate HTML for the combined matches
  combinedMatches.forEach((sentence) => {
    htmlString += `
            <div class="definition">
                <p class="sentence">${sentence}</p>
            </div>
        `;
  });

  // If no sentences were matched, return a message indicating that
  if (htmlString === "") {
    htmlString = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">No Matching Sentences</span>
                </h2>
                <p>No sentences found for the word "${wordVariations.join(
                  ", "
                )}".</p>
            </div>
        `;
  }

  return htmlString;
}

function getWordClassForMetadata(pos = "") {
  return WordClass.getWordClass(pos);
}

// Ported from Norwegian's findWordEntryForMetadata() -- used by updateURL()
// below so a card-click navigation (not just a direct renderWordDefinition
// call) picks the right homograph's metadata when a word has more than one
// dictionary entry.
function findWordEntryForMetadata(word, selectedPOS = "") {
  const normalizedWord = String(word).trim().toLowerCase();
  const normalizedSelectedPOS = WordClass.getWordClass(selectedPOS);

  const wordMatches = results.filter((entry) =>
    String(entry.ord || "")
      .toLowerCase()
      .split(/[,、]/)
      .map((form) => form.trim())
      .includes(normalizedWord),
  );

  if (!normalizedSelectedPOS) {
    return wordMatches[0] || null;
  }

  const preciseMatch = wordMatches.find(
    (entry) => WordClass.getWordClass(entry.gender) === normalizedSelectedPOS,
  );

  return preciseMatch || wordMatches[0] || null;
}

function setWordMetaTag(attributeName, attributeValue, content) {
  let tag = document.head.querySelector(
    `meta[${attributeName}="${attributeValue}"]`,
  );

  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attributeName, attributeValue);
    document.head.appendChild(tag);
  }

  tag.setAttribute("content", content);
}

function setWordCanonicalURL(url) {
  let canonicalLink = document.head.querySelector('link[rel="canonical"]');

  if (!canonicalLink) {
    canonicalLink = document.createElement("link");
    canonicalLink.setAttribute("rel", "canonical");
    document.head.appendChild(canonicalLink);
  }

  canonicalLink.setAttribute("href", url);
}

// Ported from Norwegian's updateWordMetadata(), which points its canonical
// URL at a captured static /word/<slug>/ page (see
// norwegian/scripts/capture-word-pages.py). This app has no such
// pretty-path pipeline -- the query-string lookup URL is the only real,
// dereferenceable address for a given word, so that's the canonical target
// here instead.
function updateWordMetadata(entry) {
  if (!entry) return;

  const word = String(entry.ord || "")
    .split(/[,、]/)[0]
    .trim();

  const wordClass = getWordClassForMetadata(entry.gender);

  const englishTranslation = String(entry.engelsk || "")
    .replace(/\s+/g, " ")
    .trim();

  const pageTitle =
    `${word}${wordClass ? ` (${wordClass})` : ""} ` +
    "– Japanese-English Dictionary";

  const wordDescription = wordClass
    ? `${wordClass} "${word}"`
    : `word "${word}"`;

  let description = englishTranslation
    ? `Learn the Japanese ${wordDescription}, meaning ` +
      `"${englishTranslation}" in English. See definitions, ` +
      "pronunciation, CEFR level, and example sentences."
    : `Learn the Japanese ${wordDescription}. See definitions, ` +
      "pronunciation, CEFR level, and example sentences.";

  if (description.length > 160) {
    description =
      description
        .slice(0, 157)
        .replace(/\s+\S*$/, "")
        .trimEnd() + "...";
  }

  const canonicalURL = new URL(APP_ROOT_URL);
  canonicalURL.search = "";
  canonicalURL.hash = "";
  canonicalURL.searchParams.set("type", "words");
  canonicalURL.searchParams.set("word", word);

  const socialImageURL = new URL(
    "Resources/Icons/android-chrome-512x512.png",
    APP_ROOT_URL,
  ).href;

  document.title = pageTitle;

  setWordMetaTag("name", "description", description);
  setWordMetaTag("property", "og:title", pageTitle);
  setWordMetaTag("property", "og:description", description);
  setWordMetaTag("property", "og:type", "website");
  setWordMetaTag("property", "og:url", canonicalURL.href);
  setWordMetaTag("property", "og:image", socialImageURL);

  setWordCanonicalURL(canonicalURL.href);
}

// The multi-result summary definition renders inside a flex-item <p> that
// participates in the card's row layout. makeDefinitionClickable's <ul>/<li>
// output can't be nested inside a <p> -- browsers silently close the <p>
// right before the <ul>, popping the list out of the flex row and breaking
// its alignment with the word/POS column. This produces the same
// semicolon-separated "one sense per line" look with inline-safe markup
// instead, and deliberately isn't clickable: unlike the single-result view,
// clicking anywhere on this card already opens that single-result view, so
// per-word click targets here would only conflict with it. Ported from
// Norwegian's formatMultiResultDefinition().
function formatMultiResultDefinition(defText) {
  if (!defText) return "";
  if (!defText.includes(";")) return defText;

  const items = defText
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);

  return items
    .map((item) => `<span class="multiple-results-definition-item">${item}</span>`)
    .join("");
}

function renderWordDefinition(word, selectedPOS = "") {
  const trimmedWord = word.trim().toLowerCase();

  // Switch the type selector back to "words"
  const typeSelect = document.getElementById("type-select");
  typeSelect.value = "words";

  // Re-enable the POS filter
  const posSelect = document.getElementById("pos-select");
  posSelect.disabled = false;
  const posFilterContainer = document.querySelector(".pos-filter");
  posFilterContainer.classList.remove("disabled"); // Remove the 'disabled' class for visual effect

  // Filter results based on both word and selected POS if provided.
  const normalizedSelectedPOS = WordClass.getWordClass(selectedPOS);

  const matchingResults = results
    .filter((entry) => {
      // Some CSV entries contain comma/読点-separated spelling variants. A
      // direct lookup for any individual form must find the full entry.
      const wordMatch = String(entry.ord || "")
        .toLowerCase()
        .split(/[,、]/)
        .map((form) => form.trim())
        .includes(trimmedWord);

      const posMatch = normalizedSelectedPOS
        ? WordClass.getWordClass(entry.gender) === normalizedSelectedPOS
        : true;

      return wordMatch && posMatch;
    })
    .sort((left, right) => {
      // A spelling can be both its own headword and an alternative spelling
      // on an earlier CSV row. A direct lookup for a secondary spelling
      // must still use the true headword's own row for its title and
      // metadata. Keep all homographs visible; only put an exact primary
      // headword ahead of rows where the requested spelling is secondary.
      const isPrimary = (entry) =>
        String(entry.ord || "")
          .split(/[,、]/)[0]
          .trim()
          .toLowerCase() === trimmedWord;
      return Number(isPrimary(right)) - Number(isPrimary(left));
    });

  if (matchingResults.length > 0) {
    displaySearchResults(matchingResults, "", { primaryHeading: true });
    updateWordMetadata(matchingResults[0]);
  } else {
    document.getElementById("results-container").innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">No Definition Found</span>
                </h2>
                <p>No definition found for "${trimmedWord}".</p>
            </div>
        `;
  }
}

// Word forms distinguish real inflections from an accidental substring (刻む
// vs 刻んだ vs 時), the same problem Norwegian's definition page solves with
// SentenceFormMatching + Inflections.getSentenceForms -- see that app's
// scripts.js for the version this mirrors.
function getSentenceCefrLabelHTML(cefrLevel) {
  const cefrClass = getCefrClass(cefrLevel);
  return cefrClass
    ? `<div class="sentence-cefr-label ${cefrClass}" title="${getCefrTooltip(cefrLevel)}">${cefrLevel}</div>`
    : "";
}

// Every dictionary row sharing a spelling with `entry` (comma/読点-separated
// variants included) -- used to keep a homograph's own example from being
// double-counted as a supplemental match for this entry. Small dictionary,
// so a direct scan over `results` is simpler than maintaining an index.
function getHomographEntries(entry) {
  const forms = String(entry?.ord || "")
    .split(/[,、]/)
    .map((form) => form.trim().toLowerCase())
    .filter(Boolean);
  if (forms.length === 0) return [];
  return results.filter((candidate) =>
    String(candidate?.ord || "")
      .split(/[,、]/)
      .map((form) => form.trim().toLowerCase())
      .some((form) => forms.includes(form)),
  );
}

// SentenceFormMatching's blue spans distinguish search matches. Definition
// examples are a teaching surface, so use the same yellow marker as the
// word game's learning context while preserving its inflection-aware forms.
function renderDefinitionSentenceHighlight(matcher, sentence) {
  const highlightedSentence = matcher.highlight(sentence);
  return highlightedSentence.replace(
    /<span style="color: var\(--color-interactive\);">(.*?)<\/span>/gi,
    '<mark class="definition-sentence-target">$1</mark>',
  );
}

function renderDefinitionSentenceResults(
  matchingResults,
  primaryResults,
  formMatcher,
  primaryHighlightMatcher,
  sentenceContainer,
  button,
  showEnglish,
) {
  if (matchingResults.length === 0) return false;

  const primaryResultSet = new Set(primaryResults);
  const highlightedResults = matchingResults.slice(0, 10).map((result) => {
    const cleanSentence = result.eksempel.replace(
      /<span style="color: var\(--color-interactive\);">(.*?)<\/span>/gi,
      "$1",
    );
    const highlightMatcher = primaryResultSet.has(result)
      ? primaryHighlightMatcher
      : formMatcher;
    return {
      ...result,
      eksempel: renderDefinitionSentenceHighlight(highlightMatcher, cleanSentence),
    };
  });

  const sentenceContent = highlightedResults
    .map((result) => {
      // eksempel/sentenceTranslation always hold exactly one sentence each.
      const sentences = result.eksempel ? [result.eksempel] : [];
      const translations = result.sentenceTranslation
        ? [result.sentenceTranslation]
        : [];
      const cefrLabel = getSentenceCefrLabelHTML(result.CEFR);

      return sentences
        .map(
          (sentence, index) => `
            <div class="sentence-container">
                <div class="sentence-box-norwegian ${
                  !showEnglish ? "sentence-box-norwegian-hidden" : ""
                }">
                  <div class="sentence-content">
                  <div class="cefr-audio-block">

                    ${cefrLabel}
                ${
                  result.sentenceAudio === "X"
                    ? `<i class="fas fa-volume-up sentence-audio-icon"
                          role="button" tabindex="0" aria-label="Play sentence audio"
                          data-sentence="${sentence
                            .replace(/<[^>]*>/g, "")
                            .trim()}"></i>`
                    : ""
                }
                </div>
                <p class="sentence">${sentence}</p>
                  </div>
                </div>
                ${
                  translations[index]
                    ? `
                <div class="sentence-box-english ${
                  showEnglish ? "" : "hidden"
                }">
                    <p class="sentence-translation">${translations[index]}</p>
                </div>`
                    : ""
                }
            </div>
        `,
        )
        .join("");
    })
    .join("");

  if (!sentenceContent) return false;

  sentenceContainer.innerHTML = sentenceContent;
  sentenceContainer.style.display = "block";
  if (button) {
    button.style.display = "block";
    button.innerText = showEnglish ? "Hide English" : "Show English";
  }
  return true;
}

// Fetch and render sentences for one exact dictionary sense, using its full
// conjugated word-forms paradigm (verb/adjective) or headword (every other
// class) to search the corpus and highlight matches.
async function fetchAndRenderSentences(word, pos, showEnglish = true) {
  const trimmedWord = word
    .trim()
    .toLowerCase()
    .replace(/[\r\n]+/g, ""); // Remove any carriage returns or newlines
  const sentenceContainer = document.getElementById(
    `sentences-container-${trimmedWord}`
  );

  if (!sentenceContainer) {
    console.error(`Sentence container not found for: ${trimmedWord}`);
    return;
  }
  const button = sentenceContainer.previousElementSibling?.querySelector(
    ".english-toggle-btn",
  );

  // Toggle visibility without re-fetching sentences
  if (sentenceContainer.getAttribute("data-fetched") === "true") {
    if (!button) return;
    if (sentenceContainer.style.display === "block") {
      sentenceContainer.style.display = "none";
      button.innerText = "Show Sentences";
      button.classList.remove("hide");
      button.classList.add("show");
    } else {
      sentenceContainer.style.display = "block";
      button.innerText = "Hide Sentences";
      button.classList.remove("show");
      button.classList.add("hide");
    }
    return;
  }

  const matchingWordEntry = results.find(
    (result) =>
      result.ord.toLowerCase() === trimmedWord &&
      result.gender.toLowerCase().includes((pos || "").toLowerCase())
  );
  if (!matchingWordEntry) {
    console.error(`No matching word found for "${trimmedWord}".`);
    return; // Stop if the word isn't found
  }

  sentenceContainer.innerHTML = ""; // Clear previous sentences

  // Every dictionary entry already carries its own example in the main CSV.
  // Render that immediately instead of holding it behind the word-forms
  // lookup needed only for supplemental examples, so a cold or slow
  // connection still shows useful content right away.
  const headwords = matchingWordEntry.ord
    .split(/[,、]/)
    .map((form) => form.trim())
    .filter(Boolean);
  const citationMatcher = window.SentenceFormMatching.createMatcher(headwords);
  const { primary: immediatePrimaryResults } =
    window.SentenceFormMatching.collectExamples(
      matchingWordEntry,
      [],
      citationMatcher,
      0,
    );
  renderDefinitionSentenceResults(
    immediatePrimaryResults,
    immediatePrimaryResults,
    citationMatcher,
    citationMatcher,
    sentenceContainer,
    button,
    showEnglish,
  );
  sentenceContainer.setAttribute("data-supplemental-loading", "true");

  const homographEntries = getHomographEntries(matchingWordEntry);
  const sentenceForms = await window.Inflections.getSupplementalSentenceForms(
    matchingWordEntry,
    homographEntries,
  );
  const primaryHighlightForms =
    await window.Inflections.getSentenceForms(matchingWordEntry);
  if (!sentenceContainer.isConnected) return;
  const formMatcher = window.SentenceFormMatching.createMatcher(sentenceForms);
  const primaryHighlightMatcher =
    window.SentenceFormMatching.createMatcher(primaryHighlightForms);
  const { primary: primaryResults, supplemental: supplementalResults } =
    window.SentenceFormMatching.collectExamples(
      matchingWordEntry,
      results,
      formMatcher,
      100,
      homographEntries.filter((entry) => entry !== matchingWordEntry),
    );

  // Rank supplemental examples without allowing them to move ahead of the
  // primary entry's own example sentence(s).
  const rankedSupplemental = prioritizeResults(
    supplementalResults,
    trimmedWord,
    "eksempel",
    pos,
  );
  const matchingResults = [...primaryResults, ...rankedSupplemental].slice(0, 10);

  if (matchingResults.length === 0) {
    sentenceContainer.removeAttribute("data-supplemental-loading");
    sentenceContainer.setAttribute("data-fetched", "true");
    return;
  }

  renderDefinitionSentenceResults(
    matchingResults,
    primaryResults,
    formMatcher,
    primaryHighlightMatcher,
    sentenceContainer,
    button,
    showEnglish,
  );

  sentenceContainer.removeAttribute("data-supplemental-loading");
  sentenceContainer.setAttribute("data-fetched", "true");
}

// Spinner Control Functions
function showSpinner() {
  document.getElementById("loading-spinner").style.display = "block";
}

function hideSpinner() {
  document.getElementById("loading-spinner").style.display = "none";
}

// Prioritize results based on query position or exact match
function prioritizeResults(results, query, key, pos) {
  // Define regex for exact match and start of word
  const regexStartOfWord = new RegExp(`\\b${query}`, "i");
  const regexExactMatch = new RegExp(`\\b${query}\\b`, "i");

  // Define CEFR level order
  const CEFROrder = ["A1", "A2", "B1", "B2", "C"];

  // Separate `direct examples` where both `ord` and `pos` match
  const directExamples = results.filter(
    (r) => r.ord.toLowerCase() === query.toLowerCase() && r.pos === pos
  );
  const otherResults = results.filter(
    (r) => r.ord.toLowerCase() !== query.toLowerCase() || r.pos !== pos
  );

  // Sort the other results with the usual criteria
  const sortedOthers = otherResults.sort((a, b) => {
    const aText = a[key].toLowerCase();
    const bText = b[key].toLowerCase();

    // Prioritize entries with both `eksempel` and `sentenceTranslation`
    const aHasExampleAndTranslation = a.eksempel && a.sentenceTranslation;
    const bHasExampleAndTranslation = b.eksempel && b.sentenceTranslation;

    if (aHasExampleAndTranslation && !bHasExampleAndTranslation) return -1;
    if (!aHasExampleAndTranslation && bHasExampleAndTranslation) return 1;

    // First, prioritize CEFR levels (lower levels come first)
    if (a.CEFR && b.CEFR) {
      // Handle missing CEFR values by assigning a default
      const aCEFR = a.CEFR ? a.CEFR.toUpperCase() : "C";
      const bCEFR = b.CEFR ? b.CEFR.toUpperCase() : "C";

      const aCEFRIndex = CEFROrder.indexOf(aCEFR);
      const bCEFRIndex = CEFROrder.indexOf(bCEFR);

      if (aCEFRIndex !== bCEFRIndex) {
        return aCEFRIndex - bCEFRIndex;
      }
    }

    // Prioritize exact matches
    const aExactMatch = regexExactMatch.test(aText);
    const bExactMatch = regexExactMatch.test(bText);

    if (aExactMatch && !bExactMatch) {
      return -2;
    }
    if (!aExactMatch && bExactMatch) {
      return 2;
    }

    // Check if the query appears at the start of a word
    const aStartsWithWord = regexStartOfWord.test(aText);
    const bStartsWithWord = regexStartOfWord.test(bText);

    // Prioritize where the query starts a word
    if (aStartsWithWord && !bStartsWithWord) return -1;
    if (!aStartsWithWord && bStartsWithWord) return 1;

    // Otherwise, sort by the position of the query in the text (earlier is better)
    return aText.indexOf(query) - bText.indexOf(query);
  });
  // Combine direct examples at the top, followed by sorted other results
  return [...directExamples, ...sortedOthers];
}

// Update URL based on current search parameters
function updateURL(query, type, selectedPOS, story = null, word = null) {
  const url = new URL(window.location);

  // Set or remove the query parameter
  if (query) {
    url.searchParams.set("query", query);
  } else {
    url.searchParams.delete("query");
  }

  // Always set the type parameter in the URL
  if (type) {
    url.searchParams.set("type", type);
  } else {
    url.searchParams.delete("type");
  }

  // Set or remove the POS parameter
  if (selectedPOS) {
    url.searchParams.set("pos", selectedPOS);
  } else {
    url.searchParams.delete("pos");
  }

  // Set or remove the story parameter
  if (story) {
    url.searchParams.set("story", story);
  } else {
    url.searchParams.delete("story");
  }

  // Set the word parameter if a specific word entry is clicked
  if (word) {
    url.searchParams.set("word", word);
    // Update the URL without reloading the page
    window.history.pushState({}, "", url);

    // Apply the matching word's full SEO metadata (title, description, OG
    // tags, canonical link) -- mirrors renderWordDefinition()'s own direct
    // updateWordMetadata() call, so a card-click navigation into a
    // definition gets the same treatment as a direct link into one.
    // Ported from Norwegian's updateURL().
    const metadataEntry = findWordEntryForMetadata(word, selectedPOS);
    if (metadataEntry) {
      updateWordMetadata(metadataEntry);
    } else {
      document.title = `${word} - Japanese Dictionary`; // Set title to the word
    }
    return; // Stop further execution to keep this title
  }

  // Update the page title based on the context, if no specific word is provided
  if (story) {
    document.title = `${decodeURIComponent(story)} - Japanese Story`;
  } else if (query) {
    document.title = `${query} - ${capitalizeType(
      type
    )} Search - Japanese Dictionary`;
  } else if (type) {
    document.title = `${capitalizeType(type)} - Japanese Dictionary`;
  } else {
    document.title = "Japanese Dictionary";
  }

  // Update the URL without reloading the page
  window.history.pushState({}, "", url);
}

// Helper function to capitalize and format type correctly
function capitalizeType(type) {
  switch (type) {
    case "words":
      return "Words";
    case "word-game":
      return "Word Game";
    case "sentences":
      return "Sentences";
    case "stories":
      return "Stories";
    case "pronunciation":
      return "Pronunciation";

    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

// Load the state from the URL and trigger the appropriate search or display
function loadStateFromURL() {
  const url = new URL(window.location);
  const query = url.searchParams.get("query") || ""; // Default to an empty query if not present
  const type = url.searchParams.get("type") || "words"; // Default to 'words' if not specified
  const selectedPOS = url.searchParams.get("pos") || ""; // Default to empty POS if not present
  const storyTitle = url.searchParams.get("story"); // Check for a specific story parameter
  const word = url.searchParams.get("word"); // Check for a specific word entry

  // A captured /word/<slug>/ pretty-path page (see capture-word-pages.py)
  // already has its exact renderWordDefinition() output baked in, and
  // carries no ?word= param for the check below to recognize. Left alone,
  // the default words-mode branch further down runs once the dictionary
  // loads and calls clearContainer(), wiping that pre-rendered definition
  // before this app's own JS ever gets a chance to show it again -- same
  // failure mode the story preload below exists to prevent.
  if (/\/word\/[^/]+\/?$/.test(url.pathname) && !word) {
    return;
  }

  // A captured /story/<slug>/ page embeds this one story's full data
  // directly (window.__PRELOADED_STORY__ — see
  // scripts/capture-story-pages.py) since that pretty-path URL carries no
  // ?story= param for the check above to read. Without this, the page would
  // fall through to the default words-mode branch below once the
  // dictionary loads, which clears out the story content this script just
  // rendered (syncModeNav("words") -> resetStoryReaderView()).
  const preloadedStory = window.__PRELOADED_STORY__;

  // If there's a story in the URL, display that story and exit
  if (storyTitle || preloadedStory) {
    const titleJapanese = storyTitle
      ? decodeURIComponent(storyTitle)
      : preloadedStory.titleJapanese;
    document.title = `${titleJapanese} - Japanese Story`;
    syncModeNav("stories");
    if (
      preloadedStory &&
      !storyTitle &&
      !storyResults.some((s) => s.titleJapanese === preloadedStory.titleJapanese)
    ) {
      storyResults = [preloadedStory, ...storyResults];
    }
    displayStory(titleJapanese); // Display the specific story
    return; // Exit function as story is being displayed
  }

  // Function to display the word entry once data is loaded
  function displayWordIfLoaded() {
    if (results.length > 0) {
      // Check if dictionary data is loaded
      if (word) {
        // Set title to the word
        document.title = `${word} - Japanese Dictionary`;
        syncModeNav("words");
        showLandingCard(false);
        resultsContainer.innerHTML = "";

        // Render only matching results by filtering directly within renderWordDefinition
        renderWordDefinition(word, selectedPOS);

        clearInterval(checkDataLoaded); // Stop checking once data is loaded
        return; // Exit function to prevent further handling
      }

      // Continue with regular URL-based loading if no specific word is in the URL
      document.getElementById("search-bar").value = query;
      document.getElementById("type-select").value = type;
      // Unconditional (not left to handleTypeChange below): the "words"
      // branch never calls handleTypeChange at all, so #mode-nav would
      // otherwise show no tab active on a plain page load/reload.
      syncModeNav(type);
      if (selectedPOS) {
        document.getElementById("pos-select").value = selectedPOS;
      }

      if (type === "word-game") {
        startWordGame();
      } else if (type === "pronunciation") {
        handleTypeChange("pronunciation"); // 👈 ensure pronunciation tab is restored
      } else if (type !== "words") {
        handleTypeChange(type);
      }

      // Perform a search if a query is specified; otherwise, show the landing page
      if (query) {
        search();
      } else if (type === "words") {
        document.title = "Japanese Dictionary | Search in Japanese or English";
        clearContainer();
        showLandingCard(true);
      }

      clearInterval(checkDataLoaded); // Stop checking once data is loaded
    }
  }
  // Set an interval to check data load status before proceeding
  const checkDataLoaded = setInterval(displayWordIfLoaded, 100);
}

function normalizeResultCardMatchValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Function to handle clicking on a search result card
function handleCardClick(event, word, pos, engelsk, definisjon) {
  // Filter to count only visible elements with the specific card class.
  // Cards may be nested inside a wrapper, so search descendants, not just
  // direct children.
  const visibleCards = Array.from(
    resultsContainer.querySelectorAll(".definition"),
  ).filter((card) => card.offsetParent !== null);

  // Prevent activation if only one card is displayed
  if (visibleCards.length === 1) {
    return;
  }

  // Filter results by word, POS (part of speech), and the English translation
  const clickedResult = results.filter((r) => {
    const wordMatch =
      normalizeResultCardMatchValue(r.ord) === normalizeResultCardMatchValue(word);
    const genderMatch =
      normalizeResultCardMatchValue(r.gender) === normalizeResultCardMatchValue(pos);
    const engelskMatch =
      normalizeResultCardMatchValue(r.engelsk) ===
      normalizeResultCardMatchValue(engelsk);
    const definisjonMatch =
      normalizeResultCardMatchValue(r.definisjon) ===
      normalizeResultCardMatchValue(definisjon);

    return wordMatch && genderMatch && engelskMatch && definisjonMatch;
  });

  if (clickedResult.length === 0) {
    console.error(
      `No result found for word: "${word}" with POS: "${pos}" and English: "${engelsk}"`
    );
    return;
  }

  // Clear all other results and keep only the clicked card
  resultsContainer.innerHTML = ""; // Clear the container

  if (latestMultipleResults) {
    const backDiv = document.createElement("div");
    backDiv.className = "back-navigation";
    backDiv.tabIndex = 0;
    backDiv.setAttribute("role", "button");

    // Create the icon element
    const icon = document.createElement("i");
    icon.className = "fas fa-chevron-left";

    // Create the text element
    const text = document.createTextNode(
      ` Back to Results for "${latestMultipleResults}"`
    );

    // Append icon and text to backDiv
    backDiv.appendChild(icon);
    backDiv.appendChild(text);

    // Append backDiv to resultsContainer
    resultsContainer.appendChild(backDiv);
  }

  // Clear the search bar
  clearInput();

  // Display the clicked result
  displaySearchResults(clickedResult); // This ensures only the clicked card remains

  // Update the URL to reflect the clicked entry
  updateURL("", "words", pos, null, word.split(/[,、]/)[0].trim());
}

// Initialization of the dictionary data and event listeners
window.onload = function () {
  // Check if the buttons exist in the DOM
  const searchBtn = document.getElementById("search-btn");
  const searchBar = document.getElementById("search-bar");
  const clearBtn = document.getElementById("clear-btn");
  const typeSelect = document.getElementById("type-select");
  const posSelect = document.getElementById("pos-select");
  const cefrSelect = document.getElementById("cefr-select");
  const typeFilterContainer = document.querySelector(".type-filter");
  const posFilterContainer = document.querySelector(".pos-filter");
  const cefrFilterContainer = document.querySelector(".cefr-filter");

  if (
    searchBtn &&
    searchBar &&
    clearBtn &&
    posSelect &&
    cefrSelect
  ) {
    searchBtn.disabled = true;
    searchBar.disabled = true;
    clearBtn.disabled = true;
    posSelect.disabled = true;
    cefrSelect.disabled = true;
    typeSelect.disabled = true;

    // Apply the disabled styling
    searchBtn.style.color = "#ccc";
    searchBtn.style.cursor = "not-allowed";
    searchBar.style.color = "#ccc";
    searchBar.style.cursor = "not-allowed";
    clearBtn.style.color = "#ccc";
    clearBtn.style.cursor = "not-allowed";
    typeFilterContainer.classList.add("disabled");
    posFilterContainer.classList.add("disabled"); // Add the 'disabled' class to visually disable POS filter
    cefrFilterContainer.classList.add("disabled"); // Add the 'disabled' class to visually disable CEFR filter
  }

  fetchAndLoadDictionaryData(); // Load dictionary data when the page is refreshed

  // Wait for the data to be fetched before triggering the search
  const checkDataLoaded = setInterval(() => {
    if (results.length > 0) {
      // Ensure results are loaded
      clearInterval(checkDataLoaded);

      // Enable the buttons once data is fully loaded
      // Enable the buttons and filters once data is fully loaded
      searchBtn.disabled = false;
      searchBar.disabled = false;
      clearBtn.disabled = false;
      typeSelect.disabled = false;
      posSelect.disabled = false;
      cefrSelect.disabled = false;

      // Restore original styling
      searchBtn.style.color = "";
      searchBtn.style.cursor = "pointer";
      searchBar.style.color = "";
      searchBar.style.cursor = "text";
      clearBtn.style.color = "";
      clearBtn.style.cursor = "pointer";
      typeFilterContainer.classList.remove("disabled"); // Remove 'disabled' class for POS filter
      posFilterContainer.classList.remove("disabled"); // Remove 'disabled' class for POS filter
      cefrFilterContainer.classList.remove("disabled"); // Remove 'disabled' class for CEFR filter

      // Load state from URL
      loadStateFromURL(); // This checks the URL for query/type/POS and triggers the appropriate search
    }
  }, 100);

  initializeModeNav();
  initializeAccountMenu();
  updateLandingProofLine();

  // Add event listener to POS filter dropdown
  document
    .getElementById("pos-select")
    .addEventListener("change", handlePOSChange);

  // Add event listener to POS filter dropdown
  document
    .getElementById("cefr-select")
    .addEventListener("change", handleCEFRChange);

  // Add event listener to the search bar to trigger handleKey on key press
  document.getElementById("search-bar").addEventListener("keyup", handleKey);

  document.addEventListener("click", (event) => {
    // closest(), not matches() -- the icon and text inside .back-navigation
    // are themselves valid click targets, and matches() alone missed those.
    if (event.target.closest(".back-navigation")) {
      search(latestMultipleResults);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.closest(".back-navigation")
    ) {
      event.preventDefault();
      search(latestMultipleResults);
    }
  });
};

window.addEventListener("popstate", () => {
  loadStateFromURL(); // Re-load everything based on current URL
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target.classList.contains("clickable-definition-word")) {
    let word = target.getAttribute("data-word").toLowerCase();
    const searchInput = document.getElementById("search-bar");

    if (searchInput) {
      searchInput.value = "";
      clearInput();

      // Find exact matches for the clicked word
      const exactMatches = results.filter((r) =>
        r.ord
          .toLowerCase()
          .split(/[,、]/)
          .map((s) => s.trim())
          .includes(word)
      );

      if (exactMatches.length === 1) {
        // Fully emulate the click-to-expand behavior for a single result
        latestMultipleResults = null;
        resultsContainer.innerHTML = ""; // Clear previous results

        // Display only the matched entry
        displaySearchResults(exactMatches);

        // Update the URL and page title
        updateURL(
          null,
          "words",
          exactMatches[0].gender.toLowerCase(),
          null,
          word
        );
      } else {
        search(word); // fallback to regular multi-result search
      }
    }
  }
});

function playSentenceAudioIcon(target) {
  stopAllAudio();
  const text = target.dataset.sentence;
  let audioUrl;

  // Decide if this is a word or a sentence based on where the icon lives
  if (target.closest(".pronunciation")) {
    // Word-level audio
    audioUrl = buildWordAudioUrl(text);
  } else {
    // Sentence-level audio
    audioUrl = buildPronAudioUrl(text);
  }

  const audio = new Audio(audioUrl);
  activeAudio.push(audio);
  audio.play().catch((err) => {
    console.error("Audio playback failed:", err);
  });
}

document.addEventListener("click", (event) => {
  if (event.target.classList.contains("sentence-audio-icon")) {
    playSentenceAudioIcon(event.target);
  }
});

// role="button" on these <i> icons makes them focusable (tabindex="0"),
// but only a real <button>/<a> gets Enter/Space activation for free -- a
// custom role needs it wired up by hand per the WAI-ARIA APG.
document.addEventListener("keydown", (event) => {
  if (
    event.target.classList.contains("sentence-audio-icon") &&
    (event.key === "Enter" || event.key === " ")
  ) {
    event.preventDefault();
    playSentenceAudioIcon(event.target);
  }
});
