(function () {
  "use strict";

  const STORAGE_KEY = "japanese-dictionary-favorite-stories-v1";
  const STORAGE_VERSION = 1;

  function emptyPayload() {
    return { version: STORAGE_VERSION, entries: {} };
  }

  function normalizeTitle(value) {
    return String(value ?? "").trim().normalize("NFC");
  }

  function getTitleKey(title) {
    return encodeURIComponent(normalizeTitle(title));
  }

  function parsePayload(value) {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return emptyPayload();
      }

      const payload = emptyPayload();
      const entries =
        parsed.entries &&
        typeof parsed.entries === "object" &&
        !Array.isArray(parsed.entries)
          ? parsed.entries
          : {};

      for (const [titleKey, entry] of Object.entries(entries)) {
        if (
          !entry ||
          typeof entry !== "object" ||
          !Number.isFinite(entry.updatedAt)
        ) {
          continue;
        }

        payload.entries[titleKey] = {
          present: Boolean(entry.present),
          updatedAt: Math.max(0, entry.updatedAt),
        };
      }

      return payload;
    } catch (error) {
      return emptyPayload();
    }
  }

  function serializePayload(value) {
    return JSON.stringify(parsePayload(value));
  }

  function mergePayload(baseValue, incomingValue) {
    const base = parsePayload(baseValue);
    const incoming = parsePayload(incomingValue);
    const merged = emptyPayload();

    for (const titleKey of new Set([
      ...Object.keys(base.entries),
      ...Object.keys(incoming.entries),
    ])) {
      const baseEntry = base.entries[titleKey];
      const incomingEntry = incoming.entries[titleKey];

      if (!baseEntry) {
        merged.entries[titleKey] = incomingEntry;
      } else if (!incomingEntry) {
        merged.entries[titleKey] = baseEntry;
      } else if (incomingEntry.updatedAt > baseEntry.updatedAt) {
        merged.entries[titleKey] = incomingEntry;
      } else if (incomingEntry.updatedAt < baseEntry.updatedAt) {
        merged.entries[titleKey] = baseEntry;
      } else {
        // A removal wins a same-millisecond tie so a stale add cannot
        // resurrect a favorite that was just deliberately removed.
        merged.entries[titleKey] =
          !incomingEntry.present || !baseEntry.present
            ? { present: false, updatedAt: baseEntry.updatedAt }
            : baseEntry;
      }
    }

    return merged;
  }

  function loadPayload() {
    try {
      return parsePayload(window.localStorage.getItem(STORAGE_KEY));
    } catch (error) {
      console.warn("Favorite stories could not be loaded.", error);
      return emptyPayload();
    }
  }

  let currentPayload = loadPayload();

  function dispatchUpdate(payload, { syncRemote = true } = {}) {
    window.dispatchEvent(
      new CustomEvent("story-favorites:updated", {
        detail: {
          payload: serializePayload(payload),
          syncRemote,
        },
      }),
    );
  }

  function savePayload(payload, { syncRemote = true } = {}) {
    currentPayload = parsePayload(payload);

    try {
      window.localStorage.setItem(STORAGE_KEY, serializePayload(currentPayload));
    } catch (error) {
      console.warn("Favorite stories could not be saved.", error);
    }

    dispatchUpdate(currentPayload, { syncRemote });
  }

  function isSaved(title) {
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedTitle) return false;
    return Boolean(currentPayload.entries[getTitleKey(normalizedTitle)]?.present);
  }

  function toggle(title) {
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedTitle) return false;

    const titleKey = getTitleKey(normalizedTitle);
    const nowSaved = !currentPayload.entries[titleKey]?.present;
    const nextPayload = parsePayload(currentPayload);
    nextPayload.entries[titleKey] = {
      present: nowSaved,
      updatedAt: Date.now(),
    };
    savePayload(nextPayload);
    return nowSaved;
  }

  function getFavoriteTitles() {
    return Object.entries(currentPayload.entries)
      .filter(([, entry]) => entry.present)
      .map(([titleKey]) => {
        try {
          return decodeURIComponent(titleKey);
        } catch (error) {
          return "";
        }
      })
      .filter(Boolean);
  }

  function reconcile(remoteValue) {
    const localBefore = serializePayload(currentPayload);
    const remoteBefore = serializePayload(remoteValue);
    const merged = mergePayload(currentPayload, remoteValue);
    const mergedSerialized = serializePayload(merged);
    const localChanged = mergedSerialized !== localBefore;
    const remoteNeedsRepair = mergedSerialized !== remoteBefore;

    if (localChanged || remoteNeedsRepair) {
      savePayload(merged, { syncRemote: remoteNeedsRepair });
    }

    return mergedSerialized;
  }

  window.StoryFavoritesAPI = Object.freeze({
    STORAGE_KEY,
    isSaved,
    toggle,
    getFavoriteTitles,
    getPayload: () => serializePayload(currentPayload),
    parsePayload,
    serializePayload,
    mergePayload,
    reconcile,
  });
})();
