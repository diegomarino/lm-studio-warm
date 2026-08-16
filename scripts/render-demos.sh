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

render docs/assets/quickstart-omp.cast      docs/assets/quickstart-omp.gif
render docs/assets/quickstart-pi.cast       docs/assets/quickstart-pi.gif
render docs/assets/quickstart-opencode.cast docs/assets/quickstart-opencode.gif

ls -lh docs/assets/quickstart-*.gif
