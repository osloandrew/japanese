(function () {
  "use strict";

  // Seeds a starting ability estimate from a plain-language self-rating —
  // no CEFR jargon shown to the learner — then immediately starts a real
  // ten-word practice round. The first seven distinct answers in that round
  // calibrate more quickly before the ordinary continuous ability updates
  // take over (see updateAbilityScore in wordGame.js). This avoids making a
  // new learner complete a disposable quiz before receiving useful feedback,
  // audio, example sentences, review retries, and round progress.
  const SELF_ASSESSMENT_OPTIONS = [
    { label: "I don't know any Japanese yet", anchor: 60, beginnerFocus: 1 },
    { label: "I know a handful of words and phrases", anchor: 220, beginnerFocus: 0.72 },
    { label: "I can have simple everyday conversations", anchor: 420, beginnerFocus: 0.48 },
    { label: "I can discuss familiar topics in some detail", anchor: 600, beginnerFocus: 0.18 },
    { label: "I can follow most conversations and read comfortably", anchor: 780, beginnerFocus: 0.04 },
    { label: "I'm effectively fluent", anchor: 920, beginnerFocus: 0 },
  ];

  function getResultsContainer() {
    return document.getElementById("results-container");
  }

  function renderSelfAssessment() {
    const container = getResultsContainer();
    if (!container) return;

    container.innerHTML = `
      <div class="game-intro-card placement-card">
        <h2 class="game-intro-heading">How Much Japanese Do You Know?</h2>
        <p class="game-intro-subheading">Choose a starting point, then begin a 10-word practice round. We’ll fine-tune it from recognition, listening, and recall.</p>
        <div class="placement-option-list">
          ${SELF_ASSESSMENT_OPTIONS.map(
            (option, index) => `
            <button type="button" class="placement-option-btn" data-index="${index}">
              ${escapeGameHTML(option.label)}
            </button>
          `,
          ).join("")}
        </div>
        <button type="button" class="placement-retake-link placement-skip-btn">
          Skip Placement and Start at Beginner
        </button>
      </div>
    `;

    container.querySelectorAll(".placement-option-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const option = SELF_ASSESSMENT_OPTIONS[Number(button.dataset.index)];
        startPracticeRound(option.anchor, true, option.beginnerFocus);
      });
    });

    container
      .querySelector(".placement-skip-btn")
      ?.addEventListener("click", () => {
        startPracticeRound(
          SELF_ASSESSMENT_OPTIONS[0].anchor,
          false,
          SELF_ASSESSMENT_OPTIONS[0].beginnerFocus,
        );
      });
  }

  function startPracticeRound(initialEstimate, calibrate, beginnerFocus) {
    window.WordGameHelpers?.startPlacementRound?.(initialEstimate, {
      calibrate,
      beginnerFocus,
    });
  }

  window.PlacementTestAPI = Object.freeze({
    start: renderSelfAssessment,
  });
})();
