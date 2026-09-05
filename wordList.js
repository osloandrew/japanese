(function () {
  "use strict";

  // Japanese alphabetical sorting places æ, ø, and å correctly.
  const japaneseCollator = new Intl.Collator("ja-JP", {
    sensitivity: "base",
    numeric: true,
  });

  function getWordListFilterElements() {
    return {
      typeSelect: document.getElementById("type-select"),
      searchInput: document.getElementById("search-bar"),
      posSelect: document.getElementById("pos-select"),
      cefrSelect: document.getElementById("cefr-select"),
      strengthSelect: document.getElementById("strength-select"),
    };
  }

  const WORD_LIST_BATCH_SIZE = 100;
  const MY_WORDS_STORAGE_KEY = "japanese-dictionary-my-words-v1";
  const WORD_STRENGTH_STORAGE_KEY = "japanese-dictionary-word-strength-v1";
  const WORD_STRENGTH_MAX = 5;

  let activeWordListEntries = [];
  let renderedWordListCount = 0;
  let wordListBatchIsLoading = false;
  let wordListReturnState = null;
  const myWordsInitialState = loadMyWordsState();
  let myWordsEntryIds = myWordsInitialState.entryIds;
  let myWordsEntryTimestamps = myWordsInitialState.entryTimestamps;
  let wordStrengths = loadWordStrengths();
  let activeWordListView = "all";
  // "" (any), "common-first", or "rarest-first" — the Frequency sort's
  // three states. Kept as a module variable rather than read from the DOM,
  // since the <select> itself (built in createWordListFrequencySortGroup)
  // is recreated on every renderWordList() call, same as why
  // activeWordListView above isn't read from a button's state either.
  let activeWordListFrequencySort = "";

  /**
   * Convert a value into normalized searchable text.
   */
  function normalizeWordListText(value, locale = "ja-JP") {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase(locale);
  }

  /**
   * Determine whether an entry matches the selected Word Class.
   * Grammatical-category classification lives in wordClass.js (loaded
   * before this file — see window.WordClass), shared with scripts.js and
   * wordGame.js.
   */
  function wordListEntryMatchesPOS(entry, selectedPOS) {
    return WordClass.matchesWordClass(entry.gender, selectedPOS);
  }

  /**
   * Convert the CSV gender value into a readable Word Class label.
   */
  function getWordListClassLabel(entry) {
    const originalGender = String(entry.gender ?? "").trim();

    if (!originalGender) {
      return "—";
    }

    return WordClass.formatWordClassLabel(originalGender);
  }

  /**
   * Return the URL-compatible word class for an entry.
   */
  function getWordListEntryPOS(entry) {
    return WordClass.stripNounPrefix(entry.gender);
  }

  /**
   * Create a genuine, crawlable URL for a Word List entry.
   */
  function createWordListDefinitionURL(entry) {
    const primaryWord = String(entry.ord ?? "")
      .split(/[,、]/)[0]
      .trim();

    const entryPOS = getWordListEntryPOS(entry);

    // APP_ROOT_URL (scripts.js), not document.baseURI directly — on the
    // plain app shell (no <base> tag) baseURI resolves to document.URL,
    // which pushState drags along with it after any in-app navigation.
    // This list can itself be reached from a pretty static page like
    // /word/forgjeves/, and each entry's link needs to point at the app
    // root with its own type/pos/word, not stack onto whatever path the
    // list happened to be viewed from.
    const url = new URL(APP_ROOT_URL);
    url.search = "";

    url.searchParams.set("type", "words");

    if (entryPOS) {
      url.searchParams.set("pos", entryPOS);
    }

    if (primaryWord) {
      url.searchParams.set("word", primaryWord);
    }

    return url.href;
  }

  /**
   * Create one table cell.
   */
  function createWordListCell(
    value,
    className,
    mobileLabel,
    { richContent = false } = {},
  ) {
    const cell = document.createElement("td");

    // richContent cells are about to have their real content (an icon,
    // badge, or link) appended by the caller — skip the "—" placeholder
    // rather than setting then immediately discarding it.
    cell.textContent = richContent ? "" : value || "—";
    cell.className = className;
    cell.dataset.label = mobileLabel;

    return cell;
  }

  // The CSV's `id` column is a stable, content-independent token generated
  // once per row and never recomputed from other fields. Using it — rather
  // than a hash of mutable fields — means editing a word's definition,
  // translation, reading, or class can never change the key a saved
  // word/strength record is stored under. Falls back to the legacy content
  // hash only for an entry that somehow has no id (shouldn't happen once
  // every CSV row has one).
  function getMyWordsEntryId(entry) {
    const id = String(entry?.id ?? "").trim();
    return id || getLegacyMyWordsEntryId(entry);
  }

  // Pre-migration key: a hash of mutable fields, including the definition —
  // which CI regenerates from source dictionaries whenever the CSV changes
  // (see scripts/build-definitions.py), so this silently orphaned any word
  // saved before its definition was next regenerated. Kept only so
  // migrateMyWordsEntryIds() below can recognize and remap ids computed
  // this way before the `id` column existed.
  function getLegacyMyWordsEntryId(entry) {
    return [
      entry.ord,
      entry.engelsk,
      getWordListClassLabel(entry),
      entry.definisjon,
    ]
      .map((value) =>
        String(value ?? "")
          .trim()
          .normalize("NFC"),
      )
      .join("\u001f");
  }

  // A legacy id joins 4 fields on U+001F, so it always contains that
  // separator; a stable `id` column value (a short random hex token) never
  // does. Cheap, reliable way to tell old-format keys apart from
  // already-migrated ones.
  function isLegacyMyWordsEntryId(id) {
    return typeof id === "string" && id.includes("\u001f");
  }

  function loadMyWordsState() {
    try {
      const storedValue = window.localStorage.getItem(MY_WORDS_STORAGE_KEY);

      if (!storedValue) {
        return { entryIds: new Set(), entryTimestamps: {} };
      }

      const parsedValue = JSON.parse(storedValue);
      const entryIds = Array.isArray(parsedValue.entryIds)
        ? parsedValue.entryIds
        : [];
      const entryTimestamps =
        parsedValue.entryTimestamps &&
        typeof parsedValue.entryTimestamps === "object"
          ? parsedValue.entryTimestamps
          : {};

      return { entryIds: new Set(entryIds), entryTimestamps };
    } catch (error) {
      console.warn("My Words could not be loaded.", error);
      return { entryIds: new Set(), entryTimestamps: {} };
    }
  }

  function saveMyWordsEntryIds({ syncRemote = true, changedEntryIds = null } = {}) {
    try {
      window.localStorage.setItem(
        MY_WORDS_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          entryIds: Array.from(myWordsEntryIds),
          entryTimestamps: myWordsEntryTimestamps,
        }),
      );
    } catch (error) {
      console.warn("My Words could not be saved.", error);
    }

    // Let myWordsAuth.js know My Words changed, so it can sync to Firestore
    // when a user is signed in. syncRemote is false when the change came
    // from a remote merge, to avoid immediately writing it back.
    window.dispatchEvent(
      new CustomEvent("my-words:updated", {
        detail: {
          entryIds: Array.from(myWordsEntryIds),
          entryTimestamps: myWordsEntryTimestamps,
          changedEntryIds,
          syncRemote,
        },
      }),
    );
  }

  // Last-write-wins merge, keyed per word rather than a flat array union.
  // A flat union of two entryId arrays can only ever grow, so it silently
  // resurrects a word removed on one side (e.g. locally, just before the
  // remote side's stale copy gets merged in) because nothing about a plain
  // array can express "this word was deliberately removed." Tracking a
  // per-word updatedAt timestamp (bumped on every add/remove, local or
  // remote) lets a removal beat a stale remote "present" the same way a
  // remote removal correctly beats a stale local "present."
  //
  // Entries neither side has ever timestamped (pre-upgrade local storage,
  // or a pre-upgrade Firestore document) are treated as though they were
  // just touched locally / long ago remotely, so upgrading never loses a
  // word that's actually saved on either side.
  function getMergedMyWordsState(remoteEntryIds, remoteEntryTimestamps) {
    const remoteIdSet = new Set(
      Array.isArray(remoteEntryIds) ? remoteEntryIds : [],
    );
    const remoteTimestamps =
      remoteEntryTimestamps && typeof remoteEntryTimestamps === "object"
        ? remoteEntryTimestamps
        : {};

    const now = Date.now();
    const allIds = new Set([
      ...myWordsEntryIds,
      ...Object.keys(myWordsEntryTimestamps),
      ...remoteIdSet,
      ...Object.keys(remoteTimestamps),
    ]);

    const mergedIds = new Set();
    const mergedTimestamps = {};

    allIds.forEach((entryId) => {
      const localPresent = myWordsEntryIds.has(entryId);
      const localTimestamp = Object.prototype.hasOwnProperty.call(
        myWordsEntryTimestamps,
        entryId,
      )
        ? myWordsEntryTimestamps[entryId]
        : localPresent
          ? now
          : null;

      const remotePresent = remoteIdSet.has(entryId);
      const remoteTimestamp = Object.prototype.hasOwnProperty.call(
        remoteTimestamps,
        entryId,
      )
        ? remoteTimestamps[entryId]
        : remotePresent
          ? 0
          : null;

      let present;
      let timestamp;

      if (remoteTimestamp === null) {
        present = localPresent;
        timestamp = localTimestamp;
      } else if (localTimestamp === null) {
        present = remotePresent;
        timestamp = remoteTimestamp;
      } else if (remoteTimestamp > localTimestamp) {
        present = remotePresent;
        timestamp = remoteTimestamp;
      } else {
        present = localPresent;
        timestamp = localTimestamp;
      }

      mergedTimestamps[entryId] = timestamp;

      if (present) {
        mergedIds.add(entryId);
      }
    });

    return { entryIds: mergedIds, entryTimestamps: mergedTimestamps };
  }

  // Reconciles local My Words state against a remote copy (a Firestore
  // merge on sign-in, or a live snapshot from another device) using
  // last-write-wins per word, then persists and re-renders. Returns the
  // reconciled state so callers that pushed a merge can push the actual
  // merged result back rather than re-deriving it.
  function reconcileMyWordsEntryIds(remoteEntryIds, remoteEntryTimestamps) {
    const merged = getMergedMyWordsState(remoteEntryIds, remoteEntryTimestamps);

    myWordsEntryIds = merged.entryIds;
    myWordsEntryTimestamps = merged.entryTimestamps;

    saveMyWordsEntryIds({ syncRemote: false });

    // Match replaceWordStrengths/mergeWordStrengths below: refresh whenever
    // the Word List tab is visible at all, not just the My Words sub-view —
    // a remote merge changes which rows show a filled star in "all" too.
    if (getCurrentMode() === "word-list") {
      renderWordList();
    }

    return {
      entryIds: Array.from(myWordsEntryIds),
      entryTimestamps: myWordsEntryTimestamps,
    };
  }

  // One-time move of any My Words/word-strength records still keyed by the
  // pre-`id`-column legacy hash onto the entry's stable id, dropping any
  // that no longer match a word in the current dictionary at all (a word
  // that was already orphaned under the old scheme — nothing legitimate to
  // recover). Idempotent and cheap to call unconditionally: after the first
  // run on a given browser/account, no stored id is legacy-shaped any more,
  // so every later call is a same-tick no-op. Must run after `results` is
  // populated and before anything else reads myWordsEntryIds/wordStrengths
  // against it — see the call in scripts.js's parseCSVData.
  function migrateMyWordsEntryIds() {
    if (!Array.isArray(results) || results.length === 0) {
      return;
    }

    const legacyIds = new Set();
    myWordsEntryIds.forEach((id) => {
      if (isLegacyMyWordsEntryId(id)) legacyIds.add(id);
    });
    Object.keys(myWordsEntryTimestamps).forEach((id) => {
      if (isLegacyMyWordsEntryId(id)) legacyIds.add(id);
    });
    Object.keys(wordStrengths).forEach((id) => {
      if (isLegacyMyWordsEntryId(id)) legacyIds.add(id);
    });

    if (legacyIds.size === 0) {
      return;
    }

    const entriesByLegacyId = new Map(
      results.map((entry) => [getLegacyMyWordsEntryId(entry), entry]),
    );

    const now = Date.now();
    const touchedEntryIds = [];
    const touchedStrengthIds = [];
    let migratedCount = 0;
    let orphanedCount = 0;

    legacyIds.forEach((legacyId) => {
      const matchedEntry = entriesByLegacyId.get(legacyId);
      const newId = matchedEntry ? getMyWordsEntryId(matchedEntry) : null;

      if (newId) {
        migratedCount++;
      } else {
        orphanedCount++;
      }

      const wasSaved = myWordsEntryIds.has(legacyId);
      const legacyTimestamp = myWordsEntryTimestamps[legacyId];

      if (wasSaved || legacyTimestamp !== undefined) {
        myWordsEntryIds.delete(legacyId);
        // Tombstone the legacy id at "now" so a signed-in account's remote
        // copy — still keyed by that id — is told unambiguously that it
        // was removed. Without this, the next sign-in merge would just add
        // it right back under an id nothing here recognizes any more (see
        // getMergedMyWordsState: a key local doesn't know about at all
        // defers entirely to remote).
        myWordsEntryTimestamps[legacyId] = now;
        touchedEntryIds.push(legacyId);

        if (newId && wasSaved) {
          const carriedTimestamp = Number.isFinite(legacyTimestamp)
            ? legacyTimestamp
            : now;
          const existingTimestamp = myWordsEntryTimestamps[newId];

          if (
            !Number.isFinite(existingTimestamp) ||
            carriedTimestamp > existingTimestamp
          ) {
            myWordsEntryIds.add(newId);
            myWordsEntryTimestamps[newId] = carriedTimestamp;
            touchedEntryIds.push(newId);
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(wordStrengths, legacyId)) {
        if (newId) {
          wordStrengths[newId] = wordStrengths[newId]
            ? window.SpacedRepetition.mergeRecordValues(
                wordStrengths[newId],
                wordStrengths[legacyId],
              )
            : wordStrengths[legacyId];
          touchedStrengthIds.push(newId);
        }

        delete wordStrengths[legacyId];
        touchedStrengthIds.push(legacyId);
      }
    });

    if (touchedEntryIds.length > 0) {
      saveMyWordsEntryIds({ changedEntryIds: touchedEntryIds });
    }

    if (touchedStrengthIds.length > 0) {
      saveWordStrengths({ changedEntryIds: touchedStrengthIds });
    }

    if (getCurrentMode() === "word-list") {
      renderWordList();
    }

    console.info(
      `My Words: moved ${migratedCount} saved word(s)/review record(s) to stable ids` +
        (orphanedCount > 0
          ? `; ${orphanedCount} no longer matched a word in the dictionary and were removed.`
          : "."),
    );
  }

  function loadWordStrengths() {
    try {
      const storedValue = window.localStorage.getItem(
        WORD_STRENGTH_STORAGE_KEY,
      );

      if (!storedValue) {
        return {};
      }

      const parsedValue = JSON.parse(storedValue);
      const rawRecords =
        parsedValue.records && typeof parsedValue.records === "object"
          ? parsedValue.records
          : parsedValue.strengths && typeof parsedValue.strengths === "object"
            ? parsedValue.strengths
            : {};
      const records = window.SpacedRepetition.normalizeCollection(rawRecords);

      // Migrate the old 0-5 scalar map in place. Legacy words are deliberately
      // due once because their original review dates were never stored.
      if (
        parsedValue.version !== window.SpacedRepetition.STORAGE_VERSION ||
        !parsedValue.records
      ) {
        window.localStorage.setItem(
          WORD_STRENGTH_STORAGE_KEY,
          JSON.stringify({
            version: window.SpacedRepetition.STORAGE_VERSION,
            records,
          }),
        );
      }

      return records;
    } catch (error) {
      console.warn("Word strength could not be loaded.", error);
      return {};
    }
  }

  function saveWordStrengths({
    syncRemote = true,
    changedEntryIds = null,
    deferRemote = false,
  } = {}) {
    try {
      window.localStorage.setItem(
        WORD_STRENGTH_STORAGE_KEY,
        JSON.stringify({
          version: window.SpacedRepetition.STORAGE_VERSION,
          records: wordStrengths,
        }),
      );
    } catch (error) {
      console.warn("Word strength could not be saved.", error);
    }

    // Let myWordsAuth.js know word strength changed, so it can sync to
    // Firestore when a user is signed in. syncRemote is false when the
    // change came from a remote merge, to avoid immediately writing it back.
    window.dispatchEvent(
      new CustomEvent("word-strength:updated", {
        detail: {
          strengths: { ...wordStrengths },
          changedEntryIds,
          syncRemote,
          deferRemote,
        },
      }),
    );
  }

  function replaceWordStrengths(strengths) {
    wordStrengths = window.SpacedRepetition.normalizeCollection(strengths);
    saveWordStrengths({ syncRemote: false });

    if (getCurrentMode() === "word-list") {
      renderWordList();
    }
  }

  function mergeWordStrengths(strengths) {
    wordStrengths = window.SpacedRepetition.mergeCollections(
      wordStrengths,
      strengths,
    );
    saveWordStrengths({ syncRemote: false });

    if (getCurrentMode() === "word-list") {
      renderWordList();
    }

    return window.SpacedRepetition.cloneCollection(wordStrengths);
  }

  function recordWordStrengthResult(entry, isCorrect, options = {}) {
    const resolvedEntry = resolveMyWordsEntry(entry);

    if (!resolvedEntry) {
      return null;
    }

    const entryId = getMyWordsEntryId(resolvedEntry);

    // Filler questions are deliberately shown before their actual due date
    // only to keep a bounded round moving while a failed word is being
    // spaced. A correct answer there is useful exposure, but not evidence
    // that should lengthen the durable interval. A failure always counts.
    if (isCorrect && options.credit === false) {
      return window.SpacedRepetition.cloneMemory(
        wordStrengths[entryId] || null,
      );
    }

    wordStrengths[entryId] = window.SpacedRepetition.recordSkillResult(
      wordStrengths[entryId],
      options.skill ?? "recognition",
      isCorrect,
      Date.now(),
      {
        evidenceWeight: options.evidenceWeight,
        outcomeValue: options.outcomeValue,
        initialStabilityDays: options.initialStabilityDays,
        minimumStabilityDays: options.minimumStabilityDays,
        fastTrackConfidence: options.fastTrackConfidence,
      },
    );

    saveWordStrengths({
      changedEntryIds: [entryId],
      deferRemote: Boolean(options.deferRemote),
    });

    return window.SpacedRepetition.cloneMemory(wordStrengths[entryId]);
  }

  function toggleMyWordsEntry(entry) {
    const entryId = getMyWordsEntryId(entry);

    if (myWordsEntryIds.has(entryId)) {
      myWordsEntryIds.delete(entryId);
    } else {
      myWordsEntryIds.add(entryId);
      window.trackEvent?.("select_content", { content_type: "word_saved" });
      // Approximates a one-time "reached 3 saved words" milestone by size
      // alone, not a persisted flag: correct for the overwhelming majority
      // of learners, who don't remove a word and re-save another to land
      // back on exactly 3.
      if (myWordsEntryIds.size === 3) {
        window.trackEvent?.("first_three_words_saved");
      }
    }

    myWordsEntryTimestamps[entryId] = Date.now();

    saveMyWordsEntryIds({ changedEntryIds: [entryId] });

    return entryId;
  }

  function updateMyWordsButton(button, entryId, word) {
    const isSaved = myWordsEntryIds.has(entryId);
    const icon = button.querySelector("i");
    const action = isSaved ? "Remove" : "Add";
    const destination = isSaved ? "from My Words" : "to My Words";

    button.classList.toggle("is-saved", isSaved);
    button.setAttribute("aria-pressed", String(isSaved));
    button.setAttribute("aria-label", `${action} ${word} ${destination}`);
    button.title = `${action} ${word} ${destination}`;

    icon.className = `${isSaved ? "fas" : "far"} fa-star`;
  }

  function createMyWordsCell(entry) {
    const cell = createWordListCell("", "word-list-favorite", "My Words", {
      richContent: true,
    });

    const button = document.createElement("button");
    const icon = document.createElement("i");
    const entryId = getMyWordsEntryId(entry);
    const word = String(entry.ord ?? "").trim();

    button.type = "button";
    button.className = "word-list-favorite-button";
    button.setAttribute("aria-pressed", "false");

    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);

    updateMyWordsButton(button, entryId, word);

    button.addEventListener("click", (event) => {
      // Do not open the definition when clicking the star.
      event.stopPropagation();

      toggleMyWordsEntry(entry);
      updateMyWordsButton(button, entryId, word);
      if (activeWordListView === "my") {
        renderWordList();
      }
    });

    button.addEventListener("keydown", (event) => {
      // Prevent the event from reaching the row's keyboard handler.
      event.stopPropagation();
    });

    cell.appendChild(button);

    return cell;
  }

  function createWordStrengthCell(entry) {
    const cell = createWordListCell("", "word-list-strength", "Strength", {
      richContent: true,
    });

    const entryId = getMyWordsEntryId(entry);
    const snapshot = window.SpacedRepetition.getSnapshot(
      wordStrengths[entryId],
    );

    if (snapshot.strength === null) {
      cell.textContent = "—";
      return cell;
    }

    // Floor a practiced word's displayed strength at 1, matching
    // getWordProgressTierId's own floor (wordGame.js) — the raw 0 that
    // strength can read right after a miss is real and still drives game
    // word-selection weighting, but showing it as "0 filled dots" here
    // would visually contradict the "Learning" tier that word is already
    // counted under everywhere else, breaking the 1-1 correlation between
    // this dot count and the vocabulary-profile category labels.
    const strengthValue = Math.max(1, snapshot.strength);

    const dueLabel = snapshot.isDue
      ? "Review due now"
      : `Next review ${new Intl.DateTimeFormat("en", {
          dateStyle: "medium",
        }).format(snapshot.record.dueAt)}`;

    const meter = document.createElement("span");
    meter.className = "word-strength-meter";
    meter.setAttribute(
      "aria-label",
      `Strength: ${strengthValue} out of ${WORD_STRENGTH_MAX}. ${dueLabel}`,
    );
    meter.title = dueLabel;

    for (let position = 0; position < WORD_STRENGTH_MAX; position++) {
      const dot = document.createElement("i");
      const isFilled = position < strengthValue;

      dot.className = `word-strength-dot ${
        isFilled ? "fa-solid" : "fa-regular"
      } fa-circle`;
      dot.setAttribute("aria-hidden", "true");
      meter.appendChild(dot);
    }

    cell.appendChild(meter);

    return cell;
  }

  function openWordList(view) {
    const { typeSelect, searchInput, posSelect, cefrSelect, strengthSelect } =
      getWordListFilterElements();

    if (!typeSelect) {
      return;
    }

    if (searchInput) {
      searchInput.value = "";
    }

    if (posSelect) {
      posSelect.value = "";
    }

    if (cefrSelect) {
      cefrSelect.value = "";
    }

    if (strengthSelect) {
      strengthSelect.value = "";
    }

    typeSelect.value = "word-list";
    // Passed explicitly rather than set here and left for
    // handleTypeChange's word-list branch to pick up — that branch
    // defaults to "my" on its own for every other entry point (dropdown,
    // bookmarked links), and these two landing cards need to stay exactly
    // "all" / "my" regardless of what that default is.
    handleTypeChange("word-list", { wordListView: view === "my" ? "my" : "all" });

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function goToAllWords() {
    openWordList("all");
  }

  function goToMyWords() {
    openWordList("my");
  }

  // getSavedWordStudyEntries() runs once per word-game question (see
  // wordGame.js's My Words weighting), so rebuilding an entryId->entry map
  // over the entire ~29,000-word dictionary on every call was a real,
  // measurable cost regardless of how many words were actually saved.
  // results is only ever assigned once (at initial CSV load), so this
  // index is cached and only rebuilt if that reference ever changes.
  let entriesByIdCache = null;
  let entriesByIdCacheSource = null;

  function getEntriesByIdIndex() {
    if (entriesByIdCacheSource !== results) {
      entriesByIdCache = new Map(
        results.map((entry) => [getMyWordsEntryId(entry), entry]),
      );
      entriesByIdCacheSource = results;
    }

    return entriesByIdCache;
  }

  function getSavedWordStudyEntries() {
    const entriesById = getEntriesByIdIndex();

    return Array.from(myWordsEntryIds)
      .map((entryId) => {
        const entry = entriesById.get(entryId);

        return entry ? { entryId, entry } : null;
      })
      .filter(Boolean);
  }

  function attachSingleResultMyWordsControls(entry) {
    const card = resultsContainer.querySelector(
      ".definition.single-result-definition",
    );

    if (!card || !entry) {
      return;
    }

    // Prevent duplicate controls if the definition is rendered again.
    card.querySelector(".single-result-my-words-controls")?.remove();

    const controls = document.createElement("div");
    controls.className = "single-result-my-words-controls";

    const starButton = document.createElement("button");
    const starIcon = document.createElement("i");
    const entryId = getMyWordsEntryId(entry);
    const word = String(entry.ord ?? "").trim();

    starButton.type = "button";
    starButton.className =
      "word-list-favorite-button single-result-my-words-star";

    starIcon.setAttribute("aria-hidden", "true");
    starButton.appendChild(starIcon);

    updateMyWordsButton(starButton, entryId, word);

    starButton.addEventListener("click", (event) => {
      // The definition card itself has a click handler.
      event.stopPropagation();

      toggleMyWordsEntry(entry);
      updateMyWordsButton(starButton, entryId, word);
    });

    starButton.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    // Reporting an issue lives in the definition-content grid below
    // (see displaySearchResults in scripts.js), not up here with the star.
    controls.appendChild(starButton);
    card.prepend(controls);

    // Create or reuse the navigation row above the card.
    let navigation = resultsContainer.querySelector(
      ".single-result-navigation",
    );

    if (!navigation) {
      navigation = document.createElement("div");
      navigation.className = "single-result-navigation";
      navigation.setAttribute("aria-label", "Definition navigation");

      resultsContainer.insertBefore(navigation, card);
    }

    // Move the existing Back to Results button into the left side.
    const backNavigation = Array.from(resultsContainer.children).find(
      (element) => element.classList?.contains("back-navigation"),
    );

    if (backNavigation) {
      navigation.prepend(backNavigation);
    }
  }

  function attachMultipleResultMyWordsStars(entries) {
    const cards = Array.from(
      resultsContainer.querySelectorAll(
        ".definition.multiple-results-definition:not(.word-list-header)",
      ),
    );

    cards.forEach((card, index) => {
      const entry = entries[index];

      // Ordbøkene fallback cards deliberately remain outside the local CSV
      // collection: My Words and its Firebase payload depend on the richer
      // local translation/CEFR fields. Keep the card layout, but do not offer
      // a star that would save an incomplete study entry.
      if (!entry || entry._ordbokene || card.dataset.source === "ordbokene") {
        return;
      }

      // Prevent duplicate stars if results are rendered again.
      card.querySelector(".multiple-results-my-words-star")?.remove();

      const starButton = document.createElement("button");
      const starIcon = document.createElement("i");
      const entryId = getMyWordsEntryId(entry);
      const word = String(entry.ord ?? "").trim();

      starButton.type = "button";
      starButton.className =
        "word-list-favorite-button multiple-results-my-words-star";

      starIcon.setAttribute("aria-hidden", "true");
      starButton.appendChild(starIcon);

      updateMyWordsButton(starButton, entryId, word);

      starButton.addEventListener("click", (event) => {
        // Do not open the definition when clicking the star.
        event.stopPropagation();

        toggleMyWordsEntry(entry);
        updateMyWordsButton(starButton, entryId, word);
      });

      starButton.addEventListener("keydown", (event) => {
        event.stopPropagation();
      });

      card.appendChild(starButton);
    });
  }

  function returnToWordList() {
    const { typeSelect, searchInput, posSelect, cefrSelect } =
      getWordListFilterElements();

    if (!typeSelect) {
      return;
    }

    const savedState = wordListReturnState || {
      search: "",
      pos: "",
      cefr: "",
      view: "all",
    };

    // Switch back to Word List.
    typeSelect.value = "word-list";
    handleTypeChange("word-list", { wordListView: savedState.view });

    /*
     * handleTypeChange() resets the filters, so restore the saved values
     * after calling it.
     */
    if (searchInput) {
      searchInput.value = savedState.search;
    }

    if (posSelect) {
      posSelect.value = savedState.pos;
    }

    if (cefrSelect) {
      cefrSelect.value = savedState.cefr;
    }

    // Render again using the restored search and filters.
    renderWordList();

    // Restore the Word List URL.
    updateURL(savedState.search, "word-list", savedState.pos, savedState.cefr);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function createWordListBackButton() {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "back-navigation word-list-back-navigation";

    const icon = document.createElement("i");
    icon.className = "fas fa-chevron-left";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createTextNode(" Back to Word List");

    button.append(icon, text);

    button.addEventListener("click", (event) => {
      /*
       * Prevent the existing multiple-results back-navigation handler
       * in scripts.js from processing this button.
       */
      event.stopPropagation();
      returnToWordList();
    });

    return button;
  }

  function openWordListDefinition(entry) {
    const word = String(entry.ord ?? "").trim();
    const english = String(entry.engelsk ?? "").trim();

    if (!word) {
      return;
    }

    const { typeSelect, searchInput, posSelect, cefrSelect } =
      getWordListFilterElements();

    if (!typeSelect || !searchInput) {
      return;
    }

    /*
     * Save the current Word List state before leaving it.
     */
    wordListReturnState = {
      search: searchInput.value,
      pos: posSelect ? posSelect.value : "",
      cefr: cefrSelect ? cefrSelect.value : "",
      view: activeWordListView,
    };

    /*
     * Switch to Words and perform the same search that would happen
     * if the user entered this word in the Words search field.
     */
    typeSelect.value = "words";
    searchInput.value = word;

    handleTypeChange("words");

    /*
     * At this point, the normal Words search has rendered either:
     *
     * 1. One complete definition, or
     * 2. Several multiple-result cards
     *
     * If several cards were returned, click the card matching the
     * Word List entry. This invokes the normal handleCardClick()
     * path used by the Words tab.
     */
    const resultCards = Array.from(
      resultsContainer.querySelectorAll(
        ".definition.multiple-results-definition",
      ),
    );

    if (resultCards.length > 0) {
      const normalizedWord = word.toLowerCase();
      const normalizedEnglish = english.toLowerCase();

      const matchingCard =
        resultCards.find((card) => {
          const cardWord = String(card.dataset.word ?? "")
            .trim()
            .toLowerCase();

          const cardEnglish = String(card.dataset.engelsk ?? "")
            .trim()
            .toLowerCase();

          return (
            cardWord === normalizedWord && cardEnglish === normalizedEnglish
          );
        }) ||
        resultCards.find((card) => {
          const cardWord = String(card.dataset.word ?? "")
            .trim()
            .toLowerCase();

          return cardWord === normalizedWord;
        });

      if (matchingCard) {
        /*
         * This runs the card's existing onclick code and therefore uses
         * handleCardClick(), displaySearchResults(), and the ordinary
         * sentence-loading sequence.
         */
        matchingCard.click();
      }
    }

    /*
     * The ordinary search or card-click path may have created its own
     * "Back to Results" button. Remove that because this visit came
     * from Word List.
     */
    resultsContainer
      .querySelectorAll(".back-navigation")
      .forEach((backElement) => {
        backElement.remove();
      });

    latestMultipleResults = null;

    /*
     * The search was necessary to use the normal Words loading path,
     * but the search field should be blank on the definition page.
     */
    searchInput.value = "";

    /*
     * Add the dedicated Word List return button after the normal Words
     * rendering has finished.
     */
    const backButton = createWordListBackButton();

    const navigation = resultsContainer.querySelector(
      ".single-result-navigation",
    );

    if (navigation) {
      navigation.prepend(backButton);
    } else {
      resultsContainer.insertBefore(backButton, resultsContainer.firstChild);
    }
    const primaryWord = String(entry.ord ?? "")
      .split(/[,、]/)[0]
      .trim();

    const entryPOS = getWordListEntryPOS(entry);
    const selectedCEFR = document.getElementById("cefr-select")
      ? document.getElementById("cefr-select").value.toUpperCase()
      : "";

    updateURL("", "words", entryPOS, selectedCEFR, null, primaryWord);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  /**
   * Create one vocabulary table row.
   */
  function createWordListRow(entry) {
    const row = document.createElement("tr");

    row.className = "word-list-row";

    const japaneseWord = String(entry.ord ?? "").trim();
    const englishTranslation = String(entry.engelsk ?? "").trim();
    const japaneseCell = createWordListCell(
      "",
      "word-list-japanese",
      "Japanese",
      { richContent: true },
    );

    const japaneseLink = document.createElement("a");
    const wordTextBlock = document.createElement("span");
    const spellings = japaneseWord
      .split(/[,、]/)
      .map((spelling) => spelling.trim())
      .filter(Boolean);

    japaneseLink.className = "word-list-word-link";
    japaneseLink.href = createWordListDefinitionURL(entry);
    japaneseLink.setAttribute(
      "aria-label",
      `Open the definition for ${japaneseWord}`,
    );

    wordTextBlock.className = "word-text-block";
    wordTextBlock.append(spellings[0] || japaneseWord);

    if (spellings.length > 1) {
      const alternateSpellings = document.createElement("span");

      alternateSpellings.className = "alt-spelling";
      alternateSpellings.textContent = spellings.slice(1).join(", ");
      wordTextBlock.appendChild(alternateSpellings);
    }

    japaneseLink.appendChild(wordTextBlock);

    /*
     * Preserve the existing single-page navigation for human users.
     * Search engines can still discover the real href above.
     */
    japaneseLink.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openWordListDefinition(entry);
    });

    japaneseCell.appendChild(japaneseLink);

    const englishCell = createWordListCell(
      englishTranslation,
      "word-list-english",
      "English",
    );

    japaneseCell.lang = "ja";
    englishCell.lang = "en";

    const wordClassCell = createWordListCell(
      "",
      "word-list-class",
      "Word Class",
      { richContent: true },
    );

    const wordClassBadge = document.createElement("span");

    /*
     * Reuse the exact classes from Words multiple results.
     */
    wordClassBadge.className =
      "gender multiple-results-gender-class word-list-class-badge";

    wordClassBadge.textContent = getWordListClassLabel(entry);

    wordClassCell.appendChild(wordClassBadge);

    const level = String(entry.CEFR ?? "")
      .trim()
      .toUpperCase();

    const levelCell = createWordListCell("", "word-list-level", "Level", {
      richContent: true,
    });

    if (level) {
      const levelBadge = document.createElement("span");

      /*
       * Reuse the exact CEFR classes already used by Words results:
       *
       * A1/A2 → easy
       * B1/B2 → medium
       * C     → hard
       */
      levelBadge.className = `game-cefr-label ${getCefrClass(level)}`;

      levelBadge.textContent = level;

      levelCell.appendChild(levelBadge);
    } else {
      levelCell.textContent = "—";
    }

    const strengthCell = createWordStrengthCell(entry);
    const myWordsCell = createMyWordsCell(entry);

    row.append(
      japaneseCell,
      englishCell,
      wordClassCell,
      levelCell,
      strengthCell,
      myWordsCell,
    );

    // Mouse and touchscreen activation.
    row.addEventListener("click", () => {
      openWordListDefinition(entry);
    });

    return row;
  }

  /**
   * Read the current search field and Word Class selection, then return
   * the matching entries.
   */
  function getFilteredWordListEntries() {
    const { searchInput, posSelect, cefrSelect, strengthSelect } =
      getWordListFilterElements();

    const searchText = normalizeWordListText(
      searchInput ? searchInput.value : "",
    );

    const selectedPOS = normalizeWordListText(posSelect ? posSelect.value : "");

    const selectedCEFR = String(cefrSelect ? cefrSelect.value : "")
      .trim()
      .toUpperCase();

    const selectedStrength = String(strengthSelect ? strengthSelect.value : "");

    if (!Array.isArray(results)) {
      return [];
    }

    return results
      .filter((entry) => {
        // Do not display an entry without a Japanese word.
        if (!normalizeWordListText(entry.ord)) {
          return false;
        }

        if (
          activeWordListView === "my" &&
          !myWordsEntryIds.has(getMyWordsEntryId(entry))
        ) {
          return false;
        }

        const matchesWordClass = wordListEntryMatchesPOS(entry, selectedPOS);

        const entryCEFR = String(entry.CEFR ?? "")
          .trim()
          .toUpperCase();

        const matchesLevel = !selectedCEFR || entryCEFR === selectedCEFR;

        if (!matchesWordClass || !matchesLevel) {
          return false;
        }

        if (
          selectedStrength &&
          window.WordGameHelpers?.getWordStrengthFilterId?.(entry) !==
            selectedStrength
        ) {
          return false;
        }

        // An empty search displays all entries matching the filters.
        if (!searchText) {
          return true;
        }

        const japanese = normalizeWordListText(entry.ord);
        const english = normalizeWordListText(entry.engelsk, "en");

        return (
          japanese.includes(searchText) ||
          english.includes(searchText) ||
          Boolean(
            window.JapaneseSearch?.matchesJapaneseQuery(entry, searchText),
          )
        );
      })
      .sort((firstEntry, secondEntry) => {
        if (
          activeWordListFrequencySort === "common-first" ||
          activeWordListFrequencySort === "rarest-first"
        ) {
          const frequencyComparison = compareByWordFrequency(
            firstEntry,
            secondEntry,
            activeWordListFrequencySort,
          );

          if (frequencyComparison !== 0) {
            return frequencyComparison;
          }
        }

        const japaneseComparison = japaneseCollator.compare(
          String(firstEntry.ord ?? ""),
          String(secondEntry.ord ?? ""),
        );

        if (japaneseComparison !== 0) {
          return japaneseComparison;
        }

        return japaneseCollator.compare(
          String(firstEntry.engelsk ?? ""),
          String(secondEntry.engelsk ?? ""),
        );
      });
  }

  // Ranks come from vocabulary-frequency.json (see wordGame.js), where rank 1
  // is the most common word and larger ranks are rarer. Entries missing from
  // that dataset (proper nouns, technical terms, anything below its corpus
  // cutoff) have no rank at all — those always sort after every ranked entry,
  // regardless of direction, rather than being guessed into either end.
  function compareByWordFrequency(firstEntry, secondEntry, direction) {
    const getRank = window.WordGameHelpers?.getVocabularyFrequencyRank;
    if (typeof getRank !== "function") return 0;

    const firstRank = getRank(firstEntry);
    const secondRank = getRank(secondEntry);

    if (firstRank === null && secondRank === null) return 0;
    if (firstRank === null) return 1;
    if (secondRank === null) return -1;

    return direction === "common-first"
      ? firstRank - secondRank
      : secondRank - firstRank;
  }

  /**
   * Add the Word List heading and result count.
   */
  function createWordListHeader(visibleCount) {
    const header = document.createElement("div");

    header.className =
      "definition multiple-results-definition word-list-header";

    const summary = document.createElement("div");
    summary.className = "word-list-header-summary";

    const copy = document.createElement("div");
    copy.className = "word-list-header-copy";

    const heading = document.createElement("h2");
    heading.className = "word-list-header-title";
    heading.textContent = activeWordListView === "my" ? "My Words" : "All Words";

    const description = document.createElement("p");
    description.className = "word-list-header-description";
    description.textContent =
      activeWordListView === "my"
        ? "Your personal vocabulary collection."
        : "Browse the dictionary and save words for later.";

    copy.append(heading, description);

    const count = document.createElement("strong");
    count.className = "word-list-header-count";
    const countValue =
      activeWordListView === "my" ? myWordsEntryIds.size : visibleCount;
    const countNoun = activeWordListView === "my" ? "saved word" : "word";
    count.textContent = `${countValue.toLocaleString("en-US")} ${countNoun}${
      countValue === 1 ? "" : "s"
    }`;

    summary.append(copy, count);
    header.append(summary, createWordListControls(visibleCount));

    return header;
  }

  /**
   * Create the empty-results message.
   */
  function createWordListEmptyMessage() {
    const message = document.createElement("div");
    message.className = "definition word-list-empty-state";

    const heading = document.createElement("h2");
    heading.className = "word-list-empty-heading";

    const explanation = document.createElement("p");
    explanation.className = "word-list-empty-copy";

    if (activeWordListView === "my" && myWordsEntryIds.size === 0) {
      heading.textContent = "No Saved Words Yet";
      explanation.textContent =
        "Select All Words and click a star to add a word to My Words.";
    } else {
      heading.textContent = "No Matching Words";
      explanation.textContent =
        "Try a different search, filter, or word-list view.";
    }

    message.append(heading, explanation);

    return message;
  }

  /**
   * Create the vocabulary table.
   */
  function createSharedWordList(entries = [], options = {}) {
    const tableContainer = document.createElement("div");
    tableContainer.className = [
      "word-list-table-container",
      options.containerClass,
    ]
      .filter(Boolean)
      .join(" ");

    const table = document.createElement("table");
    table.className = "word-list-table";
    table.setAttribute("aria-label", options.ariaLabel || "Vocabulary entries");

    const tableBody = document.createElement("tbody");
    if (options.bodyId) tableBody.id = options.bodyId;

    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => fragment.appendChild(createWordListRow(entry)));
    tableBody.appendChild(fragment);

    table.appendChild(tableBody);

    tableContainer.appendChild(table);

    if (options.onScroll) {
      tableContainer.addEventListener("scroll", options.onScroll);
    }

    return tableContainer;
  }

  function createWordListTable() {
    // The main My Words list fills this shared shell in lazy-loaded batches.
    return createSharedWordList([], {
      bodyId: "word-list-table-body",
      onScroll: handleWordListScroll,
    });
  }

  function appendNextWordListBatch() {
    if (wordListBatchIsLoading) {
      return;
    }

    if (renderedWordListCount >= activeWordListEntries.length) {
      return;
    }

    const tableBody = document.getElementById("word-list-table-body");

    if (!tableBody) {
      return;
    }

    wordListBatchIsLoading = true;

    const nextBatch = activeWordListEntries.slice(
      renderedWordListCount,
      renderedWordListCount + WORD_LIST_BATCH_SIZE,
    );

    const fragment = document.createDocumentFragment();

    nextBatch.forEach((entry) => {
      fragment.appendChild(createWordListRow(entry));
    });

    tableBody.appendChild(fragment);

    renderedWordListCount += nextBatch.length;
    wordListBatchIsLoading = false;
  }

  function handleWordListScroll(event) {
    const container = event.currentTarget;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    // Load another batch when the user is close to the bottom.
    if (distanceFromBottom <= 100) {
      appendNextWordListBatch();
    }
  }

  function downloadWordListFile(filename, content, mimeType) {
    /*
     * The UTF-8 marker helps spreadsheet programs display
     * æ, ø, and å correctly.
     */
    const utf8Content = "\uFEFF" + content;

    const blob = new Blob([utf8Content], {
      type: `${mimeType};charset=utf-8`,
    });

    const downloadURL = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = downloadURL;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(downloadURL);
  }

  function createWordListExportFilename(extension) {
    const { searchInput, posSelect, cefrSelect } = getWordListFilterElements();

    const search = String(searchInput?.value ?? "").trim();
    const wordClass = String(posSelect?.value ?? "").trim();
    const level = String(cefrSelect?.value ?? "").trim();

    const filenameParts = ["japanese-word-list"];

    if (wordClass) {
      filenameParts.push(wordClass);
    }

    if (level) {
      filenameParts.push(level.toLowerCase());
    }

    if (search) {
      const safeSearch = search
        .toLocaleLowerCase("ja-JP")
        .replace(/[^a-z0-9æøå]+/gi, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);

      if (safeSearch) {
        filenameParts.push(`search-${safeSearch}`);
      }
    }

    return `${filenameParts.join("-")}.${extension}`;
  }

  function cleanWordListExportValue(value) {
    return String(value ?? "")
      .replace(/\r?\n/g, " ")
      .trim();
  }

  function escapeWordListCSVValue(value) {
    const cleanedValue = cleanWordListExportValue(value);

    return `"${cleanedValue.replace(/"/g, '""')}"`;
  }

  function confirmWordListExport(format, entryCount) {
    const viewName = activeWordListView === "my" ? "My Words" : "All Words";

    const entryLabel = entryCount === 1 ? "entry" : "entries";

    const largePDFWarning =
      format === "PDF" && entryCount > 2000
        ? "\n\nThis is a large PDF and may take a while to prepare."
        : "";

    return window.confirm(
      `Export ${entryCount.toLocaleString()} ${entryLabel} ` +
        `from ${viewName} as ${format}?${largePDFWarning}`,
    );
  }

  function exportWordListCSV() {
    const entries = getFilteredWordListEntries();

    if (entries.length === 0) {
      return;
    }

    if (!confirmWordListExport("CSV", entries.length)) {
      return;
    }

    const rows = [["Japanese", "English", "Word Class", "Level"]];

    entries.forEach((entry) => {
      rows.push([
        entry.ord,
        entry.engelsk,
        getWordListClassLabel(entry),
        entry.CEFR,
      ]);
    });

    const csvContent = rows
      .map((row) => row.map(escapeWordListCSVValue).join(","))
      .join("\r\n");

    downloadWordListFile(
      createWordListExportFilename("csv"),
      csvContent,
      "text/csv",
    );
  }

  function escapeWordListTSVValue(value) {
    return cleanWordListExportValue(value).replace(/\t/g, " ");
  }

  function exportWordListTSV() {
    const entries = getFilteredWordListEntries();

    if (entries.length === 0) {
      return;
    }

    if (!confirmWordListExport("TSV", entries.length)) {
      return;
    }

    const rows = [["Japanese", "English", "Word Class", "Level"]];

    entries.forEach((entry) => {
      rows.push([
        entry.ord,
        entry.engelsk,
        getWordListClassLabel(entry),
        entry.CEFR,
      ]);
    });

    const tsvContent = rows
      .map((row) => row.map(escapeWordListTSVValue).join("\t"))
      .join("\r\n");

    downloadWordListFile(
      createWordListExportFilename("tsv"),
      tsvContent,
      "text/tab-separated-values",
    );
  }
  function createControlGroup(className, ariaLabel) {
    const group = document.createElement("div");

    group.className = `word-list-control-group ${className}`;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", ariaLabel);

    return group;
  }

  function createControlButton(label, onClick) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "word-list-export-button";
    button.textContent = label;

    if (typeof onClick === "function") {
      button.addEventListener("click", onClick);
    }

    return button;
  }

  // A dropdown that reorders the currently-visible rows by frequency rank
  // (vocabulary-frequency.json, loaded lazily — see
  // ensureVocabularyFrequencyLoaded below), without changing which rows
  // show. That's a sort, not a filter, so unlike Word Class/Level/Strength
  // — all static pills up in the shared selectors row — it lives down here
  // next to the My Words/All Words toggle, and is rebuilt on every
  // renderWordList() call the same way the toggle buttons' active state is.
  function createWordListFrequencySortGroup() {
    const group = createControlGroup(
      "word-list-sort-controls",
      "Sort by word frequency",
    );

    const wrapper = document.createElement("div");
    wrapper.className = "word-list-sort-select-wrapper";

    const select = document.createElement("select");
    select.id = "frequency-select";
    select.className = "word-list-sort-select";
    select.setAttribute("aria-label", "Sort by word frequency");

    [
      { value: "", label: "Frequency" },
      { value: "common-first", label: "Common First" },
      { value: "rarest-first", label: "Rarest First" },
    ].forEach(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });

    select.value = activeWordListFrequencySort;

    select.addEventListener("change", () => {
      activeWordListFrequencySort = select.value;
      renderWordList();
    });

    const chevron = document.createElement("i");
    chevron.className = "fas fa-chevron-down";
    chevron.setAttribute("aria-hidden", "true");

    wrapper.append(select, chevron);
    group.appendChild(wrapper);

    return group;
  }

  function createWordListControls(visibleCount) {
    const controls = document.createElement("div");
    controls.className = "word-list-controls";

    /*
     * View selection
     */
    const viewControls = createControlGroup(
      "word-list-view-controls",
      "Choose word-list view",
    );

    const allWordsButton = createControlButton("All Words", () => {
      if (activeWordListView === "all") {
        return;
      }

      activeWordListView = "all";
      renderWordList();
    });

    allWordsButton.classList.toggle("is-active", activeWordListView === "all");

    allWordsButton.setAttribute(
      "aria-pressed",
      String(activeWordListView === "all"),
    );

    const myWordsButton = createControlButton("My Words", () => {
      if (activeWordListView === "my") {
        return;
      }

      activeWordListView = "my";
      renderWordList();
    });

    myWordsButton.classList.toggle("is-active", activeWordListView === "my");

    myWordsButton.setAttribute(
      "aria-pressed",
      String(activeWordListView === "my"),
    );

    // My Words leads now that it's the default landing tab for this page
    // (see handleTypeChange's word-list branch in scripts.js).
    viewControls.append(myWordsButton, allWordsButton);
    controls.appendChild(viewControls);
    controls.appendChild(createWordListFrequencySortGroup());

    /*
     * My Words actions — hidden rather than shown disabled when there's
     * nothing yet for them to act on ("Save at least one word first" was
     * the only place that ever explained the disabled state, so a
     * first-time visitor just saw two greyed-out buttons with no
     * explanation at all).
     */
    if (activeWordListView === "my" && myWordsEntryIds.size > 0) {
      const myWordsActions = createControlGroup(
        "word-list-my-words-actions",
        "My Words actions",
      );

      const learnWordsButton = createControlButton("Learn Words", () => {
        selectType("word-game");
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      learnWordsButton.title = "Start the Word Game with My Words prioritized";

      const removeAllButton = createControlButton("Remove All Words", () => {
        const savedWordCount = myWordsEntryIds.size;

        if (savedWordCount === 0) {
          return;
        }

        const wordLabel = savedWordCount === 1 ? "saved word" : "saved words";

        const shouldRemoveAll = window.confirm(
          `Remove all ${savedWordCount} ${wordLabel} from My Words? ` +
            "This cannot be undone.",
        );

        if (!shouldRemoveAll) {
          return;
        }

        const removalTimestamp = Date.now();
        const removedEntryIds = Array.from(myWordsEntryIds);
        myWordsEntryIds.forEach((entryId) => {
          myWordsEntryTimestamps[entryId] = removalTimestamp;
        });
        myWordsEntryIds.clear();
        saveMyWordsEntryIds({ changedEntryIds: removedEntryIds });
        renderWordList();
      });

      removeAllButton.classList.add("is-danger");

      myWordsActions.append(learnWordsButton, removeAllButton);

      controls.appendChild(myWordsActions);
    }

    /*
     * Export actions — same "hide, don't disable" treatment as the My
     * Words actions above, for the same reason: nothing in the currently
     * visible list to export.
     */
    if (visibleCount > 0) {
      const exportControls = createControlGroup(
        "word-list-export-controls",
        "Export words",
      );

      const csvButton = createControlButton("Export CSV", exportWordListCSV);

      const tsvButton = createControlButton("Export TSV", exportWordListTSV);

      const pdfButton = createControlButton("Export PDF", exportWordListPDF);

      exportControls.append(csvButton, tsvButton, pdfButton);

      controls.appendChild(exportControls);
    }

    return controls;
  }

  // escapeHTML lives in scripts.js — this file runs before scripts.js at
  // load time (non-deferred vs. deferred), but by the time any of this
  // file's functions actually run (in response to user interaction), the
  // page has finished loading and scripts.js has already defined it.

  function exportWordListPDF() {
    const entries = getFilteredWordListEntries();

    if (entries.length === 0) {
      return;
    }

    if (!confirmWordListExport("PDF", entries.length)) {
      return;
    }

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
      window.alert(
        "The PDF window was blocked. Please allow pop-ups and try again.",
      );

      return;
    }

    /*
     * Prevent the new window from controlling the original page.
     */
    printWindow.opener = null;

    const filename = createWordListExportFilename("pdf");
    const documentTitle = filename.replace(/\.pdf$/i, "");

    const tableRows = entries
      .map(
        (entry) => `
        <tr>
          <td>${escapeHTML(entry.ord)}</td>
          <td>${escapeHTML(entry.engelsk)}</td>
          <td>${escapeHTML(getWordListClassLabel(entry))}</td>
          <td>${escapeHTML(entry.CEFR)}</td>
        </tr>
      `,
      )
      .join("");

    const printableDocument = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>${escapeHTML(documentTitle)}</title>

        <style>
          @page {
            size: A4;
            margin: 12mm;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            color: #222222;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 10pt;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
          }

          thead {
            display: table-header-group;
          }

          tr {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          th,
          td {
            padding: 7px 8px;
            border: 1px solid #cccccc;
            overflow-wrap: anywhere;
            text-align: left;
            vertical-align: top;
          }

          th {
            background-color: #eeeeee;
            font-size: 9pt;
            letter-spacing: 0.03em;
            text-transform: uppercase;
          }

          th:nth-child(1),
          td:nth-child(1) {
            width: 30%;
          }

          th:nth-child(2),
          td:nth-child(2) {
            width: 35%;
          }

          th:nth-child(3),
          td:nth-child(3) {
            width: 25%;
          }

          th:nth-child(4),
          td:nth-child(4) {
            width: 10%;
          }

          tbody tr:nth-child(even) {
            background-color: #f7f7f7;
          }
        </style>
      </head>

      <body>
        <table>
          <thead>
            <tr>
              <th>Japanese</th>
              <th>English</th>
              <th>Word Class</th>
              <th>Level</th>
            </tr>
          </thead>

          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </body>
    </html>
  `;

    printWindow.document.open();
    printWindow.document.write(printableDocument);
    printWindow.document.close();

    /*
     * The document contains no external resources, so a short delay
     * is sufficient before opening the print dialog.
     */
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 250);
  }

  /**
   * Render the complete Word List using the current search and Word Class.
   *
   * scripts.js calls this function whenever:
   * - The user performs a search
   * - The user clears the search
   * - The user changes Word Class
   */
  function renderWordList() {
    // Do not replace another tab's content.
    if (getCurrentMode() !== "word-list") {
      return;
    }

    showLandingCard(false);
    clearContainer();

    const panel = document.createElement("section");
    panel.id = "word-list";
    panel.className = "word-list";

    if (!Array.isArray(results) || results.length === 0) {
      const loadingMessage = document.createElement("div");
      loadingMessage.className = "definition";

      const heading = document.createElement("h2");
      heading.textContent = "Loading Vocabulary";

      const explanation = document.createElement("p");
      explanation.textContent =
        "The vocabulary data has not finished loading yet.";

      loadingMessage.append(heading, explanation);
      panel.appendChild(loadingMessage);
      resultsContainer.appendChild(panel);

      return;
    }

    const filteredEntries = getFilteredWordListEntries();

    // Reset batching whenever the search or filters change.
    activeWordListEntries = filteredEntries;
    renderedWordListCount = 0;
    wordListBatchIsLoading = false;

    panel.appendChild(createWordListHeader(filteredEntries.length));

    if (filteredEntries.length === 0) {
      panel.appendChild(createWordListEmptyMessage());
    } else {
      panel.appendChild(createWordListTable());
    }

    resultsContainer.appendChild(panel);

    // Display the first 100 matching entries.
    if (filteredEntries.length > 0) {
      appendNextWordListBatch();
    }
  }

  /**
   * Entry point called by handleTypeChange("word-list").
   */
  function initWordList() {
    if (getCurrentMode() !== "word-list") {
      return;
    }

    renderWordList();
    ensureVocabularyFrequencyLoaded();
  }

  // The Frequency select's ranks live in vocabulary-frequency.json, fetched
  // lazily by wordGame.js. Word List doesn't otherwise touch that file, so
  // without this the first "Common first"/"Rarest first" pick on a fresh
  // page load would render with the fetch still in flight (silently falling
  // back to alphabetical, via compareByWordFrequency's "not loaded yet"
  // guard) until some other feature happened to trigger the same load.
  function ensureVocabularyFrequencyLoaded() {
    const load = window.WordGameHelpers?.loadVocabularyFrequencyRanks;
    if (typeof load !== "function") return;

    load().then(() => {
      if (activeWordListFrequencySort && getCurrentMode() === "word-list") {
        renderWordList();
      }
    });
  }

  function resolveMyWordsEntry(entry) {
    if (!entry) {
      return null;
    }

    const sameValue = (first, second) =>
      String(first ?? "")
        .trim()
        .normalize("NFC") ===
      String(second ?? "")
        .trim()
        .normalize("NFC");

    /*
     * Most Word Game objects are the original result objects.
     */
    const identicalEntry = results.find((candidate) => candidate === entry);

    if (identicalEntry) {
      return identicalEntry;
    }

    /*
     * Reintroduced Word Game objects may contain only a subset of the
     * original entry's properties — try the most specific field set first,
     * then fall back to a looser one that drops "engelsk".
     */
    const fieldTiers = [
      ["ord", "engelsk", "gender", "CEFR"],
      ["ord", "gender", "CEFR"],
    ];

    for (const fields of fieldTiers) {
      const match = results.find((candidate) =>
        fields.every((field) => sameValue(candidate[field], entry[field])),
      );

      if (match) {
        return match;
      }
    }

    return entry;
  }

  function isMyWordsEntrySaved(entry) {
    const resolvedEntry = resolveMyWordsEntry(entry);

    if (!resolvedEntry) {
      return false;
    }

    return myWordsEntryIds.has(getMyWordsEntryId(resolvedEntry));
  }

  function toggleResolvedMyWordsEntry(entry) {
    const resolvedEntry = resolveMyWordsEntry(entry);

    if (!resolvedEntry) {
      return null;
    }

    toggleMyWordsEntry(resolvedEntry);

    return isMyWordsEntrySaved(resolvedEntry);
  }

  // Make these functions available to scripts.js.
  window.initWordList = initWordList;
  window.renderWordList = renderWordList;
  window.attachSingleResultMyWordsControls = attachSingleResultMyWordsControls;
  window.attachMultipleResultMyWordsStars = attachMultipleResultMyWordsStars;
  window.goToAllWords = goToAllWords;
  window.goToMyWords = goToMyWords;
  window.MyWordsAPI = Object.freeze({
    STORAGE_KEY: MY_WORDS_STORAGE_KEY,
    getSavedEntries: getSavedWordStudyEntries,
    returnToMyWords: goToMyWords,
    isSaved: isMyWordsEntrySaved,
    toggle: toggleResolvedMyWordsEntry,
    getEntryIds: () => Array.from(myWordsEntryIds),
    getEntryTimestamps: () => ({ ...myWordsEntryTimestamps }),
    reconcileEntryIds: reconcileMyWordsEntryIds,
    migrateEntryIds: migrateMyWordsEntryIds,
  });
  window.WordStrengthAPI = Object.freeze({
    STORAGE_KEY: WORD_STRENGTH_STORAGE_KEY,
    recordResult: recordWordStrengthResult,
    getAll: () => window.SpacedRepetition.cloneCollection(wordStrengths),
    replaceAll: replaceWordStrengths,
    mergeAll: mergeWordStrengths,
    mergeCollections: window.SpacedRepetition.mergeCollections,
    // Direct O(1) lookup, valid only for canonical `results` entries (not
    // resolved/partial copies) — the Word Game always hands over the
    // original entry reference, so this is safe for that caller.
    get: (entry) => {
      return window.SpacedRepetition.getSnapshot(
        wordStrengths[getMyWordsEntryId(entry)],
      ).strength;
    },
    getRecord: (entry) =>
      window.SpacedRepetition.cloneMemory(
        wordStrengths[getMyWordsEntryId(entry)] || null,
      ),
    getSnapshot: (entry, now = Date.now()) =>
      window.SpacedRepetition.getSnapshot(
        wordStrengths[getMyWordsEntryId(entry)],
        now,
      ),
    getSkillSnapshot: (entry, skill, now = Date.now()) =>
      window.SpacedRepetition.getSkillSnapshot(
        wordStrengths[getMyWordsEntryId(entry)],
        skill,
        now,
      ),
  });
  // Lets other views (e.g. the word game's round summary) render a word
  // entry in the exact same row style as the Word List / My Words tables,
  // rather than duplicating that markup.
  window.WordListAPI = Object.freeze({
    createRow: createWordListRow,
    createList: createSharedWordList,
    // Resolves a WordStrengthAPI entryId back to its dictionary entry —
    // used by myStats.js, which only has entryIds (from iterating
    // WordStrengthAPI.getAll()) and needs the full entry to render a row
    // or look up its strength. Reuses the same cached id->entry index
    // getSavedWordStudyEntries() already relies on for My Words.
    getEntryById: (entryId) => getEntriesByIdIndex().get(entryId) ?? null,
    // Sets which of the All Words / My Words tabs the next renderWordList()
    // call shows, without any of openWordList()'s other side effects
    // (clearing search/filters, scrolling) — used by scripts.js's
    // handleTypeChange to default the plain "My Words" menu entry to the
    // My Words tab. See the comment at that call site for why this is a
    // separate function rather than openWordList itself.
    setActiveView: (view) => {
      activeWordListView = view === "my" ? "my" : "all";
    },
  });
})();
