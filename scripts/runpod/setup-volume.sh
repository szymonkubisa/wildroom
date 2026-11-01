#!/usr/bin/env bash
# Wildroom — prepares a RunPod network volume for LTX-2.5 renders. Runs once on a setup pod (the app starts
# one with this as its entrypoint and reads its log); safe to run again: finished steps are skipped, downloads resume.
#
# Leaves on the volume:
#   /workspace/runpod-slim/ComfyUI        ComfyUI + venv (made by the image's first boot) + pinned custom nodes
#   /workspace/models                     LTX-2.5 bf16 and int8 weights, VAEs, upscalers, LoRAs
#   /workspace/bootstrap                  on_start.sh, Caddyfile, watchdog.sh, caddy, token, version
#
# Env: HF_TOKEN (Hugging Face token whose account accepted the LTX-2.5 licence). Optional: WILDROOM_NO_MODELS=1,
# WILDROOM_SELF_TERMINATE=1 (terminate the pod when done, with RUNPOD_API_KEY).
# Progress for the app: "[wildroom] step N/M title", then "[wildroom] done" or "[wildroom] error message".
set -euo pipefail

SETUP_VERSION=3
W=${WILDROOM_WORKSPACE:-/workspace}
B=$W/bootstrap
SRC=${WILDROOM_SRC:-$B/src}
COMFY=$W/runpod-slim/ComfyUI
CN=$COMFY/custom_nodes
MODELS=$W/models
CADDY_VERSION=2.11.7
TOTAL=7

mkdir -p "$B/logs" "$B/bin" "$MODELS" "$B/progress"
exec > >(tee -a "$B/logs/setup.log") 2>&1

# The app follows the setup through this file, served on the pod's HTTP port (progress lines only, no secrets).
PROGRESS=$B/progress/status.txt
: >"$PROGRESS"
if [ -n "${RUNPOD_POD_ID:-}" ]; then
  (cd "$B/progress" && python3 -m http.server "${WILDROOM_PROGRESS_PORT:-8188}" --bind 0.0.0.0 >/dev/null 2>&1 &)
fi
say() { echo "[wildroom] $*" | tee -a "$PROGRESS"; }
step() { say "step $1/$TOTAL $2"; }

terminate_self() {
  [ -n "${RUNPOD_POD_ID:-}" ] && [ -n "${RUNPOD_API_KEY:-}" ] || return 0
  curl -fsS -X DELETE "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" -H "Authorization: Bearer $RUNPOD_API_KEY" >/dev/null || true
}

# Never exit: an exiting PID 1 makes RunPod restart the container (and the setup) while it keeps billing. The app
# terminates the pod once it reads the last line; with WILDROOM_SELF_TERMINATE=1 the pod also does it itself.
finish() {
  trap - ERR
  if [ "${WILDROOM_SELF_TERMINATE:-0}" = 1 ]; then
    sleep 20 # let the app read the last lines first
    terminate_self
  fi
  exec sleep infinity
}

fail() {
  say "error $*"
  finish
}
trap 'fail "setup stopped at line $LINENO (see /workspace/bootstrap/logs/setup.log)"' ERR

# Hard cap in case the app is gone and nobody stops this pod.
(sleep $((${WILDROOM_SETUP_MAX_HOURS:-3} * 3600)) && say "error setup took too long" && terminate_self) &

echo "[wildroom] setup v$SETUP_VERSION on ${RUNPOD_POD_ID:-this machine} ($(date -u +%FT%TZ))"

# ---------------------------------------------------------------- 1. ComfyUI (the image's first boot)
step 1 "Installing ComfyUI on the volume"
# Before ComfyUI ever starts: loopback only (never open on the pod's port) and models from /workspace/models.
cat >"$MODELS/extra_model_paths.yaml" <<EOF
studio:
  base_path: $MODELS
  is_default: true
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  loras: loras
  latent_upscale_models: latent_upscale_models
  model_patches: model_patches
EOF
ARGS=$W/runpod-slim/comfyui_args.txt
mkdir -p "$(dirname "$ARGS")"
touch "$ARGS"
tmp=$(mktemp)
awk '/^# >>> /{skip=1} !skip{print} /^# <<< /{skip=0}' "$ARGS" >"$tmp"
printf '%s\n' '# >>> wildroom (managed by Wildroom: replaced at every start)' '--listen 127.0.0.1' '--port 18188' \
  "--extra-model-paths-config $MODELS/extra_model_paths.yaml" '# <<< wildroom' >>"$tmp"
mv "$tmp" "$ARGS"
venv_python() { ls -d "$COMFY"/.venv-*/bin/python 2>/dev/null | head -n 1; }
if [ -z "$(venv_python)" ] || [ ! -f "$COMFY/main.py" ]; then
  # The image copies ComfyUI onto /workspace and builds its venv on first boot, then starts it (on loopback only, see above).
  if [ -x /start.sh ]; then (/start.sh >"$B/logs/firstboot.log" 2>&1 &); fi
  for _ in $(seq 1 240); do
    [ -n "$(venv_python)" ] && [ -f "$COMFY/main.py" ] && break
    sleep 5
  done
fi
PY=$(venv_python)
[ -n "$PY" ] && [ -f "$COMFY/main.py" ] || fail "ComfyUI did not install (see bootstrap/logs/firstboot.log)"
echo "[wildroom] ComfyUI venv: $PY"

# ---------------------------------------------------------------- 2. Custom nodes (pinned)
step 2 "Installing custom nodes"
NODES=(
  "Lightricks/ComfyUI-LTXVideo 3bf3ca62595f1764c47d01c35c8e5dfe47e1a88f"
  "Kosinkadink/ComfyUI-VideoHelperSuite 4d907bee61e92c2e65af3bd6383a4e4d356126d1"
  "liconstudio/ComfyUI-LTX2.5-MSR 03061c18f8a79d26f3c63931dd8e28f5e5d872a6"
  "rgthree/rgthree-comfy 90709cb49c7371ab76966b181b8438a6cd176202"
)
mkdir -p "$CN"
# Custom nodes must never replace the image's torch build (it matches the GPU driver).
CONSTRAINTS=$B/constraints.txt
"$PY" -m pip freeze 2>/dev/null | grep -iE '^(torch|torchvision|torchaudio|xformers|numpy)==' >"$CONSTRAINTS" || true
for entry in "${NODES[@]}"; do
  read -r repo sha <<<"$entry"
  dir=$CN/${repo#*/}
  [ -d "$dir/.git" ] || git clone --quiet "https://github.com/$repo.git" "$dir"
  if [ "$(git -C "$dir" rev-parse HEAD)" != "$sha" ]; then
    git -C "$dir" fetch --quiet origin "$sha" 2>/dev/null || git -C "$dir" fetch --quiet origin
    git -C "$dir" checkout --quiet "$sha"
  fi
  if [ -f "$dir/requirements.txt" ]; then
    stamp=$dir/.wildroom-requirements-$(sha256sum "$dir/requirements.txt" | cut -c1-12)
    if [ ! -f "$stamp" ]; then
      "$PY" -m pip install --quiet -r "$dir/requirements.txt" -c "$CONSTRAINTS"
      touch "$stamp"
    fi
  fi
  echo "[wildroom] node ${repo#*/} @ ${sha:0:7}"
done

# ---------------------------------------------------------------- 3. Pod start files, token
step 3 "Writing the pod start files"
for f in on_start.sh Caddyfile watchdog.sh; do
  [ -f "$SRC/$f" ] || fail "missing $f next to the setup script"
  install -m 755 "$SRC/$f" "$B/$f"
done
if [ ! -s "$B/token" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_hex(32))' >"$B/token")
fi

# ---------------------------------------------------------------- 4. Caddy (the token gate)
step 4 "Installing the access gate (Caddy $CADDY_VERSION)"
if ! "$B/bin/caddy" version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  t=$(mktemp -d)
  base=https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION
  tarball=caddy_${CADDY_VERSION}_linux_amd64.tar.gz
  curl -fsSL -o "$t/$tarball" "$base/$tarball"
  curl -fsSL -o "$t/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$t" && grep " $tarball\$" checksums.txt | sha512sum -c - >/dev/null) || fail "Caddy download failed its checksum"
  tar -xzf "$t/$tarball" -C "$t" caddy
  install -m 755 "$t/caddy" "$B/bin/caddy"
  rm -rf "$t"
fi
COMFY_AUTH_TOKEN=$(cat "$B/token") WILDROOM_HEARTBEAT_LOG=$B/logs/heartbeat.log \
  "$B/bin/caddy" validate --config "$B/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || fail "the Caddyfile does not validate"

# ---------------------------------------------------------------- 5. Models
step 5 "Downloading LTX-2.5 models (~113 GB)"
LTX_FILES=(
  diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors
  diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors
  text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors
  text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors
  vae/ltx-2.5-video-vae-bf16.safetensors
  vae/ltx-2.5-audio-vae-bf16.safetensors
  latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors
  latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors
)
if [ "${WILDROOM_NO_MODELS:-0}" != 1 ]; then
  [ -n "${HF_TOKEN:-}" ] || fail "no Hugging Face token: add it in the app (Settings → Providers → RunPod)"
  if [ ! -x "$B/venv-tools/bin/hf" ]; then
    python3 -m venv "$B/venv-tools"
    "$B/venv-tools/bin/pip" install --quiet 'huggingface_hub[hf_xet]>=0.34'
  fi
  # The download cache stays on the volume, not the small container disk.
  export HF_HOME=$B/hf-home HF_XET_CHUNK_CACHE_SIZE_BYTES=0 HF_HUB_DISABLE_TELEMETRY=1
  avail=$(df -B1G --output=avail "$W" 2>/dev/null | tail -n 1 | tr -d ' ' || echo 0)
  say "free space on the volume: ${avail} GB"
  download() {
    local repo=$1 dest=$2
    shift 2
    if ! "$B/venv-tools/bin/hf" download "$repo" "$@" --local-dir "$dest" 2>&1 | tee "$B/logs/hf-last.log"; then
      if grep -qiE '401|403|gated|restricted|access' "$B/logs/hf-last.log"; then
        fail "Hugging Face refused $repo: accept its licence at https://huggingface.co/$repo with the account of your token"
      fi
      fail "download of $repo failed (see bootstrap/logs/hf-last.log)"
    fi
  }
  download Lightricks/LTX-2.5 "$MODELS" "${LTX_FILES[@]}"
  download Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients "$MODELS/loras" ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors
  download Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details "$MODELS/loras" ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors
  download LiconStudio/LTX-2.5-Multiple-Subject-Reference "$MODELS/loras" LTX-2.5-Licon-MSR-V2.safetensors
  # Camera guides (a Blender previs): a grey-box playblast as-is, or a depth render (Union, guide at half size).
  download Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render "$MODELS/loras" ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors \
    LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled.json
  download Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control "$MODELS/loras" ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
  rm -rf "$MODELS/.cache" "$MODELS/loras/.cache"
  say "models ready"
else
  echo "[wildroom] skipping models (WILDROOM_NO_MODELS=1)"
fi

# ---------------------------------------------------------------- 6. Example workflows
step 6 "Adding LTX-2.5 example workflows to ComfyUI"
WF=$COMFY/user/default/workflows/LTX-2.5
mkdir -p "$WF"
cp -n "$CN"/ComfyUI-LTXVideo/example_workflows/2.5/*.json "$WF"/ 2>/dev/null || true
cp -n "$MODELS"/loras/LTX-2.5_ICLoRA_Layout_To_Render_*.json "$WF"/ 2>/dev/null || true

# ---------------------------------------------------------------- 7. Done
step 7 "Finishing"
echo "$SETUP_VERSION" >"$B/version"
date -u +%FT%TZ >"$B/setup.done"
say "done"
finish
