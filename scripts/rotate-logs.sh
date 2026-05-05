#!/bin/bash
# Copy-truncate rotation for nanoclaw logs. Safe with open fds — node keeps
# writing to the same inode after truncation. Keeps 5 gzipped generations.
#
# Triggered daily by ~/Library/LaunchAgents/com.nanoclaw.rotate-logs.plist,
# and proactively by start.sh when a log exceeds the size threshold.

set -euo pipefail

LOG_DIR="/Users/Shared/nanoclaw/logs"
THRESHOLD_BYTES=$((100 * 1024 * 1024))   # rotate when file > 100 MB
KEEP=5

rotate() {
  local file="$1"
  [ -f "$file" ] || return 0

  local size
  size=$(stat -f%z "$file" 2>/dev/null || echo 0)
  if [ "$size" -lt "$THRESHOLD_BYTES" ]; then
    return 0
  fi

  # Shift older generations: file.4.gz -> file.5.gz, ..., file.0.gz -> file.1.gz
  for i in $(seq $((KEEP - 1)) -1 0); do
    if [ -f "${file}.${i}.gz" ]; then
      mv -f "${file}.${i}.gz" "${file}.$((i + 1)).gz"
    fi
  done
  # drop anything past KEEP
  rm -f "${file}.$((KEEP + 1)).gz"

  # Copy current contents to .0 (atomically: cp then truncate the live file)
  cp "$file" "${file}.0"
  : > "$file"
  gzip -f "${file}.0"
}

rotate "$LOG_DIR/nanoclaw.log"
rotate "$LOG_DIR/nanoclaw.error.log"
