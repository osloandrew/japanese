// Whether Japanese sentence examples show their English translation. This
// is a single flag shared by Sentence Search, Pronunciation practice, and
// Stories alike (previously each screen tracked its own, independent flag,
// so toggling it in one place had no effect on the others). Defaults to
// visible. Persisted to localStorage. Ported from norwegian/englishVisibility.js;
// Japanese has no account-sync layer yet (no myWordsAuth.js), so the
// "english-visibility:updated" event below currently has no listener — it's
// wired up ready for when My Words sign-in/sync is ported over.
const ENGLISH_VISIBLE_STORAGE_KEY = "japanese-dictionary-show-english-v1";

function loadEnglishVisible() {
  try {
    const storedValue = window.localStorage.getItem(
      ENGLISH_VISIBLE_STORAGE_KEY,
    );
    return storedValue === null ? true : storedValue === "true";
  } catch (error) {
    return true;
  }
}

let isEnglishVisible = loadEnglishVisible();

// The single place that changes isEnglishVisible. Persists locally and
// notifies listeners (via "english-visibility:updated") so other screens
// stay in sync. syncRemote is false when applying a value that just came
// from elsewhere (a remote merge/snapshot), so it isn't immediately written
// straight back — currently unused locally, kept for parity with Norwegian.
function setEnglishVisible(value, { syncRemote = true } = {}) {
  isEnglishVisible = Boolean(value);
  try {
    window.localStorage.setItem(
      ENGLISH_VISIBLE_STORAGE_KEY,
      String(isEnglishVisible),
    );
  } catch (error) {
    console.warn("English visibility could not be saved.", error);
  }

  window.dispatchEvent(
    new CustomEvent("english-visibility:updated", {
      detail: { isEnglishVisible, syncRemote },
    }),
  );
}

window.EnglishVisibilityAPI = Object.freeze({
  getState: () => isEnglishVisible,
  replaceState: (value) => setEnglishVisible(value, { syncRemote: false }),
});
