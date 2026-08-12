#!/usr/bin/env python3
"""Generate docs/demo-lm-studio-warm.cast (asciicast v2) for the README demo GIF.

Adapted from opencode-lmstudio-warm's tools/quickstart/generate-cast.py.
The demo is scripted, not screen-recorded, so it stays reproducible and free
of machine-specific noise — the plugin-facing lines (status/working message,
log wording, activation notice) are taken verbatim from the plugin's own
strings in src/stream.ts, src/index.ts and src/warm-gate.ts, and the `lms`
output lines from a real macOS/Apple Silicon capture. The ~4.5 s spinner
stands in for a real multi-second cold model load; unlike opencode, omp's
status bar really does show this working message (src/stream.ts:55-56) —
the spinner visualizes it.

Run from the repo root:
  python3 scripts/generate-quickstart-cast.py
  agg --font-size 16 --last-frame-duration 8 docs/demo-lm-studio-warm.cast docs/quickstart.gif
  python3 scripts/add-progress-bar.py docs/quickstart.gif
  gifsicle -O3 --colors 256 --batch docs/quickstart.gif
"""

import json
import random
import sys

random.seed(42)  # deterministic timings → stable diff on regeneration

WIDTH, HEIGHT = 110, 24

GREY = "\x1b[90m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
GREEN = "\x1b[32m"
RESET = "\x1b[0m"
PROMPT = f"\x1b[1;32m$\x1b[0m "

events = []
t = 0.0


def out(delay, data):
    global t
    t += delay
    events.append([round(t, 3), "o", data])


def type_text(text, cps_delay=0.045):
    for ch in text:
        out(cps_delay + random.uniform(-0.02, 0.04), ch)


def prompt():
    out(0.4, PROMPT)


def enter():
    out(0.15, "\r\n")


# ── Scene 1: opt-in by config file (presence activates the plugin) ───────────
prompt()
type_text(f"{GREY}# opt in: the config file's presence is the switch{RESET}", 0.028)
enter()
prompt()
type_text("mkdir -p ~/.omp/agent && cat > ~/.omp/agent/lm-studio-warm.yml <<'YAML'")
enter()
out(0.25, "eager: true\r\n")
out(0.20, "failMode: hybrid\r\n")
out(0.20, "YAML\r\n")

# ── Scene 2: LM Studio is cold ───────────────────────────────────────────────
out(0.9, "")
prompt()
type_text("lms ps")
enter()
out(0.35, "\r\nNo models are currently loaded.\r\n")

# ── Scene 3: first request warms the model before it leaves omp ──────────────
out(1.2, "")
prompt()
type_text(f"{GREY}# first request — the plugin loads the model BEFORE the request leaves{RESET}", 0.028)
enter()
prompt()
type_text('omp -p "Reply with exactly: Hello from a pre-warmed model!" --model qwen/qwen3.6-35b-a3b')
enter()

out(0.8, f"\r\n{GREY}> qwen/qwen3.6-35b-a3b · api lm-studio-warm{RESET}\r\n\r\n")
# Cold load happens here (real: seconds to minutes, compressed). The working
# message below is the plugin's real string (src/stream.ts:56); omp shows it
# in the status area while the gate holds the request. The "loaded ... in 7s"
# line is the gate's real log wording (src/warm-gate.ts:499).
SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
for i in range(50):
    out(0.09, f"\r\x1b[2K{GREY}{SPIN[i % 10]} lm-studio-warm: ensuring qwen/qwen3.6-35b-a3b is loaded (a cold load can take minutes){RESET}")
out(0.15, f"\r\x1b[2K{GREY}✓ lm-studio-warm: loaded qwen/qwen3.6-35b-a3b in 7s{RESET}")
out(1.0, "\r\x1b[2K")
for ch in "Hello from a pre-warmed model!":
    out(0.018, ch)
out(0.0, "\r\n")

# ── Scene 4: model resident, no TTL ──────────────────────────────────────────
out(1.4, "")
prompt()
type_text(f"lms ps   {GREY}# model resident — no TTL, no mid-request cold load{RESET}", 0.035)
enter()
out(0.4, "\r\n")
out(
    0.0,
    f"{BOLD}IDENTIFIER              MODEL                   STATUS    SIZE        CONTEXT    PARALLEL    DEVICE    TTL{RESET}\r\n"
    "qwen/qwen3.6-35b-a3b    qwen/qwen3.6-35b-a3b    IDLE      20.43 GB    204800     4           Local\r\n",
)
out(0.5, "")
prompt()
out(8.0, "")  # hold the final frame long enough to read the closing state

header = {
    "version": 2,
    "width": WIDTH,
    "height": HEIGHT,
    "title": "omp-lm-studio-warm — quick start",
    "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"},
}

path = sys.argv[1] if len(sys.argv) > 1 else "docs/demo-lm-studio-warm.cast"
with open(path, "w") as f:
    f.write(json.dumps(header) + "\n")
    for ev in events:
        f.write(json.dumps(ev) + "\n")
print(f"wrote {path} ({len(events)} events, {events[-1][0]:.1f}s)")
