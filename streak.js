// Day-streak tracking: how many consecutive calendar days in a row the
// learner has completed at least one word-game round (a bounded round
// finishing, or an infinite round being manually ended — see
// showWordGameRoundSummary() in wordGame.js, the single place that calls
// recordStreakActivity()).
//
// Mirrors wordList.js's wordStrengths pattern: state lives in localStorage
// (always, signed in or not), a CustomEvent fires on every save so
// myWordsAuth.js can sync it to Firestore for signed-in users, and a
// "syncRemote: false" save (used when applying a remote merge/replace)
// skips re-dispatching to avoid writing the same value straight back.
(function () {
  "use strict";

  const STREAK_STORAGE_KEY = "japanese-dictionary-streak-v1";
  const FREEZE_COSTS = Object.freeze({
    emerald: 4,
    ruby: 2,
    sapphire: 1,
  });

  function defaultStreakState() {
    return {
      count: 0,
      longestCount: 0,
      lastActiveDate: null, // "YYYY-MM-DD", local date
      graceUsed: false, // the one free missed-day forgiveness, per streak
      // A purchased freeze stays ready for this date and rolls forward on
      // each day the learner practices, until it protects a missed day.
      freezeDate: null,
    };
  }

  function loadStreakState() {
    try {
      const storedValue = window.localStorage.getItem(STREAK_STORAGE_KEY);

      if (!storedValue) {
        return defaultStreakState();
      }

      const parsedValue = JSON.parse(storedValue);

      return {
        ...defaultStreakState(),
        ...(parsedValue.streak && typeof parsedValue.streak === "object"
          ? parsedValue.streak
          : {}),
      };
    } catch (error) {
      console.warn("Streak could not be loaded.", error);
      return defaultStreakState();
    }
  }

  let streakState = loadStreakState();

  function saveStreakState({ syncRemote = true } = {}) {
    try {
      window.localStorage.setItem(
        STREAK_STORAGE_KEY,
        JSON.stringify({ version: 1, streak: streakState }),
      );
    } catch (error) {
      console.warn("Streak could not be saved.", error);
    }

    updateStreakBadge();

    // Let myWordsAuth.js know the streak changed, so it can sync to
    // Firestore when a user is signed in. syncRemote is false when the
    // change came from a remote merge, to avoid immediately writing it
    // back.
    window.dispatchEvent(
      new CustomEvent("streak:updated", {
        detail: { streak: { ...streakState }, syncRemote },
      }),
    );
  }

  function getLocalDateString(date = new Date()) {
    // Deliberately not toISOString() (UTC-based) — a streak is about the
    // learner's own calendar day, and that shifts near midnight in most
    // timezones if derived from UTC instead of local date parts.
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // Both arguments are "YYYY-MM-DD" local-date strings with no time
  // component. Constructed as UTC midnight purely so the subtraction below
  // is a plain, DST-immune day count — this never touches the *local*
  // meaning of either date, only measures the gap between them.
  function daysBetween(earlierDateString, laterDateString) {
    const [y1, m1, d1] = earlierDateString.split("-").map(Number);
    const [y2, m2, d2] = laterDateString.split("-").map(Number);
    const earlier = Date.UTC(y1, m1 - 1, d1);
    const later = Date.UTC(y2, m2 - 1, d2);

    return Math.round((later - earlier) / 86400000);
  }

  function dayBefore(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day - 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function dayAfter(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function formatStreakDate(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    // Midday keeps this calendar-date display stable in every local time
    // zone, including around daylight-saving changes.
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(year, month - 1, day, 12));
  }

  // Called once per completed/ended word-game round. Returns what actually
  // happened so the caller (the round summary screen) can show an
  // appropriate message — e.g. calling out that the grace day was just
  // spent, rather than silently extending the streak.
  function recordStreakActivity() {
    const today = getLocalDateString();

    if (streakState.lastActiveDate === today) {
      // Already played today — nothing changes, just report where things
      // stand (a second round in one day shouldn't double-count).
      return {
        status: "already-counted",
        count: streakState.count,
        longestCount: streakState.longestCount,
      };
    }

    let status;
    const brokenStreakLength = streakState.count;

    if (!streakState.lastActiveDate) {
      streakState.count = 1;
      streakState.graceUsed = false;
      status = "started";
    } else {
      const gap = daysBetween(streakState.lastActiveDate, today);

      if (gap === 1) {
        // Yesterday to today — the ordinary, consecutive case.
        streakState.count += 1;
        // A freeze bought in advance is not wasted when the learner does
        // study. Keep it ready for the next day instead.
        if (streakState.freezeDate === today) {
          streakState.freezeDate = dayAfter(today);
        }
        status = "extended";
      } else if (gap === 2 && streakState.freezeDate === dayBefore(today)) {
        // A freeze was deliberately activated for the one day between the
        // learner's last practice and today. It protects the streak but
        // does not count as a study session in its own right.
        streakState.count += 1;
        streakState.freezeDate = null;
        status = "freeze-covered";
      } else if (gap === 2 && !streakState.graceUsed) {
        // Exactly one day was missed, and the grace day for this streak
        // hasn't been spent yet — the streak survives, retroactively
        // treating the missed day as covered.
        streakState.count += 1;
        streakState.graceUsed = true;
        status = "grace-used";
      } else {
        // Either more than one day was missed, or the grace day was
        // already used earlier in this streak — starts over.
        streakState.count = 1;
        streakState.graceUsed = false;
        streakState.freezeDate = null;
        status = "reset";
      }
    }

    streakState.lastActiveDate = today;
    streakState.longestCount = Math.max(
      streakState.longestCount,
      streakState.count,
    );

    saveStreakState();

    // "reset" is the one status that represents a streak actually breaking
    // (as opposed to started/extended/grace-used, all forward progress) —
    // reported with the length it broke at, so the funnel can distinguish a
    // 1-day dabble from a 40-day streak lapsing.
    window.trackEvent?.(status === "reset" ? "streak_broken" : "streak_" + status.replace("-", "_"), {
      streak_count: streakState.count,
      ...(status === "reset" ? { broken_streak_length: brokenStreakLength } : {}),
    });

    return {
      status,
      count: streakState.count,
      longestCount: streakState.longestCount,
    };
  }

  // Applied when a remote (Firestore) value should become the local truth
  // — a fresh sign-in merge, or a live update from another signed-in
  // device. Never dispatches back to myWordsAuth.js (syncRemote: false),
  // since the value just came from there.
  function replaceStreakState(remoteState) {
    streakState = { ...defaultStreakState(), ...remoteState };
    saveStreakState({ syncRemote: false });
  }

  function updateStreakBadge() {
    const menu = document.getElementById("streak-menu");
    const badge = document.getElementById("streak-menu-btn");
    const countEl = document.getElementById("streak-badge-count");

    if (!menu || !badge || !countEl) {
      return;
    }

    if (streakState.count > 0) {
      countEl.textContent = String(streakState.count);
      menu.classList.remove("hidden");
      const today = getLocalDateString();
      const protectedToday = streakState.freezeDate === today;
      const completeToday = streakState.lastActiveDate === today;
      const label = protectedToday
        ? `${streakState.count}-day streak; a freeze is ready for today`
        : completeToday
          ? `${streakState.count}-day streak; practice complete for today`
          : `${streakState.count}-day streak; study today to keep it`;
      badge.setAttribute("aria-label", label);
      badge.title = label;
    } else {
      menu.classList.add("hidden");
    }
  }

  function getMenuStatus() {
    const today = getLocalDateString();
    if (streakState.freezeDate === today) {
      return `A freeze is ready for today. Return by ${formatStreakDate(dayAfter(today))} to keep your streak.`;
    }
    if (streakState.freezeDate === dayAfter(today)) {
      return `A freeze is ready for tomorrow. Return by ${formatStreakDate(dayAfter(streakState.freezeDate))} to keep your streak.`;
    }
    if (streakState.lastActiveDate === today) {
      return `Practice complete. Return by ${formatStreakDate(dayAfter(today))} to keep your streak.`;
    }
    return `Return by ${formatStreakDate(today)} to keep your ${streakState.count}-day streak.`;
  }

  function getGemPlural(reward) {
    return { emerald: "Emeralds", ruby: "Rubies", sapphire: "Sapphires" }[
      reward
    ];
  }

  function getStreakMenuGemMarkup(reward) {
    return window.getDailyQuestGemMarkup?.(
      reward,
      "streak-menu-gem-icon",
    ) ?? `<span class="streak-menu-gem-fallback" aria-hidden="true">◆</span>`;
  }

  function renderStreakMenu() {
    const panel = document.getElementById("streak-menu-panel");
    if (!panel) return;

    const today = getLocalDateString();
    const canBuyFreeze =
      streakState.count > 0 &&
      Boolean(streakState.lastActiveDate) &&
      !streakState.freezeDate &&
      (streakState.lastActiveDate === today ||
        daysBetween(streakState.lastActiveDate, today) === 1);
    const freezeTarget =
      streakState.lastActiveDate === today ? dayAfter(today) : today;
    const balance = (reward) => window.DailyQuestAPI?.getGemBalance?.(reward) ?? 0;
    const optionMarkup = Object.entries(FREEZE_COSTS)
      .map(([reward, cost]) => {
        const available = balance(reward);
        const disabled = !canBuyFreeze || available < cost;
        const label = `Buy with ${cost} ${cost === 1 ? reward : getGemPlural(reward).toLowerCase()}`;
        return `<button type="button" class="streak-menu-freeze-option streak-menu-freeze-option--${reward}" data-freeze-reward="${reward}" ${disabled ? "disabled" : ""}>${getStreakMenuGemMarkup(reward)}<span class="streak-menu-freeze-label">${label}</span><span class="streak-menu-freeze-available">${available} available</span></button>`;
      })
      .join("");

    panel.innerHTML = `
      <h2 class="streak-menu-heading">${streakState.count}-day streak</h2>
      <p class="streak-menu-status">${getMenuStatus()}</p>
      <div class="streak-menu-wallet" aria-label="Gem balances">
        ${Object.keys(FREEZE_COSTS)
          .map((reward) => `<span class="streak-menu-gem streak-menu-gem--${reward}">${getStreakMenuGemMarkup(reward)}<span class="streak-menu-gem-count">${balance(reward)}</span>${getGemPlural(reward)}</span>`)
          .join("")}
      </div>
      ${canBuyFreeze ? `<p class="streak-menu-freeze-heading">Buy a freeze for ${freezeTarget === today ? "today" : "tomorrow"}</p><div class="streak-menu-freeze-options">${optionMarkup}</div><p class="streak-menu-note">It stays ready for the next day you miss, so studying tomorrow will not waste it.</p>` : ""}
    `;

    panel.querySelectorAll("[data-freeze-reward]").forEach((button) => {
      button.addEventListener("click", () => buyFreeze(button.dataset.freezeReward));
    });
  }

  function buyFreeze(reward) {
    const cost = FREEZE_COSTS[reward];
    const today = getLocalDateString();
    if (
      !cost ||
      !streakState.lastActiveDate ||
      streakState.freezeDate ||
      (streakState.lastActiveDate !== today &&
        daysBetween(streakState.lastActiveDate, today) !== 1) ||
      !window.DailyQuestAPI?.spendGem?.(reward, cost)
    ) {
      renderStreakMenu();
      return;
    }

    streakState.freezeDate =
      streakState.lastActiveDate === today ? dayAfter(today) : today;
    saveStreakState();
    renderStreakMenu();
    window.trackEvent?.("streak_freeze_bought", { reward, gem_cost: cost, streak_count: streakState.count });
  }

  function positionStreakMenuPanel(button, panel) {
    const viewportGutter = 8;
    panel.classList.remove("streak-menu-panel--opens-right");
    panel.style.removeProperty("--streak-menu-available-width");
    const buttonRect = button.getBoundingClientRect();
    const panelWidth = panel.getBoundingClientRect().width;
    const viewportWidth = document.documentElement.clientWidth;
    const opensRight = buttonRect.right - panelWidth < viewportGutter;
    const availableWidth = opensRight
      ? viewportWidth - buttonRect.left - viewportGutter
      : buttonRect.right - viewportGutter;
    panel.classList.toggle("streak-menu-panel--opens-right", opensRight);
    panel.style.setProperty("--streak-menu-available-width", `${Math.max(0, availableWidth)}px`);
  }

  function initializeStreakMenu() {
    const menu = document.getElementById("streak-menu");
    const button = document.getElementById("streak-menu-btn");
    const panel = document.getElementById("streak-menu-panel");
    if (!menu || !button || !panel) return;
    const isOpen = () => !panel.classList.contains("hidden");
    const closeMenu = () => {
      panel.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
    };
    const openMenu = () => {
      renderStreakMenu();
      panel.classList.remove("hidden");
      positionStreakMenuPanel(button, panel);
      button.setAttribute("aria-expanded", "true");
      document.dispatchEvent(new CustomEvent("app-menu:open", { detail: { id: "streak" } }));
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      isOpen() ? closeMenu() : openMenu();
    });
    document.addEventListener("click", (event) => {
      if (isOpen() && !event.target.closest(".streak-menu")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) {
        closeMenu();
        button.focus();
      }
    });
    document.addEventListener("app-menu:open", (event) => {
      if (event.detail?.id !== "streak") closeMenu();
    });
    window.addEventListener("resize", () => {
      if (isOpen()) positionStreakMenuPanel(button, panel);
    });
  }

  // Deferred scripts run after the document is fully parsed, so the badge
  // markup in index.html is already present by the time this executes.
  updateStreakBadge();
  initializeStreakMenu();

  window.StreakAPI = Object.freeze({
    getState: () => ({ ...streakState }),
    recordActivity: recordStreakActivity,
    buyFreeze,
    replaceState: replaceStreakState,
  });
})();
