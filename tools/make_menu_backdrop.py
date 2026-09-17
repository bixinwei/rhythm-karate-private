"""Generate the page backdrop used behind the menu.

This file is *original*: nothing is sampled from the ROM or any retail asset.  It
replaces the retail room image that used to sit behind the menu (style.css
`url("assets/background.png")`) and matches the reskinned game palette, so the
published build no longer ships that artwork.

    python tools/make_menu_backdrop.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math, random

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'background.png'
W, H = 1600, 1000
# Palette twins of the reskinned game (deep space violet -> sakura).
TOP, BOTTOM = (54, 44, 116), (206, 126, 176)
GLOW = (255, 150, 190)
STAR = (255, 238, 190)


def main():
    image = Image.new('RGB', (W, H))
    draw = ImageDraw.Draw(image)
    for y in range(H):
        t = y / (H - 1)
        draw.line([(0, y), (W, y)], fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    # soft bokeh so the menu text has something to sit on without busy detail
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    random.seed(7)
    for _ in range(26):
        cx, cy = random.randrange(-100, W + 100), random.randrange(-100, H + 100)
        r = random.randrange(60, 260)
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(int(c * random.uniform(.18, .38)) for c in GLOW))
    image = Image.blend(image, glow, .55)
    # starfield: the same flying dots the game uses, so the menu reads as its shell
    draw = ImageDraw.Draw(image)
    for _ in range(160):
        x, y = random.randrange(W), random.randrange(H)
        r = random.choice([1, 1, 1, 2])
        shade = random.uniform(.5, 1)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=tuple(round(c * shade) for c in STAR))
    # No vignette: the CSS already lays a scrim over this image, and compositing a
    # mask here darkened the whole gradient instead of just the edges.
    image.save(OUT)
    print('wrote', OUT.relative_to(ROOT), image.size)


if __name__ == '__main__':
    main()