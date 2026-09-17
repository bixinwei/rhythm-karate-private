"""Derive a publishable Spaceball art set from the ROM export.

The repository's exported art is ROM-derived (see export_game_frames.py).  This
step keeps the layout, origins and animation timing byte-for-byte identical and
only re-colours pixels, so the port stays source-faithful mechanically while the
published build no longer ships the original character colours:

  * clothing, props and background rotate to a different hue family
  * skin-like pixels move to a cool non-human complexion (the batters read as
    different characters without touching a single silhouette pixel)
  * whites pick up a pale ice-blue tint so the balls/faces are not the retail look
  * near-black outline pixels are preserved, which keeps every cel readable
  * the batters additionally get the top two silhouette rows of their head
    re-coloured, i.e. a visible hat/visor band

Run after export_game_frames.py:
    python tools/reskin_spaceball.py
"""
import colorsys, json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / 'assets' / 'gba' / 'spaceball'
HUE_SHIFT = 158.0          # clothing / props / props family change
SKIN_HUE, SKIN_SAT = 186.0, 0.55
ICE = (214, 232, 255)
ICE_MIX = 0.45
HAT = (232, 74, 110)
HAT_ROWS = 2
BG_HUE_SHIFT = 205.0
BG_DESATURATE = 0.8

def rgb_to_hsv(r, g, b):
    return colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)

def hsv_to_rgb(h, s, v):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, min(1.0, max(0.0, s)), min(1.0, max(0.0, v)))
    return round(r * 255), round(g * 255), round(b * 255)

def reskin_pixel(r, g, b, a, hue_shift, skin=True, ice=True):
    if a == 0:
        return (r, g, b, a)
    h, s, v = rgb_to_hsv(r, g, b)
    if s < 0.12:                                   # near-neutral: tint, keep light
        if ice:
            r2 = round(r * (1 - ICE_MIX) + ICE[0] * ICE_MIX)
            g2 = round(g * (1 - ICE_MIX) + ICE[1] * ICE_MIX)
            b2 = round(b * (1 - ICE_MIX) + ICE[2] * ICE_MIX)
            return (r2, g2, b2, a)
        return (r, g, b, a)
    if v < 0.25:                                   # outline / shadow: keep contrast
        return (r, g, b, a)
    if skin and 0.03 <= h <= 0.13 and s >= 0.2:    # skin band -> cool complexion
        h2 = SKIN_HUE / 360.0
        s2 = max(s, SKIN_SAT)
        v2 = v
    else:
        h2 = h + hue_shift / 360.0
        s2 = min(1.0, s * 1.04)
        v2 = v
    r2, g2, b2 = hsv_to_rgb(h2, s2, v2)
    return (r2, g2, b2, a)

def reskin_image(path, hue_shift, skin=True, ice=True, hat=False):
    image = Image.open(path).convert('RGBA')
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            pixels[x, y] = reskin_pixel(*pixels[x, y], hue_shift=hue_shift, skin=skin, ice=ice)
    if hat:
        # Re-colour the top rows of the silhouette: every batter gets a hat band
        # without changing the bounding box or the sprite origin.
        rows = []
        for y in range(height):
            row = [x for x in range(width) if pixels[x, y][3] > 0]
            if row:
                rows.append((y, row))
            if len(rows) >= HAT_ROWS + 1:
                break
        for y, row in rows[:HAT_ROWS]:
            for x in row:
                pixels[x, y] = (*HAT, pixels[x, y][3])
    image.save(path)
    return image

# Batters (green / red-mask / bunny outfits in the retail atlas).  Their cel
# numbers come from the animation tables the port already uses.
BATTERS = {1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 30, 31, 32, 33, 34, 44, 45, 46, 47, 48, 49, 50, 51, 52}


def paint_hats(atlas):
    """Re-colour the top silhouette rows of every packed batter cel.

    The renderer crops each cel from the atlas with `atlasX/atlasY/width/height`,
    so the same rectangle is used here - no hand-placed coordinates, and the cel
    bounding box (and therefore every sprite origin) is untouched.
    """
    manifest = json.loads((DIR / 'frames.json').read_text())
    pixels = atlas.load()
    painted = 0
    for number, meta in manifest.items():
        # The three retail batter outfits are the tall cels; selecting them by
        # geometry avoids hard-coding cel numbers that the exporter may renumber.
        if not all(key in meta for key in ('atlasX', 'atlasY', 'width', 'height')) or meta['height'] < 100:
            continue
        left, top, right, bottom = meta['atlasX'], meta['atlasY'], meta['atlasX'] + meta['width'], meta['atlasY'] + meta['height']
        rows = []
        for y in range(top, bottom):
            row = [x for x in range(left, right) if pixels[x, y][3] > 0]
            if row:
                rows.append((y, row))
            if len(rows) > HAT_ROWS:
                break
        for y, row in rows[:HAT_ROWS]:
            for x in row:
                pixels[x, y] = (*HAT, pixels[x, y][3])
            painted += 1
    return painted


def main():
    manifest = json.loads((DIR / 'frames.json').read_text())
    # The runtime draws every cel from the packed atlas; cel*.png are only kept
    # for reference, so both are re-coloured to stay consistent.
    atlas = reskin_image(DIR / 'atlas.png', HUE_SHIFT, skin=True, ice=True, hat=False)
    rows = paint_hats(atlas)
    atlas.save(DIR / 'atlas.png')
    for number, meta in manifest.items():
        path = DIR / meta['file']
        if not path.exists():
            continue
        reskin_image(path, HUE_SHIFT, skin=True, ice=True, hat=int(number) in BATTERS)
    reskin_image(DIR / 'spaceball_bg_map.png', BG_HUE_SHIFT, skin=False, ice=False)
    print('reskinned', len(manifest), 'cels + atlas + background; hat rows', rows)

if __name__ == '__main__':
    main()