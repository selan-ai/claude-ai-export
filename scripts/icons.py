#!/usr/bin/env python3
"""Render the toolbar icons from the Selan brand mark.

    python3 scripts/icons.py        # needs Pillow

Kept out of `npm run build`: someone editing a TypeScript file should not have
to install an image library. The PNGs are committed and only need regenerating
when the brand asset changes.

The source is `brand-1024.png`, vendored verbatim from
selan-website/public/brand/logo-square-1024.png. Two adjustments are applied,
both of which the brand set already makes for small sizes:

  * The mark is enlarged to the proportion `brand/favicon.svg` uses rather than
    the one `brand/icon-violet.svg` uses. Its own note explains why: "at 16px
    the mark needs the room".
  * The square is rounded to the tile radius (119.8/512 of the side).
"""

from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src/static/icons"
SOURCE = ICONS / "brand-1024.png"
SIZES = (16, 32, 48, 128)

# favicon.svg scales the mark by 7.9931 where icon-violet.svg uses 6.6608.
MARK_ENLARGEMENT = 7.9931 / 6.6608
CORNER_RATIO = 119.8 / 512


def enlarge_mark(tile: Image.Image) -> Image.Image:
    """Crop inward and scale back, which grows the mark against a flat field."""
    side = tile.width
    kept = round(side / MARK_ENLARGEMENT)
    inset = (side - kept) // 2
    return tile.crop((inset, inset, inset + kept, inset + kept)).resize(
        (side, side), Image.LANCZOS
    )


def round_corners(tile: Image.Image) -> Image.Image:
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, tile.width - 1, tile.height - 1),
        radius=round(tile.width * CORNER_RATIO),
        fill=255,
    )
    rounded = tile.convert("RGBA")
    rounded.putalpha(mask)
    return rounded


tile = round_corners(enlarge_mark(Image.open(SOURCE).convert("RGBA")))

for size in SIZES:
    tile.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")
    print(f"icon-{size}.png")
