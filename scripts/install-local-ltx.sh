#!/usr/bin/env bash
# Installs LTX-2.5 for local generation on Apple Silicon: the MLX runtime (github.com/dgrauet/ltx-2-mlx, MIT)
# and the 4-bit weights (huggingface.co/dgrauet/ltx-2.5-mlx-q4, LTX-2.x Community License).
#
# The weights are gated: accept the licence on the model page once, then `hf auth login` with a read token.
# Only the distilled pipeline's files are downloaded (~31 GB). Pass --quality to add the dev transformer and the
# distilled LoRA (~20 GB more) for the slower, higher-quality two-stage mode.
# Re-running resumes an interrupted download.
set -euo pipefail

RUNTIME_TAG="v0.15.12"
PACK_REPO="dgrauet/ltx-2.5-mlx-q4"
# Same location rules as the app (src/server/env.ts): STUDIO_MODELS_DIR, else the folder app.json records (models
# that stayed in the old library because they couldn't be moved), else <app data>/Models.
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
RUNTIME="$MODELS/ltx-2-mlx"
PACK="$MODELS/ltx-2.5-mlx-q4"
QUALITY=0
[[ "${1:-}" == "--quality" ]] && QUALITY=1

[[ "$(uname -s)-$(uname -m)" == "Darwin-arm64" ]] || { echo "LTX-2.5 (MLX) needs an Apple Silicon Mac." >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/ (brew install uv)" >&2; exit 1; }
mkdir -p "$MODELS"

# A virtualenv holds absolute paths: after the Models folder moved it must be rebuilt (the weights are kept).
if [[ -d "$RUNTIME/.venv" ]] && ! "$RUNTIME/.venv/bin/ltx-2-mlx" --help >/dev/null 2>&1; then
  echo "==> The runtime's virtualenv is broken (moved?) — rebuilding it"
  rm -rf "$RUNTIME/.venv"
fi
if [[ ! -x "$RUNTIME/.venv/bin/ltx-2-mlx" ]]; then
  echo "==> Installing the MLX runtime ($RUNTIME_TAG) into $RUNTIME"
  [[ -d "$RUNTIME" ]] || git clone --depth 1 --branch "$RUNTIME_TAG" https://github.com/dgrauet/ltx-2-mlx.git "$RUNTIME"
  (cd "$RUNTIME" && uv sync)
else
  echo "==> Runtime already installed ($RUNTIME)"
fi

HF="$RUNTIME/.venv/bin/hf"
# `hf auth whoami` exits 0 even when logged out, so read what it says.
if HF_HUB_DISABLE_UPDATE_CHECK=1 "$HF" auth whoami 2>&1 | grep -q "Not logged in"; then
  cat >&2 <<EOF

Hugging Face login needed (the weights are gated):
  1. Accept the licence at https://huggingface.co/$PACK_REPO
  2. Create a read token at https://huggingface.co/settings/tokens
  3. Run:  "$HF" auth login
Then run this script again.
EOF
  exit 1
fi

if [[ $QUALITY == 1 ]]; then
  echo "==> Downloading $PACK_REPO (distilled + dev for Quality mode, ~51 GB) into $PACK"
  "$HF" download "$PACK_REPO" --local-dir "$PACK"
else
  echo "==> Downloading $PACK_REPO (distilled, ~31 GB) into $PACK"
  "$HF" download "$PACK_REPO" --local-dir "$PACK" \
    --exclude "transformer-dev.safetensors" --exclude "*distilled-lora*"
fi

echo "==> Done. LTX-2.5 (this Mac) is now available in Generate → Video."
