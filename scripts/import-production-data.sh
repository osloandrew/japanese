#!/bin/bash
# Pulls your most recent production data export (see the bookmarklet in
# scripts/debug-export-bookmarklet.js — run that on the real site while
# signed in first) into the repo, then opens the local import page.
#
# Requires the app + Firestore emulator already running (scripts/start-dev.sh)
# and the export downloaded to ~/Downloads.
set -e
cd "$(dirname "$0")/.." || exit 1

# Newest match, not an exact filename — a repeat download lands as
# "... (1).json" rather than overwriting the first one.
src=$(ls -t "$HOME/Downloads"/my-words-debug-export*.json 2>/dev/null | head -1)
if [ -z "$src" ]; then
  echo "No my-words-debug-export*.json found in ~/Downloads."
  echo "Run the export bookmarklet on https://osloandrew.github.io/japanese/ first (while signed in), then re-run this."
  exit 1
fi

# Gitignored — this is real personal data and must never be committed.
# mv (not cp) consumes it so a stale copy can't get re-imported by mistake.
mv "$src" ./my-words-debug-export.json
echo "Moved $(basename "$src") into the repo root."

open "http://localhost:8936/scripts/debug-import.html"
