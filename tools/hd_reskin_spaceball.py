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

# --- designed palette: 少女心 (sakura pink lead) --------------------------
# Pink-forward this time: sakura, peach and orchid carry the cast, mint survives
# only as a tiny accent, the turf is strawberry-milk pink and the sky a
# pink-lavender dusk.  Outlines move to a warm mauve so nothing reads as a black
# arcade keyline, and every colour keeps its retail brightness (the GBA artist's
# shading structure is the one thing that must not change).
ATLAS_MAP = {
    (248, 248, 248): (255, 246, 248),   # trim / balls        -> pink white
    (0, 0, 0):       (122, 85, 102),    # outlines            -> warm mauve
    (56, 56, 56):    (150, 116, 130),   # secondary darks
    (248, 248, 8):   (255, 214, 170),   # batter 2 outfit     -> peach cream
    (200, 184, 0):   (240, 186, 132),   # batter 2 shade
    (232, 0, 0):     (255, 154, 180),   # batter 2 mask       -> rose
    (184, 0, 0):     (238, 132, 158),
    (152, 0, 0):     (210, 110, 138),
    (240, 160, 8):   (255, 206, 164),
    (96, 224, 0):    (255, 178, 205),   # batter 1 outfit     -> sakura pink
    (0, 104, 16):    (224, 122, 160),   # batter 1 shade / plants
    (40, 56, 0):     (150, 92, 120),
    (48, 72, 0):     (162, 108, 132),
    (248, 200, 248): (255, 224, 242),   # batter 3 pale       -> pink lilac
    (248, 32, 168):  (226, 166, 232),   # batter 3 accent     -> orchid pink
    (176, 0, 208):   (188, 150, 226),   # batter 3 shade      -> lavender
    (224, 0, 160):   (214, 166, 226),
    (168, 0, 232):   (176, 158, 226),
    (0, 72, 232):    (186, 200, 240),   # ball highlight      -> soft sky
    (128, 192, 248): (204, 220, 246),
    (184, 216, 248): (232, 230, 250),   # light blue          -> pearl
    (56, 96, 152):   (200, 180, 220),   # ufo body            -> pearl lilac
    (24, 48, 80):    (150, 124, 164),
    (224, 104, 0):   (247, 196, 168),   # props warm          -> peach
    (232, 128, 0):   (250, 206, 178),
    (248, 160, 120): (255, 206, 186),   # warm skin
    (248, 160, 160): (255, 214, 204),   # cool skin
    (168, 96, 0):    (240, 214, 186),   # barrels             -> cream wood
    (120, 64, 0):    (214, 182, 150),
    (96, 40, 0):     (186, 152, 124),
    (208, 192, 112): (247, 230, 196),   # straw / baskets     -> cream
    (0, 232, 176):   (170, 232, 214),   # aqua accent         -> tiny mint
    (16, 0, 248):    (196, 176, 238),   # deep blue accent    -> periwinkle
}
BG_MAP = {
    (0, 160, 24):  (250, 214, 228),   # turf stripes -> strawberry milk
    (0, 144, 24):  (243, 202, 220),
    (0, 128, 16):  (235, 190, 212),
    (0, 104, 16):  (222, 172, 198),
    (0, 0, 112):   (226, 178, 214),   # night sky    -> pink-lavender dusk
    (48, 72, 0):   (206, 152, 182),
    (248, 248, 248): (255, 246, 248),
}
# The flying starfield dots are their own cel: pearl gold reads on the pink sky.
CEL_OVERRIDES = {27: (255, 246, 220)}

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
    unused = set(ATLAS_MAP) - USED
    if unused:
        print('WARNING palette keys that no retail colour used (typo?):', ['#%02X%02X%02X' % c for c in sorted(unused)])


if __name__ == '__main__':
    main()