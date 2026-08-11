#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CAST_FILE="${1:-docs/demo-lm-studio-warm.cast}"

if [[ "$CAST_FILE" != *.cast ]]; then
  echo "Output must be a .cast file. Example: ./scripts/record-demo.sh docs/demo-lm-studio-warm.cast" >&2
  exit 1
fi

if ! command -v asciinema >/dev/null 2>&1; then
  echo "asciinema is required for demo recording but was not found." >&2
  echo "Install: brew install asciinema" >&2
  exit 1
fi

cd "$ROOT_DIR"
ABS_CAST_PATH="$ROOT_DIR/$CAST_FILE"

echo "Recording demo to: $ABS_CAST_PATH"
asciinema rec --overwrite --command "bun run ./scripts/demo-console.ts" "$ABS_CAST_PATH"

echo "Saved cast: $ABS_CAST_PATH"
