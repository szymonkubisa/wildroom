#!/usr/bin/env bash
# Wildroom — terminates this pod when nothing uses it. The app stops idle GPUs itself; this is the backstop
# for when the app cannot (Mac asleep, app quit or crashed, network gone), so a forgotten pod never bills for long.
#
# Busy = ComfyUI has prompts running or waiting. Alive = the app sent a heartbeat (through Caddy, with the token)
# within the last WILDROOM_WATCHDOG_MIN minutes. Neither for WILDROOM_WATCHDOG_MIN minutes → terminate. Also terminates after
# WILDROOM_MAX_HOURS no matter what.
set -u

W=${WILDROOM_WORKSPACE:-/workspace}
B=$W/bootstrap
IDLE_MIN=${WILDROOM_WATCHDOG_MIN:-10}
MAX_HOURS=${WILDROOM_MAX_HOURS:-8}
BOOT_MIN=${WILDROOM_BOOT_MIN:-30}
TICK=${WILDROOM_WATCHDOG_TICK:-60}
HEARTBEAT_LOG=$B/logs/heartbeat.log
COMFY=${WILDROOM_COMFY_URL:-http://127.0.0.1:18188}

log() { echo "[wildroom] watchdog: $* ($(date -u +%FT%TZ))"; }

terminate() {
  log "$1 — terminating pod ${RUNPOD_POD_ID:-?}"
  if [ -n "${RUNPOD_API_KEY:-}" ] && curl -fsS -X DELETE "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" \
    -H "Authorization: Bearer $RUNPOD_API_KEY" >/dev/null; then
    return
  fi
  runpodctl remove pod "$RUNPOD_POD_ID" 2>/dev/null || runpodctl pod delete "$RUNPOD_POD_ID" 2>/dev/null \
    || log "could not terminate the pod: stop it in the RunPod console"
}

started=$(date +%s)
seen_up=0
idle=0
log "on (idle ${IDLE_MIN} min, max ${MAX_HOURS} h)"
while sleep "$TICK"; do
  now=$(date +%s)
  if [ $((now - started)) -ge $((MAX_HOURS * 3600)) ]; then
    terminate "running for ${MAX_HOURS} h"
    continue
  fi

  queue=$(curl -fsS --max-time 5 "$COMFY/queue" 2>/dev/null || true)
  if [ -z "$queue" ]; then
    # Not answering yet: the first boot (copying ComfyUI, loading models) may take a while.
    if [ "$seen_up" -eq 0 ] && [ $((now - started)) -lt $((BOOT_MIN * 60)) ]; then continue; fi
    busy=0
  else
    seen_up=1
    busy=$(python3 -c 'import json,sys
try:
    d = json.loads(sys.argv[1]); print(len(d.get("queue_running", [])) + len(d.get("queue_pending", [])))
except Exception:
    print(0)' "$queue")
  fi

  heartbeat_age=999999
  if [ -f "$HEARTBEAT_LOG" ] && tail -n 1 "$HEARTBEAT_LOG" | grep -q '"status":204'; then
    heartbeat_age=$((now - $(stat -c %Y "$HEARTBEAT_LOG" 2>/dev/null || echo 0)))
  fi

  if [ "$busy" -gt 0 ] || [ "$heartbeat_age" -lt $((IDLE_MIN * 60)) ]; then
    idle=0
  else
    idle=$((idle + 1))
  fi
  if [ $((idle * TICK)) -ge $((IDLE_MIN * 60)) ]; then
    terminate "idle ${IDLE_MIN} min and no word from the app"
    idle=0
  fi
done
