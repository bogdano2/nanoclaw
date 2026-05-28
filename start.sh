#!/bin/bash
# NanoClaw startup wrapper — waits for Docker Desktop before launching.
# Used by the launchd plist to avoid crash-looping on boot.

set -o pipefail

MAX_WAIT=120   # seconds to wait for Docker
INTERVAL=5     # seconds between checks
LOG="/Users/Shared/nanoclaw/logs/nanoclaw.log"

notify() {
  osascript -e "display notification \"$1\" with title \"NanoClaw\" sound name \"Sosumi\"" 2>/dev/null
}

waited=0
while ! docker info >/dev/null 2>&1; do
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    echo "[$(date -Iseconds)] start.sh: Docker not ready after ${MAX_WAIT}s — giving up" >> "$LOG"
    notify "Docker not running after ${MAX_WAIT}s. Open Docker Desktop or check Activity Monitor for Docker processes."
    exit 1
  fi
  sleep "$INTERVAL"
  waited=$((waited + INTERVAL))
done

if [ "$waited" -gt 0 ]; then
  echo "[$(date -Iseconds)] start.sh: Docker ready after ${waited}s" >> "$LOG"
fi

/Users/Shared/nanoclaw/scripts/rotate-logs.sh 2>/dev/null || true

# Pre-flight: native modules built against a different Node ABI cause exit-1
# crashloops here, and launchd's KeepAlive cheerfully restarts us every 30s
# until someone notices. Brew auto-upgrades Node periodically without
# rebuilding native bindings; this caused a 4-hour outage on 2026-05-20.
# Quick ABI check, auto-rebuild if mismatched, fail loudly if rebuild fails.
if ! /opt/homebrew/bin/node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] start.sh: better-sqlite3 ABI mismatch — source-rebuild against $(/opt/homebrew/bin/node --version)" >> "$LOG"
  # npm rebuild alone won't help: prebuild-install picks the closest prebuilt for
  # the wrong Node ABI and "succeeds." Wipe build/ and invoke node-gyp via
  # brew's node so headers match.
  if ! (cd /Users/Shared/nanoclaw/node_modules/better-sqlite3 \
        && rm -rf build \
        && PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/npx --yes node-gyp rebuild --release) >>"$LOG" 2>&1; then
    echo "[$(date -Iseconds)] start.sh: rebuild FAILED — giving up" >> "$LOG"
    notify "better-sqlite3 source rebuild failed. Check $LOG"
    exit 1
  fi
  echo "[$(date -Iseconds)] start.sh: better-sqlite3 rebuilt successfully" >> "$LOG"
fi

/opt/homebrew/bin/node --max-old-space-size=4096 /Users/Shared/nanoclaw/dist/index.js
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "[$(date -Iseconds)] start.sh: Node process exited with code $EXIT_CODE" >> "$LOG"
  LAST_ERR=$(tail -5 "$LOG" | grep -i -m1 'error\|fatal\|ENOENT\|ECONNREFUSED\|Cannot find' || true)
  if [ -n "$LAST_ERR" ]; then
    HINT="Last error: ${LAST_ERR:0:80}"
  else
    HINT="Check logs: $LOG"
  fi
  notify "Crashed (exit $EXIT_CODE). $HINT"
fi

exit $EXIT_CODE
