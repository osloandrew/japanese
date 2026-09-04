import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "myWordsAuth.js"), "utf8");

const PENDING_EMAIL_LINK_KEY = "japanese-dictionary-pending-email-link-v1";

function sliceFunction(startMarker, endMarker) {
  const start = authSource.indexOf(startMarker);
  const end = authSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return authSource.slice(start, end);
}

function fakeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

test("checkEmailForExistingProvider classifies a fresh, colliding, and already-linked email", async () => {
  const source = sliceFunction(
    "async function checkEmailForExistingProvider(",
    "async function sendEmailSignInLink(",
  );

  const context = vm.createContext({});
  vm.runInContext(
    `${source}\nthis.check = checkEmailForExistingProvider;`,
    context,
  );

  // Compared field-by-field, not via deepEqual on the whole returned
  // object: it's a plain object created inside the vm context, so it has
  // that realm's own Object.prototype — deepStrictEqual treats that as
  // unequal to an object literal from this file's realm even when every
  // own property matches.
  context.auth = { fetchSignInMethodsForEmail: async () => [] };
  assert.equal((await context.check("new@example.com")).status, "new");

  context.auth = { fetchSignInMethodsForEmail: async () => ["google.com"] };
  const collision = await context.check("existing@example.com");
  assert.equal(collision.status, "other-provider");
  assert.deepEqual([...collision.methods], ["google.com"]);

  context.auth = { fetchSignInMethodsForEmail: async () => ["emailLink"] };
  assert.equal(
    (await context.check("returning@example.com")).status,
    "same-provider",
  );

  context.auth = {
    fetchSignInMethodsForEmail: async () => ["google.com", "emailLink"],
  };
  assert.equal(
    (await context.check("linked@example.com")).status,
    "same-provider",
  );
});

test("trackSignInResult forwards the sign-in method into analytics", () => {
  const source = sliceFunction(
    "function trackSignInResult(",
    "function alertSignInFailure(",
  );

  const calls = [];
  const context = vm.createContext({
    window: { trackEvent: (name, detail) => calls.push([name, detail]) },
  });
  vm.runInContext(`${source}\nthis.track = trackSignInResult;`, context);

  context.track({ additionalUserInfo: { isNewUser: false } }, "EmailLink");

  // Field-by-field, same cross-realm-object reason as above: `detail` was
  // built inside the vm context by trackSignInResult itself.
  assert.equal(calls[0][0], "login");
  assert.equal(calls[0][1].method, "EmailLink");
  assert.equal(calls[1][0], "sign_in_completed");
  assert.equal(calls[1][1].is_new_user, false);
});

// triggerSignIn now gets its Google credential via requestGoogleAccessToken()
// (Google Identity Services), a separate top-level function it calls but
// that isn't itself part of the sliced source — stubbed here like
// trackSignInResult/alertSignInFailure/handleAccountExistsWithDifferentCredential
// below, each a free variable the sliced function references.
function baseTriggerSignInContext(overrides = {}) {
  return vm.createContext({
    requestGoogleAccessToken: async () => "fake-access-token",
    firebase: {
      auth: {
        GoogleAuthProvider: {
          credential: (idToken, accessToken) => ({ idToken, accessToken }),
        },
      },
    },
    trackSignInResult: () => {},
    alertSignInFailure: () => {},
    handleAccountExistsWithDifferentCredential: () => {},
    authDebugLog: () => {},
    ...overrides,
  });
}

test("triggerSignIn links a pending credential onto the sign-in result when provided", async () => {
  const source = sliceFunction(
    "async function triggerSignIn(",
    "function handleInteractiveSignIn(",
  );

  const linkCalls = [];
  const trackCalls = [];
  const user = {
    linkWithCredential: async (credential) => linkCalls.push(credential),
  };
  const context = baseTriggerSignInContext({
    auth: { signInWithCredential: async () => ({ user }) },
    trackSignInResult: (result) => trackCalls.push(result),
  });
  vm.runInContext(`${source}\nthis.trigger = triggerSignIn;`, context);

  const credential = { providerId: "emailLink" };
  await context.trigger({ linkCredential: credential });

  assert.deepEqual(linkCalls, [credential]);
  assert.equal(trackCalls.length, 1);
});

test("triggerSignIn does not attempt to link when no credential is passed", async () => {
  const source = sliceFunction(
    "async function triggerSignIn(",
    "function handleInteractiveSignIn(",
  );

  const linkCalls = [];
  const user = {
    linkWithCredential: async (credential) => linkCalls.push(credential),
  };
  const context = baseTriggerSignInContext({
    auth: { signInWithCredential: async () => ({ user }) },
  });
  vm.runInContext(`${source}\nthis.trigger = triggerSignIn;`, context);

  await context.trigger();

  assert.deepEqual(linkCalls, []);
});

test("triggerSignIn routes an account-collision sign-in error to the recovery handler", async () => {
  const source = sliceFunction(
    "async function triggerSignIn(",
    "function handleInteractiveSignIn(",
  );

  const recoveryCalls = [];
  const alertCalls = [];
  const context = baseTriggerSignInContext({
    auth: {
      signInWithCredential: async () => {
        const error = new Error("collision");
        error.code = "auth/account-exists-with-different-credential";
        throw error;
      },
    },
    alertSignInFailure: (error) => alertCalls.push(error),
    handleAccountExistsWithDifferentCredential: (error, attemptedProvider) =>
      recoveryCalls.push([error, attemptedProvider]),
  });
  vm.runInContext(`${source}\nthis.trigger = triggerSignIn;`, context);

  await context.trigger();

  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0][1], "google.com");
  assert.equal(alertCalls.length, 0);
});

function completeEmailLinkSignInSource() {
  return sliceFunction(
    "async function completeEmailLinkSignIn(",
    "function openSignInChooserDialog(",
  );
}

function baseCompleteContext(overrides = {}) {
  return vm.createContext({
    PENDING_EMAIL_LINK_KEY,
    localStorage: fakeLocalStorage(),
    window: { location: { href: "", pathname: "/", hash: "" }, alert: () => {} },
    history: { replaceState: () => {} },
    promptForEmailLinkConfirmation: async () => null,
    trackSignInResult: () => {},
    handleAccountExistsWithDifferentCredential: async () => {},
    alertSignInFailure: () => {},
    authDebugLog: () => {},
    ...overrides,
  });
}

test("completeEmailLinkSignIn is a no-op when the URL isn't a sign-in link", async () => {
  const source = completeEmailLinkSignInSource();
  const replaceStateCalls = [];
  const context = baseCompleteContext({
    auth: { isSignInWithEmailLink: () => false },
    history: { replaceState: (...args) => replaceStateCalls.push(args) },
  });
  vm.runInContext(`${source}\nthis.complete = completeEmailLinkSignIn;`, context);

  await context.complete();

  assert.deepEqual(replaceStateCalls, []);
});

test("completeEmailLinkSignIn uses the stored email and cleans up on success", async () => {
  const source = completeEmailLinkSignInSource();
  const signInCalls = [];
  const trackCalls = [];
  const replaceStateCalls = [];
  const storage = fakeLocalStorage({ [PENDING_EMAIL_LINK_KEY]: "a@b.com" });
  const context = baseCompleteContext({
    auth: {
      isSignInWithEmailLink: () => true,
      signInWithEmailLink: async (email, url) => {
        signInCalls.push([email, url]);
        return { user: { uid: "123" } };
      },
    },
    localStorage: storage,
    window: {
      location: { href: "https://x/?oobCode=abc", pathname: "/", hash: "" },
      alert: () => {},
    },
    trackSignInResult: (result, method) => trackCalls.push([result, method]),
    history: { replaceState: (...args) => replaceStateCalls.push(args) },
  });
  vm.runInContext(`${source}\nthis.complete = completeEmailLinkSignIn;`, context);

  await context.complete();

  assert.deepEqual(signInCalls, [["a@b.com", "https://x/?oobCode=abc"]]);
  assert.equal(trackCalls[0][1], "EmailLink");
  assert.equal(storage.getItem(PENDING_EMAIL_LINK_KEY), null);
  assert.deepEqual(replaceStateCalls, [[null, "", "/"]]);
});

test("completeEmailLinkSignIn re-prompts for the email on another device and honors cancellation", async () => {
  const source = completeEmailLinkSignInSource();
  const signInCalls = [];
  const promptCalls = [];
  const replaceStateCalls = [];
  const context = baseCompleteContext({
    auth: {
      isSignInWithEmailLink: () => true,
      signInWithEmailLink: async (email, url) => {
        signInCalls.push([email, url]);
        return { user: { uid: "123" } };
      },
    },
    promptForEmailLinkConfirmation: async () => {
      promptCalls.push(true);
      return null; // Cancelled.
    },
    history: { replaceState: (...args) => replaceStateCalls.push(args) },
  });
  vm.runInContext(`${source}\nthis.complete = completeEmailLinkSignIn;`, context);

  await context.complete();

  assert.equal(promptCalls.length, 1);
  assert.deepEqual(signInCalls, []); // Never attempted without an email.
  assert.equal(replaceStateCalls.length, 1); // Still cleaned up.
});

test("completeEmailLinkSignIn routes an account collision to the recovery handler", async () => {
  const source = completeEmailLinkSignInSource();
  const recoveryCalls = [];
  const context = baseCompleteContext({
    auth: {
      isSignInWithEmailLink: () => true,
      signInWithEmailLink: async () => {
        const error = new Error("collision");
        error.code = "auth/account-exists-with-different-credential";
        throw error;
      },
    },
    localStorage: fakeLocalStorage({ [PENDING_EMAIL_LINK_KEY]: "a@b.com" }),
    handleAccountExistsWithDifferentCredential: (error, attemptedProvider) =>
      recoveryCalls.push([error, attemptedProvider]),
  });
  vm.runInContext(`${source}\nthis.complete = completeEmailLinkSignIn;`, context);

  await context.complete();

  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0][1], "emailLink");
});

// handleAccountExistsWithDifferentCredential infers the *existing*
// account's provider from which one was just attempted (the only two
// providers this app has), rather than looking it up — see its file
// comment: fetchSignInMethodsForEmail() always returns [] on this project
// (Email Enumeration Protection), so a lookup-based branch would silently
// pick the wrong recovery UI. These tests pin that inference down directly.
test("handleAccountExistsWithDifferentCredential offers the email-link recovery when Google was the attempted provider", () => {
  const source = sliceFunction(
    "function handleAccountExistsWithDifferentCredential(",
    "function promptForEmailLinkConfirmation(",
  );

  const renderCalls = [];
  const context = vm.createContext({
    openAuthDialogShell: () => ({}),
    renderProviderRecoveryState: (dialog, options) => renderCalls.push(options),
    alertSignInFailure: () => {},
  });
  vm.runInContext(
    `${source}\nthis.handle = handleAccountExistsWithDifferentCredential;`,
    context,
  );

  context.handle({ email: "a@b.com", credential: {} }, "google.com");

  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].showGoogleOption, false);
  assert.equal(typeof renderCalls[0].onSendLink, "function");
});

test("handleAccountExistsWithDifferentCredential offers the Google recovery when email link was the attempted provider", () => {
  const source = sliceFunction(
    "function handleAccountExistsWithDifferentCredential(",
    "function promptForEmailLinkConfirmation(",
  );

  const renderCalls = [];
  const context = vm.createContext({
    openAuthDialogShell: () => ({}),
    renderProviderRecoveryState: (dialog, options) => renderCalls.push(options),
    alertSignInFailure: () => {},
  });
  vm.runInContext(
    `${source}\nthis.handle = handleAccountExistsWithDifferentCredential;`,
    context,
  );

  const credential = { providerId: "google.com" };
  context.handle({ email: "a@b.com", credential }, "emailLink");

  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].showGoogleOption, true);
  assert.equal(renderCalls[0].pendingCredential, credential);
});

test("handleAccountExistsWithDifferentCredential falls back to the generic alert when the error is unusable", () => {
  const source = sliceFunction(
    "function handleAccountExistsWithDifferentCredential(",
    "function promptForEmailLinkConfirmation(",
  );

  const alertCalls = [];
  const renderCalls = [];
  const context = vm.createContext({
    openAuthDialogShell: () => ({}),
    renderProviderRecoveryState: (dialog, options) => renderCalls.push(options),
    alertSignInFailure: (error) => alertCalls.push(error),
  });
  vm.runInContext(
    `${source}\nthis.handle = handleAccountExistsWithDifferentCredential;`,
    context,
  );

  context.handle({ email: null, credential: null }, "google.com");

  assert.equal(alertCalls.length, 1);
  assert.equal(renderCalls.length, 0); // Never opens a dialog without both fields.
});
