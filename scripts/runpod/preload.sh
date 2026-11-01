#!/usr/bin/env bash
# Wildroom — runs in the background when a render pod starts. The app sends it with the pod (WILDROOM_PRELOAD_SH),
# so it is not stored on the volume and changes without preparing the volume again.
#
# Reads the model files the first render loads (WILDROOM_PRELOAD: paths under the models folder) into the page cache
# while ComfyUI boots, in 1 GiB slices with many readers at once: the network volume is far faster that way than
# with ComfyUI's single reader (~4.5 min for the ~70 GB bf16 set). Skipped when the pod's memory cannot keep them.
set -u
M=${WILDROOM_MODELS:-/workspace/models}
LOG=${WILDROOM_PRELOAD_LOG:-/workspace/bootstrap/logs/preload.log}
mkdir -p "$(dirname "$LOG")"
log() { echo "[wildroom] preload: $* ($(date -u +%FT%TZ))" >>"$LOG"; }

files=()
need=0
for f in ${WILDROOM_PRELOAD:-}; do
  [ -f "$M/$f" ] || continue
  files+=("$M/$f")
  need=$((need + $(stat -c %s "$M/$f")))
done
[ ${#files[@]} -gt 0 ] || exit 0

# Memory the page cache can use: the container's limit when it has one, else the machine's.
mem=$(($(awk '/^MemTotal:/ { print $2 }' "${WILDROOM_MEMINFO:-/proc/meminfo}") * 1024))
for limit in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
  v=$(cat "$limit" 2>/dev/null || true)
  if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -lt "$mem" ]; then mem=$v; fi
done
# Room for ComfyUI itself; without it the first slices would be evicted before ComfyUI reads them.
reserve=$((mem / 5 > 16 << 30 ? mem / 5 : 16 << 30))
if [ $((need + reserve)) -gt "$mem" ]; then
  log "skipped: $((need >> 30)) GB of models, $((mem >> 30)) GB of memory"
  exit 0
fi

log "reading $((need >> 30)) GB in ${#files[@]} files"
start=$(date +%s)
for f in "${files[@]}"; do
  slices=$((($(stat -c %s "$f") + (1 << 30) - 1) >> 30))
  for ((i = 0; i < slices; i++)); do echo "$f $i"; done
done | xargs -P "${WILDROOM_PRELOAD_JOBS:-16}" -n 2 sh -c 'dd if="$0" of=/dev/null bs=16M skip=$(($1 * 64)) count=64 status=none'
log "done in $(($(date +%s) - start)) s"
