// About — a short, static page describing the site: what it does and where
// to leave feedback. No vocabulary data, no personal state — renders
// immediately regardless of dictionary-load state, unlike My Stats/Word
// List. Reuses the same "personal page" component classes as Settings
// (see settings.js's own comment on this) purely for visual consistency
// between the account menu's destinations. Ported from scripts.js's inline
// renderAboutPage(), which is now removed in favor of this file, to match
// the myStats.js/settings.js convention of a dedicated file + init*() hook
// that scripts.js's mode switch calls into.
(function () {
  "use strict";

  function getResultsContainer() {
    return document.getElementById("results-container");
  }

  function createHeaderCard() {
    const card = document.createElement("section");
    card.className = "my-stats-header";
    card.innerHTML = `
      <h2 class="my-stats-heading">About</h2>
      <p class="my-stats-subheading">What Japanese Dictionary is, and where to send feedback.</p>
    `;
    return card;
  }

  function createAboutCard() {
    const card = document.createElement("section");
    card.className = "my-stats-box";
    card.innerHTML = `
      <p class="my-stats-danger-text">
        Japanese Dictionary is a free, browser-based tool for learning
        Japanese — word and sentence search with audio, short stories at
        every CEFR level, and a Word Game that adapts to your level as you
        practice.
      </p>
      <p class="my-stats-danger-text">
        Found a word that's missing? A word search with no exact match
        offers a "Flag Missing Word Entry" button. For anything else, use
        the Get in Touch section below.
      </p>
    `;
    return card;
  }

  function createConnectCard() {
    const card = document.createElement("section");
    card.className = "my-stats-box";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Get in Touch";
    card.appendChild(heading);

    const description = document.createElement("p");
    description.className = "my-stats-danger-text";
    description.textContent =
      "Found a bug, or have an idea for something to add?";
    card.appendChild(description);

    const actionRow = document.createElement("div");
    actionRow.className = "my-stats-danger-action";

    const feedbackBtn = document.createElement("button");
    feedbackBtn.type = "button";
    feedbackBtn.className = "my-stats-danger-btn";
    feedbackBtn.textContent = "Send Feedback";
    feedbackBtn.addEventListener("click", () => {
      window.openGeneralFeedbackDialog?.(feedbackBtn);
    });

    actionRow.appendChild(feedbackBtn);
    card.appendChild(actionRow);

    return card;
  }

  function createDataSourcesCard() {
    const card = document.createElement("section");
    card.className = "my-stats-box";
    card.innerHTML = `
      <h3 class="my-stats-section-heading">Data sources and acknowledgements</h3>
      <p class="my-stats-danger-text">
        Frequency-aware sorting and practice use the
        <a href="https://clrd.ninjal.ac.jp/bccwj/en/freq-list.html" target="_blank" rel="noopener noreferrer">Balanced Corpus of Contemporary Written Japanese word list</a>,
        maintained by the National Institute for Japanese Language and Linguistics.
      </p>
      <p class="my-stats-danger-text">
        Word definitions come from the
        <a href="https://bond-lab.github.io/wnja/" target="_blank" rel="noopener noreferrer">Japanese WordNet</a>
        (NICT, Francis Bond, and Takayuki Kuribayashi) and
        <a href="https://ja.wiktionary.org/" target="_blank" rel="noopener noreferrer">Japanese Wiktionary</a>;
        English glosses come from
        <a href="https://www.edrdg.org/jmdict/j_jmdict.html" target="_blank" rel="noopener noreferrer">JMdict</a>,
        property of the Electronic Dictionary Research and Development Group.
      </p>
      <p class="my-stats-danger-text">
        Stories adapted from third-party work retain their source, author, and licence credit on the individual story.
      </p>
    `;
    return card;
  }

  function renderAbout() {
    const container = getResultsContainer();
    if (!container) return;

    const section = document.createElement("section");
    section.id = "about";
    section.className = "definition account-page";
    section.append(
      createHeaderCard(),
      createAboutCard(),
      createDataSourcesCard(),
      createConnectCard(),
    );

    container.appendChild(section);
  }

  function initAbout() {
    if (getCurrentMode() !== "about") {
      return;
    }

    showLandingCard(false);
    clearContainer();
    renderAbout();
  }

  window.initAbout = initAbout;
})();
