#!/usr/bin/env bash
# Installs FLUX.2 [klein] for local image generation on Apple Silicon: the MLX runtime (pypi.org/project/mflux, MIT)
# and pre-quantized weights from huggingface.co/mflux-community (no Hugging Face login needed).
#
# Default: klein 4B in 4-bit (Fast, 4.6 GB) and 8-bit (Quality, 8.6 GB), both Apache-2.0.
# --max adds klein 9B in 4-bit (9.5 GB): sharper, but the FLUX Non-Commercial licence applies and on a 16 GB Mac
# it only just fits. --fast-only installs just the 4-bit 4B.
# Re-running resumes an interrupted download.
set -euo pipefail

MFLUX_VERSION="0.21.0"
# Same location rules as the app (src/server/env.ts): STUDIO_MODELS_DIR, else the folder app.json records, else
# <app data>/Models.
if [[ -n "${STUDIO_HOME:-}" ]]; then
  APP_DATA="$STUDIO_HOME/AppData"
else
  APP_DATA="$HOME/Library/Application Support/Wildroom"
fi
RECORDED=""
if [[ -f "$APP_DATA/app.json" ]] && command -v node >/dev/null; then
  RECORDED="$(node -e 'try { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof d.modelsDir === "string" ? d.modelsDir : "") } catch {}' "$APP_DATA/app.json")"
fi
if [[ -n "${STUDIO_MODELS_DIR:-}" ]]; then
  MODELS="$STUDIO_MODELS_DIR"
elif [[ -n "$RECORDED" ]]; then
  MODELS="$RECORDED"
else
  MODELS="$APP_DATA/Models"
fi
RUNTIME="$MODELS/mflux"

PACKS=(flux2-klein-4b-mflux-q4 flux2-klein-4b-mflux-q8)
case "${1:-}" in
  --max) PACKS+=(flux2-klein-9b-mflux-q4) ;;
  --fast-only) PACKS=(flux2-klein-4b-mflux-q4) ;;
  "") ;;
  *) echo "Usage: $0 [--max | --fast-only]" >&2; exit 1 ;;
esac

[[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]] || { echo "FLUX.2 (MLX) needs an Apple Silicon Mac." >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/ (brew install uv)" >&2; exit 1; }
mkdir -p "$MODELS"

# A virtualenv holds absolute paths: after the Models folder moved it must be rebuilt (the weights are kept).
if [[ -d "$RUNTIME/.venv" ]] && ! "$RUNTIME/.venv/bin/mflux-generate-flux2" --help >/dev/null 2>&1; then
  echo "==> The runtime's virtualenv is broken (moved?) — rebuilding it"
  rm -rf "$RUNTIME/.venv"
fi
if [[ ! -x "$RUNTIME/.venv/bin/mflux-generate-flux2" ]] || ! "$RUNTIME/.venv/bin/python" -c "import importlib.metadata as m, sys; sys.exit(m.version('mflux') != '$MFLUX_VERSION')" 2>/dev/null; then
  echo "==> Installing mflux $MFLUX_VERSION into $RUNTIME"
  mkdir -p "$RUNTIME"
  [[ -d "$RUNTIME/.venv" ]] || uv venv --python 3.12 "$RUNTIME/.venv"
  uv pip install --python "$RUNTIME/.venv/bin/python" "mflux==$MFLUX_VERSION" "huggingface_hub[cli]"
else
  echo "==> Runtime already installed ($RUNTIME, mflux $MFLUX_VERSION)"
fi

HF="$RUNTIME/.venv/bin/hf"
for pack in "${PACKS[@]}"; do
  dest="$MODELS/$pack"
  if [[ -f "$dest/.complete" ]]; then
    echo "==> $pack already downloaded"
    continue
  fi
  echo "==> Downloading mflux-community/$pack into $dest"
  # Only the folders mflux loads: some repos also carry a stray duplicate copy of the weights.
  HF_HUB_DISABLE_UPDATE_CHECK=1 "$HF" download "mflux-community/$pack" --local-dir "$dest" \
    --include "transformer/*" --include "text_encoder/*" --include "vae/*" --include "tokenizer/*" --include "*.json"
  touch "$dest/.complete"
done

echo "==> Done. FLUX.2 [klein] (this Mac) is now the default in Generate → Image."
