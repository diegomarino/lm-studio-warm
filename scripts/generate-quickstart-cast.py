#!/usr/bin/env python3
"""Generate the scripted asciicast v2 demos behind the README GIFs.

One cast per user-facing runtime:

  docs/demo-lm-studio-warm.cast           omp      -> docs/quickstart.gif
  docs/demo-lm-studio-warm-pi.cast        pi       -> docs/quickstart-pi.gif
  docs/demo-lm-studio-warm-opencode.cast  opencode -> docs/quickstart-opencode.gif

The demos are scripted, not screen-recorded, so they stay reproducible and
free of machine-specific noise — every plugin-facing line is taken verbatim
from the plugins' own strings:

  - status/working message: packages/{omp,pi}/src/stream.ts (identical strings,
    both confirmed visible live — pi's in the 2026-08-13 attended E2E),
  - gate log wording: packages/core/src/warm-gate.ts (`loading … ( … ) ...`,
    `loaded … in Ns`) with the real appendLog line format
    (`<ISO timestamp> [pid N] <msg>`, packages/core/src/log.ts),
  - opencode activation line: packages/opencode/src/index.ts,
  - `lms` output from real macOS/Apple Silicon captures (the pi table uses the
    E2E-measured context 262144; the load durations echo the measured ~78 s
    cold load, spinner-compressed).

opencode deliberately has no in-UI gate feedback (maintainer decision F6:
no toasts), so its demo shows the honest story: the request simply waits,
and the detail lives in `~/.cache/opencode/lm-studio-warm.log`.

Run from the repo root (or use `bun run demo:gif` for the full render):
  python3 scripts/generate-quickstart-cast.py            # all three casts
  python3 scripts/generate-quickstart-cast.py pi         # just one runtime
  bash scripts/render-demos.sh                           # casts + GIFs
"""

import json
import random
import sys

WIDTH, HEIGHT = 110, 24

GREY = "\x1b[90m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
GREEN = "\x1b[32m"
RESET = "\x1b[0m"
PROMPT = "\x1b[1;32m$\x1b[0m "

SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
REPLY = "Hello from a pre-warmed model!"
MODEL = "qwen/qwen3.6-35b-a3b"
WORKING = f"lm-studio-warm: ensuring {MODEL} is loaded (a cold load can take minutes)"


class Cast:
    def __init__(self, title):
        self.title = title
        self.events = []
        self.t = 0.0
        random.seed(42)  # deterministic timings → stable diff on regeneration

    def out(self, delay, data):
        self.t += delay
        self.events.append([round(self.t, 3), "o", data])

    def type_text(self, text, cps_delay=0.045):
        for ch in text:
            self.out(cps_delay + random.uniform(-0.02, 0.04), ch)

    def prompt(self):
        self.out(0.4, PROMPT)

    def enter(self):
        self.out(0.15, "\r\n")

    def comment(self, text):
        self.prompt()
        self.type_text(f"{GREY}# {text}{RESET}", 0.028)
        self.enter()

    def lms_ps_cold(self):
        self.prompt()
        self.type_text("lms ps")
        self.enter()
        self.out(0.35, "\r\nNo models are currently loaded.\r\n")

    def lms_ps_resident(self, context):
        self.out(1.4, "")
        self.prompt()
        self.type_text(f"lms ps   {GREY}# model resident — no TTL, no mid-request cold load{RESET}", 0.035)
        self.enter()
        self.out(0.4, "\r\n")
        self.out(
            0.0,
            f"{BOLD}IDENTIFIER              MODEL                   STATUS    SIZE        CONTEXT    PARALLEL    DEVICE    TTL{RESET}\r\n"
            f"{MODEL}    {MODEL}    IDLE      20.43 GB    {context}     4           Local\r\n",
        )
        self.out(0.5, "")
        self.prompt()
        self.out(8.0, "")  # hold the final frame long enough to read the closing state

    def gated_spinner(self, seconds_label, frames=50):
        # Cold load happens here (real: seconds to minutes, compressed). The
        # working message is the plugin's real string; the closing line echoes
        # the gate's real log wording (packages/core/src/warm-gate.ts).
        for i in range(frames):
            self.out(0.09, f"\r\x1b[2K{GREY}{SPIN[i % 10]} {WORKING}{RESET}")
        self.out(0.15, f"\r\x1b[2K{GREY}✓ lm-studio-warm: loaded {MODEL} in {seconds_label}{RESET}")
        self.out(1.0, "\r\x1b[2K")

    def stream_reply(self):
        for ch in REPLY:
            self.out(0.018, ch)
        self.out(0.0, "\r\n")

    def write(self, path):
        header = {
            "version": 2,
            "width": WIDTH,
            "height": HEIGHT,
            "title": self.title,
            "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"},
        }
        with open(path, "w") as f:
            f.write(json.dumps(header) + "\n")
            for ev in self.events:
                f.write(json.dumps(ev) + "\n")
        print(f"wrote {path} ({len(self.events)} events, {self.events[-1][0]:.1f}s)")


def build_omp():
    c = Cast("omp-lm-studio-warm — quick start")

    # ── Scene 1: opt-in by config file (presence activates the plugin) ───────
    c.comment("opt in: the config file's presence is the switch")
    c.prompt()
    c.type_text("mkdir -p ~/.omp/agent && cat > ~/.omp/agent/lm-studio-warm.yml <<'YAML'")
    c.enter()
    c.out(0.25, "eager: true\r\n")
    c.out(0.20, "failMode: hybrid\r\n")
    c.out(0.20, "YAML\r\n")

    # ── Scene 2: LM Studio is cold ───────────────────────────────────────────
    c.out(0.9, "")
    c.lms_ps_cold()

    # ── Scene 3: first request warms the model before it leaves omp ──────────
    c.out(1.2, "")
    c.comment("first request — the plugin loads the model BEFORE the request leaves")
    c.prompt()
    c.type_text(f'omp -p "Reply with exactly: {REPLY}" --model {MODEL}')
    c.enter()
    c.out(0.8, f"\r\n{GREY}> {MODEL} · api lm-studio-warm{RESET}\r\n\r\n")
    c.gated_spinner("7s")
    c.stream_reply()

    # ── Scene 4: model resident, no TTL ──────────────────────────────────────
    c.lms_ps_resident("204800")
    return c


def build_pi():
    c = Cast("pi-lm-studio-warm — quick start")

    # ── Scene 1: opt-in by config file (presence activates the extension) ────
    c.comment("opt in: the config file's presence is the switch")
    c.prompt()
    c.type_text("mkdir -p ~/.pi/agent && cat > ~/.pi/agent/lm-studio-warm.yml <<'YAML'")
    c.enter()
    c.out(0.25, "eager: true\r\n")
    c.out(0.20, "failMode: hybrid\r\n")
    c.out(0.20, "YAML\r\n")

    # ── Scene 2: LM Studio is cold ───────────────────────────────────────────
    c.out(0.9, "")
    c.lms_ps_cold()

    # ── Scene 3: first prompt in a pi session — visible gated load ───────────
    c.out(1.2, "")
    c.comment("in pi, the extension registers LM Studio as the lm-studio provider")
    c.prompt()
    c.type_text("pi")
    c.enter()
    c.out(0.7, f"{GREY}model: lm-studio / {MODEL}{RESET}\r\n\r\n")
    c.out(0.4, f"{CYAN}>{RESET} ")
    c.type_text(f"Reply with exactly: {REPLY}", 0.035)
    c.enter()
    c.out(0.3, "\r\n")
    # pi really shows this working message + a `warming <model>` status while
    # the gate holds the stream (packages/pi/src/stream.ts, confirmed live in
    # the 2026-08-13 E2E; the real cold load took ~78 s, compressed here).
    c.gated_spinner("78s")
    c.stream_reply()

    # ── Scene 4: model resident, no TTL (context as measured in the E2E) ─────
    c.lms_ps_resident("262144")
    return c


def build_opencode():
    c = Cast("opencode-lm-studio-warm — quick start")

    # ── Scene 1: zero config — installing the plugin activates it ────────────
    c.comment("zero config: installing the plugin activates it with safe defaults")
    c.prompt()
    c.type_text("opencode plugin -g opencode-lm-studio-warm")
    c.enter()

    # ── Scene 2: LM Studio is cold ───────────────────────────────────────────
    c.out(0.9, "")
    c.lms_ps_cold()

    # ── Scene 3: the gate holds the request at chat.params — no UI, on purpose
    c.out(1.2, "")
    c.comment("first request — the gate holds it until the model is resident (no UI by design)")
    c.prompt()
    c.type_text(f'opencode run "Reply with exactly: {REPLY}"')
    c.enter()
    c.out(0.6, "\r\n")
    for i in range(50):
        c.out(0.09, f"\r\x1b[2K{GREY}{SPIN[i % 10]}{RESET}")
    c.out(0.15, "\r\x1b[2K")
    c.stream_reply()

    # ── Scene 4: the log carries the whole story (real line format) ──────────
    c.out(1.2, "")
    c.comment("what just happened lives in the plugin's log")
    c.prompt()
    c.type_text("tail -n 4 ~/.cache/opencode/lm-studio-warm.log")
    c.enter()
    c.out(0.4, "\r\n")
    c.out(
        0.0,
        f"{GREY}2026-08-15T13:52:01.104Z [pid 4242] plugin loaded (providers=lmstudio ttl=none parallel=default failMode=hybrid source=defaults (no config file)){RESET}\r\n"
        f"{GREY}2026-08-15T13:52:01.371Z [pid 4242] eager warm queued for {MODEL}{RESET}\r\n"
        f"{GREY}2026-08-15T13:52:01.442Z [pid 4242] loading {MODEL} (load {MODEL} -y) ...{RESET}\r\n"
        f"{GREY}2026-08-15T13:53:15.518Z [pid 4242] loaded {MODEL} in 74s{RESET}\r\n",
    )

    # ── Scene 5: model resident, no TTL ──────────────────────────────────────
    c.lms_ps_resident("204800")
    return c


BUILDERS = {
    "omp": (build_omp, "docs/demo-lm-studio-warm.cast"),
    "pi": (build_pi, "docs/demo-lm-studio-warm-pi.cast"),
    "opencode": (build_opencode, "docs/demo-lm-studio-warm-opencode.cast"),
}

if __name__ == "__main__":
    picks = sys.argv[1:] or list(BUILDERS)
    for name in picks:
        if name not in BUILDERS:
            sys.exit(f"unknown runtime {name!r} — choose from {', '.join(BUILDERS)}")
        build, path = BUILDERS[name]
        build().write(path)
