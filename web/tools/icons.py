#!/usr/bin/env python3
"""Rasterise the app icons from web/public/icons/*.svg.

Run by hand after editing one of the SVGs:

    python3 web/tools/icons.py

The PNGs it writes are committed, and that is the point. `pnpm build` must not
need Python: cairosvg is not a dependency of this project and never will be, and
a build that quietly needs one is a build that fails on the next machine. The
gates here are typecheck and build, so anything they cannot see has to be a
committed artefact rather than a step someone has to remember.

It prints the decoded size and mode of every file it writes, because that is the
only part of "the icon is correct" a script can actually check. Whether the mark
is *there* it cannot tell you -- cairosvg renders nothing, silently, for the SVG
features it does not support -- so look at favicon-32.png at 1:1 afterwards.
"""

from pathlib import Path

import cairosvg
from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "public" / "icons"
INK = (0x10, 0x14, 0x1A)


def render(src: str, size: int, out: str, opaque: bool = False) -> None:
    png = ICONS / out
    cairosvg.svg2png(
        url=str(ICONS / src), write_to=str(png), output_width=size, output_height=size
    )
    if opaque:
        # iOS composites an apple-touch-icon's alpha onto black and haloes
        # anything drawn over a transparent corner, so that one ships flattened
        # onto --ink with no alpha channel at all.
        with Image.open(png) as img:
            rgba = img.convert("RGBA")
            flat = Image.new("RGB", rgba.size, INK)
            flat.paste(rgba, mask=rgba)
            flat.save(png)
    with Image.open(png) as img:
        print(f"  {out:26} {img.size[0]}x{img.size[1]} {img.mode}")


# icon.svg carries its own rounded ground, for every platform that does not mask.
render("icon.svg", 192, "icon-192.png")
render("icon.svg", 512, "icon-512.png")
render("icon.svg", 32, "favicon-32.png")

# The square drawing, for the two platforms that supply their own mask: Android
# via purpose=maskable, and iOS, which rounds an apple-touch-icon itself and
# would otherwise round a corner we had already rounded.
render("icon-maskable.svg", 512, "icon-maskable-512.png")
render("icon-maskable.svg", 180, "apple-touch-icon-180.png", opaque=True)
