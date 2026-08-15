#!/usr/bin/env bash
# Regenerate the scripted demo casts and render their README GIFs.
# Requires: python3 (with Pillow for the progress bar), agg, gifsicle.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 scripts/generate-quickstart-cast.py

render() { # $1 = cast, $2 = gif
  agg --font-size 16 --last-frame-duration 8 "$1" "$2"
  python3 scripts/add-progress-bar.py "$2"
  gifsicle -O3 --colors 256 --batch "$2"
}

render docs/demo-lm-studio-warm.cast           docs/quickstart.gif
render docs/demo-lm-studio-warm-pi.cast        docs/quickstart-pi.gif
render docs/demo-lm-studio-warm-opencode.cast  docs/quickstart-opencode.gif

ls -lh docs/quickstart*.gif
