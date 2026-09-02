(function () {
  "use strict";

  /**
   * Fill these in with your Firebase project's config, from:
   * Firebase console > Project settings > General > Your apps > SDK setup and configuration.
   * These values are public client identifiers, not secrets, so it's fine to commit them.
   */
  const FIREBASE_CONFIG = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
  };

  // Google's OAuth 2.0 web client ID for this Firebase project (Firebase
  // console > Authentication > Sign-in method > Google > Web SDK
  // configuration). Public, like FIREBASE_CONFIG above — safe to commit.
  // Used to drive Google Identity Services directly (see
  // requestGoogleAccessToken()) instead of Firebase's own
  // signInWithPopup/signInWithRedirect, which both route through a full
  // top-level navigation to/from this project's authDomain. On iOS Safari
  // and Chrome, that hop crosses a third-party origin from the app's own
  // (github.io) origin, and iOS's Intelligent Tracking Prevention partitions
  // storage across it — the sign-in completes on Google's side (password,
  // 2FA and all) but the result never makes it back. GIS's token client
  // keeps the whole exchange inside a popup Google itself manages and
  // delivers the result to a JS callback on this page, without depending on
  // storage written on a third-party origin surviving the round trip.
  const GOOGLE_OAUTH_CLIENT_ID = "YOUR_GOOGLE_OAUTH_CLIENT_ID";

  // The Firebase SDK (~3 blocking scripts) is only needed by the minority of
  // visitors who actually sign in. Loading it eagerly on every pageview was
  // blocking initial paint for everyone else. Instead it's fetched lazily,
  // either on the first click of "Sign in" or, for someone who has signed in
  // on this browser before, immediately on load so their session still
  // restores silently like it used to.
  // SRI hashes pin these to the exact bytes served for 10.14.1 at the time
  // they were added, so a compromised/altered CDN response fails to load
  // rather than running unverified code. Bump both the version in the URL
  // and its hash together if this ever gets upgraded.
  const FIREBASE_SCRIPT_URLS = [
    {
      src: "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
      integrity:
        "sha384-ZaR6mWzmJtrRibZ1Vm7SoHFr8OXjyAuGAXalGDKqbxFT18oi/z+oZLIRFkpeNor1",
    },
    {
      src: "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js",
      integrity:
        "sha384-I1LYojsZ5RM1cOda44Z2h42Qa6YfsQ1XkXxREnhp4ueYBR/4d1pG1K+NZM537Vsj",
    },
    {
      src: "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js",
      integrity:
        "sha384-Ke0FJhH7LyRqDxZ0wt+/OXV38yfQVu7g9VPEEGjYmB4RVOY/ta04uecRhsMwT7V3",
    },
  ];
  const WAS_SIGNED_IN_KEY = "japanese-dictionary-was-signed-in-v1";
  // Email a sign-in link was sent to, written just before sendSignInLinkToEmail
  // resolves. Read back by completeEmailLinkSignIn() when the link is opened
  // in the same browser; cleared once that sign-in attempt finishes either
  // way. If it's opened in a different browser (or this was cleared), the
  // visitor is re-prompted for it instead — see promptForEmailLinkConfirmation.
  const PENDING_EMAIL_LINK_KEY = "japanese-dictionary-pending-email-link-v1";
  // Superseded by SIGNIN_NUDGE_STATE_KEY below, which tracks re-nudging by
  // milestone instead of a single ever-shown flag — read once, at startup,
  // purely to migrate a visitor who already saw the old one-shot nudge (see
  // loadSignInNudgeState).
  const SIGNIN_NUDGE_SHOWN_KEY = "japanese-dictionary-signin-nudge-shown-v1";
  const SIGNIN_NUDGE_STATE_KEY = "japanese-dictionary-signin-nudge-state-v1";

  // Re-nudge thresholds: the nudge originally fired once, ever, after the
  // first completed round. That meant a visitor who dismissed it in their
  // first five minutes — before they had anything worth losing — was never
  // asked again, even after building a real streak or word list. Instead,
  // each dimension has its own milestone ladder; crossing a new rung on
  // either one is a fresh occasion to ask, since it's a fresh amount of
  // progress that's now at risk of being lost to a cleared cache. 1 is the
  // first rung so the original "first completed round" trigger still fires
  // the same as before.
  const SIGNIN_NUDGE_STREAK_MILESTONES = [1, 3, 7, 14, 30, 60, 100];
  const SIGNIN_NUDGE_WORD_COUNT_MILESTONES = [5, 15, 30, 60, 100];
  // Even a new, higher milestone won't re-show the banner sooner than this
  // after it was last shown — otherwise a visitor who happens to cross two
  // thresholds in one sitting (e.g. finishes a round that both extends their
  // streak past 7 and pushes My Words past 15) would see it twice in a row.
  const SIGNIN_NUDGE_MIN_RESHOW_GAP_MS = 3 * 24 * 60 * 60 * 1000;

  const PUSH_DEBOUNCE_MS = 300;

  // A resource-exhausted (quota) error means the Firestore SDK already
  // auto-retried the failing transaction several times with backoff. Left
  // alone, every subsequent local edit schedules another transaction that
  // goes through the same retry cycle, hammering an already-over-budget
  // quota and flooding the console. Once that error is seen, pushes are
  // deferred until this cooldown elapses instead of being attempted
  // immediately — the underlying data stays queued (dirty flag/pending
  // patches are untouched) so nothing is lost, it just waits.
  const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;

  const isFirebaseConfigured =
    Boolean(FIREBASE_CONFIG.apiKey) && FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";

  const signInButton = document.getElementById("google-signin-btn");
  const signOutButton = document.getElementById("google-signout-btn");
  const userInfo = document.getElementById("auth-user-info");
  const userName = document.getElementById("auth-user-name");
  const syncStatus = document.getElementById("sync-status");
  const signInNudgeBanner = document.getElementById("signin-nudge-banner");
  const signInNudgeSignInButton = document.getElementById(
    "signin-nudge-signin-btn",
  );
  const signInNudgeDismissButton = document.getElementById(
    "signin-nudge-dismiss-btn",
  );

  // --- TEMPORARY diagnostic overlay for the Chrome-iOS home-screen sign-in
  // bug. Enable by visiting the app with ?authdebug=1 in the URL — writes a
  // readable, on-screen log of every step the sign-in flow takes. Chrome for
  // iOS has no remote-debugging console available, so this is the only
  // practical way to see what actually happens there. Does nothing unless
  // the query param is present. Safe to delete once the bug is diagnosed.
  let authDebugEnabled = false;
  try {
    authDebugEnabled =
      new URLSearchParams(window.location.search).get("authdebug") === "1";
  } catch (error) {
    // Ignore — overlay just stays off.
  }
  let authDebugPanel = null;
  let authDebugTextNode = null;
  const authDebugLines = [];
  function authDebugLog(message) {
    if (!authDebugEnabled) return;
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    authDebugLines.push(line);
    console.info("[authdebug]", message);
    if (!authDebugPanel && document.body) {
      authDebugPanel = document.createElement("div");
      authDebugPanel.style.cssText =
        "position:fixed;inset:auto 0 0 0;max-height:45vh;overflow:auto;" +
        "background:#000;color:#0f0;font:11px/1.4 monospace;padding:8px;" +
        "z-index:999999;white-space:pre-wrap;word-break:break-all;";
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.textContent = "Copy log";
      copyButton.style.cssText =
        "position:sticky;top:0;float:right;margin-left:8px;";
      copyButton.addEventListener("click", () => {
        navigator.clipboard?.writeText(authDebugLines.join("\n")).catch(() => {});
      });
      authDebugPanel.appendChild(copyButton);
      authDebugTextNode = document.createElement("div");
      authDebugPanel.appendChild(authDebugTextNode);
      document.body.appendChild(authDebugPanel);
    }
    if (authDebugTextNode) authDebugTextNode.textContent = authDebugLines.join("\n");
  }

  if (!isFirebaseConfigured) {
    console.warn(
      "My Words sync is disabled: add your Firebase config to myWordsAuth.js.",
    );

    if (signInButton) {
      signInButton.disabled = true;
      signInButton.title = "Google sign-in is not configured yet.";
    }

    return;
  }

  let auth = null;
  let db = null;
  let googleTokenClient = null;
  let currentUserId = null;
  let progressPushTimeoutId = null;
  let profilePushTimeoutId = null;
  let wasSignedInThisSession = false;
  let quotaCooldownUntil = 0;

  function noteQuotaExhausted() {
    quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
  }

  function isQuotaCoolingDown() {
    return Date.now() < quotaCooldownUntil;
  }

  const SIGN_IN_READY_TITLE = "Sign in to sync My Words across devices";
  const SIGN_IN_LOADING_TITLE = "Preparing sign-in…";

  // Google Identity Services' requestAccessToken() must run directly inside
  // a trusted click, same constraint signInWithPopup used to have. If the
  // SDKs are first downloaded from that click and the prompt starts only
  // after the download promise resolves, installed web apps and stricter
  // mobile browsers treat it as an unsolicited popup and block it. Keep both
  // entry points disabled until Auth is ready so their eventual click can
  // open Google's prompt synchronously.
  function setSignInControlsReady(isReady) {
    for (const button of [signInButton, signInNudgeSignInButton]) {
      if (!button) continue;
      button.disabled = !isReady;
      button.title = isReady ? SIGN_IN_READY_TITLE : SIGN_IN_LOADING_TITLE;
    }
  }

  setSignInControlsReady(false);

  // Sign-in no longer branches on standalone/installed status — see
  // GOOGLE_OAUTH_CLIENT_ID's comment above for why signInWithPopup/Redirect
  // (and therefore this detection) were replaced. Kept only to label the
  // load-time authDebugLog line below, so a future report of trouble in some
  // other installed-web-app context still shows what environment it was.
  let launchedFromHomeScreen = false;
  try {
    launchedFromHomeScreen =
      new URLSearchParams(window.location.search).get("utm_source") === "pwa";
  } catch (error) {
    // Ignore — falls back to the live standalone checks below.
  }

  function isStandaloneDisplayMode() {
    return (
      window.navigator.standalone === true ||
      (window.matchMedia?.("(display-mode: standalone)")?.matches ?? false) ||
      launchedFromHomeScreen
    );
  }

  authDebugLog(
    `load: ua="${navigator.userAgent}" navigator.standalone=${window.navigator.standalone} ` +
      `displayModeStandalone=${window.matchMedia?.("(display-mode: standalone)")?.matches} ` +
      `launchedFromHomeScreen=${launchedFromHomeScreen} isStandaloneDisplayMode=${isStandaloneDisplayMode()}`,
  );

  // Words/streak/ability data saved locally must not leak into whichever
  // account signs in next on a shared device — mergeRemoteData() below
  // unions local state into the new account's cloud doc on next sign-in,
  // so a stale local cache here would silently attribute one person's
  // words/streak to someone else. Cleared only on an actual sign-out
  // (wasSignedInThisSession guards against wiping a guest's local-only
  // progress on a page load where no session was ever established), then
  // the page reloads so every module's in-memory state — streak badge,
  // word list, ability/daily-practice caches — starts clean rather than
  // continuing to display data that's no longer stored.
  // The my-words/word-strength/favorite-stories keys are read from their
  // owning modules (loaded earlier — see index.html) rather than duplicated
  // as literals, so a future rename there can't silently stop being cleared
  // here. The remaining keys belong to modules that load after this one
  // (wordGame.js, streak.js), so those stay literal.
  const LOCAL_USER_DATA_KEYS = [
    window.MyWordsAPI.STORAGE_KEY,
    window.WordStrengthAPI.STORAGE_KEY,
    "japanese-dictionary-streak-v1",
    "japanese-dictionary-ability-v1",
    "japanese-dictionary-game-level-v1",
    "japanese-dictionary-daily-practice-v2",
    "japanese-dictionary-best-word-streak-v1",
    window.StoryFavoritesAPI.STORAGE_KEY,
  ];

  function clearLocalUserDataAndReload() {
    try {
      LOCAL_USER_DATA_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      // Best-effort only — if storage is unavailable there's nothing to clear.
    }
    window.location.reload();
  }

  // Deliberately a narrower list than LOCAL_USER_DATA_KEYS above: "reset my
  // progress" (myStats.js's Danger Zone button) means the learner's own
  // vocabulary progress, not stories they bookmarked to read later or the
  // show/hide-English display preference — neither of which the "learning"
  // status this feature exists to clear away has anything to do with.
  const PROGRESS_RESET_STORAGE_KEYS = [
    window.MyWordsAPI.STORAGE_KEY,
    window.WordStrengthAPI.STORAGE_KEY,
    "japanese-dictionary-streak-v1",
    "japanese-dictionary-ability-v1",
    "japanese-dictionary-game-level-v1",
    "japanese-dictionary-daily-practice-v2",
    "japanese-dictionary-best-word-streak-v1",
  ];

  // Wipes every word/streak/quest record this account has, remotely first
  // (when signed in) and only then locally — reversing that order would let
  // the next realtime sync tick pull the still-intact remote copy straight
  // back down (mergeRemoteData treats "more progress" as authoritative, so a
  // freshly-cleared local zero would just lose that race). Shard docs are
  // set() to an empty payload rather than deleted: firestore.rules can't
  // authorize a delete (its checks read request.resource.data, which is
  // null on delete), and an empty payload satisfies the same write rule a
  // normal progress push does. Throws (without touching local storage) if
  // any remote write fails, so a partial failure can't masquerade as a
  // completed reset — the caller is expected to surface that to the user.
  async function resetAllProgress() {
    const userId = currentUserId;

    if (userId && db) {
      const shardResets = [];
      for (let index = 0; index < window.ProgressSharding.SHARD_COUNT; index++) {
        const shardId = String(index).padStart(2, "0");
        shardResets.push(
          getProgressShardsRef(userId)
            .doc(shardId)
            .set({
              schemaVersion: window.ProgressSharding.SCHEMA_VERSION,
              payload: window.ProgressSharding.serializePayload(
                window.ProgressSharding.emptyPayload(),
              ),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }),
        );
      }
      await trackWrite(
        Promise.all(shardResets),
        "Progress could not be reset.",
      );

      // abilityScore/placementCompleted are deleted outright (an account
      // that's never taken the placement test has no such fields at all)
      // rather than set to a placeholder, so a future sign-in treats this
      // account exactly like a brand-new one for difficulty calibration.
      await trackWrite(
        getUserDocRef(userId).set(
          {
            abilityScore: firebase.firestore.FieldValue.delete(),
            placementCompleted: firebase.firestore.FieldValue.delete(),
            streak: {
              count: 0,
              longestCount: 0,
              lastActiveDate: null,
              graceUsed: false,
              freezeDate: null,
            },
            dailyPractice: window.DailyQuestAPI?.normalize?.(null) ?? {},
            bestWordStreak: 0,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
        "Progress could not be reset.",
      );

      window.clearTimeout(progressPushTimeoutId);
      window.clearTimeout(profilePushTimeoutId);
      progressPushTimeoutId = null;
      profilePushTimeoutId = null;
      pendingShardPatches = {};
      clearProgressDirty(userId);
    }

    try {
      PROGRESS_RESET_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      // Best-effort only — if storage is unavailable there's nothing to clear.
    }
    window.location.reload();
  }

  function loadFirebaseScripts() {
    return FIREBASE_SCRIPT_URLS.reduce(
      (chain, { src, integrity }) =>
        chain.then(
          () =>
            new Promise((resolve, reject) => {
              const script = document.createElement("script");
              script.src = src;
              script.integrity = integrity;
              script.crossOrigin = "anonymous";
              script.onload = resolve;
              script.onerror = () =>
                reject(new Error(`Failed to load ${src}`));
              document.head.appendChild(script);
            }),
        ),
      Promise.resolve(),
    );
  }

  // Google Identity Services' client script. Unlike FIREBASE_SCRIPT_URLS
  // above, Google does not publish versioned URLs or support Subresource
  // Integrity for this one — it's meant to always be loaded from this exact
  // unversioned address so it can change server-side without every
  // integrating site breaking. No integrity hash to pin here as a result.
  const GOOGLE_IDENTITY_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

  function loadGoogleIdentityScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error(`Failed to load ${GOOGLE_IDENTITY_SCRIPT_SRC}`));
      document.head.appendChild(script);
    });
  }

  let authReadyPromise = null;

  // Loads the SDKs (once) and wires up auth. Safe to call multiple times —
  // the sign-in click handler and the "was signed in before" auto-load path
  // both call this, and only the first call does any work.
  function ensureAuthReady() {
    if (!authReadyPromise) {
      authReadyPromise = Promise.all([
        loadFirebaseScripts(),
        loadGoogleIdentityScript(),
      ])
        .then(() => {
          if (typeof firebase === "undefined") {
            throw new Error("Firebase failed to load.");
          }
          if (typeof google === "undefined") {
            throw new Error("Google Identity Services failed to load.");
          }
          initAuth();
        })
        .catch((error) => {
          // Permit a later retry after a transient network/CDN failure.
          authReadyPromise = null;
          throw error;
        });
    }

    return authReadyPromise;
  }

  function prepareAuth() {
    setSignInControlsReady(false);
    return ensureAuthReady()
      .then(() => {
        setSignInControlsReady(true);
      })
      .catch((error) => {
        console.warn("Google sign-in could not be prepared.", error);
        // Leave the controls disabled: clicking an unprepared control would
        // only recreate the browser-blocked delayed-popup behavior.
      });
  }

  function getUserDocRef(userId) {
    return db.collection("myWordsUsers").doc(userId);
  }

  function getProgressShardsRef(userId) {
    return getUserDocRef(userId).collection("progressShards");
  }

  function defaultSignInNudgeState() {
    return {
      highestStreakMilestoneShown: 0,
      highestWordCountMilestoneShown: 0,
      lastShownAt: 0,
    };
  }

  // A visitor who already saw the old one-shot nudge shouldn't immediately
  // see it again just because this shipped — that flag becomes "milestone 1
  // already shown, as of now" (starting the re-show cooldown fresh) rather
  // than being ignored.
  function loadSignInNudgeState() {
    try {
      const stored = localStorage.getItem(SIGNIN_NUDGE_STATE_KEY);
      if (stored) {
        return { ...defaultSignInNudgeState(), ...JSON.parse(stored) };
      }

      if (localStorage.getItem(SIGNIN_NUDGE_SHOWN_KEY) === "1") {
        return {
          ...defaultSignInNudgeState(),
          highestStreakMilestoneShown: 1,
          lastShownAt: Date.now(),
        };
      }
    } catch (error) {
      // Fall through to the default below.
    }

    return defaultSignInNudgeState();
  }

  function saveSignInNudgeState(state) {
    try {
      localStorage.setItem(SIGNIN_NUDGE_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      // Best-effort only — worst case, it re-shows sooner than intended.
    }
  }

  // The highest milestone in `milestones` that `value` has reached, or 0 if
  // none have.
  function highestMilestoneReached(value, milestones) {
    let highest = 0;
    for (const milestone of milestones) {
      if (value >= milestone) highest = milestone;
    }
    return highest;
  }

  // Called after every completed/ended word-game round (see this module's
  // caller in wordGame.js). Shows the "sign in to keep this safe" banner
  // again each time the visitor crosses a new streak or My Words milestone
  // — not just once, ever — since each milestone represents a fresh amount
  // of local-only progress now at risk from a cleared cache. Uses
  // WAS_SIGNED_IN_KEY rather than currentUserId to decide "already signed
  // in" — currentUserId is still null for a moment while a returning user's
  // session silently restores (Firebase loads async), and this avoids
  // nudging them during that window.
  function maybeShowSignInNudge() {
    if (!signInNudgeBanner) {
      return;
    }

    let alreadySignedIn = true;
    let state = defaultSignInNudgeState();
    try {
      alreadySignedIn = localStorage.getItem(WAS_SIGNED_IN_KEY) === "1";
      state = loadSignInNudgeState();
    } catch (error) {
      // If localStorage is unavailable, err toward not nagging.
      return;
    }

    if (alreadySignedIn || currentUserId) {
      return;
    }

    const streakCount = window.StreakAPI?.getState?.()?.count ?? 0;
    const wordCount = window.MyWordsAPI?.getEntryIds?.()?.length ?? 0;
    const streakMilestone = highestMilestoneReached(
      streakCount,
      SIGNIN_NUDGE_STREAK_MILESTONES,
    );
    const wordCountMilestone = highestMilestoneReached(
      wordCount,
      SIGNIN_NUDGE_WORD_COUNT_MILESTONES,
    );
    const reachedNewMilestone =
      streakMilestone > state.highestStreakMilestoneShown ||
      wordCountMilestone > state.highestWordCountMilestoneShown;
    const cooldownElapsed =
      state.lastShownAt === 0 ||
      Date.now() - state.lastShownAt >= SIGNIN_NUDGE_MIN_RESHOW_GAP_MS;

    if (!reachedNewMilestone || !cooldownElapsed) {
      return;
    }

    saveSignInNudgeState({
      highestStreakMilestoneShown: Math.max(
        state.highestStreakMilestoneShown,
        streakMilestone,
      ),
      highestWordCountMilestoneShown: Math.max(
        state.highestWordCountMilestoneShown,
        wordCountMilestone,
      ),
      lastShownAt: Date.now(),
    });

    window.trackEvent?.("sign_in_nudge_shown", {
      streak_milestone: streakMilestone,
      word_count_milestone: wordCountMilestone,
      is_first_time: state.lastShownAt === 0,
    });

    signInNudgeBanner.classList.remove("hidden");
  }

  function dismissSignInNudge() {
    signInNudgeBanner?.classList.add("hidden");
  }

  // Firestore write failures used to be console.warn-only — invisible to
  // the user, who'd have no idea their changes weren't reaching their
  // account. This surfaces a small, non-alarming indicator (nothing is
  // actually lost; localStorage is always the source of truth) and clears
  // itself the moment any write succeeds again.
  let pendingFailureCount = 0;

  function showSyncStatusError() {
    pendingFailureCount++;
    syncStatus?.classList.remove("hidden");
  }

  function clearSyncStatusError() {
    pendingFailureCount = Math.max(0, pendingFailureCount - 1);
    if (pendingFailureCount === 0) {
      syncStatus?.classList.add("hidden");
    }
  }

  const inFlightWrites = new Set();
  let pendingShardPatches = {};
  let pendingProfile = {};
  let progressBatchesInFlight = 0;
  let abilityCloudPending = false;
  let abilityRevision = 0;
  const LAST_USER_ID_KEY = "japanese-dictionary-last-user-id-v1";
  const PROGRESS_DIRTY_KEY_PREFIX = "japanese-dictionary-progress-dirty-v2:";
  const GUEST_PROGRESS_DIRTY_KEY =
    "japanese-dictionary-guest-progress-dirty-v2";

  function rememberedUserId() {
    try {
      return localStorage.getItem(LAST_USER_ID_KEY);
    } catch (error) {
      return null;
    }
  }

  function setProgressDirty(userId, isDirty) {
    try {
      const key = userId
        ? PROGRESS_DIRTY_KEY_PREFIX + userId
        : GUEST_PROGRESS_DIRTY_KEY;
      if (isDirty) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch (error) {
      // Best effort. Explicit sign-out still awaits in-memory writes.
    }
  }

  function isProgressDirty(userId) {
    try {
      return (
        localStorage.getItem(PROGRESS_DIRTY_KEY_PREFIX + userId) === "1" ||
        localStorage.getItem(GUEST_PROGRESS_DIRTY_KEY) === "1"
      );
    } catch (error) {
      return true;
    }
  }

  function clearProgressDirty(userId) {
    setProgressDirty(userId, false);
    try {
      localStorage.removeItem(GUEST_PROGRESS_DIRTY_KEY);
    } catch (error) {
      // Best effort; a stale flag only causes one extra full merge.
    }
  }

  function mergeStrengthRecord(localValue, remoteValue) {
    return (
      window.SpacedRepetition?.mergeRecordValues?.(localValue, remoteValue) ??
      (window.ProgressSharding.getStrengthTimestamp(remoteValue) >
      window.ProgressSharding.getStrengthTimestamp(localValue)
        ? remoteValue
        : localValue)
    );
  }

  function trackWrite(promise, failureLabel) {
    let tracked;
    tracked = promise
      .then((value) => {
        clearSyncStatusError();
        return value;
      })
      .catch((error) => {
        console.warn(failureLabel, error);
        showSyncStatusError();
        if (error?.code === "resource-exhausted") {
          noteQuotaExhausted();
        }
        throw error;
      })
      .finally(() => inFlightWrites.delete(tracked));
    inFlightWrites.add(tracked);
    // Timer/pagehide callers cannot await. This prevents an unhandled
    // rejection while flushPendingPushes() and explicit sign-out still can.
    tracked.catch(() => {});
    return tracked;
  }

  function pushShardPatchNow(userId, shardId, patch) {
    const shardRef = getProgressShardsRef(userId).doc(shardId);
    return trackWrite(
      db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(shardRef);
        const current = snapshot.exists
          ? window.ProgressSharding.parsePayload(snapshot.data().payload)
          : window.ProgressSharding.emptyPayload();
        const merged = window.ProgressSharding.mergePayload(
          current,
          patch,
          mergeStrengthRecord,
        );
        transaction.set(
          shardRef,
          {
            schemaVersion: window.ProgressSharding.SCHEMA_VERSION,
            // A JSON string deliberately prevents Firestore from indexing a
            // field for every vocabulary entry inside the payload.
            payload: window.ProgressSharding.serializePayload(merged),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }),
      "Progress could not be synced.",
    );
  }

  function drainPendingShardPatches(userId) {
    const patches = pendingShardPatches;
    pendingShardPatches = {};
    if (!userId || Object.keys(patches).length === 0) return Promise.resolve();
    progressBatchesInFlight++;
    return Promise.all(
      Object.entries(patches).map(([shardId, patch]) =>
        pushShardPatchNow(userId, shardId, patch),
      ),
    )
      .catch((error) => {
        // Keep a retryable copy in memory and the durable dirty marker. Some
        // shards may already have committed, but replaying them is idempotent.
        for (const [shardId, patch] of Object.entries(patches)) {
          pendingShardPatches[shardId] = window.ProgressSharding.mergePayload(
            patch,
            pendingShardPatches[shardId],
            mergeStrengthRecord,
          );
        }
        setProgressDirty(userId, true);
        throw error;
      })
      .finally(() => {
        progressBatchesInFlight--;
      })
      .then(() => {
        if (
          progressBatchesInFlight === 0 &&
          Object.keys(pendingShardPatches).length === 0
        ) {
          clearProgressDirty(userId);
        }
      });
  }

  function scheduleProgressPush(options, { defer = false } = {}) {
    const targetUserId = currentUserId || rememberedUserId();
    setProgressDirty(targetUserId, true);
    if (!currentUserId) return;
    const patches = window.ProgressSharding.buildShardPatches(options);
    for (const [shardId, patch] of Object.entries(patches)) {
      pendingShardPatches[shardId] = window.ProgressSharding.mergePayload(
        pendingShardPatches[shardId],
        patch,
        mergeStrengthRecord,
      );
    }

    if (defer) return;

    const userId = currentUserId;
    window.clearTimeout(progressPushTimeoutId);
    progressPushTimeoutId = window.setTimeout(
      function attemptDrain() {
        if (isQuotaCoolingDown()) {
          progressPushTimeoutId = window.setTimeout(
            attemptDrain,
            QUOTA_COOLDOWN_MS,
          );
          return;
        }
        progressPushTimeoutId = null;
        drainPendingShardPatches(userId).catch(() => {});
      },
      PUSH_DEBOUNCE_MS,
    );
  }

  function pushProfileNow(userId, profile) {
    if (!userId || Object.keys(profile).length === 0) return Promise.resolve();
    return trackWrite(
      getUserDocRef(userId).set(
        {
          ...profile,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
      "Profile progress could not be synced.",
    );
  }

  function pushProfileWithAbilityTracking(userId, profile, revision) {
    return pushProfileNow(userId, profile).then((value) => {
      if (
        Object.prototype.hasOwnProperty.call(profile, "abilityScore") &&
        revision === abilityRevision
      ) {
        abilityCloudPending = false;
      }
      return value;
    });
  }

  // Ability, streak, and daily-quest updates all happen while a round
  // summary is being assembled. Combining partials here makes that one
  // Firestore write instead of three independent writes.
  function scheduleProfilePush(partial) {
    if (!currentUserId) return;
    if (Object.prototype.hasOwnProperty.call(partial, "abilityScore")) {
      abilityCloudPending = true;
      abilityRevision++;
    }
    pendingProfile = { ...pendingProfile, ...partial };
    const userId = currentUserId;
    window.clearTimeout(profilePushTimeoutId);
    profilePushTimeoutId = window.setTimeout(
      function attemptPush() {
        if (isQuotaCoolingDown()) {
          profilePushTimeoutId = window.setTimeout(
            attemptPush,
            QUOTA_COOLDOWN_MS,
          );
          return;
        }
        profilePushTimeoutId = null;
        const profile = pendingProfile;
        pendingProfile = {};
        const revision = abilityRevision;
        pushProfileWithAbilityTracking(userId, profile, revision).catch(() => {
          pendingProfile = { ...profile, ...pendingProfile };
        });
      },
      PUSH_DEBOUNCE_MS,
    );
  }

  // Explicit sign-out awaits this function. A pagehide can only make a
  // best-effort start, but still bypasses the debounce window.
  async function flushPendingPushes() {
    const userId = currentUserId;
    if (!userId) return;

    window.clearTimeout(progressPushTimeoutId);
    window.clearTimeout(profilePushTimeoutId);
    progressPushTimeoutId = null;
    profilePushTimeoutId = null;

    const writes = [...inFlightWrites];
    if (Object.keys(pendingShardPatches).length > 0) {
      writes.push(drainPendingShardPatches(userId));
    }
    if (Object.keys(pendingProfile).length > 0) {
      const profile = pendingProfile;
      pendingProfile = {};
      writes.push(
        pushProfileWithAbilityTracking(userId, profile, abilityRevision).catch(
          (error) => {
            pendingProfile = { ...profile, ...pendingProfile };
            throw error;
          },
        ),
      );
    }

    const results = await Promise.allSettled(writes);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingPushes();
    }
  });
  window.addEventListener("pagehide", flushPendingPushes);

  let unsubscribeRealtimeSync = null;
  let unsubscribeProgressSync = null;
  const PROGRESS_CURSOR_KEY_PREFIX =
    "japanese-dictionary-progress-cursor-v2:";

  function loadProgressCursor(userId) {
    try {
      const value = Number(localStorage.getItem(PROGRESS_CURSOR_KEY_PREFIX + userId));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
      return 0;
    }
  }

  function saveProgressCursor(userId, value) {
    if (!Number.isFinite(value) || value <= 0) return;
    try {
      localStorage.setItem(PROGRESS_CURSOR_KEY_PREFIX + userId, String(value));
    } catch (error) {
      // Best effort; losing the cursor only causes a full shard read next time.
    }
  }

  function timestampMillis(value) {
    return typeof value?.toMillis === "function" ? value.toMillis() : 0;
  }

  function applyProgressSnapshots(userId, snapshots) {
    const payloads = [];
    let newestTimestamp = loadProgressCursor(userId);
    snapshots.forEach((snapshot) => {
      if (!snapshot.exists || snapshot.metadata?.hasPendingWrites) return;
      const data = snapshot.data();
      payloads.push(window.ProgressSharding.parsePayload(data.payload));
      newestTimestamp = Math.max(newestTimestamp, timestampMillis(data.updatedAt));
    });
    if (payloads.length === 0) return newestTimestamp;

    const progress = window.ProgressSharding.combineShardDocuments(
      payloads,
      mergeStrengthRecord,
    );
    window.MyWordsAPI?.reconcileEntryIds?.(
      progress.entryIds,
      progress.entryTimestamps,
    );
    window.WordStrengthAPI?.mergeAll?.(progress.strengths);
    saveProgressCursor(userId, newestTimestamp);
    return newestTimestamp;
  }

  // Keeps this tab in sync with changes made on *other* signed-in devices,
  // without waiting for a page reload here. Firestore's own snapshot
  // metadata is what makes this safe against feedback loops: while our own
  // debounced write is still in flight, the snapshot we get back is marked
  // hasPendingWrites:true (it's just our own optimistic local echo) and is
  // skipped; only a server-confirmed snapshot is applied. Applying our own
  // just-confirmed write back to local state is a harmless no-op since the
  // values already match — no extra "is this really a remote change"
  // bookkeeping needed on top of that.
  //
  // entryIds/wordStrengths/abilityScore/streak/dailyPractice are each
  // pushed independently on their own debounce timer, so a snapshot can be
  // server-confirmed for (say) a wordStrengths write while an entryIds
  // change made moments earlier is still sitting unsent in its own 300ms
  // window — that snapshot's entryIds would then be stale. reconcileEntryIds
  // resolves this the same way it resolves the sign-in merge: per-word
  // last-write-wins, so a stale remote snapshot can't stomp a newer local
  // change (and a genuinely newer remote change still wins).
  function attachRealtimeSync(userId, cursor = loadProgressCursor(userId)) {
    unsubscribeRealtimeSync?.();
    unsubscribeProgressSync?.();

    unsubscribeRealtimeSync = getUserDocRef(userId).onSnapshot(
      (snapshot) => {
        if (userId !== currentUserId) {
          return; // Stale listener from a previous sign-in.
        }

        if (!snapshot.exists || snapshot.metadata.hasPendingWrites) {
          return;
        }

        const data = snapshot.data();

        if (Number.isFinite(data.abilityScore) && !abilityCloudPending) {
          window.WordGameHelpers?.replaceAbility?.(
            data.abilityScore,
            data.placementCompleted,
          );
        }

        if (data.streak && typeof data.streak === "object") {
          window.StreakAPI?.replaceState?.(data.streak);
        }

        if (data.dailyPractice && typeof data.dailyPractice === "object") {
          window.DailyQuestAPI?.replaceState?.(data.dailyPractice);
        }

        if (Number.isFinite(data.bestWordStreak)) {
          window.BestWordStreakAPI?.replaceState?.(data.bestWordStreak);
        }

        if (typeof data.showEnglish === "boolean") {
          window.EnglishVisibilityAPI?.replaceState?.(data.showEnglish);
        }

        if (typeof data.favoriteStoriesPayload === "string") {
          window.StoryFavoritesAPI?.reconcile?.(data.favoriteStoriesPayload);
        }
      },
      (error) => {
        console.warn("Live sync for My Words was interrupted.", error);
      },
    );

    // Re-open from one millisecond before the persisted high-water mark.
    // This may re-read a shard at the boundary but cannot miss two server
    // timestamps that happened inside the same millisecond.
    let query = getProgressShardsRef(userId);
    if (cursor > 0) {
      query = query.where(
        "updatedAt",
        ">",
        firebase.firestore.Timestamp.fromMillis(Math.max(0, cursor - 1)),
      );
    }
    unsubscribeProgressSync = query.onSnapshot(
      (snapshot) => {
        if (userId !== currentUserId) return;
        applyProgressSnapshots(
          userId,
          snapshot.docChanges().map((change) => change.doc),
        );
      },
      (error) => console.warn("Live progress sync was interrupted.", error),
    );
  }

  // Reconcile the words already saved on this device with whatever is saved
  // under the signed-in account, using per-word last-write-wins (see
  // reconcileEntryIds in wordList.js) rather than a flat union — a plain
  // union of two id arrays can only ever grow, so it can't represent "this
  // word was removed" and will silently resurrect a word removed on one
  // side just before the other side's stale copy gets merged in. This also
  // runs unconditionally on every sign-in (including a returning user's
  // silent session restore, not just an explicit sign-in click), so it
  // doubles as the retry for any local change made in the brief window
  // before auth finished restoring and schedulePush had a user to push to.
  // Review records merge by their latest answer timestamp; unlike the old
  // Math.max strength merge, this preserves a newer lapse instead of
  // reviving an obsolete mastery score.
  async function mergeRemoteData(userId) {
    try {
      const snapshot = await getUserDocRef(userId).get();
      const remoteData = snapshot.exists ? snapshot.data() : {};
      const mergedStoryFavoritesPayload =
        window.StoryFavoritesAPI?.reconcile?.(
          remoteData.favoriteStoriesPayload,
        ) ?? window.StoryFavoritesAPI?.getPayload?.();

      const hasShardedProgress =
        remoteData.progressSchemaVersion >= window.ProgressSharding.SCHEMA_VERSION;
      const storedCursor = loadProgressCursor(userId);
      const progressDirty = isProgressDirty(userId);
      let shardQuery = getProgressShardsRef(userId);
      if (hasShardedProgress && storedCursor > 0 && !progressDirty) {
        shardQuery = shardQuery.where(
          "updatedAt",
          ">",
          firebase.firestore.Timestamp.fromMillis(Math.max(0, storedCursor - 1)),
        );
      }
      const shardSnapshot = await shardQuery.get();
      const shardPayloads = shardSnapshot.docs.map((document) =>
        window.ProgressSharding.parsePayload(document.data().payload),
      );
      let newestCursor = storedCursor;
      shardSnapshot.docs.forEach((document) => {
        newestCursor = Math.max(
          newestCursor,
          timestampMillis(document.data().updatedAt),
        );
      });

      // Version-1 progress lived in two large fields on the profile doc.
      // Fold it into the same merge input until migration has committed.
      const legacyEntryIds = Array.isArray(remoteData.entryIds)
        ? remoteData.entryIds
        : [];
      const legacyEntryTimestamps =
        remoteData.entryTimestamps &&
        typeof remoteData.entryTimestamps === "object"
          ? remoteData.entryTimestamps
          : {};
      const legacyStrengths =
        remoteData.wordStrengths && typeof remoteData.wordStrengths === "object"
          ? remoteData.wordStrengths
          : {};
      const normalizedLegacyTimestamps = { ...legacyEntryTimestamps };
      legacyEntryIds.forEach((entryId) => {
        if (!Number.isFinite(normalizedLegacyTimestamps[entryId])) {
          normalizedLegacyTimestamps[entryId] = 0;
        }
      });
      const legacyPatches = window.ProgressSharding.buildShardPatches({
        entryIds: legacyEntryIds,
        entryTimestamps: normalizedLegacyTimestamps,
        strengths: legacyStrengths,
      });
      const remoteProgress = window.ProgressSharding.combineShardDocuments(
        [...shardPayloads, ...Object.values(legacyPatches)],
        mergeStrengthRecord,
      );

      const reconciledEntries = window.MyWordsAPI?.reconcileEntryIds?.(
        remoteProgress.entryIds,
        remoteProgress.entryTimestamps,
      ) ?? {
        entryIds: window.MyWordsAPI?.getEntryIds?.() ?? [],
        entryTimestamps: window.MyWordsAPI?.getEntryTimestamps?.() ?? {},
      };

      const remoteStrengths = remoteProgress.strengths;
      const localStrengths = window.WordStrengthAPI?.getAll?.() ?? {};
      const mergedStrengths =
        window.WordStrengthAPI?.mergeCollections?.(
          localStrengths,
          remoteStrengths,
        ) ?? localStrengths;

      // Ability is a single continuous value, not a set or a per-word map.
      // Prefer whichever side actually has a completed placement over a
      // raw unplaced default; once both are placed (or neither is), take
      // the higher estimate, the same "more progress wins" spirit the old
      // ordinal-level merge used.
      const localAbility = window.WordGameHelpers?.getAbilityScore?.();
      const localPlacementCompleted =
        window.WordGameHelpers?.isPlacementCompleted?.() ?? false;
      const remoteAbility = Number.isFinite(remoteData.abilityScore)
        ? remoteData.abilityScore
        : null;
      const remotePlacementCompleted = Boolean(remoteData.placementCompleted);

      let mergedAbility;
      let mergedPlacementCompleted;

      if (remoteAbility === null) {
        mergedAbility = localAbility;
        mergedPlacementCompleted = localPlacementCompleted;
      } else if (localAbility === null) {
        mergedAbility = remoteAbility;
        mergedPlacementCompleted = remotePlacementCompleted;
      } else if (localPlacementCompleted !== remotePlacementCompleted) {
        mergedAbility = localPlacementCompleted ? localAbility : remoteAbility;
        mergedPlacementCompleted = true;
      } else {
        mergedAbility = Math.max(localAbility, remoteAbility);
        mergedPlacementCompleted = localPlacementCompleted;
      }

      // Streak isn't a set or a max-per-key map either — it's a single
      // running count tied to a specific last-active date, so the side with
      // the more recent lastActiveDate is the one whose count/graceUsed
      // actually reflects reality. "YYYY-MM-DD" strings sort correctly with
      // plain comparison. On a same-day tie, keep the higher count (in case
      // one device already recorded today's activity and the other hasn't)
      // and treat the grace day as spent if either side spent it.
      const remoteStreak =
        remoteData.streak && typeof remoteData.streak === "object"
          ? remoteData.streak
          : {};
      const localStreak = window.StreakAPI?.getState?.() ?? {};
      const remoteLastActive = remoteStreak.lastActiveDate ?? "";
      const localLastActive = localStreak.lastActiveDate ?? "";
      const latestFreezeDate =
        (remoteStreak.freezeDate ?? "") > (localStreak.freezeDate ?? "")
          ? remoteStreak.freezeDate
          : localStreak.freezeDate ?? null;

      let mergedStreak;

      if (remoteLastActive === localLastActive) {
        mergedStreak = {
          count: Math.max(remoteStreak.count ?? 0, localStreak.count ?? 0),
          lastActiveDate: localLastActive || null,
          graceUsed: Boolean(remoteStreak.graceUsed) || Boolean(localStreak.graceUsed),
          freezeDate: latestFreezeDate,
        };
      } else if (remoteLastActive > localLastActive) {
        mergedStreak = {
          count: remoteStreak.count ?? 0,
          lastActiveDate: remoteLastActive,
          graceUsed: Boolean(remoteStreak.graceUsed),
          freezeDate: latestFreezeDate,
        };
      } else {
        mergedStreak = {
          count: localStreak.count ?? 0,
          lastActiveDate: localLastActive || null,
          graceUsed: Boolean(localStreak.graceUsed),
          freezeDate: latestFreezeDate,
        };
      }

      mergedStreak.longestCount = Math.max(
        remoteStreak.longestCount ?? 0,
        localStreak.longestCount ?? 0,
        mergedStreak.count,
      );

      // Daily quests reset every calendar day, so unlike streak's
      // lastActiveDate comparison, remote progress only counts when it's
      // for *today* — DailyQuestAPI.normalize resets completedRounds to 0
      // for any other date, same as a stale local read would. Within
      // today, completed rounds are earned in order, so the higher count
      // is strictly more progress and always safe to take. gemCounts is a
      // set of lifetime per-gem totals instead (My Stats' "Gems earned"),
      // not scoped to today at all, but the same max-of-both logic still
      // applies per gem type — each count only ever goes up, so the higher
      // of the two devices' counts is always the more complete one. Spent
      // counts follow the same monotonic shape and are merged independently
      // so a redeemed streak freeze survives a sign-in merge as well.
      const remoteDailyPractice =
        remoteData.dailyPractice && typeof remoteData.dailyPractice === "object"
          ? remoteData.dailyPractice
          : {};
      const localDailyPractice = window.DailyQuestAPI?.getState?.() ?? {
        date: null,
        completedRounds: 0,
        gemCounts: {},
      };
      const normalizedRemoteDailyPractice =
        window.DailyQuestAPI?.normalize?.(remoteDailyPractice) ?? {
          completedRounds: 0,
          gemCounts: {},
        };
      const mergedGemCounts = {};
      const mergedSpentGemCounts = {};
      for (const reward of new Set([
        ...Object.keys(localDailyPractice.gemCounts ?? {}),
        ...Object.keys(normalizedRemoteDailyPractice.gemCounts ?? {}),
      ])) {
        mergedGemCounts[reward] = Math.max(
          localDailyPractice.gemCounts?.[reward] ?? 0,
          normalizedRemoteDailyPractice.gemCounts?.[reward] ?? 0,
        );
        mergedSpentGemCounts[reward] = Math.min(
          mergedGemCounts[reward],
          Math.max(
            localDailyPractice.spentGemCounts?.[reward] ?? 0,
            normalizedRemoteDailyPractice.spentGemCounts?.[reward] ?? 0,
          ),
        );
      }
      const mergedDailyPractice =
        window.DailyQuestAPI?.normalize?.({
          date: localDailyPractice.date,
          completedRounds: Math.max(
            localDailyPractice.completedRounds ?? 0,
            normalizedRemoteDailyPractice.completedRounds ?? 0,
          ),
          gemCounts: mergedGemCounts,
          spentGemCounts: mergedSpentGemCounts,
        }) ?? localDailyPractice;

      // A personal-best record, same "only ever grows" shape as streak's
      // longestCount — the higher of the two devices' values is always the
      // more complete one.
      const mergedBestWordStreak = Math.max(
        Number(remoteData.bestWordStreak) || 0,
        window.BestWordStreakAPI?.getState?.() ?? 0,
      );

      // A plain display preference, not per-word progress, so there's no
      // "more progress wins" comparison to make — whichever side actually
      // has a value in the account doc wins (it reflects a real choice made
      // on some device), falling back to this device's local value only if
      // the account has never recorded one yet.
      const remoteShowEnglish =
        typeof remoteData.showEnglish === "boolean"
          ? remoteData.showEnglish
          : null;
      const mergedShowEnglish =
        remoteShowEnglish === null
          ? (window.EnglishVisibilityAPI?.getState?.() ?? true)
          : remoteShowEnglish;

      // entryIds/entryTimestamps were already reconciled and saved above,
      // via reconcileEntryIds — nothing further to apply here.
      window.WordStrengthAPI?.replaceAll?.(mergedStrengths);
      if (mergedAbility !== null && mergedAbility !== undefined) {
        window.WordGameHelpers?.replaceAbility?.(
          mergedAbility,
          mergedPlacementCompleted,
        );
      }
      window.StreakAPI?.replaceState?.(mergedStreak);
      window.DailyQuestAPI?.replaceState?.(mergedDailyPractice);
      window.BestWordStreakAPI?.replaceState?.(mergedBestWordStreak);
      window.EnglishVisibilityAPI?.replaceState?.(mergedShowEnglish);

      // First use of the sharded format on an account/browser seeds the
      // merged local state. Later sessions read and write only changed
      // shards, which is the normal low-usage path.
      if (!hasShardedProgress || storedCursor === 0 || progressDirty) {
        const mergedPatches = window.ProgressSharding.buildShardPatches({
          entryIds: reconciledEntries.entryIds,
          entryTimestamps: reconciledEntries.entryTimestamps,
          strengths: mergedStrengths,
        });
        await Promise.all(
          Object.entries(mergedPatches).map(([shardId, patch]) =>
            pushShardPatchNow(userId, shardId, patch),
          ),
        );
        clearProgressDirty(userId);
      }

      if (!hasShardedProgress) {
        // Only declare migration complete after every shard write succeeds.
        // Deleting these two legacy fields prevents the root document from
        // continuing to approach Firestore's 1 MiB document ceiling.
        await trackWrite(
          getUserDocRef(userId).set(
            {
              progressSchemaVersion: window.ProgressSharding.SCHEMA_VERSION,
              entryIds: firebase.firestore.FieldValue.delete(),
              entryTimestamps: firebase.firestore.FieldValue.delete(),
              wordStrengths: firebase.firestore.FieldValue.delete(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          ),
          "Progress migration could not be finalized.",
        );
      }

      await pushProfileNow(userId, {
        ...(mergedAbility !== null && mergedAbility !== undefined
          ? {
              abilityScore: mergedAbility,
              placementCompleted: mergedPlacementCompleted,
            }
          : {}),
        streak: mergedStreak,
        dailyPractice: mergedDailyPractice,
        bestWordStreak: mergedBestWordStreak,
        showEnglish: mergedShowEnglish,
        ...(typeof mergedStoryFavoritesPayload === "string"
          ? { favoriteStoriesPayload: mergedStoryFavoritesPayload }
          : {}),
      });
      saveProgressCursor(userId, newestCursor);
      return newestCursor;
    } catch (error) {
      console.warn("Your saved words could not be loaded from your account.", error);
      return loadProgressCursor(userId);
    }
  }

  function updateAuthUI(user) {
    if (user) {
      signInButton?.classList.add("hidden");
      userInfo?.classList.remove("hidden");
      dismissSignInNudge();

      if (userName) {
        userName.textContent = user.displayName || user.email || "Signed in";
      }

      // The Google "G" badge is only accurate for a Google-signed-in user —
      // wrong (and a little confusing) for an email-link one. Detecting
      // "is Google present" is all this needs; it doesn't depend on
      // knowing the exact provider id string Email Link itself reports.
      const isGoogleUser = Boolean(
        user.providerData?.some((entry) => entry.providerId === "google.com"),
      );
      userInfo
        ?.querySelector(".auth-google-logo")
        ?.classList.toggle("hidden", !isGoogleUser);
      userInfo
        ?.querySelector(".auth-generic-logo")
        ?.classList.toggle("hidden", isGoogleUser);
      userInfo?.classList.toggle("non-google-provider", !isGoogleUser);
    } else {
      signInButton?.classList.remove("hidden");
      userInfo?.classList.add("hidden");
    }
  }

  function rememberSignedInState(isSignedIn, userId = null) {
    try {
      if (isSignedIn) {
        localStorage.setItem(WAS_SIGNED_IN_KEY, "1");
        if (userId) localStorage.setItem(LAST_USER_ID_KEY, userId);
      } else {
        localStorage.removeItem(WAS_SIGNED_IN_KEY);
        localStorage.removeItem(LAST_USER_ID_KEY);
      }
    } catch (error) {
      // Best-effort only — worst case, Firebase loads on click instead of
      // automatically restoring the session next visit.
    }
  }

  // Shared by both the popup's resolved result and the redirect result
  // picked up after the page comes back from Google — same funnel-tracking
  // moment either way, as opposed to onAuthStateChanged firing again for a
  // returning session.
  function trackSignInResult(result, method = "Google") {
    const isNewUser = Boolean(result?.additionalUserInfo?.isNewUser);
    window.trackEvent?.(isNewUser ? "sign_up" : "login", { method });
    // Retain the existing event during migration so current reports do
    // not break while the recommended GA4 events begin collecting.
    window.trackEvent?.("sign_in_completed", { is_new_user: isNewUser });
  }

  // auth/popup-blocked is the one failure where we know exactly what went
  // wrong and what the user can do about it — Safari's ITP, Brave, and any
  // ad blocker with popup blocking all land here. Naming it directly beats
  // the generic message, which left that (common) user stuck with no idea
  // sign-in even attempted anything. `context` defaults to the original
  // Google-only wording so every existing bare `.catch(alertSignInFailure)`
  // reference keeps working unchanged; the email-link path passes its own.
  function alertSignInFailure(error, context = "Google sign-in") {
    console.warn(`${context} failed.`, error);
    if (
      error?.code === "auth/popup-blocked" ||
      error?.code === "popup_failed_to_open"
    ) {
      window.alert(
        "Your browser blocked the Google sign-in popup. Please allow pop-ups for this site and try again.",
      );
    } else {
      window.alert(`${context} failed. Please try again.`);
    }
  }

  // Wraps Google Identity Services' callback-based OAuth token flow in a
  // promise triggerSignIn() below can await. error_callback fires for
  // problems with the popup itself (blocked, or closed before completing);
  // the main callback's own `error` field fires when the flow completed but
  // the user declined consent.
  function requestGoogleAccessToken() {
    return new Promise((resolve, reject) => {
      if (!googleTokenClient) {
        reject(new Error("Google Identity Services was not ready."));
        return;
      }
      googleTokenClient.callback = (response) => {
        if (response.error) {
          reject(
            Object.assign(new Error(response.error), { code: response.error }),
          );
        } else {
          resolve(response.access_token);
        }
      };
      googleTokenClient.error_callback = (error) => {
        reject(
          Object.assign(new Error(error?.type || "unknown"), {
            code: error?.type,
          }),
        );
      };
      googleTokenClient.requestAccessToken();
    });
  }

  // `linkCredential`, when passed, attaches an AuthCredential from a
  // *different* provider (e.g. a pending email-link credential) to the
  // account this call signs into — see handleAccountExistsWithDifferentCredential.
  async function triggerSignIn({ linkCredential } = {}) {
    authDebugLog("triggerSignIn: requesting Google access token via GIS…");
    let accessToken;
    try {
      accessToken = await requestGoogleAccessToken();
    } catch (error) {
      authDebugLog(
        `requestGoogleAccessToken: rejected code=${error?.code} message=${error?.message}`,
      );
      if (error?.code !== "popup_closed" && error?.code !== "access_denied") {
        alertSignInFailure(error);
      }
      return;
    }
    authDebugLog("requestGoogleAccessToken: resolved");

    const credential = firebase.auth.GoogleAuthProvider.credential(
      null,
      accessToken,
    );
    try {
      const result = await auth.signInWithCredential(credential);
      authDebugLog(`signInWithCredential: resolved uid=${result?.user?.uid}`);
      if (linkCredential) {
        await result.user.linkWithCredential(linkCredential);
      }
      trackSignInResult(result);
    } catch (error) {
      authDebugLog(
        `signInWithCredential: rejected code=${error?.code} message=${error?.message}`,
      );
      if (error?.code === "auth/account-exists-with-different-credential") {
        handleAccountExistsWithDifferentCredential(error, "google.com");
        return;
      }
      alertSignInFailure(error);
    }
  }

  function handleInteractiveSignIn(source, button) {
    window.trackEvent?.("sign_in_started", { source });
    button.disabled = true;

    // Auth is prepared before either sign-in control is enabled. Keeping this
    // guard makes a future markup/state regression fail safely without trying
    // to open a delayed popup outside the user gesture.
    if (!auth) {
      console.warn("Google sign-in was clicked before Auth was ready.");
      prepareAuth();
      return;
    }

    // Deliberately invoked synchronously from the click handler. Do not put an
    // SDK-loading promise before this call: browsers would block the popup.
    triggerSignIn().finally(() => {
      button.disabled = false;
    });
  }

  // --- Email link (passwordless) sign-in + account linking -------------
  //
  // Firebase does not, by itself, guarantee that signing in with Google and
  // signing in via an email link for the same address land in the same
  // account — that requires (a) "Link accounts that use the same email" set
  // in the Firebase Console (Authentication > Settings > User account
  // linking), and (b) the logic below. Two guards, because Firebase's
  // collision behavior differs by direction:
  //  - checkEmailForExistingProvider() is the *load-bearing* guard for
  //    "already has Google, tries email link": Email Link and Email/Password
  //    share Firebase's "password" provider family, and that family's own
  //    sign-in call does not reliably throw the same collision error an
  //    OAuth attempt does — so this is checked proactively, before a link is
  //    ever sent, rather than relied on as a catch afterward.
  //  - handleAccountExistsWithDifferentCredential() is the load-bearing
  //    guard for the reverse direction ("already has an email-link account,
  //    tries Google") — auth/account-exists-with-different-credential is a
  //    well-documented, reliable error from signInWithPopup/signInWithRedirect
  //    in that case. It's also wired into the email-link completion path
  //    below as defense-in-depth, though it's not expected to reliably fire
  //    from there for the reasons above.

  let authDialogTriggerElement = null;
  let authDialogDismissResolver = null;

  function handleAuthDialogKeydown(event) {
    if (event.key === "Escape") {
      closeAuthDialog();
      return;
    }

    // Mirrors handleFeedbackDialogKeydown's manual Tab-cycle: aria-modal
    // claims the background is inert, but nothing enforces that for a
    // sighted keyboard user without this.
    if (event.key === "Tab") {
      const dialog = document.querySelector(".auth-dialog");
      if (!dialog) return;

      const focusable = dialog.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  // Symmetric to closeFeedbackDialog() in scripts.js, for the same
  // single-dialog-at-a-time invariant across both dialog families — see
  // openAuthDialogShell()'s call to window.closeFeedbackDialog?.().
  function closeAuthDialog() {
    const overlay = document.querySelector(".auth-dialog-overlay");
    if (!overlay) return;

    overlay.remove();
    document.removeEventListener("keydown", handleAuthDialogKeydown);

    if (
      authDialogTriggerElement &&
      typeof authDialogTriggerElement.focus === "function"
    ) {
      authDialogTriggerElement.focus();
    }
    authDialogTriggerElement = null;

    // Lets a promise-returning dialog (promptForEmailLinkConfirmation) settle
    // as "cancelled" when it's dismissed via Escape/backdrop click rather
    // than its own Cancel button — otherwise that promise would hang
    // forever. Callers that already settled it themselves clear this first,
    // so it's a no-op for them.
    const resolver = authDialogDismissResolver;
    authDialogDismissResolver = null;
    resolver?.();
  }

  // Builds an empty overlay+dialog shell, appended to <body>, and returns
  // the dialog element for the caller to fill in — mirrors
  // openFeedbackDialog()'s shape (role="dialog", aria-modal, focus trap,
  // focus restored to `triggerElement` on close) without importing from
  // scripts.js, since this needs direct access to `auth`/`googleTokenClient`,
  // both private to this file's closure (and scripts.js loads after this file
  // anyway, so a reverse dependency isn't available).
  //
  // The overlay/dialog carry both the shared .feedback-dialog* classes
  // (for the existing visual rules) and their own .auth-dialog* classes,
  // so this family's own close/focus-trap logic can query for exactly its
  // own dialog without colliding with an open feedback dialog, and vice
  // versa.
  function openAuthDialogShell(triggerElement) {
    closeAuthDialog();
    window.closeFeedbackDialog?.();

    authDialogTriggerElement = triggerElement || null;

    const overlay = document.createElement("div");
    overlay.className = "feedback-dialog-overlay auth-dialog-overlay";

    const dialog = document.createElement("div");
    dialog.className = "feedback-dialog auth-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "auth-dialog-title");
    dialog.tabIndex = -1;

    overlay.appendChild(dialog);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAuthDialog();
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", handleAuthDialogKeydown);

    return dialog;
  }

  // Google's "G" logo, used by buildGoogleContinueButton() below to build
  // "Continue with Google" buttons for the sign-in chooser and the
  // account-linking recovery state. Static, trusted markup (not derived
  // from any external/user data), so building it via innerHTML there is
  // safe. The header's own Sign In button deliberately carries no such
  // logo — see the comment on #google-signin-btn in index.html — so this
  // is the only place it's defined.
  const GOOGLE_LOGO_SVG_MARKUP = `<svg class="google-signin-btn-logo" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.6151z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2582c-.8064.54-1.8368.859-3.0477.859-2.3436 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z" />
    <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.2827-1.1168-.2827-1.71s.1027-1.17.2827-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.964 10.71z" />
    <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5813C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6564 3.5795 9 3.5795z" />
  </svg>`;

  function buildGoogleContinueButton(labelText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "google-signin-btn auth-dialog-google-btn";
    button.insertAdjacentHTML("afterbegin", GOOGLE_LOGO_SVG_MARKUP);
    button.appendChild(document.createTextNode(labelText));
    return button;
  }

  // Classifies an email against Firebase's own records for it, before this
  // app ever calls sendSignInLinkToEmail — see the file-level comment above
  // for why this (not a reactive catch) is the real guard for this
  // direction. "same-provider" covers both "no account yet" and "already
  // has an email-link/password account" — both are safe to send a link to.
  async function checkEmailForExistingProvider(email) {
    const methods = await auth.fetchSignInMethodsForEmail(email);
    if (methods.length === 0) return { status: "new" };
    if (methods.includes("emailLink") || methods.includes("password")) {
      return { status: "same-provider" };
    }
    return { status: "other-provider", methods };
  }

  async function sendEmailSignInLink(email) {
    const actionCodeSettings = {
      // document.baseURI, not scripts.js's APP_ROOT_URL — this file loads
      // before scripts.js and shouldn't depend on it having run yet, even
      // though in practice it would have by the time this is ever called.
      url: document.baseURI,
      handleCodeInApp: true,
    };
    await auth.sendSignInLinkToEmail(email, actionCodeSettings);
    try {
      localStorage.setItem(PENDING_EMAIL_LINK_KEY, email);
    } catch (error) {
      // Best-effort — if storage is unavailable, completeEmailLinkSignIn()
      // will just re-prompt for the email instead of finding it stored.
    }
  }

  // Shared "you already have an account" recovery UI, rendered into an
  // already-open (empty) dialog. Two callers:
  //  - the proactive check above, in place, before any link is sent — no
  //    pendingCredential, since nothing was attempted yet; the existing
  //    account just needs a normal sign-in.
  //  - handleAccountExistsWithDifferentCredential() below, on a fresh
  //    dialog — has a pendingCredential from the attempt that just failed,
  //    which gets linked onto whichever account the recovery sign-in
  //    resolves to.
  function renderProviderRecoveryState(
    dialog,
    { email, existingProviderLabel, showGoogleOption, onSendLink, pendingCredential },
  ) {
    dialog.innerHTML = "";

    const title = document.createElement("h3");
    title.id = "auth-dialog-title";
    title.textContent = "Sign in to continue";
    dialog.appendChild(title);

    const message = document.createElement("p");
    message.className = "feedback-dialog-status";
    message.textContent = `${email} already has an account here, signed in with ${existingProviderLabel}. Sign in that way to continue.`;
    dialog.appendChild(message);

    const actions = document.createElement("div");
    actions.className = "feedback-dialog-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "feedback-dialog-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", closeAuthDialog);
    actions.appendChild(cancelButton);

    if (showGoogleOption) {
      const googleButton = buildGoogleContinueButton("Continue with Google");
      googleButton.addEventListener("click", () => {
        closeAuthDialog();
        window.trackEvent?.("sign_in_started", { source: "account-recovery" });
        googleButton.disabled = true;
        triggerSignIn({ linkCredential: pendingCredential || undefined }).finally(
          () => {
            googleButton.disabled = false;
          },
        );
      });
      actions.appendChild(googleButton);
    } else if (onSendLink) {
      const sendButton = document.createElement("button");
      sendButton.type = "button";
      sendButton.className = "feedback-dialog-submit";
      sendButton.textContent = "Send sign-in link";
      sendButton.addEventListener("click", async () => {
        sendButton.disabled = true;
        cancelButton.disabled = true;
        try {
          await onSendLink();
          message.textContent = "Check your email for a sign-in link.";
          message.classList.remove("feedback-dialog-status-error");
          actions.innerHTML = "";
          const closeButton = document.createElement("button");
          closeButton.type = "button";
          closeButton.className = "feedback-dialog-cancel";
          closeButton.textContent = "Close";
          closeButton.addEventListener("click", closeAuthDialog);
          actions.appendChild(closeButton);
        } catch (error) {
          console.warn("Sending the sign-in link failed.", error);
          message.textContent = "Something went wrong. Please try again.";
          message.classList.add("feedback-dialog-status-error");
          sendButton.disabled = false;
          cancelButton.disabled = false;
        }
      });
      actions.appendChild(sendButton);
    }

    dialog.appendChild(actions);
    dialog.focus();
  }

  // `attemptedProvider` ("google.com" or "emailLink") identifies which
  // credential the *caller* just tried — not looked up. Firebase only
  // throws this error when the email's existing account uses a *different*
  // provider than the one just attempted, and with only two providers in
  // this app, that alone determines which one it is. This deliberately
  // does not call fetchSignInMethodsForEmail() to double-check: with Email
  // Enumeration Protection on (the default for newer Firebase projects,
  // and on for this one), that call always returns [] regardless of the
  // account's real state, so it can't be trusted to distinguish the two
  // here — see checkEmailForExistingProvider()'s file-level comment for
  // the same limitation on the proactive side.
  function handleAccountExistsWithDifferentCredential(error, attemptedProvider) {
    const pendingCredential = error.credential;
    const email = error.email || error.customData?.email;
    if (!email || !pendingCredential) {
      alertSignInFailure(error);
      return;
    }

    const dialog = openAuthDialogShell(null);

    if (attemptedProvider === "google.com") {
      // Attempted Google, collided with an existing password-family
      // (email-link) account.
      renderProviderRecoveryState(dialog, {
        email,
        existingProviderLabel: "email link",
        showGoogleOption: false,
        onSendLink: () => sendEmailSignInLink(email),
      });
    } else {
      // Attempted email link, collided with an existing Google account —
      // full one-click link, since pendingCredential is used synchronously
      // from here.
      renderProviderRecoveryState(dialog, {
        email,
        existingProviderLabel: "Google",
        showGoogleOption: true,
        pendingCredential,
      });
    }
  }

  // Cross-device email-link completion: the link was requested on a
  // browser other than this one (or PENDING_EMAIL_LINK_KEY was otherwise
  // lost), so there's no stored email to complete the sign-in with.
  // Firebase requires the email as a second factor for this flow, so ask
  // for it here instead. Resolves with the entered email, or null if
  // cancelled/dismissed.
  function promptForEmailLinkConfirmation() {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      // Set *after* openAuthDialogShell(), not before: that call itself
      // closes any dialog already open, which would otherwise immediately
      // invoke this resolver (settling this promise as cancelled) before
      // the dialog it's meant to guard has even been built.
      const dialog = openAuthDialogShell(null);
      authDialogDismissResolver = () => settle(null);

      const title = document.createElement("h3");
      title.id = "auth-dialog-title";
      title.textContent = "Confirm your email";
      dialog.appendChild(title);

      const message = document.createElement("p");
      message.className = "feedback-dialog-status";
      message.textContent =
        "Enter the email address you signed in with to finish.";
      dialog.appendChild(message);

      const emailLabel = document.createElement("label");
      emailLabel.className = "feedback-dialog-label";
      emailLabel.htmlFor = "auth-dialog-confirm-email";
      emailLabel.textContent = "Email";
      dialog.appendChild(emailLabel);

      const emailInput = document.createElement("input");
      emailInput.type = "email";
      emailInput.id = "auth-dialog-confirm-email";
      emailInput.autocomplete = "email";
      dialog.appendChild(emailInput);

      const status = document.createElement("p");
      status.className = "feedback-dialog-status";
      dialog.appendChild(status);

      const actions = document.createElement("div");
      actions.className = "feedback-dialog-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "feedback-dialog-cancel";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => {
        // Settle before closing: closeAuthDialog() also invokes
        // authDialogDismissResolver, but settle()'s own guard makes that
        // second call a no-op once this one has already run.
        settle(null);
        closeAuthDialog();
      });

      const submitButton = document.createElement("button");
      submitButton.type = "button";
      submitButton.className = "feedback-dialog-submit";
      submitButton.textContent = "Complete sign-in";
      submitButton.addEventListener("click", () => {
        const email = emailInput.value.trim();
        if (!email || !emailInput.checkValidity()) {
          status.textContent = "Please enter a valid email address.";
          status.classList.add("feedback-dialog-status-error");
          emailInput.focus();
          return;
        }
        settle(email);
        closeAuthDialog();
      });

      actions.appendChild(cancelButton);
      actions.appendChild(submitButton);
      dialog.appendChild(actions);

      emailInput.focus();
    });
  }

  // Runs once per page load, from initAuth() — completes an email-link
  // sign-in if this load's URL is one (Firebase appends its own oobCode/
  // mode/apiKey query params to the link), and is a no-op otherwise.
  async function completeEmailLinkSignIn() {
    const isEmailLink = auth.isSignInWithEmailLink(window.location.href);
    authDebugLog(`completeEmailLinkSignIn: isSignInWithEmailLink=${isEmailLink}`);
    if (!isEmailLink) return;

    try {
      let email = null;
      try {
        email = localStorage.getItem(PENDING_EMAIL_LINK_KEY);
      } catch (error) {
        email = null;
      }
      authDebugLog(`completeEmailLinkSignIn: pendingEmailInStorage=${Boolean(email)}`);

      if (!email) {
        email = await promptForEmailLinkConfirmation();
        if (!email) {
          authDebugLog("completeEmailLinkSignIn: email prompt cancelled");
          return; // Cancelled — still cleaned up in `finally` below.
        }
      }

      const result = await auth.signInWithEmailLink(email, window.location.href);
      authDebugLog(`completeEmailLinkSignIn: signInWithEmailLink resolved uid=${result?.user?.uid}`);
      trackSignInResult(result, "EmailLink");
    } catch (error) {
      authDebugLog(`completeEmailLinkSignIn: catch code=${error?.code} message=${error?.message}`);
      if (error?.code === "auth/account-exists-with-different-credential") {
        handleAccountExistsWithDifferentCredential(error, "emailLink");
      } else if (error?.code === "auth/invalid-action-code") {
        window.alert(
          "This sign-in link has expired or was already used. Please request a new one.",
        );
      } else {
        alertSignInFailure(error, "Email sign-in");
      }
    } finally {
      try {
        localStorage.removeItem(PENDING_EMAIL_LINK_KEY);
      } catch (error) {
        // Best-effort.
      }
      // Strips oobCode/mode/apiKey so a reload can't replay a consumed code.
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.hash,
      );
    }
  }

  // The Sign In entry point: a "Continue with Google" button (fires the
  // existing popup/redirect flow unchanged, as a direct synchronous click
  // on *this* button — the popup-timing constraint holds because this is
  // itself a fresh real user gesture) plus an email field below it.
  function openSignInChooserDialog(triggerElement) {
    const dialog = openAuthDialogShell(triggerElement);

    const title = document.createElement("h3");
    title.id = "auth-dialog-title";
    title.textContent = "Sign in";
    dialog.appendChild(title);

    const googleButton = buildGoogleContinueButton("Continue with Google");
    googleButton.addEventListener("click", () => {
      closeAuthDialog();
      handleInteractiveSignIn("dialog", googleButton);
    });
    dialog.appendChild(googleButton);

    const divider = document.createElement("div");
    divider.className = "auth-dialog-divider";
    divider.textContent = "or";
    dialog.appendChild(divider);

    const emailLabel = document.createElement("label");
    emailLabel.className = "feedback-dialog-label";
    emailLabel.htmlFor = "auth-dialog-email";
    emailLabel.textContent = "Email";
    dialog.appendChild(emailLabel);

    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.id = "auth-dialog-email";
    emailInput.autocomplete = "email";
    emailInput.placeholder = "you@example.com";
    dialog.appendChild(emailInput);

    const status = document.createElement("p");
    status.className = "feedback-dialog-status";
    dialog.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "feedback-dialog-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "feedback-dialog-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", closeAuthDialog);

    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "feedback-dialog-submit";
    sendButton.textContent = "Send sign-in link";
    sendButton.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      if (!email || !emailInput.checkValidity()) {
        status.textContent = "Please enter a valid email address.";
        status.classList.add("feedback-dialog-status-error");
        emailInput.focus();
        return;
      }

      sendButton.disabled = true;
      cancelButton.disabled = true;
      status.classList.remove("feedback-dialog-status-error");
      status.textContent = "Checking…";

      try {
        // Unlike the popup path, nothing here needs to run inside a
        // synchronous click — this is a plain async network call, so it's
        // safe to await SDK loading if it hasn't happened yet.
        if (!auth) await ensureAuthReady();

        const check = await checkEmailForExistingProvider(email);
        if (check.status === "other-provider") {
          // "same-provider" already covers the email-link/password case
          // above, so with only two providers in this app, "other" can
          // only mean Google — no need to inspect check.methods (and
          // safer than checking .includes("google.com"): that would
          // silently leave neither recovery option offered if this app
          // ever gains a third provider without this being updated).
          renderProviderRecoveryState(dialog, {
            email,
            existingProviderLabel: "Google",
            showGoogleOption: true,
          });
          return;
        }

        status.textContent = "Sending…";
        await sendEmailSignInLink(email);
        status.classList.remove("feedback-dialog-status-error");
        status.textContent = "Check your email for a sign-in link.";
        emailInput.disabled = true;
        sendButton.remove();
        cancelButton.textContent = "Close";
        cancelButton.disabled = false;
      } catch (error) {
        console.warn("Sending the sign-in link failed.", error);
        status.textContent = "Something went wrong. Please try again.";
        status.classList.add("feedback-dialog-status-error");
        sendButton.disabled = false;
        cancelButton.disabled = false;
      }
    });

    actions.appendChild(cancelButton);
    actions.appendChild(sendButton);
    dialog.appendChild(actions);

    // Matches openFeedbackDialog()'s convention: focus the dialog itself on
    // narrow/touch widths rather than a field directly, since programmatic
    // focus can behave surprisingly there.
    const usesCompactAuthDialog = window.matchMedia?.(
      "(max-width: 1024px)",
    ).matches;
    (usesCompactAuthDialog ? dialog : emailInput).focus();
  }

  // Runs once, after the SDK scripts have finished loading.
  function initAuth() {
    firebase.initializeApp(FIREBASE_CONFIG);

    auth = firebase.auth();
    db = firebase.firestore();
    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: "openid email profile",
      // Real callbacks are attached per-request in requestGoogleAccessToken()
      // — initTokenClient() just needs *a* function here to accept the config.
      callback: () => {},
    });

    // Local development talks to a local Firestore emulator instead of the
    // real project, so testing/reloading never touches the production
    // account's free-tier quota. Auth stays real (Google sign-in still works
    // normally); only Firestore reads/writes are redirected. useEmulator
    // must be called before any other Firestore operation, which this is —
    // nothing above touches `db`.
    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      db.useEmulator("localhost", 8080);
      console.info(
        "Firestore: using local emulator (localhost:8080) — run `npm run emulators` if it's not already running.",
      );
    }

    // Completes an email-link sign-in if this load's URL is one. Fire-and-
    // forget — onAuthStateChanged handles whatever the eventual signed-in
    // state turns out to be either way.
    completeEmailLinkSignIn().catch((error) =>
      alertSignInFailure(error, "Email sign-in"),
    );

    signOutButton?.addEventListener("click", async () => {
      window.trackEvent?.("sign_out");
      signOutButton.disabled = true;
      try {
        await flushPendingPushes();
        await auth.signOut();
      } catch (error) {
        console.warn("Sign-out failed.", error);
        window.alert(
          "Your latest progress could not be synced, so you have not been signed out. Please check your connection and try again.",
        );
        signOutButton.disabled = false;
      }
    });

    auth.onAuthStateChanged(async (user) => {
      authDebugLog(`onAuthStateChanged: user=${Boolean(user)} uid=${user?.uid}`);
      currentUserId = user ? user.uid : null;
      updateAuthUI(user);
      rememberSignedInState(Boolean(user), user?.uid);

      if (user) {
        wasSignedInThisSession = true;
        const cursor = await mergeRemoteData(user.uid);
        if (currentUserId === user.uid) {
          attachRealtimeSync(user.uid, cursor);
        }
      } else {
        unsubscribeRealtimeSync?.();
        unsubscribeProgressSync?.();
        unsubscribeRealtimeSync = null;
        unsubscribeProgressSync = null;

        if (wasSignedInThisSession) {
          wasSignedInThisSession = false;
          clearLocalUserDataAndReload();
        }
      }
    });
  }

  signInButton?.addEventListener("click", () => {
    openSignInChooserDialog(signInButton);
  });

  let wasSignedInBefore = false;
  try {
    wasSignedInBefore = localStorage.getItem(WAS_SIGNED_IN_KEY) === "1";
  } catch (error) {
    // Ignore — falls back to loading on click, same as a first-time visitor.
  }

  if (wasSignedInBefore) {
    // Returning users restore immediately. First-time visitors wait until the
    // initial page has loaded, then prepare Auth in the background so their
    // eventual click still retains its browser user-activation permission.
    prepareAuth();
  } else if (document.readyState === "complete") {
    prepareAuth();
  } else {
    window.addEventListener("load", prepareAuth, { once: true });
  }

  // Fired by wordList.js's saveMyWordsEntryIds() whenever My Words changes.
  window.addEventListener("my-words:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    scheduleProgressPush({
      entryIds: event.detail?.entryIds ?? [],
      entryTimestamps: event.detail?.entryTimestamps ?? {},
      changedEntryIds: event.detail?.changedEntryIds,
    });
  });

  // Fired by wordList.js's saveWordStrengths() whenever word strength changes.
  window.addEventListener("word-strength:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    scheduleProgressPush(
      {
        strengths: event.detail?.strengths ?? {},
        changedStrengthIds: event.detail?.changedEntryIds,
      },
      { defer: event.detail?.deferRemote === true },
    );
  });

  // Fired by storyFavorites.js after a local toggle or when a newer local
  // tombstone needs to repair stale account data from another device.
  window.addEventListener("story-favorites:updated", (event) => {
    if (
      event.detail?.syncRemote === false ||
      typeof event.detail?.payload !== "string"
    ) {
      return;
    }

    scheduleProfilePush({ favoriteStoriesPayload: event.detail.payload });
  });

  window.addEventListener("progress:round-complete", () => {
    if (!currentUserId || Object.keys(pendingShardPatches).length === 0) return;
    if (isQuotaCoolingDown()) return; // Stays queued; the debounce timer will retry.
    window.clearTimeout(progressPushTimeoutId);
    progressPushTimeoutId = null;
    drainPendingShardPatches(currentUserId).catch(() => {});
  });

  // Fired by wordGame.js's saveAbilityState() whenever the ability score
  // (or placement-completed flag) changes.
  window.addEventListener("ability:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      if (event.detail?.cloudPending === true) {
        abilityCloudPending = true;
        abilityRevision++;
      }
      return;
    }

    if (!Number.isFinite(event.detail?.score)) {
      return;
    }

    scheduleProfilePush({
      abilityScore: event.detail.score,
      placementCompleted: Boolean(event.detail.placementCompleted),
    });
  });

  // Fired by streak.js's saveStreakState() whenever the streak changes.
  window.addEventListener("streak:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    scheduleProfilePush({ streak: event.detail?.streak ?? {} });
  });

  // Fired by wordGame.js's saveDailyPracticeState() whenever quest progress
  // changes.
  window.addEventListener("daily-quest:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    scheduleProfilePush({ dailyPractice: event.detail?.dailyPractice ?? {} });
  });

  // Fired by wordGame.js's saveBestWordStreakState() whenever a new
  // personal-best correct-answer streak is reached.
  window.addEventListener("best-word-streak:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    if (!Number.isFinite(event.detail?.longest)) {
      return;
    }

    scheduleProfilePush({ bestWordStreak: event.detail.longest });
  });

  // Fired by englishVisibility.js's setEnglishVisible() whenever the
  // show/hide-English preference changes.
  window.addEventListener("english-visibility:updated", (event) => {
    if (event.detail?.syncRemote === false) {
      return;
    }

    scheduleProfilePush({
      showEnglish: Boolean(event.detail?.isEnglishVisible),
    });
  });

  signInNudgeDismissButton?.addEventListener("click", () => {
    window.trackEvent?.("sign_in_nudge_dismissed");
    dismissSignInNudge();
  });

  signInNudgeSignInButton?.addEventListener("click", () => {
    window.trackEvent?.("sign_in_nudge_clicked");
    dismissSignInNudge();
    openSignInChooserDialog(signInNudgeSignInButton);
  });

  // Called by wordGame.js after the first completed round — the moment a
  // signed-out visitor first has something (a streak, saved words) worth
  // protecting from a cleared cache.
  window.SignInNudgeAPI = Object.freeze({
    maybeShow: maybeShowSignInNudge,
    dismiss: dismissSignInNudge,
  });

  // Consumed by myStats.js's Danger Zone card — kept here rather than in
  // that file because a full reset has to touch Firestore (when signed in)
  // using this module's currentUserId/db/shard-ref plumbing, not just the
  // local storage clearing myStats.js could do on its own.
  window.ProgressResetAPI = Object.freeze({
    resetAllProgress,
  });
})();
