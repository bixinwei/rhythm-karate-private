"""Pack already-exported GBA cel PNGs into one lossless atlas per folder."""
from __future__ import annotations
import json, sys
from pathlib import Path
from PIL import Image

folder = Path(sys.argv[1])
manifest_path = folder / "frames.json"
manifest = json.loads(manifest_path.read_text())
items = []
for key, meta in sorted(manifest.items(), key=lambda item: int(item[0])):
    image = Image.open(folder / meta["file"]).convert("RGBA")
    items.append((key, meta, image))

width, padding = 1024, 2
x = y = row_h = 0
placements = []
for key, meta, image in items:
    if x and x + image.width > width:
        x = 0; y += row_h + padding; row_h = 0
    placements.append((key, meta, image, x, y))
    x += image.width + padding; row_h = max(row_h, image.height)

atlas = Image.new("RGBA", (width, y + row_h))
for key, meta, image, x, y in placements:
    atlas.alpha_composite(image, (x, y))
    meta["atlasX"], meta["atlasY"] = x, y
atlas.save(folder / "atlas.png", optimize=True)
manifest_path.write_text(json.dumps(manifest, indent=2))
print(folder, len(items), atlas.size)
