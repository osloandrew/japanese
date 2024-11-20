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
  function checkAudio(titleEnglish) {
    return new Promise((resolve) => {
      const audioPath = `Audio/${titleEnglish}.m4a`;
      const audio = new Audio(audioPath);

      console.log(`Checking audio at path: ${audioPath}`); // Log the path being checked

      // Try to load the audio file
      audio.oncanplaythrough = () => {
        console.log(`Audio found for: ${titleEnglish}`); // Log if audio is found
        resolve(audio);
      };
      audio.onerror = () => {
        console.warn(`Audio not found for: ${titleEnglish}`); // Log if audio is missing
        resolve(null);
      };
    });
  }

  // Show the selected story
  async function showStory(story) {
    storyListSection.style.display = "none";
    storyViewer.style.display = "block";
    storyContent.innerHTML = "";

    // Check for audio and display a play button if audio exists
    const audio = await checkAudio(story.titleEnglish);
    if (audio) {
      const audioButton = document.createElement("button");
      audioButton.textContent = "Play Audio";
      audioButton.style.marginBottom = "1em"; // Adjust margin for spacing below the button
      audioButton.addEventListener("click", () => {
        audio.play();
      });
      storyContent.appendChild(audioButton); // Append the button at the top
    }

    const japaneseSentences = story.japanese
      .split("。")
      .filter((sentence) => sentence.trim());
    const englishSentences = story.english
      .split(".")
      .filter((sentence) => sentence.trim());

    // Add sentences to the story content
    japaneseSentences.forEach((japaneseSentence, index) => {
      if (japaneseSentence.trim()) {
        // Add Japanese sentence
        const japaneseDiv = document.createElement("div");
        japaneseDiv.textContent = japaneseSentence.trim() + "。";
        storyContent.appendChild(japaneseDiv);

        // Add corresponding English sentence if it exists
        if (englishSentences[index]) {
          const englishDiv = document.createElement("div");
          englishDiv.textContent = englishSentences[index].trim() + ".";
          storyContent.appendChild(englishDiv);
        }
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
