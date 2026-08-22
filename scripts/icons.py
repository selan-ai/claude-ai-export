#!/usr/bin/env python3
"""Render the toolbar icons.

    python3 scripts/icons.py        # needs Pillow

Kept out of `npm run build`: someone editing a TypeScript file should not have
to install an image library. The PNGs are committed and only need regenerating
when the icon changes.

The geometry lives here and nowhere else. An SVG twin would look tidier, but
two descriptions of one shape drift, and the PNGs are what Chrome loads.

Selan's tile, an export mark rather than the Selan symbol: this sits in a
browser toolbar next to a dozen other icons, where it has to say what it does.
Everything except the glyph is taken from the brand set — the violet, the
corner radius and the stroke weight are `brand/icon-violet.svg`'s, not
approximations of them.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src/static/icons"
SIZES = (16, 32, 48, 128)

# Drawn large and downsampled: anti-aliasing this geometry at 16px directly
# turns the arrowhead to mush.
SCALE = 8
GRID = 128
BASE = GRID * SCALE

TILE = (124, 92, 255, 255)   # brand violet #7C5CFF
MARK = (255, 255, 255, 255)
# brand/icon-violet.svg: rx 119.8 on a 512 tile, stroke 5.4 on a 64 grid.
RADIUS = round(BASE * 119.8 / 512)
STROKE = round(BASE * 5.4 / 64)


def s(x: float, y: float) -> tuple[float, float]:
    return (x * SCALE, y * SCALE)


def stroke_path(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]]) -> None:
    """A polyline with round caps and joins. Pillow gives joins but not caps."""
    draw.line(points, fill=MARK, width=STROKE, joint="curve")
    radius = STROKE / 2
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=MARK)


canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=RADIUS, fill=TILE)

# An arrow leaving a tray: the universal export mark, and one of the few shapes
# that still resolves at 16px.
stroke_path(draw, [s(64, 28), s(64, 74)])                          # stem
stroke_path(draw, [s(45, 56), s(64, 76), s(83, 56)])               # head
stroke_path(draw, [s(36, 86), s(36, 99), s(92, 99), s(92, 86)])    # tray

for size in SIZES:
    canvas.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")
    print(f"icon-{size}.png")
