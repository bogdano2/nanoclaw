#!/bin/bash
# check-deps.sh — Weekly dependency check for NanoClaw
# Writes results to data/dep-check.json. Andy reads this and notifies the user.
set -euo pipefail

NANOCLAW_DIR="/Users/Shared/nanoclaw"
RESULTS_FILE="$NANOCLAW_DIR/data/dep-check.json"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cd "$NANOCLAW_DIR"

# --- npm packages (host) ---
npm_host_outdated=""
npm_host_count=0
if command -v npm &>/dev/null; then
  npm_host_outdated=$(npm outdated --json 2>/dev/null || true)
  if [ -n "$npm_host_outdated" ] && [ "$npm_host_outdated" != "{}" ]; then
    npm_host_count=$(echo "$npm_host_outdated" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  fi
fi

# --- npm packages (container agent-runner) ---
npm_container_outdated=""
npm_container_count=0
if [ -d "$NANOCLAW_DIR/container/agent-runner" ]; then
  cd "$NANOCLAW_DIR/container/agent-runner"
  npm_container_outdated=$(npm outdated --json 2>/dev/null || true)
  if [ -n "$npm_container_outdated" ] && [ "$npm_container_outdated" != "{}" ]; then
    npm_container_count=$(echo "$npm_container_outdated" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  fi
  cd "$NANOCLAW_DIR"
fi

# --- Ollama ---
ollama_update=""
ollama_version=""
if command -v ollama &>/dev/null; then
  ollama_version=$(ollama --version 2>/dev/null | head -1)
  if command -v brew &>/dev/null; then
    ollama_update=$(brew outdated ollama 2>/dev/null || true)
  fi
fi

# --- Build summary ---
updates_found=false
summary_parts=()

if [ "$npm_host_count" -gt 0 ]; then
  updates_found=true
  summary_parts+=("$npm_host_count npm packages outdated (host)")
fi

if [ "$npm_container_count" -gt 0 ]; then
  updates_found=true
  summary_parts+=("$npm_container_count npm packages outdated (container)")
fi

if [ -n "$ollama_update" ]; then
  updates_found=true
  summary_parts+=("Ollama update available")
fi

if [ "$updates_found" = false ]; then
  summary="All dependencies are up to date."
else
  summary=$(IFS=', '; echo "${summary_parts[*]}")
fi

# --- Write results ---
mkdir -p "$(dirname "$RESULTS_FILE")"
cat > "$RESULTS_FILE" <<ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "updates_found": $updates_found,
  "summary": "$summary",
  "npm_host_count": $npm_host_count,
  "npm_container_count": $npm_container_count,
  "ollama_version": "$ollama_version",
  "ollama_update_available": $([ -n "$ollama_update" ] && echo true || echo false)
}
ENDJSON

echo "[check-deps] $TIMESTAMP — $summary"

# --- Notify via IPC if updates found ---
if [ "$updates_found" = true ]; then
  IPC_DIR="$NANOCLAW_DIR/data/ipc/main/messages"
  mkdir -p "$IPC_DIR"

  # Read the main group's chat JID from the database
  MAIN_JID=$(sqlite3 "$NANOCLAW_DIR/store/messages.db" \
    "SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1" 2>/dev/null || true)

  if [ -n "$MAIN_JID" ]; then
    cat > "$IPC_DIR/dep-check-$(date +%s).json" <<IPCJSON
{
  "type": "message",
  "chatJid": "$MAIN_JID",
  "text": "[Weekly Dep Check] $summary. Reply 'update deps' if you'd like me to handle it."
}
IPCJSON
    echo "[check-deps] Notification sent via IPC"
  fi
fi
