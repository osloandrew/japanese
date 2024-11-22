const genreIcons = {
  action: '<i class="fas fa-bolt"></i>', // Action genre icon
  adventure: '<i class="fas fa-compass"></i>', // Adventure genre icon
  art: '<i class="fas fa-paint-brush"></i>', // Art genre icon
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
  mystery: '<i class="fas fa-search"></i>', // Mystery genre icon
  music: '<i class="fas fa-music"></i>', // Music genre icon
  nature: '<i class="fas fa-leaf"></i>', // Nature genre icon
  philosophy: '<i class="fas fa-brain"></i>', // Philosophy genre icon
  poetry: '<i class="fas fa-feather-alt"></i>', // Poetry genre icon
  politics: '<i class="fas fa-balance-scale"></i>', // Politics genre icon
  psychology: '<i class="fas fa-brain"></i>', // Psychology genre icon
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

document.addEventListener("DOMContentLoaded", () => {
  const storyList = document.getElementById("stories");
  const storyViewer = document.getElementById("story-viewer");
  const storyContent = document.getElementById("story-content");
  const backButton = document.getElementById("back-button");
  const stickyHeader = document.getElementById("sticky-header");
  const storyListSection = document.getElementById("story-list");
  const filterContainer = document.getElementById("filter-container"); // Filters wrapper
  const searchBar = document.getElementById("search-bar");
  const genreFilter = document.getElementById("genre-filter");
  const cefrFilter = document.getElementById("cefr-filter");
  const toggleEnglishBtn = document.getElementById("toggle-english-btn");
  let isEnglishVisible = true; // Default state
  let stories = []; // Global array to store all stories

  // Utility function to shuffle an array
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function updateEnglishVisibility() {
    const englishSentences = document.querySelectorAll(".english-sentence");
    if (isEnglishVisible) {
      // Show English sentences
      englishSentences.forEach((sentence) => {
        sentence.style.display = "block";
      });
      toggleEnglishBtn.textContent = "Hide English";
    } else {
      // Hide English sentences
      englishSentences.forEach((sentence) => {
        sentence.style.display = "none";
      });
      toggleEnglishBtn.textContent = "Show English";
    }
  }

  // Event listener for the toggle button
  toggleEnglishBtn.addEventListener("click", () => {
    isEnglishVisible = !isEnglishVisible;
    updateEnglishVisibility();
  });

  // Set default visibility on page load
  updateEnglishVisibility();

  // CSV Parsing Function
  function parseCSV(csvText) {
    const rows = csvText.split("\n").filter((row) => row.trim() !== ""); // Remove empty rows
    const headers = rows[0].split(",").map((header) => header.trim()); // Split and trim headers
    return rows.slice(1).map((row) => {
      const values = [];
      let current = "";
      let insideQuotes = false;

      for (let char of row) {
        if (char === '"' && insideQuotes) {
          insideQuotes = false;
        } else if (char === '"' && !insideQuotes) {
          insideQuotes = true;
        } else if (char === "," && !insideQuotes) {
          values.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      values.push(current.trim()); // Add the last value

      const story = {};
      headers.forEach((header, index) => {
        story[header] = values[index] || ""; // Assign value to header or empty string
      });
      return story;
    });
  }

  // CSV Data Loading Function
  function loadCSV(url, callback) {
    fetch(url)
      .then((response) => response.text())
      .then((data) => {
        const parsedStories = parseCSV(data);
        stories = shuffleArray(parsedStories); // Shuffle the stories array
        callback(stories); // Display all stories initially
      })
      .catch((err) => console.error("Error loading CSV:", err));
  }

  // Display the list of stories
  function displayStories(stories) {
    filterContainer.style.display = "flex"; // Show filters on the list page
    storyList.innerHTML = ""; // Clear previous stories

    stories.forEach((story, index) => {
      const listItem = document.createElement("li");
      listItem.style.display = "flex";
      listItem.style.justifyContent = "space-between";
      listItem.style.alignItems = "center";

      // Title container (Japanese and English stacked)
      const titleContainer = document.createElement("div");
      titleContainer.id = `story-title-container-${index}`;
      titleContainer.classList.add("title-container");

      // Japanese title
      const japaneseTitleDiv = document.createElement("div");
      japaneseTitleDiv.id = `story-japanese-title-${index}`;
      japaneseTitleDiv.classList.add("japanese-title");
      japaneseTitleDiv.textContent = story.titleJapanese;

      // English title
      const englishTitleDiv = document.createElement("div");
      englishTitleDiv.id = `story-english-title-${index}`;
      englishTitleDiv.classList.add("english-title");
      englishTitleDiv.textContent = story.titleEnglish;

      // Append Japanese and English titles to title container
      titleContainer.appendChild(japaneseTitleDiv);
      titleContainer.appendChild(englishTitleDiv);

      // CEFR container
      const cefrDiv = document.createElement("div");
      cefrDiv.id = `story-cefr-${index}`;
      cefrDiv.classList.add("cefr-value", getCefrClass(story.CEFR)); // Add CEFR level class
      cefrDiv.textContent = story.CEFR || "N/A"; // Display CEFR or "N/A"

      // Genre container with Font Awesome icon
      const genreDiv = document.createElement("div");
      genreDiv.classList.add("stories-genre");
      genreDiv.innerHTML = genreIcons[story.genre.toLowerCase()] || ""; // Use English genre for icons

      // Detail container to wrap CEFR and genre divs
      const detailContainer = document.createElement("div");
      detailContainer.classList.add("stories-detail-container");
      detailContainer.appendChild(genreDiv); // Add genre to detail container
      detailContainer.appendChild(cefrDiv); // Add CEFR to detail container

      // Append title container and detail container to list item
      listItem.appendChild(titleContainer); // Titles on the left
      listItem.appendChild(detailContainer); // CEFR and Genre on the right

      // Add click event to navigate to the story
      listItem.addEventListener("click", () => showStory(story));

      // Append list item to the story list
      storyList.appendChild(listItem);
    });
  }

  // Helper function to determine CEFR class
  function getCefrClass(cefrLevel) {
    if (!cefrLevel) return "cefr-unknown"; // Fallback for missing CEFR levels
    const level = cefrLevel.toUpperCase();
    if (["A1", "A2"].includes(level)) return "easy";
    if (["B1", "B2"].includes(level)) return "medium";
    if (["C1", "C2"].includes(level)) return "hard";
    return "cefr-unknown"; // Default
  }

  // Check if an audio file exists
  async function checkAudio(titleEnglish) {
    const encodedTitleEnglish = encodeURIComponent(titleEnglish);
    const audioPath = `Audio/${encodedTitleEnglish}.m4a`;
    console.log(`Checking audio at path: ${audioPath}`);

    try {
      const response = await fetch(audioPath, {
        method: "HEAD",
        cache: "no-cache",
      });
      if (response.ok) {
        console.log(`Audio found for: ${audioPath}`);
        return audioPath;
      } else {
        console.warn(`No audio found for: ${audioPath}`);
        return null;
      }
    } catch (error) {
      console.error(`Error checking audio for ${audioPath}:`, error);
      return null;
    }
  }

  // Filter stories based on search and dropdowns
  function filterStories() {
    const searchText = searchBar.value.toLowerCase();
    const selectedGenre = genreFilter.value.toLowerCase().trim(); // Trim whitespace
    const selectedCefr = cefrFilter.value.toUpperCase().trim(); // Trim whitespace

    // Filter stories using all criteria
    const filteredStories = stories.filter((story) => {
      const matchesSearch =
        !searchText || // If search bar is empty, match everything
        story.titleJapanese.toLowerCase().includes(searchText) ||
        story.titleEnglish.toLowerCase().includes(searchText);

      const matchesGenre =
        !selectedGenre || // If no genre selected, match everything
        (story.genre && story.genre.toLowerCase().trim() === selectedGenre);

      const matchesCefr =
        !selectedCefr || // If no CEFR selected, match everything
        (story.CEFR && story.CEFR.trim().toUpperCase() === selectedCefr);

      return matchesSearch && matchesGenre && matchesCefr;
    });

    displayStories(filteredStories);
  }

  // Show the selected story
  async function showStory(story) {
    filterContainer.style.display = "none"; // Hide filters in the story viewer
    storyListSection.style.display = "none";
    storyViewer.style.display = "block";
    stickyHeader.classList.remove("hidden"); // Show sticky header
    storyContent.innerHTML = ""; // Clear previous content

    // Check for audio and add it to the storyContent
    const existingAudio = storyViewer.querySelector("audio");
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.currentTime = 0;
      existingAudio.remove();
    }

    const audioPath = await checkAudio(story.titleEnglish);
    if (audioPath) {
      const audioPlayer = document.createElement("audio");
      audioPlayer.controls = true;
      audioPlayer.src = audioPath;
      storyContent.appendChild(audioPlayer);
    }

    // Update the sticky header dynamically
    stickyHeader.innerHTML = `
    <button id="back-button" class="back-button">
      <i class="fas fa-chevron-left"></i> Back
    </button>
    <div class="sticky-title-container">
      <h2 class="sticky-title-japanese">${story.titleJapanese}</h2>
      <p class="sticky-title-english">${story.titleEnglish}</p>
    </div>
    <div class="sticky-detail-container">
      <div class="sticky-genre">
        ${genreIcons[story.genre.toLowerCase()] || ""}
      </div>
      <div class="sticky-cefr-label ${getCefrClass(story.CEFR)}">
        ${story.CEFR || "N/A"}
      </div>
    </div>
    <button id="toggle-english-btn" class="toggle-english-btn">
      ${isEnglishVisible ? "Hide English" : "Show English"}
    </button>
  `;

    // Updated regex for splitting sentences
    const sentenceEndings = /([。！？.!?]+)/g;

    const japaneseSentences = story.japanese
      .split(sentenceEndings)
      .reduce((acc, cur, i) => {
        if (i % 2 === 0) acc.push(cur);
        else acc[acc.length - 1] += cur;
        return acc;
      }, [])
      .filter((sentence) => sentence.trim());

    const englishSentences = story.english
      .split(sentenceEndings)
      .reduce((acc, cur, i) => {
        if (i % 2 === 0) acc.push(cur);
        else acc[acc.length - 1] += cur;
        return acc;
      }, [])
      .filter((sentence) => sentence.trim());

    japaneseSentences.forEach((japaneseSentence, index) => {
      const coupletContainer = document.createElement("div");

      const japaneseDiv = document.createElement("div");
      japaneseDiv.classList.add("japanese-sentence");
      japaneseDiv.textContent = japaneseSentence.trim();
      coupletContainer.appendChild(japaneseDiv);

      if (englishSentences[index]) {
        const englishDiv = document.createElement("div");
        englishDiv.classList.add("english-sentence");
        englishDiv.textContent = englishSentences[index].trim();
        coupletContainer.appendChild(englishDiv);
      }

      storyContent.appendChild(coupletContainer);
    });

    updateEnglishVisibility();

    // Reattach event listeners for back and toggle buttons
    document
      .getElementById("back-button")
      .addEventListener("click", backButtonHandler);
    document
      .getElementById("toggle-english-btn")
      .addEventListener("click", () => {
        isEnglishVisible = !isEnglishVisible;
        updateEnglishVisibility();
      });
  }

  // Back button handler
  function backButtonHandler() {
    filterContainer.style.display = "flex"; // Show filters when returning to the list page
    storyViewer.style.display = "none";
    storyListSection.style.display = "block";
    stickyHeader.classList.add("hidden"); // Hide sticky header

    // Stop any currently playing audio
    const existingAudio = storyViewer.querySelector("audio");
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.currentTime = 0; // Reset playback position
      existingAudio.remove(); // Remove the audio element
    }
  }

  // Event Listeners for Filters
  searchBar.addEventListener("input", filterStories);
  genreFilter.addEventListener("change", filterStories);
  cefrFilter.addEventListener("change", filterStories);

  // Initialize the app
  loadCSV("japaneseStories.csv", displayStories);
});
