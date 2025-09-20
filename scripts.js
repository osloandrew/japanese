// Global Variables
let results = [];
let isEnglishVisible = true;
let isKanjiVisible = true; // default: show Kanji
let latestMultipleResults = null;
const resultsContainer = document.getElementById("results-container");
// Language + schema for Japanese
const APP_LANG = "es";

// Map incoming CSV headers to the app’s canonical keys
const SCHEMA_MAP = {
  ord: "漢字",
  engelsk: "英訳",
  CEFR: "CEFR",
  gender: "仮名", // not in Japanese CSV
  uttale: null, // not in Japanese CSV
  etymologi: null, // not in Japanese CSV
  definisjon: "定義",
  eksempel: "例文",
  sentenceTranslation: "sentenceTranslation",
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

// Function to navigate back to the landing card when the H1 is clicked
function returnToLandingPage() {
  // Update the URL to the base URL without any query parameters
  const baseUrl = window.location.origin + window.location.pathname;
  window.history.pushState({}, "", baseUrl);
  window.location.reload();
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
  if (landingCard) {
    // Temporarily remove the landing card from the container, then clear everything else
    landingCard.parentNode.removeChild(landingCard);
  }

  resultsContainer.innerHTML = ""; // Clear everything else in the container

  // Restore the landing card
  if (landingCard) {
    resultsContainer.appendChild(landingCard);
  }
}

function appendToContainer(content) {
  resultsContainer.innerHTML += content;
}

function shouldNotDecline(adjective) {
  // Pattern for adjectives that do not decline (same form in all genders)
  const noDeclinePattern = /(ende|bra|ing|y|ekte)$/i;

  return noDeclinePattern.test(adjective);
}

function formatDefinitionWithMultipleSentences(definition) {
  return definition
    .split(/(?<=[.!?])\s+/) // Split by sentence delimiters
    .map((sentence) => `<p class="example">${sentence}</p>`) // Wrap each sentence in a <p> tag
    .join(""); // Join them together into a string
}

function togglePronunciationGuide() {
  const pronunciationWrapper = document.querySelector(".pronunciation-wrapper"); // Target the wrapper div
  pronunciationWrapper.classList.toggle("hidden"); // Toggle hidden class
}

// Filter results based on selected part of speech (POS)
function filterResultsByPOS(results, selectedPOS) {
  if (!selectedPOS) return results;

  return results.filter((r) => {
    // Handle nouns based on gender
    if (selectedPOS === "noun") {
      return (
        r.gender &&
        ["noun", "masculine", "feminine"].some((genderVal) =>
          r.gender.toLowerCase().includes(genderVal)
        )
      );
    }

    // Handle all other POS types like "verb," "adjective," etc.
    return (
      r.gender && r.gender.toLowerCase().startsWith(selectedPOS.toLowerCase())
    );
  });
}

// Filter results based on selected CEFR level
function filterResultsByCEFR(results, selectedCEFR) {
  if (!selectedCEFR) return results;
  return results.filter(
    (r) => r.CEFR && r.CEFR.toUpperCase() === selectedCEFR.toUpperCase()
  );
}

// Helper function to format 'gender' (grammatical gender) based on its value
// Helper to format/display 'gender' and flag nouns consistently
function formatGender(gender) {
  if (!gender) return "";
  const g = gender.toLowerCase().trim();
  const esNounMarkers = ["noun", "masculine", "feminine"];
  const norNounMarkers = ["en", "et", "ei", "en-et", "en-ei-et"];

  if (esNounMarkers.some((m) => g === m)) {
    // Japanese CSV uses masculine/feminine for nouns
    return "noun - " + gender;
  }
  if (norNounMarkers.some((m) => g.startsWith(m))) {
    return "noun - " + gender;
  }
  return gender;
}
// Helper to format/display 'gender' and flag nouns consistently
function formatGender(gender) {
  if (!gender) return "";
  const g = gender.toLowerCase().trim();
  const esNounMarkers = ["noun", "masculine", "feminine"];
  const norNounMarkers = ["en", "et", "ei", "en-et", "en-ei-et"];

  if (g === "noun") return "noun";

  if (esNounMarkers.some((m) => g === m)) {
    // Japanese CSV uses masculine/feminine for nouns
    return "noun - " + gender;
  }
  if (norNounMarkers.some((m) => g.startsWith(m))) {
    return "noun - " + gender;
  }
  return gender;
}

// Clear the search input field
function clearInput() {
  const searchEl = document.getElementById("search-bar");
  if (searchEl) searchEl.value = "";

  const typeSelect = document.getElementById("type-select");
  if (typeSelect && typeSelect.value === "stories") {
    // Reset CEFR and Genre filters too
    const cefrEl = document.getElementById("cefr-select");
    const genreEl = document.getElementById("genre-select");
    if (cefrEl) cefrEl.value = "";
    if (genreEl) genreEl.value = "";

    // Now re-render the full list (empty search, no filters)
    displayStoryList();
  }
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

// Parse the CSV data using PapaParse and normalize to canonical keys
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
          region: get("region"),
        };

        // Defensive trims
        entry.ord = entry.ord.trim();

        return entry;
      });

      console.log("Parsed and normalized data:", results);
    },
    error: function (error) {
      console.error("Error parsing CSV:", error);
    },
  });
}

function flagMissingWordEntry(word) {
  // URL of your Google Form
  const formUrl =
    "https://docs.google.com/forms/d/e/1FAIpQLSdEbYtaDMd278Cwx4MmYYqWwyYEv7HY1__yev0UaczKjO9Tsw/formResponse";

  // Prepare the data to be sent
  const formData = new FormData();
  formData.append("entry.279285583", word); // This is the field ID for the word entry

  // Send the form data via POST request
  fetch(formUrl, {
    method: "POST",
    body: formData,
    mode: "no-cors", // Necessary to avoid CORS issues
  })
    .then(() => {
      alert(`The word "${word}" has been flagged successfully!`);
    })
    .catch((error) => {
      console.error("Error flagging the word:", error);
      alert("There was an issue flagging this word. Please try again later.");
    });
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
                        ${cefrLabel}  <!-- Add the CEFR label in the upper-left corner -->
                        <p class="sentence">${cleanedSentence}</p>
                    </div>
                </div>
        `;

    if (selectedTranslation) {
      sentenceHTML += `
                <div class="sentence-box-english" style="display: ${
                  isEnglishVisible ? "block" : "none"
                };">
                    <p class="sentence">${selectedTranslation}</p>
                </div>
            `;
    }
    sentenceHTML += "</div>"; // Close the sentence-container div
    document.getElementById("results-container").innerHTML = sentenceHTML;
  } else {
    // Update the URL to include the random word's info
    updateURL("", type, randomResult.gender, null, randomResult.ord);
    // If it's a word, render it with highlighting (if needed)
    displaySearchResults([randomResult], randomResult.ord);
  }
  hideSpinner(); // Hide the spinner
}

// Function to generate potential inexact matches by removing plural endings, etc.
function generateInexactMatches(query) {
  const variations = [query.toLowerCase().trim()]; // Always include the base query

  // Handle common suffixes like 'ing', 'ed', etc.
  const suffixes = [
    // plurals
    "s",
    "es",
    // adverbs
    "mente",
    // adjective gender/number
    "o",
    "a",
    "os",
    "as",
    // common diminutives
    "ito",
    "ita",
    "itos",
    "itas",
    // participles and gerunds
    "ado",
    "ada",
    "ados",
    "adas",
    "ido",
    "ida",
    "idos",
    "idas",
    "ando",
    "iendo",
    // very common present/preterite endings (short list for recall)
    "o",
    "as",
    "a",
    "amos",
    "an",
    "es",
    "e",
    "emos",
    "en",
    "í",
    "iste",
    "ió",
    "imos",
    "ieron",
    // infinitive recovery helper
    "r",
    "ar",
    "er",
    "ir",
  ];
  suffixes.forEach((suffix) => {
    if (query.endsWith(suffix)) {
      variations.push(query.slice(0, -suffix.length));
    }
  });

  return variations;
}

// Perform a search based on the input query and selected POS
async function search(queryOverride = null) {
  const originalQuery =
    queryOverride ||
    document.getElementById("search-bar").value.toLowerCase().trim();

  document.getElementById("search-bar").dataset.originalQuery = originalQuery; // 👈 this line
  // Try to find a base form in the dataset
  const variations = generateInexactMatches(originalQuery);
  const query =
    variations.find((base) =>
      results.some((r) => {
        const ordList = r.ord
          .toLowerCase()
          .split(",")
          .map((s) => s.trim());
        const kanaList = (r.gender || "")
          .toLowerCase()
          .split(",")
          .map((s) => s.trim()); // 👈 add this
        const engList = r.engelsk
          .toLowerCase()
          .split(",")
          .map((s) => s.trim());
        return (
          ordList.includes(base) ||
          kanaList.includes(base) ||
          engList.includes(base)
        ); // 👈 add kanaList
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
  updateURL(query, type, selectedPOS); // <--- Trigger URL update

  // Show the spinner at the start of the search
  showSpinner();

  showLandingCard(false);
  clearContainer(); // Clear previous results

  let matchingResults;

  if (type === "stories") {
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
    // Handle empty search query
    if (!query) {
      resultsContainer.innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <div class="gender">Empty Search</div>
                </h2>
                <p>Please enter a word in the search field before searching.</p>
            </div>
        `;
      hideSpinner();
      return;
    }

    // If searching sentences, look for matches in both 'eksempel' and 'sentenceTranslation' fields
    matchingResults = cleanResults.filter((r) => {
      return normalizedQueries.some((normQuery) => {
        const japaneseSentenceMatch =
          r.eksempel && r.eksempel.toLowerCase().includes(normQuery); // Match in 'eksempel'
        const englishTranslationMatch =
          r.sentenceTranslation &&
          r.sentenceTranslation.toLowerCase().includes(normQuery); // Match in 'sentenceTranslation'
        return japaneseSentenceMatch || englishTranslationMatch;
      });
    });

    // Additionally, filter by the selected CEFR level
    matchingResults = filterResultsByCEFR(matchingResults, selectedCEFR);

    // Prioritize the matching results using the prioritizeResults function
    matchingResults = prioritizeResults(matchingResults, query, "eksempel");

    // Highlight the query in both 'eksempel' and 'sentenceTranslation'
    matchingResults.forEach((result) => {
      result.eksempel = highlightQuery(result.eksempel, query);
      if (result.sentenceTranslation) {
        result.sentenceTranslation = highlightQuery(
          result.sentenceTranslation,
          query
        );
      }
    });
    renderSentences(matchingResults, query); // Pass the query for highlighting
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

        const ordText = (r.ord || "").toLowerCase();
        const kanaText = (r.gender || "").toLowerCase(); // 👈 kana
        const engVals = (r.engelsk || "")
          .toLowerCase()
          .split(",")
          .map((e) => e.trim());

        const wordMatch =
          exactRegex.test(ordText) ||
          partialRegex.test(ordText) ||
          exactRegex.test(kanaText) ||
          partialRegex.test(kanaText); // 👈 include kana

        const englishMatch = engVals.some(
          (eng) => exactRegex.test(eng) || partialRegex.test(eng)
        );
        return wordMatch || englishMatch;
      });

      // Handle POS filtering for nouns and other parts of speech
      return (
        matchesQuery &&
        (!selectedPOS ||
          (selectedPOS === "noun" &&
            ["noun", "masculine", "feminine"].some((gender) =>
              r.gender.toLowerCase().includes(gender)
            )) ||
          r.gender.toLowerCase().includes(selectedPOS)) &&
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
        const matchesInexact = inexactWordQueries.some((inexactQuery) => {
          const q = inexactQuery.toLowerCase();
          return (
            (r.ord || "").toLowerCase().includes(q) ||
            (r.gender || "").toLowerCase().includes(q) || // 👈 include kana
            (r.engelsk || "").toLowerCase().includes(q)
          );
        });
        return (
          matchesInexact &&
          (!selectedPOS ||
            (selectedPOS === "noun" &&
              ["noun", "masculine", "feminine"].some((gender) =>
                r.gender.toLowerCase().includes(gender)
              )) ||
            r.gender.toLowerCase().includes(selectedPOS)) &&
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
          .map((s) => s.trim())
          .includes(queryLower) ||
        (a.engelsk || "")
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .includes(queryLower) ||
        (a.gender || "")
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .includes(queryLower); // 👈

      const isExactMatchB =
        b.ord
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .includes(queryLower) ||
        (b.engelsk || "")
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .includes(queryLower) ||
        (b.gender || "")
          .toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .includes(queryLower); // 👈
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

// Check if any sentences exist for a word or its variations
function checkForSentences(word, pos) {
  const lowerCaseWord = word.trim().toLowerCase();
  const wordParts = lowerCaseWord.split(",").map((w) => w.trim());
  let sentenceFound = false;

  // Iterate through each part of the comma-separated list
  wordParts.forEach((wordPart) => {
    // Find matching word entry by both word and POS
    const matchingWordEntry = results.find((result) => {
      const wordMatch = result.ord.toLowerCase().includes(wordPart);
      // Handle POS matching for nouns and other parts of speech
      const posMatch =
        (pos === "noun" &&
          ["noun", "masculine", "feminine"].some((gender) =>
            result.gender.toLowerCase().includes(gender)
          )) ||
        result.gender.toLowerCase().includes(pos.toLowerCase());
      return wordMatch && posMatch; // Ensure both word and POS match
    });

    if (!matchingWordEntry) {
      console.log(`No matching word entry for '${wordPart}' with POS '${pos}'`);
      return;
    }

    // Generate word variations
    // Generate variations from both ord and kana (gender) if present
    const entry = results.find(
      (r) => r.ord.toLowerCase() === wordPart.toLowerCase()
    );
    const baseForms = [wordPart];
    if (entry?.gender) baseForms.push(entry.gender);
    const wordVariations = baseForms.flatMap((f) =>
      generateWordVariationsForSentences(f, pos)
    );
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
  handleTypeChange(type);
}

// Handle change in search type (words/sentences)
function handleTypeChange(type) {
  // If type is not passed in (e.g., called from dropdown), get it from the dropdown
  type = type || document.getElementById("type-select").value;
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
  const randomBtn = document.getElementById("random-btn");
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
  const cefrFilterContainer = document.querySelector(".cefr-filter"); // Get the CEFR filter container

  // Filter dropdowns for POS, Genre, and CEFR
  const posSelect = document.getElementById("pos-select");
  const genreSelect = document.getElementById("genre-select");
  const cefrSelect = document.getElementById("cefr-select"); // Get the CEFR filter dropdown
  const cefrLock = document.getElementById("lock-icon");

  removeStoryHeader();
  gameEnglishFilterContainer.style.display = "none";
  gameEnglishSelect.style.display = "none"; // Hide random button

  // Update the URL with the selected type, query, and POS
  updateURL(query, type, selectedPOS); // This ensures the type is reflected in the URL

  // Add logic for the "Stories" type
  if (type === "stories") {
    genreFilterContainer.style.display = "inline-flex"; // Show genre dropdown in story mode
    genreSelect.value = ""; // Reset to default genre

    searchBarWrapper.style.display = "inline-flex"; // Hide search-bar-wrapper
    posFilterContainer.style.display = "none";
    randomBtn.style.display = "none"; // Hide random button
    cefrLock.style.display = "none";

    searchContainerInner.classList.remove("word-game-active");

    showLandingCard(false);
    clearInput();

    cefrSelect.disabled = false; // Enable CEFR filter
    cefrFilterContainer.classList.remove("disabled"); // Visually enable the CEFR filter
    cefrSelect.value = ""; // Reset to default "CEFR Level"

    // Load stories data if not already loaded
    if (!storyResults.length) {
      fetchAndLoadStoryData().then(() => {
        displayStoryList(); // Display the list of stories
      });
    } else {
      displayStoryList(); // Display the list of stories if already loaded
    }
  } else if (type === "sentences") {
    isEnglishVisible = true;
    // Show POS and CEFR dropdowns, hide Genre dropdown
    genreFilterContainer.style.display = "none"; // Hide genre dropdown in sentences mode

    searchBarWrapper.style.display = "inline-flex";
    randomBtn.style.display = "block";

    searchContainerInner.classList.remove("word-game-active");
    gameActive = false;

    // Disable the POS dropdown and gray it out
    posFilterContainer.style.display = "inline-flex"; // Show POS dropdown
    posSelect.disabled = true; // Disable POS dropdown
    cefrLock.style.display = "none";
    posSelect.value = ""; // Reset to "Part of Speech" option
    posFilterContainer.classList.add("disabled"); // Add the 'disabled' class

    // Disable the CEFR dropdown and gray it out
    cefrSelect.disabled = false; // Enable CEFR filter when sentences are selected
    cefrSelect.value = ""; // Reset to "CEFR Level" option
    cefrFilterContainer.classList.remove("disabled"); // Visually enable the CEFR filter

    // If the search bar is not empty, perform a sentence search
    if (query) {
      console.log("Searching for sentences with query:", query);
      search(); // This will trigger a search for sentences based on the search bar query
    } else {
      console.log("Search bar empty, generating a random sentence.");
      randomWord(); // Generate a random sentence if the search bar is empty
    }
  } else if (type === "word-game") {
    // Handle "Word Game" type

    resetGame();
    startWordGame(); // Call the word game function
  } else {
    // Handle default case (e.g., "Words" type)
    genreFilterContainer.style.display = "none"; // Hide genre dropdown

    searchBarWrapper.style.display = "inline-flex"; // Show search-bar-wrapper
    randomBtn.style.display = "block"; // Show random button

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

    // Optionally, generate a random word if needed when switching back to words
    if (query) {
      console.log("Searching for words with query:", query);
      search(); // Trigger a word search if the search bar has a value
    } else {
      console.log("Search bar empty, generating a random word.");
      randomWord(); // Generate a random word if the search bar is empty
    }
  }
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

function makeDefinitionClickable(defText) {
  if (!defText) return "";

  // Normalize lines; strip trailing sentence punctuation (incl. JP)
  let text = defText
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s*[.!?…。、！？]\s*$/u, "");

  // Build once: alternation of known JP headwords (kanji + kana)
  if (!makeDefinitionClickable._rxBuilt) {
    const set = new Set();
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r?.ord) {
          r.ord
            .split(",")
            .map((s) => s.trim())
            .forEach((w) => {
              if (
                /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
                  w
                )
              )
                set.add(w);
            });
        }
        if (r?.gender) {
          r.gender
            .split(",")
            .map((s) => s.trim())
            .forEach((w) => {
              if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w))
                set.add(w);
            });
        }
      }
    }
    const words = Array.from(set)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alt = words.map(esc).join("|") || "(?!)";
    // Match headwords ANYWHERE (no JP boundary requirement)
    makeDefinitionClickable._rx = new RegExp(`(${alt})`, "gu");
    makeDefinitionClickable._rxBuilt = true;
  }

  // Wrap JP headwords found in the text + add a space if another JP char follows
  text = text.replace(makeDefinitionClickable._rx, (m, _g1, offset, str) => {
    const safe = m.replace(/["&<>]/g, (ch) =>
      ch === "&"
        ? "&amp;"
        : ch === '"'
        ? "&quot;"
        : ch === "<"
        ? "&lt;"
        : "&gt;"
    );

    // Look at the next character in the *original* string
    const nextChar = str.slice(offset + m.length, offset + m.length + 1);

    // JP char class incl. long-vowel mark + halfwidth kana
    const JP_NEXT =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\uFF66-\uFF9D]/u;

    const needsSpace = JP_NEXT.test(nextChar);

    return `<span class="clickable-definition-word" data-word="${safe}">${m}</span>${
      needsSpace ? " " : ""
    }`;
  });

  // Fallback wrapper for spaced languages — but SKIP any token that contains JP chars
  const hasJP = (s) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);

  function wrapToken(token) {
    if (/<span[^>]*>/.test(token)) return token; // already wrapped by JP pass
    if (hasJP(token)) return token; // don't wrap whole JP runs

    // (foo)bar or foo(bar)baz
    const complex = token.match(
      /^([\p{L}\-']*)\(([\p{L}\-']+)\)([\p{L}\-']*)([.,;!?]*)$/u
    );
    if (complex) {
      const [, before, inside, after, punct] = complex;
      const parts = [];
      if (before)
        parts.push(
          `<span class="clickable-definition-word" data-word="${before}">${before}</span>`
        );
      parts.push("(");
      parts.push(
        `<span class="clickable-definition-word" data-word="${inside}">${inside}</span>`
      );
      parts.push(")");
      if (after)
        parts.push(
          `<span class="clickable-definition-word" data-word="${after}">${after}</span>`
        );
      parts.push(punct || "");
      return parts.join("");
    }

    const m = token.match(
      /^(\()?(?<prefix>[\p{L}\-']+)?(\))?(?<base>[\p{L}\-']+)?([:.,;!?]*)$/u
    );
    if (!m || !m.groups) return token;

    const { prefix, base } = m.groups;
    const punct = (token.match(/[:.,;!?]+$/) || [""])[0];
    const open = token.startsWith("(") ? "(" : "";
    const close = token.includes(")") ? ")" : "";
    const endsWithHyphen = token.endsWith("-");
    const word = (prefix || base || "").replace(/-$/, "");
    if (!word) return `${open}${close}${punct}`;
    return `${open}<span class="clickable-definition-word" data-word="${word}">${word}</span>${
      endsWithHyphen ? "-" : ""
    }${close}${punct}`;
  }

  if (text.includes(";")) {
    const items = text
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    return (
      `<ul class="definition-list">` +
      items
        .map((item) => `<li>${item.split(/\s+/).map(wrapToken).join(" ")}</li>`)
        .join("") +
      `</ul>`
    );
  }

  return text
    .split(/\s+/)
    .map((token) => {
      if (/<span[^>]*>/.test(token)) return token; // preserve JP matches
      if (hasJP(token)) return token; // don't wrap whole JP tokens
      if (token.includes("/") && !token.startsWith("http")) {
        return token.split("/").map(wrapToken).join("/");
      }
      return wrapToken(token);
    })
    .join(" ");
}

// Render a list of results (words)
function displaySearchResults(results, query = "") {
  query = query.toLowerCase().trim(); // Ensure the query is lowercased and trimmed
  const defaultResult = results.length <= 1; // Determine if there are multiple results
  const multipleResults = results.length > 1; // Determine if there are multiple results

  let htmlString = "";

  // Limit to a maximum of 10 results
  results.slice(0, 10).forEach((result) => {
    result.gender = formatGender(result.gender);

    const g = (result.gender || "").toLowerCase();
    const NOUN_MARKERS = [
      "en",
      "et",
      "ei",
      "en-et",
      "en-ei-et",
      "noun",
      "masculine",
      "feminine",
      "m",
      "f",
      "m/f",
      "noun - masculine",
      "noun - feminine",
    ];

    const isNoun = NOUN_MARKERS.some((m) => g.includes(m));
    result.pos = isNoun ? "noun" : g;

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

    function normalizeDefinitionText(def) {
      return def
        .split(/\r?\n+/)
        .map((line) => {
          line = line.trim();
          if (!line) return "";
          // lowercase the first alphabetic char
          line = line.replace(
            /^([(\s"«“¡¿]*)?([A-ZÁÉÍÓÚÜÑÇÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÅÆØŒ])/u,
            (m, pre = "", ch) => pre + ch.toLowerCase()
          );
          // strip trailing . ! ? …
          line = line.replace(/\s*[.!?…]\s*$/u, "");
          return line;
        })
        .filter(Boolean)
        .join(" ");
    }

    htmlString += `
<div 
  class="definition ${multipleResultsDefinition}" 
  data-word="${escapedWord}" 
  data-pos="${result.pos}" 
  data-engelsk="${result.engelsk}" 
  onclick="if (!window.getSelection().toString()) handleCardClick(event, '${escapedWord}', '${result.gender
      .replace(/'/g, "\\'")
      .trim()}', '${result.engelsk
      .replace(/'/g, "\\'")
      .trim()}', this.querySelector('.${multipleResultsDefinitionText}')?.textContent?.trim() || '')">
                <div class="${multipleResultsDefinitionHeader}">
                <h2 class="word-gender ${multipleResultsWordgender}">
                  <div class="word-text-block">
                    ${
                      result.ord.includes(",")
                        ? (() => {
                            const [first, ...rest] = result.ord.split(",");
                            return `${first.trim()}<br><span class="alt-spelling">${rest
                              .join(", ")
                              .trim()}</span>`;
                          })()
                        : result.ord
                    }
                  </div>

                    ${
                      result.gender && result.gender !== result.ord
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
                          )}">${result.CEFR}</div>`
                        : ""
                    } 
                </h2>
                ${
                  result.definisjon
                    ? `<p class="${multipleResultsDefinitionText}">${
                        defaultResult
                          ? makeDefinitionClickable(result.definisjon)
                          : result.definisjon // 👈 multiple results just show raw definisjon
                      }</p>`
                    : ""
                }
                </div>
                <div class="definition-content ${multipleResultsHiddenContent}"> <!-- Apply the hidden class conditionally -->
                    ${
                      result.engelsk
                        ? `<p class="english"><i class="fas fa-language"></i> ${result.engelsk}</p>`
                        : ""
                    }
                    ${
                      result.uttale
                        ? `<p class="pronunciation"><i class="fas fa-volume-up"></i> ${result.uttale}</p>`
                        : ""
                    }
                    ${
                      result.etymologi
                        ? `<p class="etymology"><i class="fa-solid fa-flag"></i> ${result.etymologi}</p>`
                        : ""
                    }
                    ${
                      result.CEFR
                        ? `<p style="display: inline-flex; align-items: center; font-family: 'Noto Sans', sans-serif; font-weight: bold; text-transform: uppercase; font-size: 12px; color: #4F4F4F;"><i class="fa-solid fa-signal" style="margin-right: 5px;"></i><span style="text-align: center; min-width: 15px; display: inline-block; padding: 3px 7px; border-radius: 4px; background-color: ${getCefrColor(
                            result.CEFR
                          )};">${result.CEFR}</span></p>`
                        : ""
                    }
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

  // Automatically load sentences for a single result, regardless of whether sentences exist in `eksempel`
  if (defaultResult && results[0]) {
    console.log("Auto-loading sentences for:", results[0].ord);
    setTimeout(() => {
      const singleResult = results[0];
      fetchAndRenderSentences(
        singleResult.ord,
        singleResult.pos,
        isEnglishVisible
      );
    }, 0);
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
  const norwegianSentenceDivs = wordId
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

  // Toggle visibility based on the global isEnglishVisible state
  isEnglishVisible = !isEnglishVisible;

  englishSentenceDivs.forEach((div) => {
    div.style.display = isEnglishVisible ? "block" : "none";
  });

  norwegianSentenceDivs.forEach((div) => {
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

// Utility function to generate word variations for verbs ending in -ere and handle adjective/noun forms
function generateWordVariationsForSentences(word, pos) {
  const variations = [];

  // Split the word into parts in case it's a phrase (e.g., "vedtatt sannhet")
  const wordParts = word.split(" ");

  // Handle phrases with slashes (e.g., "være/vær så snill", "logge inn/på")
  if (word.includes("/")) {
    // Split on the slash and create variations for both parts
    const [firstPart, secondPart] = word.split("/");
    const restOfPhrase = word.split(" ").slice(1).join(" "); // Get the rest of the phrase after the first word

    variations.push(`${firstPart} ${restOfPhrase}`); // Add the first part with the rest of the phrase
    variations.push(`${secondPart} ${restOfPhrase}`); // Add the second part with the rest of the phrase
    return variations;
  }

  // Reflexive pronouns to handle reflexive verbs with variations (e.g., "seg", "deg", "meg", "oss", etc.)
  const reflexivePronouns = ["me", "te", "se", "nos", "os"];

  // If it's a single word
  if (wordParts.length === 1) {
    const singleWord = wordParts[0];
    let stem = singleWord;
    let gender = getWordGender(singleWord);

    if (singleWord.length <= 2) {
      // Handle the case where the word is too short to generate meaningful variations
      console.warn(`Word "${singleWord}" is too short to generate variations.`);
      variations.push(singleWord); // Just return the word as is
      return variations;
    }

    if (pos === "noun" && gender.includes("ei")) {
      if (singleWord.endsWith("e")) {
        stem = singleWord.slice(0, -1); // Remove the final -e from the word
      }
      variations.push(
        `${stem}`, // setning
        `${stem}e`, // jente
        `${stem}a`, // jenta
        `${stem}en`, // jenten
        `${stem}er`, // jenter
        `${stem}ene` // jentene
      );
      // Handle verb variations if the word is a verb and ends with "e"
    } else if (pos === "verb") {
      if (singleWord.endsWith("e")) {
        stem = singleWord.slice(0, -1); // Remove the final -e from the verb
      }
      variations.push(
        `${stem}`, // imperative: anglifiser
        `${stem}a`, // past tense: snakka
        `${stem}e`, // infinitive: anglifisere
        `${stem}er`, // present tense: anglifiserer
        `${stem}es`, // passive: anglifiseres
        `${stem}et`, // past tense: snakket
        `${stem}r`, // present tense: bor
        `${stem}t`, // past participle: anglifisert
        `${stem}te` // past tense: anglifiserte
      );
    } else {
      // For non-verbs, just add the word itself as a variation
      variations.push(singleWord);
    }

    // If it's a phrase (e.g., "vedtatt sannhet"), handle each part separately
  } else if (wordParts.length >= 2) {
    const [firstWord, secondWord, ...restOfPhrase] = wordParts;
    const remainingPhrase = restOfPhrase.join(" ");

    // Handle reflexive verbs like "beklage seg" with variations for reflexive pronouns
    if (reflexivePronouns.includes(secondWord)) {
      let stem;
      // Only remove the final 'e' if it exists; otherwise, use the full word (e.g., for "bry")
      if (firstWord.endsWith("e")) {
        stem = firstWord.slice(0, -1); // Remove the final -e from the verb
      } else {
        stem = firstWord; // Use the full word if it doesn't end with 'e'
      }
      // Add variations for all reflexive pronouns (seg, deg, meg, etc.)
      reflexivePronouns.forEach((reflexive) => {
        variations.push(
          `${stem}e ${reflexive} ${remainingPhrase}`, // infinitive
          `${stem}er ${reflexive} ${remainingPhrase}`, // present tense
          `${stem}te ${reflexive} ${remainingPhrase}`, // past tense
          `${stem}t ${reflexive} ${remainingPhrase}`, // past participle
          `${stem}et ${reflexive} ${remainingPhrase}`, // past tense/past participle
          `${stem}a ${reflexive} ${remainingPhrase}`, // past tense/past participle
          `${stem} ${reflexive} ${remainingPhrase}`, // imperative
          `${stem}es ${reflexive} ${remainingPhrase}` // passive
        );
      });
    } else if (wordParts.length === 2) {
      // Handle adjective inflection (e.g., "vedtatt" -> "vedtatte")
      const adjectiveVariations = [firstWord, firstWord.replace(/t$/, "te")]; // Add plural/adjective form

      // Handle noun pluralization (e.g., "sannhet" -> "sannheter")
      const nounVariations = [secondWord, secondWord + "er"]; // Add plural form for nouns

      // Combine all variations of adjective and noun
      adjectiveVariations.forEach((adj) => {
        nounVariations.forEach((noun) => {
          variations.push(`${adj} ${noun}`);
        });
      });
    } else {
      // For other longer phrases, just return the phrase as is
      variations.push(word);
    }
  } else {
    // Add the original phrase as a variation (no transformation needed for long phrases)
    variations.push(word);
  }

  return variations;
}

// Render a single sentence
function renderSentence(sentenceResult) {
  // Split the example by common sentence delimiters (period, question mark, exclamation mark)
  const sentences = sentenceResult.eksempel.split(/(?<=[.!?])\s+/);

  // Get the first sentence from the array
  const firstSentence = sentences[0];

  const sentenceHTML = `
        <div class="definition">
            <p class="sentence">${firstSentence}</p>
        </div>
    `;

  document.getElementById("results-container").innerHTML = sentenceHTML;
}

function renderSentences(sentenceResults, word) {
  clearContainer(); // Clear previous results

  const query = word.trim().toLowerCase(); // Trim and lower-case the search term for consistency
  let exactMatches = [];
  let partialMatches = [];
  let uniqueSentences = new Set(); // Track unique sentences

  const regexExactMatch = new RegExp(`\\b${query}\\b`, "i");

  sentenceResults.forEach((result) => {
    // Split example sentences by common sentence delimiters (period, question mark, exclamation mark)
    const sentences = result.eksempel.match(/[^.!?]+[.!?]*/g) || [
      result.eksempel,
    ];
    const translations = result.sentenceTranslation
      ? result.sentenceTranslation.match(/[^.!?]+[.!?]*/g)
      : [];

    // Generate the CEFR label based on the result's CEFR value
    let cefrLabel = "";
    if (result.CEFR === "A1") {
      cefrLabel = '<div class="sentence-cefr-label easy">A1</div>';
    } else if (result.CEFR === "A2") {
      cefrLabel = '<div class="sentence-cefr-label easy">A2</div>';
    } else if (result.CEFR === "B1") {
      cefrLabel = '<div class="sentence-cefr-label medium">B1</div>';
    } else if (result.CEFR === "B2") {
      cefrLabel = '<div class="sentence-cefr-label medium">B2</div>';
    } else if (result.CEFR === "C") {
      cefrLabel = '<div class="sentence-cefr-label hard">C</div>';
    }

    // Iterate through each sentence and match it with its translation
    sentences.forEach((sentence, index) => {
      const trimmedSentence = sentence.trim();
      const translation = translations[index] || "";

      if (!uniqueSentences.has(trimmedSentence)) {
        // Only add unique sentences
        uniqueSentences.add(trimmedSentence);

        // Check for exact match (whole word match) in both the Japanese sentence and English translation
        if (
          regexExactMatch.test(sentence.toLowerCase()) ||
          regexExactMatch.test(translation.toLowerCase())
        ) {
          exactMatches.push({
            cefrLabel,
            sentence: highlightQuery(sentence, query),
            translation: highlightQuery(translation, query),
          });
        }
        // Check for partial match in both Japanese sentence and English translation
        else if (
          sentence.toLowerCase().includes(query) ||
          translation.toLowerCase().includes(query)
        ) {
          partialMatches.push({
            cefrLabel,
            sentence: highlightQuery(sentence, query),
            translation: highlightQuery(translation, query),
          });
        }
      }
    });
  });

  // Combine exact matches first, then partial matches
  const combinedMatches = [...exactMatches, ...partialMatches].slice(0, 10);

  // Debugging log
  console.log("Exact Matches:", exactMatches);
  console.log("Partial Matches:", partialMatches);
  console.log("Combined Matches:", combinedMatches);

  // Check if no results found
  if (combinedMatches.length === 0) {
    document.getElementById("results-container").innerHTML = `
            <div class="definition error-message">
                <h2 class="word-gender">
                    Error <span class="gender">No Matching Sentences</span>
                </h2>
                <p>No sentences found containing "${query}".</p>
            </div>
        `;
    return; // Exit early since there's nothing to render
  }

  // Generate HTML for the combined matches
  let htmlString = "";

  if (combinedMatches.length > 0) {
    // Generate the header card
    htmlString += `
            <div class="result-header">
                <h2>Sentence Results for "${word}"</h2>
            </div>
            <button class="sentence-btn english-toggle-btn" onclick="toggleEnglishTranslations()">
                ${isEnglishVisible ? "Hide English" : "Show English"}
            </button>    
        `;
  }

  combinedMatches.forEach((match) => {
    htmlString += `
            <div class="sentence-container">
                <div class="sentence-box-norwegian ${
                  !isEnglishVisible ? "sentence-box-norwegian-hidden" : ""
                }">
                    <div class="sentence-content">
                        ${match.cefrLabel}
                        <p class="sentence">${match.sentence}</p>
                    </div>
                </div>
        `;

    // Only add the English translation box if it exists
    if (match.translation) {
      htmlString += `
            <div class="sentence-box-english" style="display: ${
              isEnglishVisible ? "block" : "none"
            };">
                    <p class="sentence">${match.translation}</p>
                </div>
            `;
    }

    htmlString += "</div>"; // Close the sentence-container div
  });

  // Insert the generated HTML into the results container
  document.getElementById("results-container").innerHTML = htmlString;
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
  const letters = "[\\wåæøÅÆØáéíóúÁÉÍÓÚñÑüÜ]"; // Include Japanese letters in the pattern
  const regex = new RegExp(`(${letters}*${query}${letters}*)`, "gi");

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
    const regex = new RegExp(`(\\b${q}\\b|\\b${q}(?![\\wåæøÅÆØ]))`, "gi");

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
  const pos = matchingWordEntry
    ? ["noun", "masculine", "feminine"].some((gender) =>
        matchingWordEntry.gender.toLowerCase().includes(gender)
      )
      ? "noun"
      : matchingWordEntry.gender.toLowerCase()
    : "";

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
          const japanesePattern = "[\\wåæøÅÆØ]"; // Pattern including Japanese letters
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

  // Filter results based on both word and selected POS if provided
  const matchingResults = results.filter((r) => {
    const wordMatch = r.ord.toLowerCase().trim() === trimmedWord;

    // Check for noun gender match when selectedPOS is 'noun'
    const posMatch =
      selectedPOS === "noun"
        ? ["noun", "masculine", "feminine"].some((gender) =>
            r.gender.toLowerCase().includes(gender)
          )
        : selectedPOS
        ? r.gender.toLowerCase().includes(selectedPOS)
        : true;

    return wordMatch && posMatch;
  });

  if (matchingResults.length > 0) {
    displaySearchResults(matchingResults);
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

// Fetch and render sentences for a word or phrase, including handling comma-separated variations
function fetchAndRenderSentences(word, pos, showEnglish = true) {
  // Added showEnglish parameter with default value
  const trimmedWord = word
    .trim()
    .toLowerCase()
    .replace(/[\r\n]+/g, ""); // Remove any carriage returns or newlines
  const button = document.querySelector(`button[data-word='${word}']`);
  const sentenceContainer = document.getElementById(
    `sentences-container-${trimmedWord}`
  );

  if (!sentenceContainer) {
    console.error(`Sentence container not found for: ${trimmedWord}`);
    return;
  }

  // Toggle visibility without re-fetching sentences
  if (sentenceContainer.getAttribute("data-fetched") === "true") {
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

  sentenceContainer.innerHTML = ""; // Clear previous sentences

  // Find the part of speech (POS) of the word
  const matchingWordEntry = results.find(
    (result) => result.ord.toLowerCase() === trimmedWord
  ); // Updated to use exact match

  if (!matchingWordEntry) {
    console.error(`No matching word found for "${trimmedWord}".`);
    return; // Stop if the word isn't found
  }

  // Generate word variations using the external function
  // Variations from ord + kana (gender) if available
  const entry = results.find(
    (r) => r.ord.toLowerCase() === trimmedWord.toLowerCase()
  );
  // For Japanese: just use ord first, then kana (gender) if present
  const wordVariations = [
    trimmedWord,
    ...(entry?.gender ? [entry.gender] : []),
  ];

  const kanji = entry.ord.trim(); // e.g. 人
  const kana = entry.gender?.trim(); // e.g. ひと

  // Collect matches for each form
  function collectMatches(form) {
    return results.filter((r) => r.eksempel && r.eksempel.includes(form));
  }

  let kanjiEntries = collectMatches(kanji);
  let kanaEntries = kana ? collectMatches(kana) : [];

  // Prioritize separately, then merge
  const prioritizedKanji = prioritizeResults(
    kanjiEntries.filter((r) => r.ord !== matchingWordEntry.ord),
    kanji,
    "eksempel"
  );
  const prioritizedKana = kana
    ? prioritizeResults(
        kanaEntries.filter((r) => r.ord !== matchingWordEntry.ord),
        kana,
        "eksempel"
      )
    : [];

  // Collect kanji matches first, then kana
  let relevantEntries = collectMatches(kanji);
  if (kana) {
    relevantEntries = [...relevantEntries, ...collectMatches(kana)];
  }

  // Use a Set to store unique sentences and translations
  const uniqueSentences = new Set();
  const uniqueTranslations = new Set();

  // Now, split sentences and align translations
  let matchingResults = [];

  // --- Ensure own entry’s sentences always appear first ---
  if (matchingWordEntry.eksempel) {
    const primarySentences = matchingWordEntry.eksempel.split(/(?<=[.!?])\s+/);
    const primaryTranslations = matchingWordEntry.sentenceTranslation
      ? matchingWordEntry.sentenceTranslation.split(/(?<=[.!?])\s+/)
      : [];

    primarySentences.forEach((sentence, index) => {
      if (!uniqueSentences.has(sentence)) {
        uniqueSentences.add(sentence);
        matchingResults.push({
          ...matchingWordEntry,
          eksempel: sentence,
          sentenceTranslation: primaryTranslations[index] || "",
        });
      }
    });
  }
  outerLoop: for (const r of relevantEntries) {
    const sentences = r.eksempel.split(/(?<=[.!?])\s+/);
    const translations = r.sentenceTranslation
      ? r.sentenceTranslation.split(/(?<=[.!?])\s+/)
      : [];

    const matched = { matchedSentences: [], matchedTranslations: [] };

    sentences.forEach((sentence, index) => {
      const isMatched = wordVariations.some((variation) => {
        const regex = new RegExp(variation, "i");
        return regex.test(sentence);
      });

      if (isMatched) {
        if (!uniqueSentences.has(sentence)) {
          uniqueSentences.add(sentence);
          matched.matchedSentences.push(sentence);
        }
        if (
          translations[index] &&
          !uniqueTranslations.has(translations[index])
        ) {
          uniqueTranslations.add(translations[index]);
          matched.matchedTranslations.push(translations[index]);
        }
      }
    });

    if (matched.matchedSentences.length > 0) {
      matchingResults.push({
        ...r,
        eksempel: matched.matchedSentences.join(" "),
        sentenceTranslation: matched.matchedTranslations.join(" "),
      });
    }

    if (uniqueSentences.size >= 10) break outerLoop;
  }

  // Check if there are any matching results
  if (matchingResults.length === 0) {
    console.log(`No sentences found for the word variations.`);
    return;
  }

  // Merge: own entry sentences first, then other kanji, then kana
  // Merge: own entry sentences first, then other kanji, then kana
  const seen = new Set(matchingResults.map((r) => r.eksempel));

  matchingResults = [
    ...matchingResults,
    ...prioritizedKanji.filter((r) => !seen.has(r.eksempel)),
    ...prioritizedKana.filter((r) => !seen.has(r.eksempel)),
  ];
  // Apply highlighting for the new word and reset any previous highlighting
  matchingResults.forEach((result) => {
    wordVariations.forEach((variation) => {
      const highlightedSentence = highlightQuery(result.eksempel, variation); // Highlight query in sentence
      result.eksempel = highlightedSentence; // Set the highlighted sentence back
    });
  });

  // Create the sentence content with CEFR labels
  let sentenceContent = matchingResults
    .slice(0, 10)
    .map((result) => {
      // Split example sentences by common sentence delimiters (period, question mark, exclamation mark)
      const sentences = result.eksempel
        ? result.eksempel.split(/(?<=[.!?])\s+/)
        : [];
      const translations = result.sentenceTranslation
        ? result.sentenceTranslation.split(/(?<=[.!?])\s+/)
        : [];

      // Generate the CEFR label based on the result's CEFR value
      let cefrLabel = "";
      if (result.CEFR === "A1") {
        cefrLabel = '<div class="sentence-cefr-label easy">A1</div>';
      } else if (result.CEFR === "A2") {
        cefrLabel = '<div class="sentence-cefr-label easy">A2</div>';
      } else if (result.CEFR === "B1") {
        cefrLabel = '<div class="sentence-cefr-label medium">B1</div>';
      } else if (result.CEFR === "B2") {
        cefrLabel = '<div class="sentence-cefr-label medium">B2</div>';
      } else if (result.CEFR === "C") {
        cefrLabel = '<div class="sentence-cefr-label hard">C</div>';
      }

      // For each sentence, map it to a card
      return sentences
        .map(
          (sentence, index) => `
            <div class="sentence-container">
                <div class="sentence-box-norwegian ${
                  !showEnglish ? "sentence-box-norwegian-hidden" : ""
                }">
                    <div class="sentence-content">
                        ${cefrLabel}
                        <p class="sentence">${sentence}</p>
                    </div>
                </div>
                ${
                  translations[index]
                    ? `
                <div class="sentence-box-english" style="display: ${
                  showEnglish ? "block" : "none"
                };">
                    <p class="sentence-translation">${translations[index]}</p>
                </div>`
                    : ""
                }
            </div>
        `
        )
        .join("");
    })
    .join("");

  if (sentenceContent) {
    sentenceContainer.innerHTML = sentenceContent;
    sentenceContainer.style.display = "block"; // Show the container

    // Find the button and display it if sentences exist
    const englishButton = sentenceContainer.parentElement.querySelector(
      ".english-toggle-btn"
    );
    if (englishButton) {
      englishButton.style.display = "block"; // Make the button visible
      englishButton.innerText = showEnglish ? "Hide English" : "Show English";
    }
  } else {
    console.warn("No content to show for the word:", trimmedWord);
  }

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
    document.title = `${word} - Japanese Dictionary`; // Set title to the word
    // Update the URL without reloading the page
    window.history.pushState({}, "", url);
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

  // If there's a story in the URL, display that story and exit
  if (storyTitle) {
    document.title = `${decodeURIComponent(storyTitle)} - Japanese Story`;
    displayStory(decodeURIComponent(storyTitle)); // Display the specific story
    return; // Exit function as story is being displayed
  }

  // Function to display the word entry once data is loaded
  function displayWordIfLoaded() {
    if (results.length > 0) {
      // Check if dictionary data is loaded
      if (word) {
        // Set title to the word
        document.title = `${word} - Japanese Dictionary`;
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
      if (selectedPOS) {
        document.getElementById("pos-select").value = selectedPOS;
      }

      if (type === "word-game") {
        startWordGame();
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

// Function to handle clicking on a search result card
function handleCardClick(event, word, pos, engelsk, definisjon) {
  console.log(`Word clicked: ${word}, POS: ${pos}`); // Log the clicked word and POS

  // Filter to count only visible elements with the specific card class
  const visibleCards = Array.from(resultsContainer.children).filter(
    (child) =>
      child.classList.contains("definition") && child.offsetParent !== null
  );

  // Log the count of visible cards
  console.log(
    "Number of visible cards in resultsContainer:",
    visibleCards.length
  );

  // Prevent activation if only one card is displayed
  if (visibleCards.length === 1) {
    console.log("Only one card displayed, click action disabled.");
    return;
  }

  // Filter results by word, POS (part of speech), and the English translation
  const clickedResult = results.filter((r) => {
    const wordMatch = r.ord.toLowerCase().trim() === word.toLowerCase().trim();
    const genderMatch =
      r.gender.toLowerCase().trim() === pos.toLowerCase().trim();
    const engelskMatch =
      r.engelsk.toLowerCase().trim() === engelsk.toLowerCase().trim();
    const definisjonMatch =
      r.definisjon.toLowerCase().trim() === definisjon.toLowerCase().trim();

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
  updateURL("", "words", pos, null, word.split(",")[0].trim());
}

// Initialization of the dictionary data and event listeners
window.onload = function () {
  // Check if the buttons exist in the DOM
  const searchBtn = document.getElementById("search-btn");
  const randomBtn = document.getElementById("random-btn");
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
    randomBtn &&
    searchBar &&
    clearBtn &&
    posSelect &&
    cefrSelect
  ) {
    searchBtn.disabled = true;
    randomBtn.disabled = true;
    searchBar.disabled = true;
    clearBtn.disabled = true;
    posSelect.disabled = true;
    cefrSelect.disabled = true;
    typeSelect.disabled = true;

    // Apply the disabled styling
    searchBtn.style.color = "#ccc";
    searchBtn.style.cursor = "not-allowed";
    randomBtn.style.color = "#ccc";
    randomBtn.style.cursor = "not-allowed";
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
      randomBtn.disabled = false;
      searchBar.disabled = false;
      clearBtn.disabled = false;
      typeSelect.disabled = false;
      posSelect.disabled = false;
      cefrSelect.disabled = false;

      // Restore original styling
      searchBtn.style.color = "";
      searchBtn.style.cursor = "pointer";
      randomBtn.style.color = "";
      randomBtn.style.cursor = "pointer";
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
    if (event.target.matches(".back-navigation")) {
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
          .split(",")
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
