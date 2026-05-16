#!/bin/sh
set -e

OUTPUT="mancala.xdc"
rm -f "$OUTPUT"

# Only include files needed for the .xdc (not webxdc.js — Delta Chat injects it)
zip -9 -j "$OUTPUT" \
  index.html \
  manifest.toml \
  icon.png

echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
