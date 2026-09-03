// Comprehension-check quiz shown at the end of a story. Question content is
// generated offline (see storyQuestions.json) rather than hand-authored, so
// this module is purely a renderer/grader: it looks up a story's questions
// by titleJapanese and has no opinion about how those questions were made.
(function () {
  "use strict";

  const DATA_URL = "storyQuestions.json";
  const QUIZ_RESULTS_STORAGE_KEY = "japanese-dictionary-quiz-results-v1";

  let dataPromise = null;

  function loadStoryQuestions() {
    if (!dataPromise) {
      // Anchored to APP_ROOT_URL (scripts.js) — see the identical fix on
      // inflections.js's loadSnapshot for why a bare relative path here
      // breaks after in-app navigation.
      // Revalidate the separately-deployed data file on each fresh page load.
      // Its contents can change without storyQuiz.js changing, so a fixed
      // query-string version would otherwise allow returning visitors to keep
      // an obsolete question set after an incremental deployment.
      dataPromise = fetch(new URL(DATA_URL, APP_ROOT_URL), { cache: "no-cache" })
        .then((response) => (response.ok ? response.json() : {}))
        .catch((error) => {
          console.warn("Story questions could not be loaded.", error);
          return {};
        });
    }
    return dataPromise;
  }

  function loadQuizResults() {
    try {
      const stored = window.localStorage.getItem(QUIZ_RESULTS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.warn("Quiz results could not be loaded.", error);
      return {};
    }
  }

  function saveQuizResult(titleJapanese, score, total) {
    try {
      const results = loadQuizResults();
      results[titleJapanese] = { score, total, completedAt: Date.now() };
      window.localStorage.setItem(
        QUIZ_RESULTS_STORAGE_KEY,
        JSON.stringify(results),
      );
    } catch (error) {
      console.warn("Quiz result could not be saved.", error);
    }
  }

  // Generation tends to place the correct answer first far more often than
  // chance (observed ~80% at index 0 across the generated question set), so
  // the stored correctIndex can't be trusted as a display order — shuffle
  // fresh on every render instead, including retries.
  function shuffleOptions(question) {
    const paired = question.options.map((text, i) => ({
      text,
      isCorrect: i === question.correctIndex,
    }));
    for (let i = paired.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [paired[i], paired[j]] = [paired[j], paired[i]];
    }
    return {
      options: paired.map((p) => p.text),
      correctIndex: paired.findIndex((p) => p.isCorrect),
    };
  }

  // Renders one question at a time into `root`, tracking score as the
  // learner progresses. `questions` is the array for a single story.
  function renderQuizFlow(root, titleJapanese, questions) {
    let index = 0;
    let score = 0;
    let answers = [];
    let shuffled = null;

    function renderQuestion({ focusPrompt = false } = {}) {
      const question = questions[index];
      shuffled = shuffleOptions(question);
      root.innerHTML = `
        <div class="story-quiz-progress">Question ${index + 1} of ${questions.length}</div>
        <div class="story-quiz-prompt">${escapeHTML(question.prompt)}</div>
        <div class="story-quiz-options"></div>
        <div class="story-quiz-feedback" hidden></div>
      `;

      const optionsEl = root.querySelector(".story-quiz-options");
      shuffled.options.forEach((option, optionIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "story-quiz-option-btn";
        button.textContent = option;
        button.addEventListener("click", () =>
          handleAnswer(optionIndex, button, optionsEl),
        );
        optionsEl.appendChild(button);
      });

      if (focusPrompt) {
        const prompt = root.querySelector(".story-quiz-prompt");
        if (prompt) {
          prompt.setAttribute("tabindex", "-1");
          prompt.focus({ preventScroll: true });
          prompt.addEventListener(
            "blur",
            () => prompt.removeAttribute("tabindex"),
            { once: true },
          );
        }
      }
    }

    function handleAnswer(chosenIndex, chosenButton, optionsEl) {
      const question = questions[index];
      const isCorrect = chosenIndex === shuffled.correctIndex;
      // Reuses the word game's shared chime kit (wordGame.js, loaded earlier
      // as a plain script so its top-level bindings are visible here) so
      // in-story feedback matches the rest of the app's answer sounds.
      playChime(isCorrect ? goodChime : badChime, CHIME_PRIORITY.answer);
      if (isCorrect) score += 1;
      answers.push({
        prompt: question.prompt,
        chosenOption: shuffled.options[chosenIndex],
        correctOption: shuffled.options[shuffled.correctIndex],
        isCorrect,
      });

      optionsEl.querySelectorAll(".story-quiz-option-btn").forEach((btn, i) => {
        btn.disabled = true;
        if (i === shuffled.correctIndex) {
          btn.classList.add("story-quiz-correct");
          btn.insertAdjacentHTML(
            "beforeend",
            '<i class="fas fa-check story-quiz-icon story-quiz-icon-correct" aria-hidden="true"></i>',
          );
        } else if (btn === chosenButton) {
          btn.classList.add("story-quiz-incorrect");
          btn.insertAdjacentHTML(
            "beforeend",
            '<i class="fas fa-times story-quiz-icon story-quiz-icon-incorrect" aria-hidden="true"></i>',
          );
        }
      });

      const feedbackEl = root.querySelector(".story-quiz-feedback");
      feedbackEl.hidden = false;
      feedbackEl.innerHTML = `
        <p class="story-quiz-feedback-label">
          <i class="fas ${isCorrect ? "fa-check story-quiz-icon-correct" : "fa-times story-quiz-icon-incorrect"} story-quiz-icon" aria-hidden="true"></i>
          ${isCorrect ? "Correct" : "Not Quite"}
        </p>
        <p class="story-quiz-feedback-source" lang="ja">${escapeHTML(question.sourceSentence)}</p>
        <button type="button" class="story-quiz-next-btn">
          ${index + 1 < questions.length ? "Next Question" : "See Results"}
        </button>
      `;
      feedbackEl
        .querySelector(".story-quiz-next-btn")
        .addEventListener("click", () => {
          index += 1;
          if (index < questions.length) {
            renderQuestion({ focusPrompt: true });
          } else {
            renderResults();
          }
        });
    }

    function renderResults() {
      playChime(roundCompleteChime, CHIME_PRIORITY.roundComplete);
      saveQuizResult(titleJapanese, score, questions.length);
      window.trackEvent?.("story_quiz_complete", {
        score,
        total: questions.length,
      });

      const reviewHTML = answers
        .map(
          (answer, i) => `
        <div class="story-quiz-review-item">
          <p class="story-quiz-review-prompt">${i + 1}. ${escapeHTML(answer.prompt)}</p>
          <p class="story-quiz-review-answer">
            <i class="fas ${answer.isCorrect ? "fa-check story-quiz-icon-correct" : "fa-times story-quiz-icon-incorrect"} story-quiz-icon" aria-hidden="true"></i>
            Your Answer: ${escapeHTML(answer.chosenOption)}
          </p>
          ${
            answer.isCorrect
              ? ""
              : `<p class="story-quiz-review-correct-answer">
                  <i class="fas fa-check story-quiz-icon-correct story-quiz-icon" aria-hidden="true"></i>
                  Correct Answer: ${escapeHTML(answer.correctOption)}
                </p>`
          }
        </div>
      `,
        )
        .join("");

      root.innerHTML = `
        <div class="story-quiz-results">
          <p class="story-quiz-results-score">${score} / ${questions.length} correct</p>
          <div class="story-quiz-review">${reviewHTML}</div>
          <button type="button" class="story-quiz-retry-btn">Try Again</button>
        </div>
      `;
      root
        .querySelector(".story-quiz-retry-btn")
        .addEventListener("click", () => {
          index = 0;
          score = 0;
          answers = [];
          renderQuestion({ focusPrompt: true });
        });
    }

    renderQuestion();
  }

  // Appends a comprehension-check section to `storyContent` for `story`, if
  // questions exist for it. Called once per story render, after the couplets
  // are already in the DOM.
  async function renderStoryComprehensionQuiz(storyContent, story) {
    if (!storyContent || !story) return;

    // Static capture waits for this explicit state instead of guessing how
    // long the JSON fetch will take. Set it before the first await so a second
    // story render cannot accidentally observe the previous story's state.
    storyContent.dataset.storyQuizState = "loading";

    const data = await loadStoryQuestions();
    const entry = data[story.titleJapanese];
    if (!entry || !Array.isArray(entry.questions) || !entry.questions.length) {
      storyContent.dataset.storyQuizState = "empty";
      return;
    }

    const section = document.createElement("div");
    section.className = "story-quiz-section";
    section.innerHTML = `
      <h2 class="story-quiz-heading">Comprehension Check</h2>
      <div class="story-quiz-body"></div>
    `;
    storyContent.appendChild(section);

    renderQuizFlow(
      section.querySelector(".story-quiz-body"),
      story.titleJapanese,
      entry.questions,
    );
    storyContent.dataset.storyQuizState = "ready";
  }

  window.renderStoryComprehensionQuiz = renderStoryComprehensionQuiz;
})();
