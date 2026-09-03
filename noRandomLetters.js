// Single-letter dictionary headwords (e.g. Norwegian's "å" glossed as just
// "the letter å") get excluded from the word game's random-pick paths via
// this list, kept separate from noRandom.js -- see wordGame.js's own
// comment at its usage for why. Japanese has no equivalent "the letter X"
// dictionary-entry convention (kana/kanji headwords aren't single Latin
// letters), so this stays empty rather than porting Norwegian's actual
// alphabet list, which wouldn't correspond to anything in this app's data.
const noRandomLetters = [];
