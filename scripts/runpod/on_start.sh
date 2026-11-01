#!/usr/bin/env bash
# Wildroom — runs at every start of a render pod, before RunPod's own /start.sh (ComfyUI).
# Lives on the network volume (/workspace/bootstrap); setup-volume.sh installs it there.
#
#  1. ComfyUI listens on loopback only (127.0.0.1:18188) and reads models from /workspace/models.
#  2. Caddy on :8188 lets in only requests carrying the app's token. No valid token: nothing is exposed.
#  3. A watchdog terminates the pod when nothing uses it (the app is gone, asleep or crashed).
#  4. Renders older than 7 days are removed so the volume does not fill up (the app already downloaded them).
set -u

W=${WILDROOM_WORKSPACE:-/workspace}
B=$W/bootstrap
LOGS=$B/logs
mkdir -p "$LOGS"
log() { echo "[wildroom] $* ($(date -u +%FT%TZ))" >>"$LOGS/on_start.log"; }
log "pod start ${RUNPOD_POD_ID:-?}"

# ---- 1. ComfyUI arguments: a managed block at the end of comfyui_args.txt (the user's own lines stay above it).
ARGS=$W/runpod-slim/comfyui_args.txt
mkdir -p "$(dirname "$ARGS")"
touch "$ARGS"
tmp=$(mktemp)
# Any managed block ("# >>> name … # <<< name") is dropped and ours written again.
awk '/^# >>> /{skip=1} !skip{print} /^# <<< /{skip=0}' "$ARGS" >"$tmp"
cat >>"$tmp" <<EOF
# >>> wildroom (managed by Wildroom: replaced at every start)
--listen 127.0.0.1
--port 18188
--extra-model-paths-config $W/models/extra_model_paths.yaml
# <<< wildroom
EOF
mv "$tmp" "$ARGS"

# ---- 2. The token gate.
TOKEN=${COMFY_AUTH_TOKEN:-}
if [ -z "$TOKEN" ] && [ -f "$B/token" ]; then TOKEN=$(tr -d '\r\n' <"$B/token"); fi
if [[ "$TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] && [ -x "$B/bin/caddy" ]; then
  export COMFY_AUTH_TOKEN="$TOKEN"
  export WILDROOM_HEARTBEAT_LOG="$LOGS/heartbeat.log"
  if ! pgrep -f "caddy run --config $B/Caddyfile" >/dev/null 2>&1; then
    # Restarted if it ever exits; ComfyUI itself is never reachable without it.
    setsid bash -c "while :; do '$B/bin/caddy' run --config '$B/Caddyfile' --adapter caddyfile; sleep 2; done" \
      >>"$LOGS/caddy.log" 2>&1 </dev/null &
    log "caddy started"
  fi
else
  log "no valid token or no caddy: ComfyUI stays private (loopback only)"
fi

# ---- 3. The watchdog (only on RunPod, where it can terminate the pod).
if [ -n "${RUNPOD_POD_ID:-}" ] && [ -f "$B/watchdog.sh" ] && ! pgrep -f "$B/watchdog.sh" >/dev/null 2>&1; then
  setsid bash "$B/watchdog.sh" >>"$LOGS/watchdog.log" 2>&1 </dev/null &
  log "watchdog started"
fi

# ---- 4. Old renders.
find "$W/runpod-slim/ComfyUI/output" -type f -mtime +7 -delete 2>/dev/null || true

exec "${WILDROOM_START:-/start.sh}"
