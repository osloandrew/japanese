let storyResults = []; // Global variable to store the stories
let currentSpeed = 1.0; // default speed

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

const CSV_URL = "spanishStories.csv";
const STORY_CACHE_KEY = "storyDataEs";
const STORY_CACHE_TIME_KEY = "storyDataTimestampEs";

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
      titleSpanish: (entry.titleSpanish || "").trim(),
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
    titleSpanish: (entry.titleSpanish || "").trim(),
  }));
}

// Helper function to determine CEFR class
function getCefrClass(cefrLevel) {
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

async function displayStoryList(filteredStories = storyResults) {
  showSpinner(); // Show spinner before rendering story list
  restoreSearchContainerInner();
  removeStoryHeader();
  clearContainer(); // Clear previous results

  // Reset the page title and URL to the main list view
  document.title = "Stories - Spanish Dictionary";
  history.replaceState(
    {},
    "",
    `${window.location.origin}${window.location.pathname}`
  );
  updateURL(null, "stories", null);

  // Retrieve selected CEFR and genre filter values
  const selectedCEFR = document
    .getElementById("cefr-select")
    .value.toUpperCase()
    .trim();
  const selectedGenre = document
    .getElementById("genre-select")
    .value.toLowerCase()
    .trim();

  // NEW: read search text (support either id if your HTML differs)
  const searchInput =
    document.getElementById("search-bar") ||
    document.getElementById("stories-search") ||
    document.getElementById("global-search");
  const searchText = (searchInput?.value || "").toLowerCase().trim();

  // Filter stories based on selected CEFR and genre
  let filtered = filteredStories.filter((story) => {
    const genreMatch = selectedGenre
      ? story.genre && story.genre.trim().toLowerCase() === selectedGenre
      : true;
    const cefrMatch = selectedCEFR
      ? story.CEFR && story.CEFR.trim().toUpperCase() === selectedCEFR
      : true;
    const hasSpanish = story.spanish && story.spanish.trim() !== "";
    // NEW: title search across ES + EN titles, like JP
    const matchesSearch =
      !searchText ||
      (story.titleSpanish &&
        story.titleSpanish.toLowerCase().includes(searchText)) ||
      (story.titleEnglish &&
        story.titleEnglish.toLowerCase().includes(searchText));

    return genreMatch && cefrMatch && hasSpanish && matchesSearch;
  });

  // Shuffle the filtered stories using Fisher-Yates algorithm
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  // ▶ NEW: populate <ul id="stories"> with <li> items (JP mirror)
  const container = document.getElementById("results-container");
  let storyList = document.getElementById("stories");
  if (!storyList) {
    storyList = document.createElement("ul");
    storyList.id = "stories";
    storyList.className = "stories-list";
    container.appendChild(storyList);
  }
  storyList.innerHTML = ""; // clear old list items

  filtered.forEach((story) => {
    const li = document.createElement("li");
    li.className = "stories-list-item"; // reuse your existing styling class
    li.style.display = "flex";
    li.style.justifyContent = "space-between";
    li.style.alignItems = "center";

    // left: titles (ES over EN if different)
    const titleContainer = document.createElement("div");
    titleContainer.classList.add("title-container");

    const es = document.createElement("div");
    es.classList.add("japanese-title"); // reuse existing class name to avoid CSS churn
    es.textContent = story.titleSpanish;

    titleContainer.appendChild(es);

    if (story.titleSpanish !== story.titleEnglish) {
      const en = document.createElement("div");
      en.classList.add("english-title", "stories-subtitle");
      en.textContent = story.titleEnglish || "";
      titleContainer.appendChild(en);
    }

    // right: genre icon + CEFR
    const detail = document.createElement("div");
    detail.classList.add("stories-detail-container");

    const genreDiv = document.createElement("div");
    genreDiv.classList.add("stories-genre");
    genreDiv.innerHTML =
      (story.genre && genreIcons[story.genre.toLowerCase()]) || "";

    const cefrDiv = document.createElement("div");
    cefrDiv.classList.add("cefr-value", getCefrClass(story.CEFR));
    cefrDiv.textContent = story.CEFR || "N/A";

    detail.appendChild(genreDiv);
    detail.appendChild(cefrDiv);

    li.appendChild(titleContainer);
    li.appendChild(detail);

    // click → open reader (unchanged behavior)
    li.addEventListener("click", () => displayStory(story.titleSpanish));

    storyList.appendChild(li);
  });

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

async function displayStory(titleSpanish) {
  document.documentElement.classList.add("reading");
  showSpinner(); // Show spinner at the start of story loading
  const searchContainer = document.getElementById("search-container");
  const searchContainerInner = document.getElementById(
    "search-container-inner"
  );
  const selectedStory = storyResults.find(
    (story) => story.titleSpanish === titleSpanish
  );

  if (!selectedStory) {
    console.error(`No story found with the title: ${titleSpanish}`);
    return;
  }

  document.title = selectedStory.titleSpanish + " - Spanish Dictionary";

  updateURL(null, "story", null, titleSpanish); // Update URL with story parameter

  clearContainer();

  // Check for the image (mirror JP: EN title only)
  const imageFileURL = await hasImageByEnglishTitle(selectedStory.titleEnglish);

  // Check for the audio file
  const audioFileURL = await hasAudio(selectedStory.titleEnglish);
  const audioHTML = audioFileURL
    ? `<audio controls src="${audioFileURL}" class="stories-audio-player"></audio>`
    : "";
  // Build sticky header here, just before audio is constructed
  const genreIcon = genreIcons[selectedStory.genre.toLowerCase()] || "";
  const cefrClass = getCefrClass(selectedStory.CEFR);

  const sticky = document.getElementById("sticky-header");
  sticky.classList.remove("hidden");

  // 1) Render a stable skeleton with fixed slots so layout never reflows
  sticky.innerHTML = `
  <div class="sticky-detail-container">
    <div class="sticky-row">
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
      isEnglishVisible = !isEnglishVisible;
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

    for (let i = 0; i < spanishSentences.length; i++) {
      const spanishSentence = spanishSentences[i].trim();
      const englishSentence = englishSentences[i]
        ? englishSentences[i].trim()
        : "";

      contentHTML += `
    <div class="couplet">
      <div class="japanese-sentence">${spanishSentence}</div>
      <div class="english-sentence">${englishSentence}</div>
    </div>
  `;
    }

    const storyViewer = document.getElementById("story-viewer");
    const storyContent = document.getElementById("story-content");
    const listEl = document.getElementById("results-container");

    if (storyContent) {
      storyContent.innerHTML = contentHTML; // render story body into the reader pane
      // Insert the sticky title above the first child (mirror JP order)
      const titleNode = document.createElement("div");
      titleNode.className = "sticky-title-container";
      titleNode.innerHTML = `
  <h2 class="sticky-title-japanese">${selectedStory.titleSpanish}</h2>
  ${
    selectedStory.titleSpanish !== selectedStory.titleEnglish
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
  };

  // Process story text into sentences
  const standardizedSpanish = selectedStory.spanish.replace(/[“”«»]/g, '"');
  const standardizedEnglish = selectedStory.english.replace(/[“”«»]/g, '"');
  const sentenceRegex =
    /(?:(["]?.+?(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bDr)(?<!\bProf)(?<!\bJr)(?<!\bSr)(?<!\bSt)(?<!\bMt)[.!?]["]?)(?=\s|$)|(?:\.\.\."))/g;
  let spanishSentences = standardizedSpanish.match(sentenceRegex) || [
    standardizedSpanish,
  ];
  let englishSentences = standardizedEnglish.match(sentenceRegex) || [
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

  spanishSentences = combineSentences(spanishSentences);
  englishSentences = combineSentences(englishSentences, /\basked\b/i);

  finalizeContent(false);
}

// Function to toggle the visibility of English sentences and update Spanish box styles
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

  // 1) Capture current CEFR/Genre BEFORE changing the UI
  const cefrElBefore = document.getElementById("cefr-select");
  const genreElBefore = document.getElementById("genre-select");
  const savedCEFR = cefrElBefore ? cefrElBefore.value : "";
  const savedGenre = genreElBefore ? genreElBefore.value : "";

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
  if (cefrElAfter) cefrElAfter.value = savedCEFR;
  if (genreElAfter) genreElAfter.value = savedGenre;

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

  // After data is loaded, wire up live filtering like JP:
  const searchEl =
    document.getElementById("search-bar") ||
    document.getElementById("stories-search") ||
    document.getElementById("global-search");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      if (isStoriesTabActive()) {
        displayStoryList();
      }
    });
  }
  if (cefrEl) {
    cefrEl.addEventListener("change", () => {
      if (isStoriesTabActive()) {
        displayStoryList();
      }
    });
  }

  if (genreEl) {
    genreEl.addEventListener("change", () => {
      if (isStoriesTabActive()) {
        displayStoryList();
      }
    });
  }
});
