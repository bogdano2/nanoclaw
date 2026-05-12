#!/bin/bash
# Daily restart of nanoclaw with a graceful-shutdown + port-release wait.
#
# Replaces the previous `launchctl kickstart -k gui/<uid>/com.nanoclaw` line.
# That command was racing: launchd sent SIGTERM and then proceeded to start a
# new instance before the old one had finished closing its sockets, leaving
# the old node process running outside launchd's process group and holding
# port 3001 (credential proxy). The new instance crashlooped on EADDRINUSE
# until someone manually killed the orphan. Symptom-side, this corrupted
# creds.json mid-write at least once per recurrence.
#
# This script:
#   1. Logs context.
#   2. Finds nanoclaw's node PID by lsof on port 3001 (the canonical canary).
#   3. SIGTERMs it and polls until the port frees, up to GRACEFUL_TIMEOUT.
#   4. SIGKILLs if still bound and waits a few more seconds.
#   5. Triggers launchd to start fresh (kickstart WITHOUT -k now that we've
#      done the kill ourselves cleanly).
#   6. Verifies the new instance binds within VERIFY_TIMEOUT.
#   7. Exits non-zero on failure so the launchd log records the problem.

set -uo pipefail

LABEL="com.nanoclaw"
PORT=3001
GRACEFUL_TIMEOUT=30      # seconds to wait for SIGTERM-driven exit
# VERIFY_TIMEOUT covers start.sh's Docker-wait window (up to 120s) plus node
# spinup. Set to 180s after observing two false-positive failures at 60s on
# 2026-05-12 — the new instance bound port 3001 ~80s after kickstart, well
# past the old timeout.
VERIFY_TIMEOUT=180       # seconds to wait for new instance to bind 3001
LOG="/Users/Shared/nanoclaw/logs/daily-restart.log"

log() {
  echo "[$(date -Iseconds)] daily-restart: $*" >> "$LOG"
}

port_holder_pid() {
  /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 {print $2; exit}'
}

wait_port_free() {
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -z "$(port_holder_pid)" ]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_port_bound() {
  local deadline=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -n "$(port_holder_pid)" ]; then return 0; fi
    sleep 1
  done
  return 1
}

log "starting"

OLD_PID=$(port_holder_pid)
if [ -z "$OLD_PID" ]; then
  log "no process holding port $PORT — nothing to stop, just kickstarting"
else
  OLD_ETIME=$(ps -p "$OLD_PID" -o etime= 2>/dev/null | tr -d ' ')
  log "found PID $OLD_PID on port $PORT (etime=$OLD_ETIME) — SIGTERM"
  /bin/kill -TERM "$OLD_PID" 2>/dev/null || log "SIGTERM to $OLD_PID failed (already gone?)"

  if wait_port_free "$GRACEFUL_TIMEOUT"; then
    log "port $PORT released cleanly after SIGTERM"
  else
    STILL_PID=$(port_holder_pid)
    log "port $PORT still held by PID $STILL_PID after ${GRACEFUL_TIMEOUT}s — SIGKILL"
    [ -n "$STILL_PID" ] && /bin/kill -KILL "$STILL_PID" 2>/dev/null
    if ! wait_port_free 5; then
      log "ERROR: port $PORT STILL held after SIGKILL — aborting (launchd will not start fresh)"
      exit 1
    fi
    log "port $PORT released after SIGKILL"
  fi
fi

# Kickstart WITHOUT -k since we just did the killing ourselves.
log "kickstarting $LABEL"
/bin/launchctl kickstart "gui/$(id -u)/$LABEL" 2>>"$LOG" || {
  log "ERROR: launchctl kickstart returned non-zero"
  exit 2
}

# Verify the new instance binds 3001 (covers the Docker-wait window in start.sh).
if wait_port_bound "$VERIFY_TIMEOUT"; then
  NEW_PID=$(port_holder_pid)
  log "OK — new PID $NEW_PID listening on $PORT"
  exit 0
else
  log "ERROR: no process bound port $PORT after ${VERIFY_TIMEOUT}s — service may be stuck on Docker wait or another startup step"
  exit 3
fi
