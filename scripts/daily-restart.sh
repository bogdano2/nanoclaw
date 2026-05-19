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
# spinup. 180s was reached after the 60s floor caused false positives on
# 2026-05-12. Actual node bind is ~3s when Docker is already up, so 180s
# already includes generous headroom; the historical 15–19 min "timeout"
# gaps were the kickstart call hanging, not this wait. See KICKSTART_TIMEOUT.
VERIFY_TIMEOUT=180       # seconds to wait for new instance to bind 3001
KICKSTART_TIMEOUT=30     # cap on launchctl kickstart — it can hang for minutes
                         # if launchd is in a transitional state, which is what
                         # produced 18-min "timeouts" before this cap was added.
LOG="/Users/Shared/nanoclaw/logs/daily-restart.log"

log() {
  echo "[$(date -Iseconds)] daily-restart: $*" >> "$LOG"
}

notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"NanoClaw daily-restart\" sound name \"Sosumi\"" 2>/dev/null || true
}

# Run a command with a hard wall-clock timeout. Returns the command's exit
# code on success, 124 on timeout (matching coreutils convention).
run_with_timeout() {
  local secs=$1; shift
  /usr/bin/perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

# Use -k so launchd resets its view of the job. Without -k, when the previous
# instance exited cleanly (which is what happens after our SIGTERM), launchd
# treats it as "exited successfully" + ThrottleInterval=30s and silently
# refuses the kickstart — observed as 180s timeouts on every daily run from
# 2026-05-12 to 05-19. Safe to use -k here because we've already killed node
# ourselves and confirmed port 3001 is free; -k will only reap the bash
# wrapper (start.sh), which is idempotent.
kickstart() {
  run_with_timeout "$KICKSTART_TIMEOUT" /bin/launchctl kickstart -k "gui/$(id -u)/$LABEL" >>"$LOG" 2>&1
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

# Kickstart with -k (see kickstart() comment) wrapped with a hard timeout
# because the call can hang for many minutes if launchd is in a transitional
# state (observed 15–19 min hangs on 2026-05-12..05-19).
log "kickstarting $LABEL"
kickstart
KICK_RC=$?
if [ "$KICK_RC" -eq 124 ]; then
  log "WARN: launchctl kickstart hung past ${KICKSTART_TIMEOUT}s — proceeding to port-bind verify anyway"
elif [ "$KICK_RC" -ne 0 ]; then
  log "WARN: launchctl kickstart returned $KICK_RC — proceeding to port-bind verify anyway"
fi

# Verify the new instance binds 3001 (covers the Docker-wait window in start.sh).
if wait_port_bound "$VERIFY_TIMEOUT"; then
  log "OK — new PID $(port_holder_pid) listening on $PORT"
  exit 0
fi

# First verify failed — try one more kickstart -k in case the first one hit a
# launchd race. Rare path now that we use -k from the start, but kept as a
# defensive fallback since the failure is silent and the user-facing cost of
# nanoclaw being down for a day is high.
log "WARN: no bind after ${VERIFY_TIMEOUT}s — retrying kickstart -k"
kickstart || log "WARN: retry kickstart returned non-zero or timed out"

if wait_port_bound "$VERIFY_TIMEOUT"; then
  log "OK on retry — new PID $(port_holder_pid) listening on $PORT"
  exit 0
fi

log "ERROR: no process bound port $PORT after retry — nanoclaw is DOWN"
notify "Daily restart failed — nanoclaw is not bound to port $PORT. Check logs/daily-restart.log."
exit 3
