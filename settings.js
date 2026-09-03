// Settings — account-level actions that aren't part of any one page's own
// flow. Currently just the destructive progress reset that used to live at
// the bottom of My Stats (myStats.js) — moved here now that Settings exists
// as a real destination, since "delete everything" reads as a settings
// action, not a stat. Reuses My Stats' shared "personal page" component
// classes (.my-stats-box, .my-stats-section-heading, .my-stats-danger-*,
// etc. — see styles/10-shell-landing-and-stats.css) rather than duplicating
// that CSS under a new name: the wrapper below opts in via .account-page
// alongside #settings, the same way #my-stats already tags the original.
(function () {
  "use strict";

  function getResultsContainer() {
    return document.getElementById("results-container");
  }

  function createHeaderCard() {
    const card = document.createElement("section");
    card.className = "my-stats-header";
    card.innerHTML = `
      <h2 class="my-stats-heading">Settings</h2>
      <p class="my-stats-subheading">Manage your account and practice data.</p>
    `;
    return card;
  }

  // Moved verbatim from myStats.js's createDangerZoneCard — same behavior,
  // same confirmation copy, same ProgressResetAPI call.
  function createDangerZoneCard() {
    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-danger";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Danger Zone";
    card.appendChild(heading);

    const description = document.createElement("p");
    description.className = "my-stats-danger-text";
    description.textContent =
      "Permanently delete your saved words, practice history, and streak — including from your account if you're signed in. This can't be undone.";
    card.appendChild(description);

    const actionRow = document.createElement("div");
    actionRow.className = "my-stats-danger-action";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "my-stats-danger-btn";
    resetBtn.textContent = "Reset My Progress";
    resetBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Reset all your Word Game progress? This deletes your saved words, " +
          "practice history, and streak everywhere you're signed in. " +
          "This can't be undone.",
      );
      if (!confirmed) return;

      window.trackEvent?.("reset_progress");
      resetBtn.disabled = true;
      resetBtn.textContent = "Resetting…";

      try {
        await window.ProgressResetAPI?.resetAllProgress?.();
      } catch (error) {
        console.warn("Progress reset failed.", error);
        window.alert(
          "Your progress could not be reset. Please check your connection and try again.",
        );
        resetBtn.disabled = false;
        resetBtn.textContent = "Reset My Progress";
      }
    });

    actionRow.appendChild(resetBtn);
    card.appendChild(actionRow);

    return card;
  }

  function renderSettings() {
    const container = getResultsContainer();
    if (!container) return;

    const section = document.createElement("section");
    section.id = "settings";
    section.className = "definition account-page";
    section.append(createHeaderCard(), createDangerZoneCard());

    container.appendChild(section);
  }

  function initSettings() {
    if (getCurrentMode() !== "settings") {
      return;
    }

    // Unlike My Stats/Word List, nothing here reads from the dictionary —
    // renders immediately regardless of CSV load state.
    showLandingCard(false);
    clearContainer();
    renderSettings();
  }

  window.initSettings = initSettings;
})();
