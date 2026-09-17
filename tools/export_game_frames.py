"""Export original GBA backgrounds and OBJ animation cells for a game.

Usage: python tools/export_game_frames.py <game> [object-stem] [cell-prefix] [output-name]
The game must follow the standard <game>_obj.4bpp / <game>_pal.c layout.
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
GAME = sys.argv[1]
OBJ = sys.argv[2] if len(sys.argv) > 2 else GAME
CELL_PREFIX = sys.argv[3] if len(sys.argv) > 3 else GAME
SRC = ROOT / "reference" / "rhythmtengoku-upstream" / "games" / GAME / "graphics"
OUT = ROOT / "assets" / "gba" / (sys.argv[4] if len(sys.argv) > 4 else GAME)
SIZES = {0: [(8,8),(16,16),(32,32),(64,64)], 1: [(16,8),(32,8),(32,16),(64,32)], 2: [(8,16),(8,32),(16,32),(32,64)]}

def signed(v, bits): return v - (1 << bits) if v & (1 << (bits - 1)) else v

def banks():
    values = re.findall(r"TO_RGB555\(0x([0-9A-Fa-f]+)\)", (SRC / f"{GAME}_pal.c").read_text())
    rgba = []
    for i, value in enumerate(values[:256]):
        n = int(value, 16)
        rgba.append(((n >> 16) & 255, (n >> 8) & 255, n & 255, 255))
    return [rgba[i:i + 16] for i in range(0, len(rgba), 16)]

def tile(raw, number, palette, transparent=True):
    image = Image.new("RGBA", (8, 8)); p = image.load(); at = number * 32
    for y in range(8):
        for x in range(8):
            byte = raw[at + y * 4 + x // 2]; color = byte >> 4 if x & 1 else byte & 15
            r, g, b, _ = palette[color]
            # Tile-layer and OBJ pixels with local colour index 0 are
            # transparent.  When every BG is transparent, BG palette entry 0
            # is rendered separately as the backdrop colour by the scene.
            p[x, y] = (r, g, b, 0 if transparent and color == 0 else 255)
    return image

def cells():
    text = (SRC / f"{CELL_PREFIX}_anim_cells.inc.c").read_text()
    found = re.findall(rf"AnimationCel {CELL_PREFIX}_cel(\d+)\[\] = \{{\s*/\* Len \*/ (\d+),(.*?)\n\}};", text, re.S)
    result = {}
    for number, length, body in found:
        words = [int(v, 16) for v in re.findall(r"0x([0-9a-fA-F]{4})", body)]
        result[int(number)] = [tuple(words[i:i+3]) for i in range(0, int(length) * 3, 3)]
    return result

def compose(entries, raw, palette_banks, palette_offset=0):
    parts, bounds = [], [9999,9999,-9999,-9999]
    for a0, a1, a2 in entries:
        x, y = signed(a1 & 0x1ff, 9), signed(a0 & 0xff, 8)
        shape, size = (a0 >> 14) & 3, (a1 >> 14) & 3
        w, h = SIZES[shape][size]; bank, base = ((a2 >> 12) & 15) + palette_offset, a2 & 0x3ff
        if bank >= len(palette_banks): raise ValueError(f"missing bank {bank}")
        part = Image.new("RGBA", (w, h))
        for py in range(0, h, 8):
            for px in range(0, w, 8):
                part.alpha_composite(tile(raw, base + (py // 8) * 32 + px // 8, palette_banks[bank]), (px, py))
        if a1 & 0x1000: part = part.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if a1 & 0x2000: part = part.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        parts.append((part, x, y)); bounds = [min(bounds[0],x), min(bounds[1],y), max(bounds[2],x+w), max(bounds[3],y+h)]
    pad = 3; image = Image.new("RGBA", (bounds[2]-bounds[0]+pad*2, bounds[3]-bounds[1]+pad*2))
    for part, x, y in reversed(parts): image.alpha_composite(part, (x-bounds[0]+pad, y-bounds[1]+pad))
    return image, {"originX": -bounds[0]+pad, "originY": -bounds[1]+pad}

def export_bg(raw, map_path, palette_banks, output, tile_mask=0x3ff, chroma_black=False, full_size=False):
    bg = Image.new("RGBA", (256, 256))
    mapraw = map_path.read_bytes()
    for i in range(min(1024, len(mapraw) // 2)):
        entry = int.from_bytes(mapraw[i*2:i*2+2], "little"); part = tile(raw, entry & tile_mask, palette_banks[(entry >> 12) & 15])
        if entry & 0x400: part = part.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if entry & 0x800: part = part.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        bg.alpha_composite(part, ((i % 32) * 8, (i // 32) * 8))
    if not full_size:
        bg = bg.crop((0, 0, 240, 160))
    bg.save(output)

def export_affine_bg(raw, map_path, palette_banks, output):
    """GBA affine backgrounds use an 8-bit tile map and 8bpp tiles."""
    bg = Image.new("RGBA", (256, 256)); mapraw = map_path.read_bytes()
    palette = [color for bank in palette_banks for color in bank]
    for i, index in enumerate(mapraw[:1024]):
        part = Image.new("RGBA", (8, 8)); pixels = part.load(); at = index * 64
        for y in range(8):
            for x in range(8):
                color = raw[at + y * 8 + x]
                r, g, b, _ = palette[color]
                pixels[x, y] = (r, g, b, 0 if color == 0 else 255)
        bg.alpha_composite(part, ((i % 32) * 8, (i // 32) * 8))
    # Affine maps are sampled from the complete 256x256 texture at runtime.
    # Spaceball changes its source rectangle around (128, 176), so exporting a
    # normal 240x160 screen crop loses the lower part of the room and makes the
    # camera transform impossible to reproduce correctly in the browser.
    bg.save(output)

def main():
    OUT.mkdir(parents=True, exist_ok=True); palette_banks = banks()
    # Most games name this <game>_obj; a few keep a second sheet such as
    # power_calligraphy_obj_dancers.  Accept either the historical short stem
    # or the full graphics-file stem.
    obj_path = SRC / f"{OBJ}_obj.4bpp"
    if not obj_path.exists(): obj_path = SRC / f"{OBJ}.4bpp"
    raw = obj_path.read_bytes(); manifest = {}
    for number, entries in cells().items():
        image, meta = compose(entries, raw, palette_banks); filename = f"cel{number:03d}.png"
        image.save(OUT / filename); manifest[str(number)] = {"file": filename, **meta, "width": image.width, "height": image.height}
    # Night Walk creates each balloon with a runtime base-palette offset
    # (`i % 5`).  A static cel export otherwise bakes every balloon as red.
    # Keep palette 0 under the original IDs and place the four shifted variants
    # in a separate numeric namespace consumed by the web renderer.
    if GAME == "night_walk":
        all_cells = cells()
        for palette_offset in range(1, 5):
            for number in (89, 90, 91, 92):
                image, meta = compose(all_cells[number], raw, palette_banks, palette_offset)
                variant = number + palette_offset * 1000
                filename = f"cel{variant:04d}.png"
                image.save(OUT / filename)
                manifest[str(variant)] = {"file": filename, **meta, "width": image.width, "height": image.height}
    (OUT / "frames.json").write_text(json.dumps(manifest, indent=2))
    bg_path = SRC / f"{GAME}_bg_tiles.4bpp"
    # Night Walk deliberately reuses its OBJ tiles as BG tiles.
    bgraw = (obj_path if not bg_path.exists() else SRC / f"{GAME}_bg_tiles.4bpp").read_bytes()
    for map_path in SRC.glob(f"{GAME}_bg_map*.tilemap"):
        if GAME == "spaceball":
            export_affine_bg(bgraw, map_path, palette_banks, OUT / f"{map_path.stem}.png")
        else:
            is_overlay = map_path.stem != f"{GAME}_bg_map"
            export_bg(bgraw, map_path, palette_banks, OUT / f"{map_path.stem}.png",
                      chroma_black=is_overlay, full_size=(GAME == "samurai_slice" and is_overlay))
    print(f"{GAME}: {len(manifest)} cels")

if __name__ == "__main__": main()
