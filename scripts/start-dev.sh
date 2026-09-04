#!/bin/bash
# Starts local dev (app server + Firestore emulator) — see `npm run dev`.
# Exists as its own file so a double-click, a Shortcuts button, a Dock icon,
# etc. can launch it without anyone needing to remember the npm command or
# the repo's path.
cd "$(dirname "$0")/.." || exit 1

npm run dev &
dev_pid=$!

# Poll instead of a fixed sleep — the server binds almost immediately, but
# opening the tab before it does just shows a connection-refused page.
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:8936/" && break
  sleep 0.5
done

open "http://localhost:8936/"

# Keeps this script (and the Terminal tab running it) attached to npm run
# dev, so Ctrl+C here still reaches it instead of leaving it orphaned.
wait "$dev_pid"
