#!/bin/bash
# Regenerate the README gallery screenshots from known UI states.
# Requires: npm install (for puppeteer)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="node"

echo "Generating README screenshots..."
"$NODE" "$DIR/readme-screenshots.js"
echo "Done. Screenshots:"
ls -1 \
  "$DIR/landing-screen.png" \
  "$DIR/board-in-play.png" \
  "$DIR/about-screen.png" \
  "$DIR/how-to-play-screen.png"
