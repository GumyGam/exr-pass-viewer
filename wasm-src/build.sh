#!/usr/bin/env bash
# Build the tinyexr WASM module via Emscripten + Embind.
#
# Produces:
#   public/tinyexr.mjs   ES-module loader
#   public/tinyexr.wasm  WASM binary
#
# Idempotent. Resolves all paths from the script's own location so the cwd
# does not matter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC_DIR="$REPO_ROOT/public"
BINDINGS="$SCRIPT_DIR/bindings.cpp"
TINYEXR_DIR="$SCRIPT_DIR/tinyexr"
EMSDK_ENV="/Users/agam/emsdk/emsdk_env.sh"

if [[ ! -f "$EMSDK_ENV" ]]; then
  echo "error: emsdk env not found at $EMSDK_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$EMSDK_ENV" >/dev/null

if ! command -v em++ >/dev/null 2>&1; then
  echo "error: em++ not in PATH after sourcing emsdk_env.sh" >&2
  exit 1
fi

mkdir -p "$PUBLIC_DIR"

OUT_MJS="$PUBLIC_DIR/tinyexr.mjs"
OUT_WASM="$PUBLIC_DIR/tinyexr.wasm"

# Clean prior outputs so a failed re-link does not leave stale .wasm around.
rm -f "$OUT_MJS" "$OUT_WASM"

BUILD_DIR="$SCRIPT_DIR/.build"
mkdir -p "$BUILD_DIR"
MINIZ_OBJ="$BUILD_DIR/miniz.o"
BINDINGS_OBJ="$BUILD_DIR/bindings.o"

echo "Building miniz (C)..."
emcc \
  -c \
  -O3 \
  -I "$TINYEXR_DIR/deps/miniz" \
  "$TINYEXR_DIR/deps/miniz/miniz.c" \
  -o "$MINIZ_OBJ"

echo "Building bindings.cpp..."
em++ \
  -c \
  -std=c++17 \
  -O3 \
  -fexceptions \
  -I "$TINYEXR_DIR" \
  -I "$TINYEXR_DIR/deps/miniz" \
  "$BINDINGS" \
  -o "$BINDINGS_OBJ"

echo "Linking tinyexr WASM..."
em++ \
  -O3 \
  "$BINDINGS_OBJ" \
  "$MINIZ_OBJ" \
  -lembind \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s SINGLE_FILE=0 \
  -s ENVIRONMENT=web,worker,node \
  -s EXPORT_NAME=createTinyExrModule \
  -s INITIAL_MEMORY=67108864 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s STACK_SIZE=5242880 \
  -s DISABLE_EXCEPTION_CATCHING=0 \
  -fexceptions \
  -o "$OUT_MJS"

echo ""
echo "Build complete. Output sizes:"
ls -lh "$OUT_MJS" "$OUT_WASM" | awk '{printf "  %s  %s\n", $5, $NF}'
