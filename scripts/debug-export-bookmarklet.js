// Run this on the PRODUCTION site (osloandrew.github.io/japanese), signed
// in, to download everything myWordsAuth.js considers "your data" as one
// JSON file. This is the readable source — see below for the bookmarklet
// form actually used.
//
// This list is deliberately kept in sync by hand with
// myWordsAuth.js's LOCAL_USER_DATA_KEYS, which is the app's own
// authoritative "this is user-owned local data" list (it's what gets wiped
// on sign-out). Reading localStorage directly like this works because, by
// the time you're signed in on the real site, mergeRemoteData() has already
// reconciled your full account into these same keys — no separate Firestore
// read is needed here.
(function () {
  var KEYS = [
    "japanese-dictionary-my-words-v1", // MyWordsAPI.STORAGE_KEY
    "japanese-dictionary-word-strength-v1", // WordStrengthAPI.STORAGE_KEY
    "japanese-dictionary-streak-v1",
    "japanese-dictionary-ability-v1",
    "japanese-dictionary-game-level-v1",
    "japanese-dictionary-daily-practice-v2",
    "japanese-dictionary-best-word-streak-v1",
    "japanese-dictionary-favorite-stories-v1", // StoryFavoritesAPI.STORAGE_KEY
  ];

  var data = {};
  KEYS.forEach(function (key) {
    var value = localStorage.getItem(key);
    if (value !== null) data[key] = value;
  });

  var blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = "my-words-debug-export.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  alert(
    "Exported " +
      Object.keys(data).length +
      " of " +
      KEYS.length +
      " keys to your Downloads folder.",
  );
})();

// --- Bookmarklet form (minified onto one line, prefixed with "javascript:") ---
// Save this as a browser bookmark, or use it directly in a Shortcuts
// "Open URLs" action targeting Safari — both just run this in the current
// tab, so you must already be on the production site, signed in, first.
//
// javascript:(function(){var K=["japanese-dictionary-my-words-v1","japanese-dictionary-word-strength-v1","japanese-dictionary-streak-v1","japanese-dictionary-ability-v1","japanese-dictionary-game-level-v1","japanese-dictionary-daily-practice-v2","japanese-dictionary-best-word-streak-v1","japanese-dictionary-favorite-stories-v1"];var d={};K.forEach(function(k){var v=localStorage.getItem(k);if(v!==null)d[k]=v;});var b=new Blob([JSON.stringify(d,null,2)],{type:"application/json"});var u=URL.createObjectURL(b);var a=document.createElement("a");a.href=u;a.download="my-words-debug-export.json";document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u);alert("Exported "+Object.keys(d).length+" of "+K.length+" keys to your Downloads folder.");})();
