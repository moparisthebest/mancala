#!/bin/sh
set -e

OUTPUT="mancala.xdc"
SOLVER_MESSAGE="all solvers included"
SOLVER_FILES=""
rm -f "$OUTPUT"

if sh ./mancala-solver/build.sh && [ -f mancala-solver.wasm ]; then
  SOLVER_FILES="mancala-solver.wasm"
else
  SOLVER_MESSAGE="install Rust to build all solvers"
fi

# Only include files needed for the .xdc (not webxdc.js — Delta Chat injects it)
zip -9 -j "$OUTPUT" \
  index.html \
  manifest.toml \
  icon.png \
  $SOLVER_FILES

echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1)); $SOLVER_MESSAGE"
