let currentWord;
let correctTranslation;
let correctlyAnsweredWords = []; // Array to store correctly answered words
let correctLevelAnswers = 0; // Track correct answers per level
let correctCount = 0; // Tracks the total number of correct answers
let correctStreak = 0; // Track the current streak of correct answers
let currentCEFR = "A1"; // Start at A1 by default
let levelCorrectAnswers = 0;
let levelTotalQuestions = 0;
let gameActive = false;
let incorrectCount = 0; // Tracks the total number of incorrect answers
let incorrectWordQueue = []; // Queue for storing incorrect words with counters
const levelThresholds = {
  A1: { up: 0.85, down: null }, // Starting level — can't go lower
  A2: { up: 0.9, down: 0.6 },
  B1: { up: 0.94, down: 0.7 },
  B2: { up: 0.975, down: 0.8 },
  C: { up: null, down: 0.9 }, // Final level — can fall from here, but not climb higher
};
let previousWord = null;
let recentAnswers = []; // Track the last X answers, 1 for correct, 0 for incorrect
let reintroduceThreshold = 10; // Set how many words to show before reintroducing incorrect ones
let totalQuestions = 0; // Track total questions per level
let wordsSinceLastIncorrect = 0; // Counter to track words shown since the last incorrect word
let wordDataStore = [];
let questionsAtCurrentLevel = 0; // Track questions answered at current level
let goodChime = new Audio("Resources/Audio/goodChime.wav");
let badChime = new Audio("Resources/Audio/badChime.wav");
let popChime = new Audio("Resources/Audio/popChime.wav");

goodChime.volume = 0.2;
badChime.volume = 0.2;

const gameContainer = document.getElementById("results-container"); // Assume this is where you'll display the game
const statsContainer = document.getElementById("game-session-stats"); // New container for session stats

// Centralized banner handler
const banners = {
  congratulations: "game-congratulations-banner",
  fallback: "game-fallback-banner",
  streak: "game-streak-banner", // New banner for 10-word streak
  clearedPracticeWords: "game-cleared-practice-banner", // New banner for clearing reintroduced words
};

const clearedPracticeMessages = [
  "🎉 Awesome! You've cleared all practice words!",
  "👏 Great job! Practice makes perfect.",
  "🌟 Stellar effort! Practice words completed.",
  "🏆 Victory! Practice session conquered.",
  "🚀 You're ready for the next challenge!",
  "🎓 Practice complete! Onward to new words.",
  "🔥 Practice words? Done and dusted!",
  "💡 Bright work! Practice session finished.",
  "🎯 Target achieved! Practice words cleared.",
  "🧠 Brainpower at its best! Practice complete.",
];

const congratulationsMessages = [
  "🎉 Fantastic work! You've reached level {X}!",
  "🏅 Congratulations! Level {X} achieved!",
  "🌟 You're shining bright at level {X}!",
  "🚀 Level up! Welcome to level {X}!",
  "👏 Great job! You've advanced to level {X}!",
  "🎯 Target hit! Now at level {X}!",
  "🎓 Smart move! Level {X} unlocked!",
  "🔥 Keep it up! Level {X} is yours!",
  "💡 Brilliant! You've made it to level {X}!",
  "🏆 Victory! Level {X} reached!",
];

const fallbackMessages = [
  "🔄 Don't worry! You're back at level {X}. Keep going!",
  "💪 Stay strong! Level {X} is a chance to improve.",
  "🌱 Growth time! Revisit level {X} and conquer it.",
  "🎯 Aim steady! Level {X} is your new target.",
  "🚀 Regroup at level {X} and launch again!",
  "🔥 Keep the fire alive! Level {X} awaits.",
  "🧠 Sharpen your skills at level {X}.",
  "🎓 Learning is a journey. Level {X} is part of it.",
  "🏗️ Rebuild your streak starting at level {X}.",
  "💡 Reflect and rise! Level {X} is your step forward.",
];

const lockToggleMessages = {
  locked: ["🔒 Level lock enabled. You won’t advance or fall back."],
  unlocked: ["🚀 Level lock disabled. Progression is active."],
};

const streakMessages = [
  "🔥 You're on fire with a {X}-word streak!",
  "💪 Power streak! That's {X} in a row!",
  "🎯 Precision mode: {X} correct straight!",
  "🎉 Amazing! You've hit a {X}-word streak!",
  "👏 Well done! {X} correct answers without a miss!",
  "🌟 Stellar performance! {X} consecutive correct answers!",
  "🚀 You're soaring! {X} right answers in a row!",
  "🏆 Champion streak! {X} correct answers and counting!",
  "🎓 Scholar level: {X} correct answers straight!",
  "🧠 Brainpower unleashed! {X} correct answers consecutively!",
];

function showBanner(type, level) {
  const bannerPlaceholder = document.getElementById("game-banner-placeholder");
  let bannerHTML = "";
  let message = "";

  if (type === "congratulations") {
    const randomIndex = Math.floor(
      Math.random() * congratulationsMessages.length
    );
    message = congratulationsMessages[randomIndex].replace("{X}", level);
    bannerHTML = `<div class="game-congratulations-banner"><p>${message}</p></div>`;
  } else if (type === "fallback") {
    const randomIndex = Math.floor(Math.random() * fallbackMessages.length);
    message = fallbackMessages[randomIndex].replace("{X}", level);
    bannerHTML = `<div class="game-fallback-banner"><p>${message}</p></div>`;
  } else if (type === "streak") {
    const randomIndex = Math.floor(Math.random() * streakMessages.length);
    message = streakMessages[randomIndex].replace("{X}", level);
    bannerHTML = `<div class="game-streak-banner"><p>${message}</p></div>`;
  } else if (type === "clearedPracticeWords") {
    const randomIndex = Math.floor(
      Math.random() * clearedPracticeMessages.length
    );
    message = clearedPracticeMessages[randomIndex];
    bannerHTML = `<div class="game-cleared-practice-banner"><p>${message}</p></div>`;
  } else if (type === "levelLock") {
    const messages =
      level === "locked"
        ? lockToggleMessages.locked
        : lockToggleMessages.unlocked;
    const randomIndex = Math.floor(Math.random() * messages.length);
    message = messages[randomIndex];
    bannerHTML = `<div class="game-lock-banner"><p>${message}</p></div>`;
  }

  bannerPlaceholder.innerHTML = bannerHTML;
}

function hideAllBanners() {
  const bannerPlaceholder = document.getElementById("game-banner-placeholder");

  if (bannerPlaceholder) {
    // Check if the element exists
    bannerPlaceholder.innerHTML = ""; // Clear the banner placeholder
  } else {
    console.warn("Banner placeholder not found in the DOM.");
  }
}

// Track correct/incorrect answers for each question
function updateRecentAnswers(isCorrect) {
  recentAnswers.push(isCorrect ? 1 : 0);
  if (isCorrect) {
    levelCorrectAnswers++;
  }
  levelTotalQuestions++;
}

function isBaseForm(word, baseWord) {
  return word.toLowerCase() === baseWord.toLowerCase();
}

function toggleGameEnglish() {
  const englishSelect = document.getElementById("game-english-select");
  const translationElement = document.querySelector(
    ".game-cefr-spacer .game-english-translation"
  );

  if (translationElement) {
    translationElement.style.display =
      englishSelect.value === "show-english" ? "block" : "none";
  }
}

function renderStats() {
  const statsContainer = document.getElementById("game-session-stats");
  if (!statsContainer) return;

  const total = recentAnswers.length;
  const correctCount = recentAnswers.reduce((a, b) => a + b, 0);
  const correctPercentage = total > 0 ? (correctCount / total) * 100 : 0;
  const wordsToReview = incorrectWordQueue.length;

  const currentThresholds = levelThresholds[currentCEFR];
  let fillColor = "#c7e3b6"; // default green
  let fontColor = "#6b9461";

  if (total === 0) {
    // Before the user answers any question
    fillColor = "#ddd"; // neutral gray
    fontColor = "#444"; // dark gray text
  } else if (
    currentThresholds.down !== null &&
    correctPercentage < currentThresholds.down * 100
  ) {
    fillColor = "#e9a895"; // red
    fontColor = "#b5634d";
  } else if (
    currentThresholds.up !== null &&
    correctPercentage < currentThresholds.up * 100
  ) {
    fillColor = "#f2e29b"; // yellow
    fontColor = "#a0881c";
  }

  // Inject HTML only if it hasn't been rendered yet
  if (!statsContainer.querySelector(".level-progress-bar-fill")) {
    statsContainer.innerHTML = `
      <div class="game-stats-content" style="width: 100%;">
        <div class="game-stats-correct-box"><p id="streak-count">${correctStreak}</p></div>

        <div class="level-progress-bar-bg" style="flex-grow: 1; border-radius: 10px; overflow: hidden; position: relative;">
          <div class="level-progress-bar-fill"
            style="width: 0%; background-color: ${fillColor}; height: 100%;"></div>
          <p class="level-progress-label"
            style="position: absolute; width: 100%; text-align: center; margin: 0; user-select: none;
                   font-family: 'Noto Sans', sans-serif; font-size: 18px; font-weight: 500;
                   z-index: 1; color: ${fontColor}; line-height: 38px;">
            ${Math.round(correctPercentage)}%
          </p>
        </div>

        <div class="game-stats-incorrect-box"><p id="review-count">${wordsToReview}</p></div>
      </div>
    `;
  }

  // Update existing elements only
  const fillEl = statsContainer.querySelector(".level-progress-bar-fill");
  const labelEl = statsContainer.querySelector(".level-progress-label");
  const streakEl = statsContainer.querySelector("#streak-count");
  const reviewEl = statsContainer.querySelector("#review-count");

  if (fillEl) {
    fillEl.style.width = `${correctPercentage}%`;
    fillEl.style.backgroundColor = fillColor;
  }

  if (labelEl) {
    labelEl.textContent = `${Math.round(correctPercentage)}%`;
    labelEl.style.color = fontColor;
  }

  if (streakEl) streakEl.textContent = correctStreak;
  if (reviewEl) reviewEl.textContent = wordsToReview;
}

async function startWordGame() {
  document.getElementById("lock-icon").style.display = "inline";
  const searchContainerInner = document.getElementById(
    "search-container-inner"
  ); // The container to update
  const searchBarWrapper = document.getElementById("search-bar-wrapper");
  const randomBtn = document.getElementById("random-btn");

  // Filter containers for POS, Genre, and CEFR
  const posFilterContainer = document.querySelector(".pos-filter");
  const genreFilterContainer = document.getElementById("genre-filter"); // Get the Genre filter container
  const cefrFilterContainer = document.querySelector(".cefr-filter"); // Get the CEFR filter container
  const gameEnglishFilterContainer = document.querySelector(
    ".game-english-filter"
  );

  // Filter dropdowns for POS, Genre, and CEFR
  const posSelect = document.getElementById("pos-select");
  const cefrSelect = document.getElementById("cefr-select");
  const gameEnglishSelect = document.getElementById("game-english-select");

  gameActive = true;
  showLandingCard(false);
  hideAllBanners(); // Hide banners before starting the new word

  searchBarWrapper.style.display = "none"; // Hide search-bar-wrapper
  randomBtn.style.display = "none"; // Hide random button

  searchContainerInner.classList.add("word-game-active"); // Indicate word game is active

  // Handle "word-game" option
  showLandingCard(false);

  genreFilterContainer.style.display = "none";

  gameEnglishSelect.style.display = "inline-flex"; // Hide random button
  gameEnglishFilterContainer.style.display = "inline-flex";

  posSelect.value = ""; // Reset to "Part of Speech" option
  posFilterContainer.style.display = "none";

  cefrSelect.disabled = false;
  cefrFilterContainer.classList.remove("disabled");

  // Check if all available words have been answered correctly
  const totalWords = results.filter(
    (r) => r.CEFR === currentCEFR && !noRandom.includes(r.ord.toLowerCase())
  );
  if (correctlyAnsweredWords.length >= totalWords.length) {
    console.log(
      "All words answered correctly, resetting correctlyAnsweredWords array."
    );
    correctlyAnsweredWords = []; // Reset the array
  }

  // First, check if there is an incorrect word to reintroduce
  if (
    incorrectWordQueue.length > 0 &&
    wordsSinceLastIncorrect >= reintroduceThreshold
  ) {
    const firstWordInQueue = incorrectWordQueue[0];
    if (firstWordInQueue.counter >= 10) {
      // Play the popChime when reintroducing an incorrect word
      popChime.currentTime = 0; // Reset audio to the beginning
      popChime.play(); // Play the pop sound

      console.log(
        "Reintroducing word from incorrectWordQueue:",
        firstWordInQueue.wordObj
      );

      // Reintroduce the word
      currentWord = firstWordInQueue.wordObj.ord;
      correctTranslation = firstWordInQueue.wordObj.engelsk;

      // Log wordObj being passed to renderWordGameUI
      console.log(
        "Passing wordObj to renderWordGameUI:",
        firstWordInQueue.wordObj
      );

      if (firstWordInQueue.wasCloze) {
        const randomWordObj = firstWordInQueue.wordObj;
        const baseWord = randomWordObj.ord.split(",")[0].trim().toLowerCase();
        const matchingEntry = results.find(
          (r) =>
            r.ord.toLowerCase() === randomWordObj.ord.toLowerCase() &&
            r.gender === randomWordObj.gender &&
            r.CEFR === randomWordObj.CEFR
        );
        const exampleText = matchingEntry?.eksempel || "";
        const firstSentence = exampleText.split(/(?<=[.!?])\s+/)[0];
        const tokens = firstSentence.match(/\p{L}+/gu) || [];

        let clozedForm = firstWordInQueue.clozedForm;
        const formattedClozed = clozedForm.toLowerCase();

        const distractors = generateClozeDistractors(
          baseWord,
          clozedForm,
          randomWordObj.CEFR,
          randomWordObj.gender
        );

        let allWords = shuffleArray([formattedClozed, ...distractors]);
        let uniqueWords = ensureUniqueDisplayedValues(allWords);

        if (/^[A-ZÆØÅ]/.test(clozedForm)) {
          uniqueWords = uniqueWords.map(
            (word) => word.charAt(0).toUpperCase() + word.slice(1)
          );
        }

        renderClozeGameUI(randomWordObj, uniqueWords, clozedForm, true);
      } else {
        // Rebuild incorrect translations for non-cloze word
        let incorrectTranslations = fetchIncorrectTranslations(
          firstWordInQueue.wordObj.gender,
          correctTranslation,
          firstWordInQueue.wordObj.CEFR
        );

        if (incorrectTranslations.length < 3) {
          const additionalTranslations =
            fetchIncorrectTranslationsFromOtherCEFRLevels(
              firstWordInQueue.wordObj.gender,
              correctTranslation
            );
          incorrectTranslations = incorrectTranslations.concat(
            additionalTranslations
          );
        }

        const allTranslations = shuffleArray([
          correctTranslation,
          ...incorrectTranslations,
        ]);

        const uniqueDisplayedTranslations =
          ensureUniqueDisplayedValues(allTranslations);

        renderWordGameUI(
          firstWordInQueue.wordObj,
          uniqueDisplayedTranslations,
          true
        );
      }

      // Do not remove the word from the queue yet. It will be removed when answered correctly.
      firstWordInQueue.shown = true; // Mark that this word has been shown again

      // Reset counter for new words shown
      wordsSinceLastIncorrect = 0;

      // Render the updated stats box
      renderStats();
      return;
    } else {
      // Increment the counter for this word
      incorrectWordQueue.forEach((word) => word.counter++);
    }
  }

  wordsSinceLastIncorrect++; // Increment counter for words since last incorrect word

  // Use the currentCEFR directly, since it's dynamically updated when the user selects a new CEFR level
  if (!currentCEFR) {
    currentCEFR = "A1"; // Default to A1 if no level is set
  }

  // Fetch a random word that respects CEFR and POS filters
  const randomWordObj = await fetchRandomWord();

  // If no words match the filters, stop the game
  if (!randomWordObj) return;

  currentWord = randomWordObj;
  correctTranslation = randomWordObj.engelsk;

  const isClozeQuestion = Math.random() < 0.5; // 50% chance to show a cloze question
  const bannedWordClasses = ["numeral", "pronoun", "possessive", "determiner"];

  // Fetch incorrect translations with the same gender
  const incorrectTranslations = fetchIncorrectTranslations(
    randomWordObj.gender,
    correctTranslation,
    currentCEFR
  );

  // Shuffle correct and incorrect translations into an array
  const allTranslations = shuffleArray([
    correctTranslation,
    ...incorrectTranslations,
  ]);

  // Ensure no duplicate displayed values
  const uniqueDisplayedTranslations =
    ensureUniqueDisplayedValues(allTranslations);
  // Skip cloze if the selected word is in a banned class
  if (
    isClozeQuestion &&
    bannedWordClasses.some((b) =>
      randomWordObj.gender?.toLowerCase().startsWith(b)
    )
  ) {
    renderWordGameUI(randomWordObj, uniqueDisplayedTranslations, false);
    return;
  }

  console.log(
    "Showing " + (isClozeQuestion ? "CLOZE" : "FLASHCARD") + " question for:",
    randomWordObj.ord
  );

  if (isClozeQuestion) {
    const baseWord = randomWordObj.ord.split(",")[0].trim().toLowerCase();
    const matchingEntry = results.find(
      (r) =>
        r.ord.toLowerCase() === randomWordObj.ord.toLowerCase() &&
        r.gender === randomWordObj.gender &&
        r.CEFR === randomWordObj.CEFR
    );
    const exampleText = matchingEntry?.eksempel || "";
    const firstSentence = exampleText.split(/(?<=[.!?])\s+/)[0];
    const tokens = firstSentence.match(/\p{L}+/gu) || [];

    let clozedForm = null;
    const baseWordTokens = baseWord.split(/\s+/);

    for (let start = 0; start < tokens.length; start++) {
      for (let end = start + 1; end <= tokens.length; end++) {
        const group = tokens.slice(start, end);
        const joinedWithSpace = group.join(" ").toLowerCase();
        const joinedWithHyphen = group.join("-").toLowerCase();

        if (
          matchesInflectedForm(baseWord, joinedWithSpace, randomWordObj.gender)
        ) {
          clozedForm = group.join(" ");
          break;
        }
        if (
          matchesInflectedForm(baseWord, joinedWithHyphen, randomWordObj.gender)
        ) {
          clozedForm = group.join("-");
          break;
        }
      }
      if (clozedForm) break;
    }

    if (!clozedForm) {
      const cleanedTokens = tokens.map((t) =>
        t.toLowerCase().replace(/[.,!?;:()"]/g, "")
      );

      const normalizedTokens = cleanedTokens;
      const normalizedBase = baseWord;

      let fallbackClozed = null;
      for (let len = normalizedBase.length; len > 2; len--) {
        const prefix = normalizedBase.slice(0, len);
        const matchIndex = normalizedTokens.findIndex((t) =>
          t.startsWith(prefix)
        );
        if (matchIndex !== -1) {
          // Try to recover the full expression from the token window
          const endIndex = matchIndex + baseWordTokens.length - 1;
          const matchedTokens = tokens.slice(matchIndex, endIndex + 1);

          const restOfBase = baseWordTokens.slice(1).join(" ");
          const restOfSentence = matchedTokens.slice(1).join(" ").toLowerCase();

          if (restOfSentence === restOfBase) {
            fallbackClozed = matchedTokens.join(" "); // e.g., "ryddet ut"
          } else {
            fallbackClozed = tokens[matchIndex]; // fallback to just "ryddet"
          }

          break;
        }
      }

      if (fallbackClozed) {
        clozedForm = fallbackClozed;
      } else {
        console.warn("❌ CLOZE fallback triggered!");
        console.warn("Word:", randomWordObj.ord);
        console.warn("Sentence:", firstSentence);
        console.warn("Base word for matching:", baseWord);
        console.warn("Tokens analyzed:", cleanedTokens);
        console.warn("Gender/POS:", randomWordObj.gender);
        console.warn(
          "No matching token found after analyzing sentence for cloze insertion."
        );
        console.warn("⚠️ Falling back to flashcard due to cloze failure");
        console.log("Fallback word object:", randomWordObj);
        console.log("Fallback translations:", uniqueDisplayedTranslations);

        renderWordGameUI(randomWordObj, uniqueDisplayedTranslations, false);
        return;
      }
    }

    // Format the clozed word and get its final letter
    const formatCase = (word) => word.charAt(0).toLowerCase() + word.slice(1);

    let formattedClozed = formatCase(clozedForm);
    const wasCapitalizedFromLowercase =
      !/^[A-ZÆØÅ]/.test(baseWord) && /^[A-ZÆØÅ]/.test(clozedForm);
    const distractors = generateClozeDistractors(
      baseWord,
      formattedClozed,
      randomWordObj.CEFR,
      randomWordObj.gender
    );

    let allWords = shuffleArray([formattedClozed, ...distractors]);
    let uniqueWords = ensureUniqueDisplayedValues(allWords);

    if (wasCapitalizedFromLowercase) {
      uniqueWords = uniqueWords.map(
        (word) => word.charAt(0).toUpperCase() + word.slice(1)
      );
      formattedClozed =
        formattedClozed.charAt(0).toUpperCase() + formattedClozed.slice(1);
    }

    renderClozeGameUI(randomWordObj, uniqueWords, formattedClozed, false);
  } else {
    renderWordGameUI(randomWordObj, uniqueDisplayedTranslations, false);
  }

  // Render the updated stats box
  renderStats();
  if (!isClozeQuestion) {
    displayPronunciation(currentWord);
  }
}

function ensureUniqueDisplayedValues(translations) {
  const uniqueTranslations = [];
  const displayedSet = new Set(); // To track displayed parts

  translations.forEach((translation) => {
    const displayedPart = translation.split(",")[0].trim();
    if (!displayedSet.has(displayedPart)) {
      displayedSet.add(displayedPart);
      uniqueTranslations.push(translation);
    }
  });

  return uniqueTranslations;
}

function fetchIncorrectTranslations(gender, correctTranslation, currentCEFR) {
  const isCapitalized = /^[A-Z]/.test(correctTranslation); // Check if the current word starts with a capital letter

  let incorrectResults = results.filter((r) => {
    const isMatchingCase = /^[A-Z]/.test(r.engelsk) === isCapitalized; // Check if the word's case matches
    return (
      r.gender === gender &&
      r.engelsk !== correctTranslation &&
      r.CEFR === currentCEFR && // Ensure CEFR matches
      isMatchingCase && // Ensure the case matches
      !noRandom.includes(r.ord.toLowerCase())
    );
  });

  // Shuffle the incorrect results to ensure randomness
  incorrectResults = shuffleArray(incorrectResults);

  // Use a Set to track the displayed parts of translations to avoid duplicates
  const displayedTranslationsSet = new Set();
  const incorrectTranslations = [];

  // First, try to collect translations from the same CEFR level
  for (
    let i = 0;
    i < incorrectResults.length && incorrectTranslations.length < 3;
    i++
  ) {
    const displayedTranslation = incorrectResults[i].engelsk
      .split(",")[0]
      .trim();
    if (!displayedTranslationsSet.has(displayedTranslation)) {
      incorrectTranslations.push(incorrectResults[i].engelsk);
      displayedTranslationsSet.add(displayedTranslation);
    }
  }

  // If we still don't have enough, broaden the search to include words of the same gender but any CEFR level
  if (incorrectTranslations.length < 4) {
    let additionalResults = results.filter((r) => {
      const isMatchingCase = /^[A-Z]/.test(r.engelsk) === isCapitalized; // Ensure case matches for fallback
      return (
        r.gender === gender &&
        r.engelsk !== correctTranslation && // Exclude the correct translation
        isMatchingCase && // Ensure the case matches
        !noRandom.includes(r.ord.toLowerCase()) &&
        !displayedTranslationsSet.has(r.engelsk.split(",")[0].trim())
      ); // Ensure no duplicates
    });

    for (
      let i = 0;
      i < additionalResults.length && incorrectTranslations.length < 3;
      i++
    ) {
      const displayedTranslation = additionalResults[i].engelsk
        .split(",")[0]
        .trim();
      if (!displayedTranslationsSet.has(displayedTranslation)) {
        incorrectTranslations.push(additionalResults[i].engelsk);
        displayedTranslationsSet.add(displayedTranslation);
      }
    }
  }

  // If we still don't have enough, broaden the search to include any word, ignoring CEFR and gender
  if (incorrectTranslations.length < 4) {
    let fallbackResults = results.filter((r) => {
      const isMatchingCase = /^[A-Z]/.test(r.engelsk) === isCapitalized; // Ensure case matches for fallback
      return (
        r.engelsk !== correctTranslation && // Exclude the correct translation
        isMatchingCase && // Ensure the case matches
        !noRandom.includes(r.ord.toLowerCase()) &&
        !displayedTranslationsSet.has(r.engelsk.split(",")[0].trim())
      ); // Ensure no duplicates
    });

    for (
      let i = 0;
      i < fallbackResults.length && incorrectTranslations.length < 3;
      i++
    ) {
      const displayedTranslation = fallbackResults[i].engelsk
        .split(",")[0]
        .trim();
      if (!displayedTranslationsSet.has(displayedTranslation)) {
        incorrectTranslations.push(fallbackResults[i].engelsk);
        displayedTranslationsSet.add(displayedTranslation);
      }
    }
  }

  return incorrectTranslations;
}

function fetchIncorrectNorwegianWords(correctWord, CEFR, gender) {
  const baseWord = correctWord.split(",")[0].trim().toLowerCase();

  let incorrectResults = results.filter((r) => {
    const word = r.ord.split(",")[0].trim().toLowerCase();
    return (
      word !== baseWord &&
      r.CEFR === CEFR &&
      r.gender === gender &&
      !noRandom.includes(r.ord.toLowerCase())
    );
  });

  incorrectResults = shuffleArray(incorrectResults);

  const seen = new Set();
  const incorrectWords = [];

  for (
    let i = 0;
    i < incorrectResults.length && incorrectWords.length < 3;
    i++
  ) {
    const word = incorrectResults[i].ord.split(",")[0].trim();
    if (!seen.has(word)) {
      seen.add(word);
      incorrectWords.push(word);
    }
  }

  return incorrectWords;
}

function displayPronunciation(word) {
  const pronunciationContainer = document.querySelector(
    "#game-banner-placeholder"
  );
  if (pronunciationContainer && word.uttale) {
    const uttaleText = word.uttale.split(",")[0].trim(); // Get the part before the first comma
    pronunciationContainer.innerHTML = `
      <p class="game-pronunciation">${uttaleText}</p>
    `;
  } else if (pronunciationContainer) {
    pronunciationContainer.innerHTML = ""; // Clear if no pronunciation
  } else {
    console.log("No container found.");
  }
}

function renderWordGameUI(wordObj, translations, isReintroduced = false) {
  // Add the word object to the data store and get its index
  const wordId = wordDataStore.push(wordObj) - 1;

  // Split the word at the comma and use the first part
  let displayedWord = wordObj.ord.split(",")[0].trim();
  let displayedGender = wordObj.gender;

  if (wordObj.gender.startsWith("noun")) {
    displayedGender = "Noun";
  } else if (wordObj.gender.startsWith("masculine")) {
    displayedGender = "N - Masc";
  } else if (wordObj.gender.startsWith("feminine")) {
    displayedGender = "N - Fem";
  } else if (wordObj.gender.startsWith("adjective")) {
    displayedGender = "Adj";
  } else if (wordObj.gender.startsWith("adverb")) {
    displayedGender = "Adv";
  } else if (wordObj.gender.startsWith("conjunction")) {
    displayedGender = "Conj";
  } else if (wordObj.gender.startsWith("determiner")) {
    displayedGender = "Det";
  } else if (wordObj.gender.startsWith("expression")) {
    displayedGender = "Exp";
  } else if (wordObj.gender.startsWith("interjection")) {
    displayedGender = "Inter";
  } else if (wordObj.gender.startsWith("numeral")) {
    displayedGender = "Num";
  } else if (wordObj.gender.startsWith("possessive")) {
    displayedGender = "Poss";
  } else if (wordObj.gender.startsWith("preposition")) {
    displayedGender = "Prep";
  } else if (wordObj.gender.startsWith("pronoun")) {
    displayedGender = "Pron";
  }

  // Check if CEFR is selected; if not, add a label based on wordObj.CEFR
  let cefrLabel = "";
  const firstTrickyLabelPlaceholder =
    '<div class="game-tricky-word" style="visibility: hidden;"><i class="fa fa-repeat" aria-hidden="true"></i></div>';
  const secondTrickyLabel = isReintroduced
    ? '<div class="game-tricky-word visible"><i class="fa fa-repeat" aria-hidden="true"></i></div>'
    : '<div class="game-tricky-word" style="visibility: hidden;"><i class="fa fa-repeat" aria-hidden="true"></i></div>';

  // Always show the CEFR label if CEFR is available
  if (wordObj.CEFR === "A1") {
    cefrLabel = '<div class="game-cefr-label easy">A1</div>';
  } else if (wordObj.CEFR === "A2") {
    cefrLabel = '<div class="game-cefr-label easy">A2</div>';
  } else if (wordObj.CEFR === "B1") {
    cefrLabel = '<div class="game-cefr-label medium">B1</div>';
  } else if (wordObj.CEFR === "B2") {
    cefrLabel = '<div class="game-cefr-label medium">B2</div>';
  } else if (wordObj.CEFR === "C") {
    cefrLabel = '<div class="game-cefr-label hard">C</div>';
  } else {
    console.warn("CEFR value is missing for this word:", wordObj);
  }

  // Create placeholder for banners (this will be dynamically updated when banners are shown)
  let bannerPlaceholder = '<div id="game-banner-placeholder"></div>';

  gameContainer.innerHTML = `
        <!-- Session Stats Section -->
        <div class="game-stats-content" id="game-session-stats">
            <!-- Stats will be updated dynamically in renderStats() -->
        </div>

        <div class="game-word-card">
            <div class="game-labels-container">
              <div class="game-label-subgroup">
              <div class="game-gender">${displayedGender}</div>
                ${cefrLabel}  <!-- Add the CEFR label here if applicable -->
              </div>
                ${bannerPlaceholder}  <!-- This is where banners will appear dynamically -->
                <div class="game-label-subgroup">
                  ${secondTrickyLabel}
                  <div class="game-gender" style="visibility: hidden;">${displayedGender}</div>
                </div>
            </div>
            <div class="game-word">
                <h2>${displayedWord}</h2>
            </div>
            <div class="game-cefr-spacer"></div>
        </div>

        <!-- Translations Grid Section -->
        <div class="game-grid">
            ${translations
              .map(
                (translation, index) => `
                <div class="game-translation-card" data-id="${wordId}" data-index="${index}">
                    ${translation.split(",")[0].trim()}
                </div>
            `
              )
              .join("")}
        </div>

        <!-- Next Word Button -->
        <div class="game-next-button-container">
            <button id="game-next-word-button" disabled>Next Word</button>
        </div>
    `;

  // Add event listeners for translation cards
  document.querySelectorAll(".game-translation-card").forEach((card) => {
    card.addEventListener("click", function () {
      const wordId = this.getAttribute("data-id"); // Retrieve the word ID
      const selectedTranslation = this.innerText.trim();
      const wordObj = wordDataStore[wordId]; // Get the word object from the data store

      handleTranslationClick(selectedTranslation, wordObj);
    });
  });

  // Add event listener for the next word button
  document
    .getElementById("game-next-word-button")
    .addEventListener("click", async function () {
      hideAllBanners(); // Hide all banners when Next Word is clicked
      await startWordGame(); // Move to the next word
    });

  renderStats(); // Ensure stats are drawn once DOM is fully loaded
}

function renderClozeGameUI(
  wordObj,
  translations,
  clozedWordForm,
  isReintroduced = false,
  englishTranslation = ""
) {
  const blank = "___";
  const wordId = wordDataStore.push(wordObj) - 1;
  let cefrLabel = "";
  if (wordObj.CEFR === "A1") {
    cefrLabel = '<div class="game-cefr-label easy">A1</div>';
  } else if (wordObj.CEFR === "A2") {
    cefrLabel = '<div class="game-cefr-label easy">A2</div>';
  } else if (wordObj.CEFR === "B1") {
    cefrLabel = '<div class="game-cefr-label medium">B1</div>';
  } else if (wordObj.CEFR === "B2") {
    cefrLabel = '<div class="game-cefr-label medium">B2</div>';
  } else if (wordObj.CEFR === "C") {
    cefrLabel = '<div class="game-cefr-label hard">C</div>';
  }
  correctTranslation = clozedWordForm;
  const baseWord = wordObj.ord.split(",")[0].trim().toLowerCase();
  const matchingEntry = results.find(
    (r) =>
      r.ord.toLowerCase() === wordObj.ord.toLowerCase() &&
      r.gender === wordObj.gender &&
      r.CEFR === wordObj.CEFR
  );
  const exampleText = matchingEntry?.eksempel || "";
  const englishText = wordObj.sentenceTranslation || "";

  const norwegianSentences = exampleText
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== "");
  const englishSentences = englishText
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== "");

  let firstNorwegian = "[Mangler norsk setning]";
  let matchingEnglish = "";

  for (let i = 0; i < norwegianSentences.length; i++) {
    const nSent = norwegianSentences[i];
    const lower = nSent.toLowerCase().normalize("NFC");
    const base = baseWord.toLowerCase().normalize("NFC");
    const isExpression = wordObj.gender === "expression";

    if (isExpression) {
      const parts = baseWord.split(/\s+/); // e.g., ['ende', 'opp']
      const tokens = nSent.match(/[\p{L}-]+/gu) || [];

      for (let i = 0; i < tokens.length - (parts.length - 1); i++) {
        const slice = tokens.slice(i, i + parts.length);
        const [first, ...rest] = slice;

        if (
          matchesInflectedForm(parts[0], first, "verb") &&
          rest.map((r) => r.toLowerCase()).join(" ") ===
            parts.slice(1).join(" ")
        ) {
          firstNorwegian = nSent;
          const matchingIndex = norwegianSentences.findIndex(
            (s) => s === firstNorwegian
          );
          matchingEnglish =
            matchingIndex >= 0 ? englishSentences[matchingIndex] || "" : "";
          break;
        }
      }
    } else {
      const tokens = nSent.match(/[\p{L}-]+/gu) || [];
      for (const token of tokens) {
        const clean = token.toLowerCase().replace(/[.,!?;:()"]/g, "");
        if (matchesInflectedForm(base, clean, wordObj.gender)) {
          firstNorwegian = nSent;
          const matchingIndex = norwegianSentences.findIndex(
            (s) => s === firstNorwegian
          );
          matchingEnglish =
            matchingIndex >= 0 ? englishSentences[matchingIndex] || "" : "";
          break;
        }
      }
      if (firstNorwegian !== "[Mangler norsk setning]") break;
    }
  }

  // Try to find and blank the cloze target
  let clozeTarget = null;
  const lowerSentence = firstNorwegian.toLowerCase();
  const lowerBaseWord = baseWord.toLowerCase();

  if (wordObj.gender === "expression" || wordObj.gender === "interjection") {
    const normalizedBase = baseWord.normalize("NFC").toLowerCase();
    const normalizedSentence = firstNorwegian.normalize("NFC");

    console.log("🔍 Attempting cloze match for expression:");
    console.log("  Base word (normalized):", normalizedBase);
    console.log("  Sentence (normalized):", normalizedSentence);

    try {
      const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escapedBase, "i");
      const match = normalizedSentence.match(regex);

      console.log("  Using regex:", regex);

      if (match) {
        clozeTarget = match[0];
        console.log("✅ Match found:", clozeTarget);
      } else {
        // NEW fallback logic for inflected multi-word expressions
        const parts = baseWord.split(/\s+/); // e.g., ['bli', 'borte']
        const tokens = firstNorwegian.match(/[\p{L}-]+/gu) || [];

        for (let i = 0; i < tokens.length - (parts.length - 1); i++) {
          const slice = tokens.slice(i, i + parts.length);
          const [first, ...rest] = slice;

          if (
            matchesInflectedForm(parts[0], first, "verb") &&
            rest.map((t) => t.toLowerCase()).join(" ") ===
              parts.slice(1).join(" ")
          ) {
            clozeTarget = slice.join(" ");
            console.log("✅ Fallback match found:", clozeTarget);
            break;
          }
        }

        if (!clozeTarget) {
          console.warn("❌ No match found using regex:", regex);
        }
      }
    } catch (err) {
      console.error("🚨 Regex construction failed:", err.message);
      console.error("  Problematic base word was:", normalizedBase);
    }
  } else {
    const tokens = firstNorwegian.match(/[\p{L}-]+/gu) || [];

    // New vowel-stripping rule
    const strippedBase = lowerBaseWord.replace(/[aeiouyæøå]+$/i, "");

    for (const token of tokens) {
      const clean = token.toLowerCase().replace(/[.,!?;:()"]/g, "");
      if (clean.startsWith(strippedBase) && clean.length >= 3) {
        clozeTarget = token;
        break;
      }
    }
  }

  let sentenceWithBlank;
  if (clozeTarget) {
    sentenceWithBlank = firstNorwegian.replace(clozeTarget, blank);
  } else {
    console.warn("❌ No cloze target found — switching to flashcard fallback.");

    correctTranslation = wordObj.engelsk; // ✅ Fix the root bug

    // Regenerate English options
    const incorrectTranslations = fetchIncorrectTranslations(
      wordObj.gender,
      wordObj.engelsk,
      currentCEFR
    );

    const allTranslations = shuffleArray([
      wordObj.engelsk,
      ...incorrectTranslations,
    ]);
    const uniqueDisplayedTranslations =
      ensureUniqueDisplayedValues(allTranslations);

    renderWordGameUI(wordObj, uniqueDisplayedTranslations, false);
    return;
  }

  gameContainer.innerHTML = `
    <!-- Session Stats Section -->
    <div class="game-stats-content" id="game-session-stats">
      <!-- Stats will be updated dynamically in renderStats() -->
    </div>
  
    <div class="game-word-card">
      <div class="game-labels-container">
        <div class="game-label-subgroup">
      <div class="game-gender">${
        wordObj.gender.startsWith("en") ||
        wordObj.gender.startsWith("et") ||
        wordObj.gender.startsWith("ei")
          ? "N - " + wordObj.gender
          : wordObj.gender.startsWith("adjective")
          ? "Adj"
          : wordObj.gender.startsWith("adverb")
          ? "Adv"
          : wordObj.gender.startsWith("conjunction")
          ? "Conj"
          : wordObj.gender.startsWith("determiner")
          ? "Det"
          : wordObj.gender.startsWith("expression")
          ? "Exp"
          : wordObj.gender.startsWith("interjection")
          ? "Inter"
          : wordObj.gender.startsWith("numeral")
          ? "Num"
          : wordObj.gender.startsWith("possessive")
          ? "Poss"
          : wordObj.gender.startsWith("preposition")
          ? "Prep"
          : wordObj.gender.startsWith("pronoun")
          ? "Pron"
          : wordObj.gender
      }</div>          ${cefrLabel}
        </div>
        <div id="game-banner-placeholder"></div>
        <div class="game-label-subgroup">
          <div class="game-tricky-word" style="${
            isReintroduced ? "visibility: visible;" : "visibility: hidden;"
          }">
            <i class="fa fa-repeat" aria-hidden="true"></i>
          </div>
          <div class="game-gender" style="visibility: hidden;"></div>
        </div>
      </div>
  
      <div class="game-word">
      <h2 id="cloze-sentence">${sentenceWithBlank}</h2>        <p class="game-english-translation" style="display: inline;">${matchingEnglish}</p> 
      </div>
  
      <div class="game-cefr-spacer"></div>
    </div>
  
    <!-- Translations Grid Section -->
    <div class="game-grid">
      ${translations
        .map(
          (translation, index) => `
          <div class="game-translation-card" data-id="${wordId}" data-index="${index}">
            ${translation}
          </div>
        `
        )
        .join("")}
    </div>
  
    <!-- Next Word Button -->
    <div class="game-next-button-container">
      <button id="game-next-word-button" disabled>Next Word</button>
    </div>
  `;

  document.querySelectorAll(".game-translation-card").forEach((card) => {
    card.addEventListener("click", function () {
      const wordId = this.getAttribute("data-id");
      const selectedTranslation = this.innerText.trim();
      const wordObj = wordDataStore[wordId];
      handleTranslationClick(selectedTranslation, wordObj, true); // true = cloze mode
    });
  });

  document
    .getElementById("game-next-word-button")
    .addEventListener("click", async function () {
      hideAllBanners();
      await startWordGame();
    });

  renderStats(); // Ensure stats bar is present after cloze loads too
}

async function handleTranslationClick(
  selectedTranslation,
  wordObj,
  isCloze = false
) {
  if (!gameActive) return; // Prevent further clicks if the game is not active

  gameActive = false; // Disable further clicks until the next word is generated

  const cards = document.querySelectorAll(".game-translation-card");

  // Reset all cards to their default visual state
  cards.forEach((card) => {
    card.classList.remove(
      "game-correct-card",
      "game-incorrect-card",
      "distractor-muted"
    );
  });

  // Extract the part before the comma for both correct and selected translations
  const correctTranslationPart = correctTranslation.split(",")[0].trim();
  const selectedTranslationPart = selectedTranslation.split(",")[0].trim();

  totalQuestions++; // Increment total questions for this level
  questionsAtCurrentLevel++; // Increment questions at this level

  if (selectedTranslationPart === correctTranslationPart) {
    goodChime.currentTime = 0; // Reset audio to the beginning
    goodChime.play(); // Play the chime sound when correct
    // Mark the selected card as green (correct)
    cards.forEach((card) => {
      const cardText = card.innerText.trim();
      if (cardText === selectedTranslationPart) {
        card.classList.add("game-correct-card");
      } else if (cardText !== correctTranslationPart) {
        card.classList.add("distractor-muted");
      }
    });
    correctCount++; // Increment correct count globally
    correctStreak++; // Increment the streak
    correctLevelAnswers++; // Increment correct count for this level
    updateRecentAnswers(true); // Track this correct answer
    // Add the word to the correctly answered words array to exclude it from future questions
    correctlyAnsweredWords.push(wordObj.ord);

    if (isCloze) {
      const fullSentence =
        results.find(
          (r) =>
            r.ord.toLowerCase() === wordObj.ord.toLowerCase() &&
            r.gender === wordObj.gender &&
            r.CEFR === wordObj.CEFR
        )?.eksempel || "";

      const firstSentence = fullSentence.split(/(?<=[.!?])\s+/)[0];
      const sentenceElement = document.getElementById("cloze-sentence");
      if (sentenceElement && firstSentence) {
        sentenceElement.textContent = firstSentence;
      }
    }

    // If the word was in the review queue and the user answered it correctly, remove it
    const indexInQueue = incorrectWordQueue.findIndex(
      (incorrectWord) =>
        incorrectWord.wordObj.ord === wordObj.ord && incorrectWord.shown
    );
    if (indexInQueue !== -1) {
      incorrectWordQueue.splice(indexInQueue, 1); // Remove from review queue once answered correctly
    }
    // Trigger the streak banner if the user reaches a streak
    if (correctStreak % 10 === 0) {
      showBanner("streak", correctStreak);
    }
    // Trigger the cleared practice words banner ONLY if the queue is now empty
    if (incorrectWordQueue.length === 0 && indexInQueue !== -1) {
      showBanner("clearedPracticeWords"); // Show the cleared practice words banner
    }
  } else {
    badChime.currentTime = 0; // Reset audio to the beginning
    badChime.play(); // Play the chime sound when incorrect
    // Mark the incorrect card as red
    cards.forEach((card) => {
      const cardText = card.innerText.trim();

      if (cardText === selectedTranslationPart) {
        card.classList.add("game-incorrect-card");
      } else if (cardText === correctTranslationPart) {
        card.classList.add("game-correct-card");
      } else {
        card.classList.add("distractor-muted");
      }
    });
    incorrectCount++; // Increment incorrect count
    correctStreak = 0; // Reset the streak
    updateRecentAnswers(false); // Track this correct answer

    if (isCloze) {
      const fullSentence =
        results.find(
          (r) =>
            r.ord.toLowerCase() === wordObj.ord.toLowerCase() &&
            r.gender === wordObj.gender &&
            r.CEFR === wordObj.CEFR
        )?.eksempel || "";

      const firstSentence = fullSentence.split(/(?<=[.!?])\s+/)[0];
      const sentenceElement = document.getElementById("cloze-sentence");
      if (sentenceElement && firstSentence) {
        sentenceElement.textContent = firstSentence;
      }
    }

    // If the word isn't already in the review queue, add it
    const inQueueAlready = incorrectWordQueue.some(
      (incorrectWord) => incorrectWord.wordObj.ord === wordObj.ord
    );
    if (!inQueueAlready) {
      incorrectWordQueue.push({
        wordObj: {
          ord: wordObj.ord, // explicitly using wordObj.ord here
          engelsk: correctTranslation,
          gender: wordObj.gender,
          CEFR: wordObj.CEFR,
          uttale: wordObj.uttale,
          eksempel: wordObj.eksempel, // needed to rebuild sentence
        },
        counter: 0, // Start counter for this word
        wasCloze: isCloze,
        clozedForm: correctTranslation, // << STORE the clozed form separately!
      });
    }
  }

  // Enable the "Next Word" button
  document.getElementById("game-next-word-button").disabled = false;

  // Update the stats after the answer
  renderStats();

  // Only evaluate progression if at least 20 questions have been answered at the current level
  if (questionsAtCurrentLevel >= 20) {
    evaluateProgression();
    questionsAtCurrentLevel = 0; // Reset the counter after progression evaluation
  }

  const { exampleSentence, sentenceTranslation } = await fetchExampleSentence(
    wordObj
  );
  console.log("Fetched example sentence:", exampleSentence);

  if (exampleSentence && !isCloze) {
    const completedSentence = exampleSentence;

    const translationHTML = `
      <p class="game-english-translation" style="display: ${
        document.getElementById("game-english-select").value === "show-english"
          ? "inline-block"
          : "none"
      };">${sentenceTranslation}</p>`;

    document.querySelector(".game-cefr-spacer").innerHTML = `
      <div class="sentence-pair">
        <p>${completedSentence}</p>
        ${translationHTML}
      </div>
    `;
  } else if (exampleSentence && isCloze) {
    const translationHTML = `
      <p class="game-english-translation" style="display: ${
        document.getElementById("game-english-select").value === "show-english"
          ? "inline-block"
          : "none"
      };">${sentenceTranslation}</p>`;

    document.querySelector(".game-cefr-spacer").innerHTML = `
      <div class="sentence-pair">
        ${translationHTML}
      </div>
    `;
  } else {
    document.querySelector(".game-cefr-spacer").innerHTML = "";
  }

  document.getElementById("game-next-word-button").style.display = "block";
}

async function fetchExampleSentence(wordObj) {
  console.log("Fetching example sentence for:", wordObj);

  // Ensure gender and CEFR are defined before performing the search
  if (!wordObj.gender || !wordObj.CEFR || !wordObj.ord) {
    console.warn("Missing required fields for search:", wordObj);
    return null;
  }

  // Find the exact matching word object based on 'ord', 'definisjon', 'gender', and 'CEFR'
  let matchingEntry = results.find(
    (result) =>
      result.ord.toLowerCase() === wordObj.ord.toLowerCase() &&
      result.gender === wordObj.gender &&
      result.CEFR === wordObj.CEFR
  );

  // Log the matching entry or lack thereof
  if (matchingEntry) {
    console.log("Matching entry found:", matchingEntry);
    console.log("Example sentence found:", matchingEntry.eksempel);
  } else {
    console.warn(`No matching entry found for word: ${wordObj.ord}`);
  }

  // Step 2: Check if the matching entry has an example sentence
  if (
    !matchingEntry ||
    !matchingEntry.eksempel ||
    matchingEntry.eksempel.trim() === ""
  ) {
    console.log(
      `No example sentence available for word: ${wordObj.ord} with specified gender and CEFR.`
    );

    // Step 3: Search for another entry with the same 'ord' but without considering 'gender' or 'CEFR'
    matchingEntry = results.find(
      (result) =>
        result.eksempel &&
        result.eksempel.toLowerCase().startsWith(wordObj.ord.toLowerCase())
    );
    if (matchingEntry) {
      console.log(
        "Found example sentence from another word entry:",
        matchingEntry.eksempel
      );
    } else {
      console.warn(
        `No example sentence found in the entire dataset containing the word: ${wordObj.ord}`
      );
      return null; // No example sentence found at all
    }
  }

  // Split example sentences and remove any empty entries
  const exampleSentences = matchingEntry.eksempel
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim() !== "");

  const translations = matchingEntry.sentenceTranslation
    ? matchingEntry.sentenceTranslation
        .split(/(?<=[.!?])\s+/)
        .filter((translation) => translation.trim() !== "")
    : [];

  // If there is only one sentence, return it with its translation if available
  if (exampleSentences.length === 1) {
    return {
      exampleSentence: exampleSentences[0],
      sentenceTranslation: translations[0] || "",
    };
  }

  // If there are multiple sentences, pick one at random
  const randomIndex = Math.floor(Math.random() * exampleSentences.length);
  const exampleSentence = exampleSentences[randomIndex];
  const sentenceTranslation = translations[randomIndex] || ""; // Provide an empty string if translation is unavailable
  return { exampleSentence, sentenceTranslation };
}

async function fetchRandomWord() {
  const selectedPOS = document.getElementById("pos-select")
    ? document.getElementById("pos-select").value.toLowerCase()
    : "";

  // Always use the current CEFR level, whether it's A1 by default or selected by the user
  const cefrLevel = currentCEFR;

  // Filter results based on CEFR, POS, and excluding the previous word
  let filteredResults = results.filter(
    (r) =>
      r.engelsk &&
      !noRandom.includes(r.ord.toLowerCase()) &&
      r.ord !== previousWord &&
      r.CEFR === cefrLevel && // Ensure the word belongs to the same CEFR level
      !correctlyAnsweredWords.includes(r.ord) // Exclude words already answered correctly
  );

  if (selectedPOS) {
    filteredResults = filteredResults.filter((r) => {
      const gender = r.gender ? r.gender.toLowerCase() : "";

      // Handle nouns: Include "en", "et", "ei" but exclude "pronoun"
      if (selectedPOS === "noun") {
        return (
          (gender.startsWith("en") ||
            gender.startsWith("et") ||
            gender.startsWith("ei")) &&
          gender !== "pronoun"
        );
      }

      // For non-noun POS, filter based on the selectedPOS value
      return gender.startsWith(selectedPOS);
    });
  }

  if (cefrLevel) {
    // Filter by CEFR level if selected
    filteredResults = filteredResults.filter(
      (r) => r.CEFR && r.CEFR.toUpperCase() === cefrLevel
    );
  }

  // Filter out words where the Norwegian word and its English translation are identical
  filteredResults = filteredResults.filter((r) => {
    // Split and trim the Norwegian word (handle comma-separated words)
    const norwegianWord = r.ord.split(",")[0].trim().toLowerCase();

    // Split and trim the English translation (handle comma-separated translations)
    const englishTranslation = r.engelsk.split(",")[0].trim().toLowerCase();

    // Return true if the Norwegian and English words are not the same
    return norwegianWord !== englishTranslation;
  });

  // If no words match the filters, return a message
  if (filteredResults.length === 0) {
    console.log("No words found matching the selected CEFR and POS filters.");
    return null;
  }

  // Randomly select a result from the filtered results
  const randomResult =
    filteredResults[Math.floor(Math.random() * filteredResults.length)];

  previousWord = randomResult.ord; // Update the previous word

  return {
    ord: randomResult.ord,
    engelsk: randomResult.engelsk,
    gender: randomResult.gender, // Add gender
    CEFR: randomResult.CEFR, // Make sure CEFR is returned here
    uttale: randomResult.uttale, // Ensure uttale is included here
    eksempel: randomResult.eksempel, // ⬅️ ADD THIS LINE
  };
}

function advanceToNextLevel() {
  if (incorrectWordQueue.length > 0) {
    // Block level advancement if there are still incorrect words
    console.log(
      "The user must review all incorrect words before advancing to the next level."
    );
    return;
  }

  let nextLevel = "";
  if (currentCEFR === "A1") nextLevel = "A2";
  else if (currentCEFR === "A2") nextLevel = "B1";
  else if (currentCEFR === "B1") nextLevel = "B2";
  else if (currentCEFR === "B2") nextLevel = "C";

  // Only advance if we are not already at the next level
  if (currentCEFR !== nextLevel && nextLevel) {
    currentCEFR = nextLevel;
    resetGame(false); // Preserve streak when progressing
    showBanner("congratulations", nextLevel); // Show the banner
    updateCEFRSelection();
  }
}

function fallbackToPreviousLevel() {
  let previousLevel = "";
  if (currentCEFR === "A2") previousLevel = "A1";
  else if (currentCEFR === "B1") previousLevel = "A2";
  else if (currentCEFR === "B2") previousLevel = "B1";
  else if (currentCEFR === "C") previousLevel = "B2";

  // Only change the level if it is actually falling back to a previous level
  if (currentCEFR !== previousLevel && previousLevel) {
    currentCEFR = previousLevel; // Update the current level to the previous one
    resetGame(false); // Preserve streak when progressing
    incorrectWordQueue = []; // Reset the incorrect word queue on fallback
    showBanner("fallback", previousLevel); // Show the fallback banner
    updateCEFRSelection(); // Update the CEFR selection to reflect the new level
  }
}

let levelLocked = false;

function toggleLevelLock() {
  levelLocked = !levelLocked;
  const icon = document.getElementById("lock-icon");
  if (icon) {
    icon.className = levelLocked ? "fas fa-lock" : "fas fa-lock-open";
    icon.title = levelLocked ? "Level is locked" : "Level is unlocked";
  }
  showBanner("levelLock", levelLocked ? "locked" : "unlocked");
}

// Check if the user can level up or fall back
function evaluateProgression() {
  if (levelLocked) return;

  if (levelTotalQuestions >= 10) {
    const accuracy = levelCorrectAnswers / levelTotalQuestions;
    const { up, down } = levelThresholds[currentCEFR];
    console.log(`Evaluating: Accuracy is ${Math.round(accuracy * 100)}%`);

    if (accuracy >= up && incorrectWordQueue.length === 0) {
      advanceToNextLevel();
    } else if (accuracy < down) {
      fallbackToPreviousLevel();
    }
    resetLevelStats();
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getEndingPattern(form) {
  if (form.match(/ene$/)) return /ene$/i;
  if (form.match(/en$/)) return /en$/i;
  if (form.match(/a$/)) return /a$/i;
  if (form.match(/te$/)) return /te$/i;
  if (form.match(/et$/)) return /et$/i;
  if (form.match(/er$/)) return /er$/i;
  if (form.match(/e$/)) return /e$/i;
  if (form.match(/t$/)) return /t$/i;
  if (form.match(/r$/)) return /r$/i; // ⬅️ New line you add
  return new RegExp(form.slice(-1) + "$", "i"); // fallback
}

function isDefiniteNounForm(word, gender) {
  const lower = word.toLowerCase();
  if (gender.startsWith("en") || gender.startsWith("ei")) {
    return lower.endsWith("en") || lower.endsWith("a");
    // ❗ REMOVE lower.endsWith("n")
  }
  if (gender.startsWith("et")) {
    return lower.endsWith("et");
    // ❗ REMOVE lower.endsWith("t")
  }
  return false;
}

function matchesInflectedForm(base, token, gender) {
  if (!base || !token) return false;

  const lowerBase = base.toLowerCase();
  const lowerToken = token.toLowerCase();

  // ✅ Exact match
  if (lowerToken === lowerBase) return true;

  // ✅ Token starts with base
  if (lowerToken.startsWith(lowerBase)) return true;

  // ✅ Special feminine noun trick: "jente" → "jenta"
  if (lowerBase.endsWith("e")) {
    const baseWithoutE = lowerBase.slice(0, -1);
    if (lowerToken.startsWith(baseWithoutE)) return true;
  }

  return false;
}

function applyInflection(base, clozedForm, gender) {
  if (!base || !clozedForm || !gender) return base;

  const lowerBase = base.toLowerCase();
  const lowerClozed = clozedForm.toLowerCase();
  const stripFinalE = (word) => (word.endsWith("e") ? word.slice(0, -1) : word);
  const endsWith = (ending) => lowerBase.endsWith(ending);

  // ✅ Universal rule: Never add "t" to adjectives ending in "ig" or "sk"
  if (
    lowerClozed.endsWith("t") &&
    (lowerBase.endsWith("ig") || lowerBase.endsWith("sk"))
  ) {
    return base;
  }

  // ✅ Adjective inflection
  if (gender.startsWith("adjective")) {
    if (lowerClozed.endsWith("t")) {
      return base + "t"; // stor → stort, ren → rent
    }
    if (lowerClozed.endsWith("e")) {
      return base + "e"; // stor → store
    }
    if (lowerClozed.endsWith("ere")) {
      return endsWith("e") ? base.slice(0, -1) + "ere" : base + "ere"; // rare → rarere, fin → finere
    }
    if (lowerClozed.endsWith("est")) {
      return endsWith("e") ? base.slice(0, -1) + "est" : base + "est"; // rare → rarest, fin → finest
    }
  }

  // ✅ Verb inflection
  if (gender.startsWith("verb")) {
    if (lowerClozed.endsWith("er")) {
      return endsWith("e") ? base.slice(0, -1) + "er" : base + "er"; // spise → spiser
    }
    if (lowerClozed.endsWith("r")) {
      return endsWith("e") ? base.slice(0, -1) + "r" : base + "r";
    }
    if (lowerClozed.endsWith("et")) {
      return endsWith("e") ? base.slice(0, -1) + "et" : base + "et"; // snakke → snakket
    }
    if (lowerClozed.endsWith("te")) {
      return endsWith("e") ? base.slice(0, -1) + "te" : base + "te"; // bygge → bygget
    }
    if (lowerClozed.endsWith("t")) {
      return endsWith("e") ? base.slice(0, -1) + "t" : base + "t"; // dø → dødd
    }
    if (lowerClozed.endsWith("s")) {
      return endsWith("e") ? base.slice(0, -1) + "s" : base + "s"; // oppbevare → oppbevares
    }
  }

  // ✅ Noun inflection (en/et/ei nouns)
  if (
    gender.startsWith("en") ||
    gender.startsWith("et") ||
    gender.startsWith("ei") ||
    gender.startsWith("noun") ||
    gender.startsWith("substantiv")
  ) {
    if (lowerClozed.endsWith("en")) {
      return endsWith("e") ? base + "n" : base + "en"; // bok → boken
    }
    if (lowerClozed.endsWith("n")) {
      return base + "n"; // katt → katten
    }
    if (lowerClozed.endsWith("et")) {
      return endsWith("e") ? base + "t" : base + "et"; // hus → huset
    }
    if (lowerClozed.endsWith("t")) {
      return base + "t"; // barn → barnet
    }
    if (lowerClozed.endsWith("a")) {
      return base + "a"; // ku → kua
    }
    if (lowerClozed.endsWith("er")) {
      return endsWith("e") ? base + "r" : base + "er"; // jente → jenter, bok → bøker (irregular cases not handled)
    }
    if (lowerClozed.endsWith("r")) {
      return base + "r"; // lilje → liljer
    }
    if (lowerClozed.endsWith("ene")) {
      return base + "ene"; // katten → kattene
    }
  }

  // ✅ Default fallback
  return base;
}

function generateClozeDistractors(baseWord, clozedForm, CEFR, gender) {
  const formattedClozed = clozedForm.toLowerCase();
  const formattedBase = baseWord.toLowerCase();

  const isUninflected = clozedForm.trim() === baseWord.trim(); // key fix

  const matchCapitalization = /^[A-ZÆØÅ]/.test(clozedForm);
  const endingPattern = getEndingPattern(formattedClozed);

  const bannedWordClasses = ["numeral", "pronoun", "possessive", "determiner"];

  let strictDistractors = [];

  const baseCandidates = results.filter((r) => {
    const ord = r.ord.split(",")[0].trim().toLowerCase();
    if (!ord || ord === formattedBase) return false;
    if (ord.includes(" ")) return false;
    if (ord.length < 3 || ord.length > 12) return false;
    if (
      r.gender &&
      !r.gender.toLowerCase().startsWith(gender.slice(0, 2).toLowerCase())
    )
      return false;
    if (r.CEFR !== CEFR) return false;
    if (bannedWordClasses.some((b) => r.gender?.toLowerCase().startsWith(b)))
      return false;
    return true;
  });

  const inflected = baseCandidates
    .map((r) => {
      const raw = r.ord.split(",")[0].trim().toLowerCase();
      return isUninflected
        ? raw
        : applyInflection(raw, formattedClozed, gender);
    })
    .filter(
      (w) =>
        w !== formattedClozed &&
        /^[a-zA-ZæøåÆØÅ]/.test(w) &&
        (isUninflected || endingPattern.test(w))
    );

  strictDistractors = shuffleArray(inflected).slice(0, 3);

  if (strictDistractors.length < 3) {
    const relaxed = results
      .filter((r) => {
        const raw = r.ord.split(",")[0].trim().toLowerCase();
        return (
          raw !== formattedBase &&
          r.gender === gender &&
          !bannedWordClasses.some((b) => r.gender?.toLowerCase().startsWith(b))
        );
      })
      .map((r) => {
        const raw = r.ord.split(",")[0].trim().toLowerCase();
        return isUninflected
          ? raw
          : applyInflection(raw, formattedClozed, gender);
      })
      .filter(
        (w) =>
          w !== formattedClozed &&
          /^[a-zA-ZæøåÆØÅ]/.test(w) &&
          (isUninflected || endingPattern.test(w))
      );

    strictDistractors = strictDistractors
      .concat(shuffleArray(relaxed))
      .slice(0, 3);
  }

  if (strictDistractors.length < 3) {
    const extra = results
      .map((r) => {
        const raw = r.ord.split(",")[0].trim();
        return isUninflected
          ? raw
          : applyInflection(raw.toLowerCase(), formattedClozed, gender);
      })
      .filter(
        (w) =>
          w &&
          w.toLowerCase() !== formattedClozed &&
          endingPattern.test(w.toLowerCase()) &&
          /^[a-zA-ZæøåÆØÅ]/.test(w) === matchCapitalization
      );

    strictDistractors = strictDistractors
      .concat(shuffleArray(extra))
      .slice(0, 3);
  }

  return strictDistractors;
}

function updateCEFRSelection() {
  const cefrSelect = document.getElementById("cefr-select");
  // Update the actual selected value in the dropdown to reflect the current CEFR level
  cefrSelect.value = currentCEFR;
}

function resetGame(resetStreak = true) {
  correctCount = 0; // Reset correct answers count
  correctLevelAnswers = 0; // Reset correct answers for the current level
  if (resetStreak) {
    correctStreak = 0; // Reset the streak if the flag is true
  }
  levelCorrectAnswers = 0;
  incorrectCount = 0; // Reset incorrect answers count
  incorrectWordQueue = [];
  levelTotalQuestions = 0; // Reset this here too
  questionsAtCurrentLevel = 0; // Reset questions counter for the level
  recentAnswers = []; // Clear the recent answers array
  totalQuestions = 0; // Reset total questions for the current level
  renderStats(); // Re-render the stats display to reflect the reset
}

// Reset level stats after progression or fallback
function resetLevelStats() {
  levelCorrectAnswers = 0;
  levelTotalQuestions = 0;
}

document.getElementById("cefr-select").addEventListener("change", function () {
  const typeValue = document.getElementById("type-select").value; // Get the current value of the type selector

  if (typeValue === "word-game") {
    const selectedCEFR = this.value.toUpperCase(); // Get the newly selected CEFR level
    currentCEFR = selectedCEFR; // Set the current CEFR level to the new one
    resetGame(); // Reset the game stats
    startWordGame(); // Start the game with the new CEFR level
  }
});

document.addEventListener("keydown", function (event) {
  if (
    event.key === "Enter" &&
    document.getElementById("type-select").value === "word-game"
  ) {
    const nextWordButton = document.getElementById("game-next-word-button");

    // Check if the button exists and is visible using computed styles
    if (
      nextWordButton &&
      window.getComputedStyle(nextWordButton).display !== "none"
    ) {
      nextWordButton.click(); // Simulate a click on the next word button
    }
  }
});

window.toggleLevelLock = toggleLevelLock;
