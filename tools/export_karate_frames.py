"""Compose Karate Man animation cells from the decomp's local 4bpp tiles.

This exports local preview assets only.  It uses the original tile layout,
palette banks and OAM cell definitions supplied by the decomp project.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "reference" / "rhythmtengoku-upstream" / "games" / "karate_man" / "graphics"
OUT = ROOT / "assets" / "gba"

SIZES = {
    0: [(8, 8), (16, 16), (32, 32), (64, 64)],
    1: [(16, 8), (32, 8), (32, 16), (64, 32)],
    2: [(8, 16), (8, 32), (16, 32), (32, 64)],
}


def signed(value, bit):
    return value - (1 << bit) if value & (1 << (bit - 1)) else value


def palettes():
    values = re.findall(r"TO_RGB555\(0x([0-9A-Fa-f]+)\)", (SRC / "karate_man_pal.c").read_text())
    result = []
    # engine.c copies 0x140 bytes of this table into OBJ palette memory: 10 banks.
    for i, value in enumerate(values[:160]):
        rgb = int(value, 16)
        result.append(((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 0 if i % 16 == 0 else 255))
    return result


def tile_image(raw, tile_index, palette):
    image = Image.new("RGBA", (8, 8))
    pixels = image.load()
    at = tile_index * 32
    for y in range(8):
        for x in range(8):
            value = raw[at + y * 4 + x // 2]
            colour = value >> 4 if x & 1 else value & 15
            pixels[x, y] = palette[colour]
    return image


def cells():
    source = (SRC / "karate_man_anim_cells.inc.c").read_text()
    found = re.findall(r"AnimationCel karate_man_cel(\d+)\[\] = \{\s*/\* Len \*/ (\d+),(.*?)\n\};", source, re.S)
    result = {}
    for name, length, body in found:
        words = [int(v, 16) for v in re.findall(r"0x([0-9a-fA-F]{4})", body)]
        entries = [tuple(words[i:i + 3]) for i in range(0, int(length) * 3, 3)]
        if not entries or any(len(entry) != 3 for entry in entries):
            continue  # incomplete/unused definition at the tail of the source file
        result[int(name)] = entries
    return result


def compose(entries, raw, palette_banks):
    parts, bounds = [], [9999, 9999, -9999, -9999]
    for a0, a1, a2 in entries:
        x, y = signed(a1 & 0x1FF, 9), signed(a0 & 0xFF, 8)
        shape, size = (a0 >> 14) & 3, (a1 >> 14) & 3
        width, height = SIZES[shape][size]
        bank = (a2 >> 12) & 15
        tile = a2 & 0x3FF
        if bank >= len(palette_banks):
            raise ValueError(f"missing palette bank {bank} for tile {tile:#x}")
        part = Image.new("RGBA", (width, height))
        # Rhythm Tengoku uses the GBA's 2D OBJ tile layout: each sprite row
        # advances by 32 tiles in OBJ VRAM, rather than by the sprite width.
        # Treating it as 1D is what produced repeated vertical strips of Joe.
        for py in range(0, height, 8):
            for px in range(0, width, 8):
                source_tile = tile + (py // 8) * 32 + px // 8
                part.alpha_composite(tile_image(raw, source_tile, palette_banks[bank]), (px, py))
        if a1 & 0x1000: part = part.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if a1 & 0x2000: part = part.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        parts.append((part, x, y))
        bounds = [min(bounds[0], x), min(bounds[1], y), max(bounds[2], x + width), max(bounds[3], y + height)]
    pad = 3
    image = Image.new("RGBA", (bounds[2] - bounds[0] + pad * 2, bounds[3] - bounds[1] + pad * 2))
    # GBA OBJ priority ties are resolved by OAM index: the first entry is in
    # front.  Canvas paints the last image on top, so compose the cell in
    # reverse order.  The prior forward pass covered Joe's face/chin pixels
    # with later body tiles, leaving a monochrome, malformed silhouette.
    for part, x, y in reversed(parts):
        image.alpha_composite(part, (x - bounds[0] + pad, y - bounds[1] + pad))
    return image, {"originX": -bounds[0] + pad, "originY": -bounds[1] + pad}


def render_background(bg_raw, bg_map, palette_rows):
    background = Image.new("RGBA", (256, 256))
    for index in range(32 * 32):
        entry = int.from_bytes(bg_map[index * 2:index * 2 + 2], "little")
        tile = tile_image(bg_raw, entry & 0x3FF, palette_rows[(entry >> 12) & 0xF])
        if entry & 0x400: tile = tile.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if entry & 0x800: tile = tile.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        background.alpha_composite(tile, ((index % 32) * 8, (index // 32) * 8))
    return background


def main():
    raw = (SRC / "karate_man_obj.4bpp").read_bytes()
    colours = palettes()
    banks = [colours[i * 16:(i + 1) * 16] for i in range(10)]
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for number, entries in cells().items():
        image, origin = compose(entries, raw, banks)
        filename = f"cel{number:03d}.png"
        image.save(OUT / filename)
        manifest[str(number)] = {"file": filename, "width": image.width, "height": image.height, **origin}
    (OUT / "karate_frames.json").write_text(json.dumps(manifest, indent=2))
    # The map is 32x32 tiles, while the Game Boy Advance viewport is 240x160.
    # Karate Man initializes BG1 at (0, 0) in karate_engine_start().  Keep
    # this exact viewport: OBJ positions such as Joe (80,88) and the hit
    # point (158,54) are expressed in this same screen coordinate system.
    bg_raw = (SRC / "karate_man_bg_tiles.4bpp").read_bytes()
    bg_map = (SRC / "karate_man_bg_map.tilemap").read_bytes()
    # karate_init_flow() points bgPalIndex at karate_flow_palette_low and
    # karate_init_gfx3() copies palette 5 into BG palette row 4 before the first
    # frame, so the tilemap's authored palette 4 is never displayed.  Low Flow
    # keeps palette 5; High Flow alternates palettes 6 and 7 on every
    # beat_anim.  Export exactly those three variants.
    for name, palette_id in (("low", 5), ("high_a", 6), ("high_b", 7)):
        rows = list(banks)
        rows[4] = colours[palette_id * 16:(palette_id + 1) * 16]
        viewport = render_background(bg_raw, bg_map, rows).crop((0, 0, 240, 160))
        viewport.save(OUT / f"karate_man_stage_{name}.png")
    print(f"Exported {len(manifest)} original Karate Man animation cells and 3 stage palettes to {OUT}")


if __name__ == "__main__":
    main()
