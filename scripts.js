document.addEventListener("DOMContentLoaded", () => {
  const storyList = document.getElementById("stories");
  const storyViewer = document.getElementById("story-viewer");
  const storyContent = document.getElementById("story-content");
  const backButton = document.getElementById("back-button");
  const storyListSection = document.getElementById("story-list");

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
        const stories = parseCSV(data);
        callback(stories);
      })
      .catch((err) => console.error("Error loading CSV:", err));
  }

  // Display the list of stories
  function displayStories(stories) {
    storyList.innerHTML = "";
    stories.forEach((story) => {
      const listItem = document.createElement("li");
      listItem.innerHTML = `<strong>${story.titleJapanese}</strong><br>${story.titleEnglish}`;
      listItem.addEventListener("click", () => showStory(story));
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

  // Show the selected story
  async function showStory(story) {
    storyListSection.style.display = "none";
    storyViewer.style.display = "block";
    storyContent.innerHTML = "";

    const audioPath = await checkAudio(story.titleEnglish);
    if (audioPath) {
      const audioPlayer = document.createElement("audio");
      audioPlayer.controls = true;
      audioPlayer.src = audioPath;
      storyContent.appendChild(audioPlayer);
    }

    const japaneseSentences = story.japanese
      .split("。")
      .filter((sentence) => sentence.trim());
    const englishSentences = story.english
      .split(".")
      .filter((sentence) => sentence.trim());

    japaneseSentences.forEach((japaneseSentence, index) => {
      const japaneseDiv = document.createElement("div");
      japaneseDiv.textContent = japaneseSentence.trim() + "。";
      storyContent.appendChild(japaneseDiv);
      // Add corresponding English sentence if it exists
      if (englishSentences[index]) {
        const englishDiv = document.createElement("div");
        englishDiv.textContent = englishSentences[index].trim() + ".";
        storyContent.appendChild(englishDiv);
      }
    });
  }

  // Back button functionality
  backButton.addEventListener("click", () => {
    storyViewer.style.display = "none";
    storyListSection.style.display = "block";
  });

  // Initialize the app
  loadCSV("japaneseStories.csv", displayStories);
});
