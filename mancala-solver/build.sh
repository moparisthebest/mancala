#!/bin/sh
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MANIFEST_PATH="$SCRIPT_DIR/Cargo.toml"
TARGET_DIR="$SCRIPT_DIR/target"
TARGET_PATH="$TARGET_DIR/wasm32-unknown-unknown/release/mancala_solver.wasm"
OUTPUT_PATH="$REPO_ROOT/mancala-solver.wasm"
CARGO_BIN="${CARGO:-cargo}"

rm -f "$OUTPUT_PATH"

"$CARGO_BIN" build --manifest-path "$MANIFEST_PATH" --lib --target wasm32-unknown-unknown --target-dir "$TARGET_DIR" --release
cp "$TARGET_PATH" "$OUTPUT_PATH"

if command -v llvm-strip >/dev/null 2>&1; then
  llvm-strip -s "$OUTPUT_PATH" || true
fi

echo "Built $OUTPUT_PATH ($(du -h "$OUTPUT_PATH" | cut -f1))"
