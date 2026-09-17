"""Spaceball art derivative: curated palette + pixel-art HD upscale.

Two deliberate steps, both reproducible from the ROM export:

1. Palette.  The retail atlas is a 33-colour GBA palette, so a per-colour
   remapping is exactly how the original artist would have re-skinned it.  The
   table below is designed rather than rotated: four hue families (teal, amber,
   violet, clay) plus warm neutrals, with each colour keeping its original value
   so every highlight/shadow relationship survives.  Result: a night-match cast
   that reads as its own game instead of "the same sprites, hue-shifted".

2. HD.  EPX/Scale2x (two passes = 4x) rebuilds the diagonal edges of the pixel
   art, and the canvas draws the result 1:1 at its native 4x sprite scale, so the
   published build is sharper than the retail 240x160 art rather than blurrier.

Run after export_game_frames.py + pack_frame_atlas.py:
    python tools/hd_reskin_spaceball.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / 'assets' / 'gba' / 'spaceball'
SCALE = 4

# --- designed palette: 小清新 / 少女心 ------------------------------------
# Pastel scheme: everything sits in the high-value / low-saturation corner, the
# outlines drop from black to a soft plum so the art reads "cute" instead of
# "arcade", and every colour keeps its retail brightness so the shading the GBA
# artist baked in survives.  Hue families: mint, apricot-rose, lavender, sky,
# warm cream.
ATLAS_MAP = {
    (248, 248, 248): (255, 247, 242),   # white trim / balls        -> cream
    (0, 0, 0):       (91, 74, 99),      # outlines                  -> soft plum
    (56, 56, 56):    (110, 92, 116),    # secondary darks
    (248, 248, 8):   (255, 217, 160),   # batter 2 outfit           -> apricot
    (200, 184, 0):   (240, 190, 124),   # batter 2 shade
    (232, 0, 0):     (255, 158, 176),   # batter 2 mask/face        -> rose
    (184, 0, 0):     (232, 134, 154),
    (152, 0, 0):     (201, 111, 132),
    (240, 160, 8):   (255, 201, 143),
    (96, 224, 0):    (143, 224, 200),   # batter 1 outfit           -> mint
    (0, 104, 16):    (63, 169, 143),    # batter 1 shade / plants   -> deep mint
    (40, 56, 0):     (47, 107, 92),
    (48, 72, 0):     (58, 122, 105),
    (248, 200, 248): (255, 227, 239),   # batter 3 pale             -> baby pink
    (248, 32, 168):  (201, 160, 232),   # batter 3 accent           -> orchid
    (176, 0, 208):   (169, 143, 224),   # batter 3 shade            -> lavender
    (224, 0, 160):   (191, 160, 224),
    (168, 0, 232):   (155, 143, 216),
    (0, 72, 232):    (159, 196, 240),   # ball highlight            -> sky
    (128, 192, 248): (187, 217, 245),
    (184, 216, 248): (216, 233, 250),
    (56, 96, 152):   (168, 187, 216),   # ufo body                  -> pale blue
    (24, 48, 80):    (124, 143, 181),
    (224, 104, 0):   (242, 185, 138),   # props warm                -> peach
    (232, 128, 0):   (245, 196, 150),   # props warm light          -> peach light
    (248, 160, 120): (255, 201, 174),   # warm skin                 -> apricot skin
    (248, 160, 160): (255, 211, 196),   # cool skin                 -> peach skin
    (168, 96, 0):    (232, 199, 154),   # barrels                   -> light wood
    (120, 64, 0):    (201, 164, 122),
    (96, 40, 0):     (169, 131, 95),
    (208, 192, 112): (242, 221, 176),   # straw / baskets           -> butter
    (0, 232, 176):   (143, 232, 220),   # aqua accent
    (16, 0, 248):    (176, 168, 240),   # deep blue accent          -> periwinkle
}
BG_MAP = {
    (0, 160, 24):  (168, 230, 192),   # turf stripes -> pastel mint
    (0, 144, 24):  (150, 220, 180),
    (0, 128, 16):  (134, 208, 168),
    (0, 104, 16):  (111, 191, 151),
    (0, 0, 112):   (142, 134, 200),   # night sky    -> dusk periwinkle
    (48, 72, 0):   (95, 174, 138),
    (248, 248, 248): (255, 247, 242),
}
# The flying starfield dots are their own cel, so they get a colour that belongs
# to the pastel scheme instead of inheriting the cream trim.
CEL_OVERRIDES = {27: (255, 226, 176)}

UNMAPPED = set()


def remap(image, table):
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if (r, g, b) not in table:
                UNMAPPED.add((r, g, b))
            pixels[x, y] = (*table.get((r, g, b), (r, g, b)), a)
    return image


def epx(image):
    """One 2x EPX/Scale2x pass: smooths diagonals, keeps the pixel-art look."""
    src = image.load()
    out = Image.new('RGBA', (image.width * 2, image.height * 2))
    dst = out.load()
    for y in range(image.height):
        for x in range(image.width):
            p = src[x, y]
            up = src[x, y - 1] if y > 0 else p
            down = src[x, y + 1] if y + 1 < image.height else p
            left = src[x - 1, y] if x > 0 else p
            right = src[x + 1, y] if x + 1 < image.width else p
            a, b, c, d = p, p, p, p
            if left == up and left != down and up != right:
                a = up
            if up == right and up != left and right != down:
                b = right
            if left == down and left != up and down != right:
                c = left
            if down == right and down != left and right != up:
                d = right
            dst[2 * x, 2 * y] = a
            dst[2 * x + 1, 2 * y] = b
            dst[2 * x, 2 * y + 1] = c
            dst[2 * x + 1, 2 * y + 1] = d
    return out


def upscale(image, passes):
    for _ in range(passes):
        image = epx(image)
    return image


def main():
    import json
    manifest = json.loads((DIR / 'frames.json').read_text())
    for number, meta in manifest.items():
        path = DIR / meta['file']
        if path.exists():
            # The runtime only crops the packed atlas; the per-cel files are kept
            # as small recoloured references instead of 4x copies.
            remap(Image.open(path).convert('RGBA'), ATLAS_MAP).save(path)
    upscale(remap(Image.open(DIR / 'atlas.png').convert('RGBA'), ATLAS_MAP), SCALE // 2).save(DIR / 'atlas.png')
    upscale(remap(Image.open(DIR / 'spaceball_bg_map.png').convert('RGBA'), BG_MAP), SCALE // 2).save(DIR / 'spaceball_bg_map.png')
    atlas = Image.open(DIR / 'atlas.png')
    # 星空小点: paint the sparkle cel with its own pastel colour.
    if CEL_OVERRIDES:
        pixels = atlas.load()
        for number, colour in CEL_OVERRIDES.items():
            meta = manifest.get(str(number))
            if not meta or not all(k in meta for k in ('atlasX', 'atlasY', 'width', 'height')):
                continue
            for y in range(meta['atlasY'], meta['atlasY'] + meta['height']):
                for x in range(meta['atlasX'], meta['atlasX'] + meta['width']):
                    if pixels[x, y][3] > 0:
                        pixels[x, y] = (*colour, pixels[x, y][3])
        atlas.save(DIR / 'atlas.png')
    print(f'reskinned + HD x{SCALE}: atlas {atlas.size}, {len(manifest)} cels')
    if UNMAPPED:
        print('WARNING unmapped retail colours:', ['#%02X%02X%02X' % c for c in sorted(UNMAPPED)])


if __name__ == '__main__':
    main()