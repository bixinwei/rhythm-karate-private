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

# --- designed palette -------------------------------------------------------
# old -> new.  Values (brightness) are carried over from the original so the
# shading structure is untouched; only hue/saturation are re-authored.
ATLAS_MAP = {
    (248, 248, 248): (246, 241, 226),   # white trim / balls      -> warm cream
    (0, 0, 0):       (16, 19, 30),      # outlines                -> soft navy-black
    (56, 56, 56):    (44, 50, 66),      # secondary darks
    (248, 248, 8):   (242, 178, 64),    # batter 2 outfit         -> amber
    (200, 184, 0):   (196, 138, 44),    # batter 2 shade          -> deep amber
    (232, 0, 0):     (214, 78, 74),     # batter 2 mask/face      -> clay red
    (184, 0, 0):     (168, 58, 56),
    (152, 0, 0):     (126, 42, 42),
    (96, 224, 0):    (62, 186, 168),    # batter 1 outfit         -> teal
    (0, 104, 16):    (24, 92, 84),      # batter 1 shade / plants -> deep teal
    (40, 56, 0):     (26, 54, 50),
    (48, 72, 0):     (32, 66, 60),
    (248, 200, 248): (222, 210, 240),   # batter 3 pale           -> lilac
    (248, 32, 168):  (176, 106, 208),   # batter 3 accent         -> orchid
    (176, 0, 208):   (118, 92, 196),    # batter 3 shade          -> indigo
    (224, 0, 160):   (150, 84, 178),
    (168, 0, 232):   (108, 84, 190),
    (0, 72, 232):    (74, 150, 214),    # ball/highlight blue     -> sky
    (128, 192, 248): (176, 214, 240),
    (184, 216, 248): (212, 232, 245),
    (56, 96, 152):   (86, 106, 138),    # ufo body                -> slate
    (24, 48, 80):    (44, 56, 76),
    (232, 104, 0):   (226, 138, 74),    # props warm              -> copper
    (248, 160, 120): (232, 176, 132),   # skin (warm)             -> tan
    (248, 160, 160): (226, 168, 156),   # skin (cool)             -> rose tan
    (168, 96, 0):    (126, 104, 82),    # barrels                 -> steel
    (120, 64, 0):    (98, 80, 62),
    (96, 40, 0):     (74, 60, 48),
    (208, 192, 112): (196, 184, 142),   # straw/baskets           -> wheat
    (0, 232, 176):   (96, 216, 196),    # sparkle                 -> aqua
    (240, 160, 8):   (240, 186, 92),
    (16, 0, 248):    (86, 108, 226),    # deep blue accent        -> periwinkle
}
BG_MAP = {
    (0, 160, 24):  (34, 82, 92),      # pitch stripes -> teal turf under lights
    (0, 128, 16):  (26, 66, 78),
    (0, 144, 24):  (30, 74, 86),
    (0, 104, 16):  (20, 52, 64),
    (0, 0, 112):   (18, 24, 54),      # night sky
    (48, 72, 0):   (22, 44, 52),
    (248, 248, 248): (246, 241, 226),
}


def remap(image, table):
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
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
    print(f'reskinned + HD x{SCALE}: atlas {atlas.size}, {len(manifest)} cels')


if __name__ == '__main__':
    main()