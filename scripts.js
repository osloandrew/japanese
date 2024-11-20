document.addEventListener("DOMContentLoaded", () => {
  const storyList = document.getElementById("stories");
  const storyViewer = document.getElementById("story-viewer");
  const storyContent = document.getElementById("story-content");
  const backButton = document.getElementById("back-button");
  const storyListSection = document.getElementById("story-list");
  const filterContainer = document.getElementById("filter-container"); // Filters wrapper
  const searchBar = document.getElementById("search-bar");
  const genreFilter = document.getElementById("genre-filter");
  const cefrFilter = document.getElementById("cefr-filter");
  let stories = []; // Global array to store all stories

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
        stories = parsedStories; // Populate the global stories array
        callback(stories); // Display all stories initially
      })
      .catch((err) => console.error("Error loading CSV:", err));
  }

  // Display the list of stories
  function displayStories(stories) {
    filterContainer.style.display = "flex"; // Show filters on the list page
    storyList.innerHTML = ""; // Clear previous stories
    stories.forEach((story) => {
      const listItem = document.createElement("li");

      // Title container
      const titleDiv = document.createElement("div");
      titleDiv.innerHTML = `<strong>${story.titleJapanese}</strong><br>${story.titleEnglish}`;
      titleDiv.style.flex = "1"; // Allow the title to take most of the space

      // CEFR container
      const cefrDiv = document.createElement("div");
      cefrDiv.classList.add("cefr-value");
      cefrDiv.textContent = story.CEFR || "N/A"; // Display CEFR or "N/A"

      // Append title and CEFR to list item
      listItem.appendChild(titleDiv);
      listItem.appendChild(cefrDiv);

      // Add click event to navigate to the story
      listItem.addEventListener("click", () => showStory(story));

      // Append list item to the story list
      storyList.appendChild(listItem);
    });
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
    storyContent.innerHTML = "";

    // Check if there's existing audio and stop it by finding it in the DOM
    const existingAudio = storyViewer.querySelector("audio");
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.currentTime = 0; // Reset playback position
      existingAudio.remove(); // Remove the audio element
    }

    const audioPath = await checkAudio(story.titleEnglish);
    if (audioPath) {
      const audioPlayer = document.createElement("audio");
      audioPlayer.controls = true;
      audioPlayer.src = audioPath;
      storyContent.appendChild(audioPlayer); // Append it to the story viewer
    }

    const japaneseSentences = story.japanese
      .split("。")
      .filter((sentence) => sentence.trim());
    const englishSentences = story.english
      .split(".")
      .filter((sentence) => sentence.trim());

    japaneseSentences.forEach((japaneseSentence, index) => {
      const coupletContainer = document.createElement("div"); // Wrapper for the couplet

      const japaneseDiv = document.createElement("div");
      japaneseDiv.textContent = japaneseSentence.trim() + "。";

      coupletContainer.appendChild(japaneseDiv);

      if (englishSentences[index]) {
        const englishDiv = document.createElement("div");
        englishDiv.textContent = englishSentences[index].trim() + ".";
        coupletContainer.appendChild(englishDiv);
      }

      storyContent.appendChild(coupletContainer);
    });
  }

  // Back button functionality
  backButton.addEventListener("click", () => {
    filterContainer.style.display = "flex"; // Show filters when returning to the list page
    storyViewer.style.display = "none";
    storyListSection.style.display = "block";

    // Stop any currently playing audio by querying it directly
    const existingAudio = storyViewer.querySelector("audio");
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.currentTime = 0; // Reset playback position
      existingAudio.remove(); // Remove the audio element
    }
  });

  // Event Listeners for Filters
  searchBar.addEventListener("input", filterStories);
  genreFilter.addEventListener("change", filterStories);
  cefrFilter.addEventListener("change", filterStories);

  // Initialize the app
  loadCSV("japaneseStories.csv", displayStories);
});
