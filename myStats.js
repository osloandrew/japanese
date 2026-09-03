// "My Stats" — a personal report, not a browsable list, which is why it's
// its own top-level type (alongside Word Game / Word List) rather than a
// tab bolted onto Word List's All Words/My Words switcher: those two share
// one table renderer for a filtered slice of the dictionary, while this
// page is a single summary card, a fundamentally different shape.
//
// Rendered as one .definition "paper" (the same card chrome the landing
// page's own #landing-card uses) containing a plain-text header plus one
// light-blue .my-stats-box per section — mirroring the landing page's
// .landing-daily-quests / .landing-progress-summary boxes exactly, rather
// than stacking separate white cards. Every text element explicitly sets
// "Source Sans 3" (see the comment above .my-stats in the shell/landing/stats
// stylesheet for why that has to be explicit, not inherited).
//
// Every number here already exists somewhere in WordStrengthAPI or
// StreakAPI — this file is pure aggregation/rendering, no new tracking.
// The vocabulary breakdown reuses wordGame.js's buildVocabProgressBarMarkup
// so it can never drift from the landing page's compact "Vocabulary
// profile" widget, which this page is the detail view for (see its
// "See full stats" button).
(function () {
  "use strict";

  const MAX_TROUBLE_WORDS_SHOWN = 20;

  function getStatsCefrBadgeClass(cefrLevel) {
    const normalizedLevel = String(cefrLevel || "").toUpperCase();
    if (normalizedLevel === "C") return "c1";
    return ["A1", "A2", "B1", "B2", "C1", "C2"].includes(normalizedLevel)
      ? normalizedLevel.toLowerCase()
      : "cefr-unknown";
  }

  function getResultsContainer() {
    return document.getElementById("results-container");
  }

  // Records are now multi-skill memories (see spacedRepetition.js's
  // normalizeMemory: { skills: { recognition, production, listening,
  // context }, updatedAt }) rather than a single scheduled record, so
  // there's no top-level dueAt to compare directly. Reuse
  // SpacedRepetition.getSnapshot the same way wordGame.js's
  // getVocabProgressSummary does — its aggregate `isDue` is already true
  // when any practiced skill is due — evaluated once at `now` and once at
  // the horizon so "due this week" excludes words already due now.
  function getUpcomingDueCount(days, now = Date.now()) {
    const dayMs = window.SpacedRepetition?.DAY_MS ?? 24 * 60 * 60 * 1000;
    const horizon = now + days * dayMs;
    const records = Object.values(window.WordStrengthAPI?.getAll?.() ?? {});
    const isDueBy = (record, timestamp) =>
      Boolean(window.SpacedRepetition?.getSnapshot?.(record, timestamp)?.isDue);

    return records.filter(
      (record) => !isDueBy(record, now) && isDueBy(record, horizon),
    ).length;
  }

  // A memory's lapses are tracked per skill (see spacedRepetition.js's
  // scheduleIncorrect), so a word's total is the sum across whichever
  // skills it's been practiced in.
  function getTotalLapses(record) {
    return Object.values(record?.skills ?? {}).reduce(
      (sum, skillRecord) => sum + (skillRecord?.lapses ?? 0),
      0,
    );
  }

  // Every word ever missed at least once, ranked by how many times.
  function getTroubleEntries(limit = MAX_TROUBLE_WORDS_SHOWN) {
    const allRecords = window.WordStrengthAPI?.getAll?.() ?? {};

    return Object.entries(allRecords)
      .map(([entryId, record]) => [entryId, getTotalLapses(record)])
      .filter(([, lapses]) => lapses > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([entryId]) => window.WordListAPI?.getEntryById?.(entryId))
      .filter(Boolean);
  }

  function createStatTile(value, label) {
    const tile = document.createElement("div");
    tile.className = "game-summary-stat";

    const valueEl = document.createElement("p");
    valueEl.className = "game-summary-stat-value";
    valueEl.textContent = value;

    const labelEl = document.createElement("p");
    labelEl.className = "game-summary-stat-label";
    labelEl.textContent = label;

    tile.append(valueEl, labelEl);
    return tile;
  }

  function createHeaderCard() {
    const card = document.createElement("section");
    card.className = "my-stats-header";
    card.innerHTML = `
      <h2 class="my-stats-heading">My Stats</h2>
      <p class="my-stats-subheading">A closer look at your vocabulary and practice history.</p>
      <a class="my-stats-see-all-link my-stats-manage-account-link" href="?type=settings">Manage Account</a>
    `;
    // Same manual-intercept pattern as the "See All Words" link below
    // (createVocabularyCard) — this markup is created after
    // initializeNavigation()'s one-time pass already ran, so it needs its
    // own click handler rather than relying on that pass to find it.
    card
      .querySelector(".my-stats-manage-account-link")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        selectType("settings");
      });
    return card;
  }

  function createOverviewCard() {
    const streak = window.StreakAPI?.getState?.() ?? {
      count: 0,
      longestCount: 0,
    };
    const bestWordStreak = window.BestWordStreakAPI?.getState?.() ?? 0;
    const dueNow = window.WordGameHelpers?.getVocabProgressSummary?.().dueCount ?? 0;
    const dueThisWeek = getUpcomingDueCount(7);
    const lifetime = window.WordGameHelpers?.getLifetimeTotalsSummary?.() ?? {
      questionsAnswered: 0,
      accuracyPercent: 0,
    };

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-overview";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Overview";
    card.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "game-summary-stats my-stats-overview-grid";
    grid.append(
      createStatTile(streak.count, "Day Streak"),
      createStatTile(streak.longestCount, "Longest Streak"),
      createStatTile(bestWordStreak, "Best Word Streak"),
      createStatTile(dueNow, "Due Now"),
      createStatTile(dueThisWeek, "Due This Week"),
      createStatTile(lifetime.questionsAnswered.toLocaleString("en-US"), "Questions Answered"),
      createStatTile(`${lifetime.accuracyPercent}%`, "Lifetime Accuracy"),
    );
    card.appendChild(grid);

    const actionRow = document.createElement("div");
    actionRow.className = "my-stats-overview-action";

    const practiceBtn = document.createElement("button");
    practiceBtn.type = "button";
    practiceBtn.className = "game-summary-primary-btn";
    practiceBtn.textContent =
      dueNow > 0 ? "Practice Due Words" : "Practice Now";
    practiceBtn.addEventListener("click", () => {
      selectType("word-game");
    });
    actionRow.appendChild(practiceBtn);
    card.appendChild(actionRow);

    return card;
  }

  // A small vertical bar per CEFR band (percent known as height), colored
  // with the same --color-cefr-* tokens used throughout the app. A
  // percentage on every bar plus a hover title spell out what's being
  // measured — no caption sentence needed alongside it (see
  // createProficiencyCard's short "Accuracy by Level" label instead).
  function createCefrMasteryBar(bands) {
    const barLabel = bands
      .map(
        (band) =>
          `${band.level}: ${Math.round(band.ratio * 100)}% known, ${band.known} of ${band.attempted} words`,
      )
      .join(", ");

    const bar = document.createElement("div");
    bar.className = "my-stats-cefr-bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `Mastery by level: ${barLabel}`);
    bar.innerHTML = bands
      .map((band) => {
        const fillPercent = Math.round(band.ratio * 100);
        const badgeClass = getStatsCefrBadgeClass(band.level);
        const title = `${band.label} (${band.level}): ${fillPercent}% known — ${band.known} of ${band.attempted} words practiced at this level`;
        return `
          <div class="my-stats-cefr-segment" title="${title}">
            <span class="my-stats-cefr-segment-percent">${fillPercent}%</span>
            <div class="my-stats-cefr-segment-track">
              <span class="my-stats-cefr-segment-fill my-stats-cefr-segment-fill--${badgeClass}" style="height: ${fillPercent}%;"></span>
            </div>
            <span class="my-stats-cefr-segment-label">${band.level}</span>
          </div>
        `;
      })
      .join("");

    return bar;
  }

  // KPIs first, prose last: the two numbers (words known, estimated level)
  // are what a learner scans for, so they get the same bolded stat-tile
  // treatment as the Overview card right above — not a sentence competing
  // for attention with the data. Deliberately not the raw abilityScore
  // (wordGame.js's Elo-style adaptive difficulty rating) — that's kept
  // invisible on purpose (see its own comment in wordGame.js, next to
  // CEFR_DIFFICULTY_ANCHOR) because it's a noisy per-answer estimate that
  // can dip on a single bad round, and a level that visibly falls is
  // demotivating. getVocabularyByCefrSummary instead derives a level purely
  // from durable, already-stored per-word CEFR tags and accuracy, so it
  // only moves when real words actually graduate or decay.
  function createProficiencyCard() {
    const summary = window.WordGameHelpers?.getVocabularyByCefrSummary?.() ?? {
      bands: [],
      estimatedLevel: null,
      nextLevel: null,
    };
    // Single source of truth for "known" — see getVocabularyByCefrSummary's
    // CEFR_WORD_KNOWN_* comment (wordGame.js) for why this is an
    // accuracy-based count, not the Vocabulary Profile tier bar's
    // spaced-repetition "Strong"/"Mastered" tiers further down this page.
    // The two can legitimately disagree: this answers "do I get this word
    // right," that answers "has this word survived a long gap without
    // review."
    const wordsKnown = summary.bands.reduce((sum, band) => sum + band.known, 0);

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-proficiency";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Proficiency";
    card.appendChild(heading);

    if (wordsKnown === 0) {
      const empty = document.createElement("p");
      empty.className = "my-stats-empty";
      empty.textContent =
        "Keep practicing — your proficiency estimate will appear here once you've built up some well-known words.";
      card.appendChild(empty);
      return card;
    }

    const kpiRow = document.createElement("div");
    kpiRow.className = "game-summary-stats my-stats-proficiency-grid";

    const levelTile = createStatTile(
      summary.estimatedLevel ? summary.estimatedLevel.level : "—",
      "Estimated Level",
    );
    if (!summary.estimatedLevel && summary.nextLevel) {
      const note = document.createElement("p");
      note.className = "my-stats-proficiency-level-note";
      note.textContent = `→ ${summary.nextLevel.level} in progress`;
      levelTile.appendChild(note);
    }

    kpiRow.append(
      createStatTile(wordsKnown.toLocaleString("en-US"), "Words You Know"),
      levelTile,
    );
    card.appendChild(kpiRow);

    if (summary.bands.length > 0) {
      const chartLabel = document.createElement("p");
      chartLabel.className = "my-stats-cefr-bar-caption";
      chartLabel.textContent = "Accuracy by Level";
      card.appendChild(chartLabel);
      card.appendChild(createCefrMasteryBar(summary.bands));
    }

    return card;
  }

  function getHeatmapIntensityLevel(count, maxCount) {
    if (count === 0 || maxCount <= 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  // Monday=0 .. Sunday=6, matching the grid's row order below (weeks start
  // on Monday).
  const HEATMAP_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const HEATMAP_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short" });
  // A month label needs at least this many columns to itself, or it visibly
  // runs into its neighbor's — three-letter text overflowing an 11px column
  // needs more room than one week provides. Below this, the column(s) keep
  // their data but lose the label; see the comment where this is used.
  const HEATMAP_MIN_MONTH_LABEL_COLUMNS = 2;

  // GitHub-contribution-style calendar: 53 Monday-start weekly columns of
  // how many questions were answered each day, read from
  // WordGameHelpers.getPracticeActivityLog (a local-only, capped date->count
  // log — see wordGame.js's recordPracticeActivityForToday). Sparse/empty
  // for existing users right after this ships; it only starts collecting
  // from today onward. A bare grid of squares turned out to be unreadable
  // without a sense of scale, so this also draws month labels above the
  // columns and Mon/Wed/Fri labels to the left of the rows, exactly like
  // the calendar it's modeled on — both are sticky so they survive the
  // horizontal scroll to today's column below.
  function buildActivityHeatmapGrid(log) {
    const dayMs = 24 * 60 * 60 * 1000;
    const totalWeeks = 53;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // getDay() is 0=Sunday..6=Saturday; remap so Monday's week-start offset
    // is 0 and Sunday's is 6, then walk back to the Monday of today's week
    // before walking back the remaining full weeks.
    const todayMondayOffset = (today.getDay() + 6) % 7;
    const currentWeekMonday = new Date(today.getTime() - todayMondayOffset * dayMs);
    const gridStart = new Date(currentWeekMonday.getTime() - (totalWeeks - 1) * 7 * dayMs);

    const columns = [];
    let maxCount = 0;
    for (let week = 0; week < totalWeeks; week++) {
      const column = [];
      for (let day = 0; day < 7; day++) {
        const cellDate = new Date(gridStart.getTime() + (week * 7 + day) * dayMs);
        if (cellDate > today) {
          column.push(null);
          continue;
        }
        const dateKey = window.WordGameHelpers?.getDateKeyForDate?.(cellDate);
        const count = log[dateKey] ?? 0;
        maxCount = Math.max(maxCount, count);
        column.push({ dateKey, count, date: cellDate });
      }
      columns.push(column);
    }

    const practicedDays = Object.keys(log).length;
    const totalQuestions = Object.values(log).reduce((sum, count) => sum + count, 0);

    const scroller = document.createElement("div");
    scroller.className = "my-stats-heatmap-scroll";

    const inner = document.createElement("div");
    inner.className = "my-stats-heatmap-inner";

    // Month labels: group columns into runs sharing the same month (by
    // each column's Monday), then only label a run at least
    // HEATMAP_MIN_MONTH_LABEL_COLUMNS wide. A shorter run — typically just
    // the leftover week of whatever month the 53-week window happens to
    // start mid-way through — keeps its cells but loses its label instead
    // of overlapping the very next one; that month gets an unambiguous
    // label of its own a few weeks later regardless.
    const monthsRow = document.createElement("div");
    monthsRow.className = "my-stats-heatmap-months-row";
    const daySpacer = document.createElement("span");
    daySpacer.className = "my-stats-heatmap-day-col-spacer";
    const monthsTrack = document.createElement("div");
    monthsTrack.className = "my-stats-heatmap-months";
    const monthOfColumn = columns.map((column) => column[0]?.date?.getMonth() ?? null);
    const monthLabelText = columns.map(() => "");
    let runStart = 0;
    for (let i = 1; i <= columns.length; i++) {
      if (i < columns.length && monthOfColumn[i] === monthOfColumn[runStart]) continue;
      const runLength = i - runStart;
      if (runLength >= HEATMAP_MIN_MONTH_LABEL_COLUMNS && monthOfColumn[runStart] !== null) {
        monthLabelText[runStart] = HEATMAP_MONTH_FORMATTER.format(columns[runStart][0].date);
      }
      runStart = i;
    }
    monthLabelText.forEach((text) => {
      const slot = document.createElement("span");
      slot.className = "my-stats-heatmap-month-slot";
      slot.textContent = text;
      monthsTrack.appendChild(slot);
    });
    monthsRow.append(daySpacer, monthsTrack);

    const bodyRow = document.createElement("div");
    bodyRow.className = "my-stats-heatmap-body-row";

    const dayLabels = document.createElement("div");
    dayLabels.className = "my-stats-heatmap-day-labels";
    dayLabels.setAttribute("aria-hidden", "true");
    dayLabels.innerHTML = HEATMAP_DAY_LABELS.map((label) => `<span>${label}</span>`).join("");

    const grid = document.createElement("div");
    grid.className = "my-stats-heatmap-grid";
    grid.setAttribute("role", "img");
    grid.setAttribute(
      "aria-label",
      `Practice activity over the last 12 months: ${practicedDays} day${practicedDays === 1 ? "" : "s"} practiced, ${totalQuestions.toLocaleString("en-US")} total questions answered.`,
    );

    columns.forEach((column) => {
      const columnEl = document.createElement("div");
      columnEl.className = "my-stats-heatmap-column";
      column.forEach((cell) => {
        const cellEl = document.createElement("span");
        if (!cell) {
          cellEl.className = "my-stats-heatmap-cell my-stats-heatmap-cell--future";
        } else {
          const level = getHeatmapIntensityLevel(cell.count, maxCount);
          cellEl.className = `my-stats-heatmap-cell my-stats-heatmap-cell--${level}`;
          cellEl.title = `${cell.count} question${cell.count === 1 ? "" : "s"} on ${cell.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
        }
        columnEl.appendChild(cellEl);
      });
      grid.appendChild(columnEl);
    });

    bodyRow.append(dayLabels, grid);
    inner.append(monthsRow, bodyRow);
    scroller.appendChild(inner);
    // Land on today's column, not 53 weeks ago — scrollWidth only reads
    // correctly once this is actually laid out in the document, which
    // happens synchronously in renderMyStats right after this returns, so a
    // rAF (deferred to the next frame) is enough to land after that.
    requestAnimationFrame(() => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
    return scroller;
  }

  function createActivityHeatmapCard() {
    const log = window.WordGameHelpers?.getPracticeActivityLog?.() ?? {};

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-heatmap-card";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Practice Activity";
    card.appendChild(heading);

    if (Object.keys(log).length === 0) {
      const empty = document.createElement("p");
      empty.className = "my-stats-empty";
      empty.textContent =
        "Your daily practice calendar starts today — come back to watch it fill in.";
      card.appendChild(empty);
      return card;
    }

    const caption = document.createElement("p");
    caption.className = "my-stats-cefr-bar-caption";
    caption.textContent = "Last 12 Months";
    card.appendChild(caption);

    card.appendChild(buildActivityHeatmapGrid(log));

    const legend = document.createElement("div");
    legend.className = "my-stats-heatmap-legend";
    legend.setAttribute("aria-hidden", "true");
    legend.innerHTML = `
      <span>Less</span>
      ${[0, 1, 2, 3, 4].map((level) => `<span class="my-stats-heatmap-cell my-stats-heatmap-cell--${level}"></span>`).join("")}
      <span>More</span>
    `;
    card.appendChild(legend);

    return card;
  }

  // What each skill tests, and why it's a different skill from the others
  // rather than just another word-strength number — labels alone
  // ("Recall", "Word Connections") say neither. Mirrors the exercise
  // mapping in wordGame.js's REVIEW_MODE_BY_SKILL: recognition -> forward,
  // production -> reverse/typed-reverse, listening ->
  // listening/typed-listening, context -> cloze/typed-cloze, semantic ->
  // synonym.
  const SKILL_DESCRIPTIONS = Object.freeze({
    recognition:
      "Seeing the word and picking its meaning — the foundation of reading.",
    production:
      "Producing the word from its meaning — harder, and closer to real conversation.",
    listening:
      "Understanding the word by ear alone — essential for following spoken Japanese.",
    context:
      "Using the word correctly inside a sentence — tests grammar, not just vocabulary.",
    semantic:
      "Linking the word to others with a similar meaning — builds a deeper vocabulary.",
  });

  function createSkillsCard() {
    const skills = window.WordGameHelpers?.getSkillsBreakdownSummary?.() ?? [];
    const practicedSkills = skills.filter((skill) => skill.practicedCount > 0);

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-skills";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Skills";
    card.appendChild(heading);

    if (practicedSkills.length === 0) {
      const empty = document.createElement("p");
      empty.className = "my-stats-empty";
      empty.textContent =
        "Play the Word Game to start building a skills breakdown — recognition, recall, listening, sentences, and word connections will show up here.";
      card.appendChild(empty);
      return card;
    }

    const intro = document.createElement("p");
    intro.className = "my-stats-vocabulary-intro";
    intro.textContent = "How well you're doing across each way the game tests a word.";
    card.appendChild(intro);

    // Each skill gets its own bordered tile — a plain stacked list of
    // similar-weight text made it hard to tell where one skill's row ended
    // and the next began. Reading order top to bottom is deliberately a
    // hierarchy, not a flat list: the skill name is a small muted eyebrow
    // (identifies the tile, doesn't compete for attention), the percentage
    // is the single largest/boldest element on the tile (it's the number
    // this whole card exists to show), the bar restates it visually, and
    // the description + word count shrink further down since they're
    // supporting context, not the headline.
    const rows = document.createElement("div");
    rows.className = "my-stats-skills-rows";
    rows.innerHTML = practicedSkills
      .map(
        (skill) => `
        <div class="my-stats-skill-tile">
          <p class="my-stats-skill-label">${skill.label}</p>
          <div class="my-stats-skill-value-row">
            <span class="my-stats-skill-value">${skill.avgPercent}%</span>
            <div class="my-stats-skill-bar-bg" role="img" aria-label="${skill.label}: ${skill.avgPercent}% mastery across ${skill.practicedCount} words">
              <span class="my-stats-skill-bar-fill" style="width: ${skill.avgPercent}%;"></span>
            </div>
          </div>
          <p class="my-stats-skill-description">${SKILL_DESCRIPTIONS[skill.skill] ?? ""}</p>
          <p class="my-stats-skill-count">${skill.practicedCount.toLocaleString("en-US")} word${skill.practicedCount === 1 ? "" : "s"} practiced</p>
        </div>
      `,
      )
      .join("");
    card.appendChild(rows);

    return card;
  }

  // Current daily-quest gem holdings. Gems are currency, so subtract gems
  // already spent from the lifetime amount earned.
  function createGemsCard() {
    const state = window.DailyQuestAPI?.getState?.() ?? {};
    const gemCounts = state.gemCounts ?? {};
    // Keyed off gemCounts' own keys (always all three reward types once
    // normalized -- see normalizeDailyPracticeState in wordGame.js) rather
    // than reaching into wordGame.js's DAILY_QUESTS directly, so this
    // keeps to the same "read an *API, don't reach into internals"
    // convention as the rest of this file.
    const rewards = Object.keys(gemCounts);
    const balances = Object.fromEntries(
      rewards.map((reward) => [
        reward,
        window.DailyQuestAPI?.getGemBalance?.(reward) ??
          Math.max(0, (gemCounts[reward] ?? 0) - (state.spentGemCounts?.[reward] ?? 0)),
      ]),
    );
    const total = rewards.reduce((sum, reward) => sum + balances[reward], 0);

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-gems";
    card.innerHTML = `
      <div class="my-stats-gems-header">
        <h3 class="my-stats-section-heading">Gem Holdings</h3>
        <strong class="landing-progress-summary-count">${total.toLocaleString("en-US")} total</strong>
      </div>
      <div class="my-stats-gems-row">
        ${rewards
          .map(
            (reward) => `
          <div class="my-stats-gems-tile">
            ${getDailyQuestGemMarkup(reward, "my-stats-gems-icon")}
            <p class="game-summary-stat-value">${balances[reward].toLocaleString("en-US")}</p>
            <p class="game-summary-stat-label">${reward.charAt(0).toUpperCase()}${reward.slice(1)}</p>
          </div>
        `,
          )
          .join("")}
      </div>
    `;

    return card;
  }

  function createVocabularyCard() {
    const { total, counts } = window.WordGameHelpers?.getVocabProgressSummary?.() ?? {
      total: 0,
      counts: [],
    };

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-vocabulary";

    if (total === 0) {
      card.innerHTML = `
        <h3 class="my-stats-section-heading">Vocabulary Profile</h3>
        <p class="my-stats-empty">Play the Word Game to start building your vocabulary profile — words you practice will show up here, grouped by how well you know them.</p>
      `;
      return card;
    }

    card.innerHTML = `
      <div class="my-stats-vocabulary-header">
        <h3 class="my-stats-section-heading">Vocabulary Profile</h3>
        <strong class="landing-progress-summary-count">${total.toLocaleString("en-US")} word${total === 1 ? "" : "s"}</strong>
      </div>
      <p class="my-stats-vocabulary-intro">Grouped by how durably each word has stuck over time — a stricter, slower-moving measure than the accuracy-based Proficiency card above, so the two won’t always match.</p>
      ${window.WordGameHelpers.buildVocabProgressBarMarkup(counts, total)}
      <a class="my-stats-see-all-link" href="?type=word-list">See All Words</a>
    `;

    card
      .querySelector(".my-stats-see-all-link")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        window.goToAllWords?.();
      });

    return card;
  }

  function createTroubleWordsCard() {
    const troubleEntries = getTroubleEntries();

    const card = document.createElement("section");
    card.className = "my-stats-box my-stats-trouble";

    const heading = document.createElement("h3");
    heading.className = "my-stats-section-heading";
    heading.textContent = "Words You’ve Missed the Most";
    card.appendChild(heading);

    if (troubleEntries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "my-stats-empty";
      empty.textContent =
        "No trouble words yet — nice work! Words you miss more than once will show up here.";
      card.appendChild(empty);
      return card;
    }

    const tableContainer = window.WordListAPI.createList(troubleEntries, {
      ariaLabel: "Words you've missed the most",
      containerClass: "my-stats-trouble-table-container",
    });
    card.appendChild(tableContainer);

    return card;
  }

  function renderMyStats() {
    const container = getResultsContainer();
    if (!container) return;

    if (!Array.isArray(results) || results.length === 0) {
      const loadingMessage = document.createElement("div");
      loadingMessage.className = "definition";

      const heading = document.createElement("h2");
      heading.textContent = "Loading Vocabulary";

      const explanation = document.createElement("p");
      explanation.textContent =
        "Your stats will be ready once the vocabulary data finishes loading.";

      loadingMessage.append(heading, explanation);
      container.appendChild(loadingMessage);
      return;
    }

    const section = document.createElement("section");
    section.id = "my-stats";
    section.className = "definition my-stats";
    section.append(
      createHeaderCard(),
      createOverviewCard(),
      createProficiencyCard(),
      createActivityHeatmapCard(),
      createSkillsCard(),
      createVocabularyCard(),
      createGemsCard(),
      createTroubleWordsCard(),
    );

    container.appendChild(section);
  }

  function initMyStats() {
    if (getCurrentMode() !== "my-stats") {
      return;
    }

    showLandingCard(false);
    clearContainer();
    renderMyStats();
  }

  window.initMyStats = initMyStats;
})();
