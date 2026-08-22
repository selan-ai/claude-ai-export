#!/usr/bin/env python3
"""Render src/static/icons/icon.svg's geometry to the PNG sizes Chrome wants.

Kept out of `npm run build`: this needs Pillow, and someone changing a
TypeScript file should not have to install it. The PNGs are committed and only
need regenerating when the icon itself changes.

    python3 scripts/icons.py

Drawn at 4x and downsampled, which anti-aliases the curves far better than
drawing at 16px ever could.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src/static/icons"
SIZES = (16, 32, 48, 128)
SCALE = 4
BASE = 128 * SCALE

TILE = (139, 108, 255, 255)   # --g-tile  #8b6cff
MARK = (255, 255, 255, 255)   # --g-on-tile
RADIUS = 28 * SCALE
STROKE = 12 * SCALE


def s(*points: float) -> tuple[float, ...]:
    return tuple(p * SCALE for p in points)


def stroke_path(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]]) -> None:
    """A polyline with round caps and joins — Pillow has joins but not caps."""
    draw.line(points, fill=MARK, width=STROKE, joint="curve")
    radius = STROKE / 2
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=MARK)


canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=RADIUS, fill=TILE)

# An arrow leaving a tray: the universal export mark, and one of the few
# shapes that still reads at 16px in a toolbar.
stroke_path(draw, [s(64, 28), s(64, 74)])                       # stem
stroke_path(draw, [s(45, 56), s(64, 76), s(83, 56)])            # arrowhead
stroke_path(draw, [s(36, 86), s(36, 99), s(92, 99), s(92, 86)]) # tray

for size in SIZES:
    canvas.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")
    print(f"icon-{size}.png")
