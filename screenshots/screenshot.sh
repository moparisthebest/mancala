#!/bin/bash
# Regenerate all board screenshots.
# Requires: npm install (for puppeteer)

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="node"

echo "Generating board screenshots..."

$NODE "$DIR/screenshot.js" "$DIR/board-1-12.png" \
  1 2 3 4 5 6  7 8 9 10 11 12

$NODE "$DIR/screenshot.js" "$DIR/board-13-24.png" \
  13 14 15 16 17 18  19 20 21 22 23 24

$NODE "$DIR/screenshot.js" "$DIR/board-stores-24.png" \
  0 0 0 0 0 0  0 0 0 0 0 0  24 24

$NODE "$DIR/screenshot.js" "$DIR/board-stores-3-5.png" \
  0 0 0 0 0 0  0 0 0 0 0 0  3 5

$NODE "$DIR/screenshot.js" "$DIR/board-stores-11-13.png" \
  0 0 0 0 0 0  0 0 0 0 0 0  11 13

$NODE "$DIR/screenshot.js" "$DIR/board-stores-33-36.png" \
  0 0 0 0 0 0  0 0 0 0 0 0  33 36

$NODE "$DIR/screenshot.js" "$DIR/board-store-48.png" \
  0 0 0 0 0 0  0 0 0 0 0 0  48 0

echo "Done. Screenshots:"
ls -1 "$DIR"/board-*.png
