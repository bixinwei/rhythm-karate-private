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

# --- designed palette: 艳丽少女心 (vivid sakura) ---------------------------
# The pastel pass read as foggy because every colour sat in the light/low-sat
# corner with nothing dark to anchor it.  This scheme keeps the girly hues but
# pushes saturation up and adds real darks: near-black plum outlines, hot pink
# and magenta leads, vivid mint and periwinkle accents, and a saturated turf so
# the pink cast pops instead of melting into the background.
ATLAS_MAP = {
    (248, 248, 248): (255, 132, 186),   # uniform base / balls -> sakura pink
    (0, 0, 0):       (58, 26, 48),      # outlines            -> deep plum (punch)
    (56, 56, 56):    (96, 52, 78),      # secondary darks
    (248, 248, 8):   (255, 176, 64),    # batter 2 outfit     -> vivid apricot
    (200, 184, 0):   (232, 138, 40),    # batter 2 shade      -> deep orange
    (232, 0, 0):     (255, 76, 118),    # batter 2 mask       -> vivid rose
    (184, 0, 0):     (222, 48, 92),
    (152, 0, 0):     (176, 28, 70),
    (240, 160, 8):   (255, 196, 92),
    (96, 224, 0):    (255, 252, 252),   # batter 1 sleeves/cap -> white trim
    (0, 104, 16):    (214, 54, 120),    # sakura shade / plants
    (40, 56, 0):     (150, 54, 96),
    (48, 72, 0):     (170, 66, 112),
    (248, 200, 248): (255, 206, 240),   # batter 3 pale       -> pink lilac
    (248, 32, 168):  (255, 64, 186),    # batter 3 accent     -> magenta
    (176, 0, 208):   (168, 62, 232),    # batter 3 shade      -> vivid violet
    (224, 0, 160):   (226, 42, 200),
    (168, 0, 232):   (140, 60, 224),
    (0, 72, 232):    (58, 132, 255),    # ball highlight      -> vivid sky
    (128, 192, 248): (110, 190, 255),
    (184, 216, 248): (170, 222, 255),
    (56, 96, 152):   (110, 130, 224),   # ufo body            -> periwinkle
    (24, 48, 80):    (46, 58, 128),
    (224, 104, 0):   (255, 150, 74),    # props warm          -> vivid orange
    (232, 128, 0):   (255, 168, 92),
    (248, 160, 120): (255, 186, 150),   # warm skin
    (248, 160, 160): (255, 170, 172),   # cool skin
    (168, 96, 0):    (222, 158, 74),    # barrels             -> golden wood
    (120, 64, 0):    (176, 112, 44),
    (96, 40, 0):     (132, 80, 28),
    (208, 192, 112): (246, 214, 118),   # straw / baskets     -> vivid butter
    (0, 232, 176):   (40, 226, 174),    # accent              -> vivid mint
    (16, 0, 248):    (108, 92, 255),    # deep blue accent    -> vivid periwinkle
}
BG_MAP = {
    (0, 160, 24):  (58, 196, 116),    # turf stripes -> saturated mint-green
    (0, 144, 24):  (46, 178, 104),
    (0, 128, 16):  (36, 158, 92),
    (0, 104, 16):  (26, 136, 78),
    (0, 0, 112):   (88, 92, 208),     # windows      -> vivid periwinkle
    (48, 72, 0):   (20, 118, 70),
    (248, 248, 248): (255, 255, 255),
}
# Starfield dots: bright gold so they sparkle against the indigo sky.
CEL_OVERRIDES = {27: (255, 226, 120)}

# Diagnostics: a colour the table forgot would ship as retail art, and a key no
# colour uses means a typo (that is how two neon oranges once slipped through).
UNMAPPED = set()
USED = set()

def remap(image, table):
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if (r, g, b) not in table:
                UNMAPPED.add((r, g, b))
            else:
                USED.add((r, g, b))
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
    # Nearest-neighbour, NOT EPX: Scale2x interpolates the edges of pixel art and
    # that softness is exactly what made the previous pass look foggy.  An integer
    # copy keeps every pixel hard while the canvas draws it 1:1.
    for _ in range(passes):
        image = image.resize((image.width * 2, image.height * 2), Image.NEAREST)
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
    unused = set(ATLAS_MAP) - USED
    if unused:
        print('WARNING palette keys that no retail colour used (typo?):', ['#%02X%02X%02X' % c for c in sorted(unused)])


if __name__ == '__main__':
    main()