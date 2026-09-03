// Builds the conjugation reverse index (inflected surface form -> dictionary
// entry) on a background thread, mirroring Norwegian's
// inflectionsWorker.js. Not consumed by the Word Forms table itself (that's
// computed directly, per word, in inflections.js) -- this is the
// infrastructure a future "resolve an inflected form seen in a story or
// definition back to its dictionary entry" feature needs, the same way
// Norwegian's click-to-define already works. For ~1700 verbs/adjectives
// times ~15 forms each, building it is cheap enough to not strictly need a
// worker, but keeping it off the main thread costs nothing and matches the
// pattern the rest of this codebase already uses for exactly this reason.
self.APP_ROOT_URL = new URL("./", self.location.href).href;
importScripts("inflections.js");

self.onmessage = async (event) => {
  try {
    const index = await self.Inflections.computeReverseIndexData(
      event.data?.entries || [],
    );
    self.postMessage({ index });
  } catch (error) {
    self.postMessage({ error: String((error && error.message) || error) });
  }
};
