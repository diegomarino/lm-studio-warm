#!/usr/bin/env python3
"""Overlay a playback progress bar along the bottom edge of the demo GIF.

agg has no built-in progress indicator, so this post-processes its output:
a 4 px track drawn across the bottom of every frame, filled proportionally
to elapsed time (per-frame GIF durations).

agg coalesces every idle stretch (scene pauses, the final hold) into ONE long
frame, which would make the bar freeze and then jump. Frames longer than
CHUNK_MS are therefore subdivided into copies that only differ in bar fill,
so the bar keeps sliding through pauses. gifsicle's frame-diff optimization
makes the copies nearly free (only the bar strip changes).

Usage:  python3 scripts/add-progress-bar.py docs/quickstart.gif [output.gif]

Re-quantizing per frame breaks GIF inter-frame compression; recover it with
`gifsicle -O3 --colors 256 --batch <gif>` afterwards.
"""

import math
import sys

from PIL import Image, ImageDraw, ImageSequence

TRACK = (40, 45, 56)   # slightly lighter than the asciinema theme background
FILL = (78, 201, 176)  # teal accent, matches the prompt/table greens
BAR_H = 4
CHUNK_MS = 200         # max per-frame duration before subdividing

src = sys.argv[1] if len(sys.argv) > 1 else "docs/quickstart.gif"
dst = sys.argv[2] if len(sys.argv) > 2 else src

im = Image.open(src)
durations = [f.info.get("duration", 0) for f in ImageSequence.Iterator(im)]
total = sum(durations) or 1

frames = []
out_durations = []
elapsed = 0
im.seek(0)
for frame, d in zip(ImageSequence.Iterator(im), durations):
    base = frame.convert("RGB")
    w, h = base.size
    n = max(1, math.ceil(d / CHUNK_MS))
    step = d / n
    for i in range(n):
        rgb = base.copy() if n > 1 else base
        draw = ImageDraw.Draw(rgb)
        draw.rectangle([0, h - BAR_H, w, h], fill=TRACK)
        # The bar reaches elapsed+d exactly when this source frame's time is up.
        filled = elapsed + step * (i + 1)
        draw.rectangle([0, h - BAR_H, int(w * filled / total), h], fill=FILL)
        frames.append(rgb)
        out_durations.append(round(step))
    elapsed += d

frames[0].save(
    dst,
    save_all=True,
    append_images=frames[1:],
    duration=out_durations,
    loop=0,
    optimize=True,
)
print(f"wrote {dst} ({len(frames)} frames from {len(durations)}, {total / 1000:.1f}s)")
