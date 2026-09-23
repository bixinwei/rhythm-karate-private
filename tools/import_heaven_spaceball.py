"""Import Heaven Studio's HD Spaceball art into the port's 4x atlas (full run).

Composites body+bat+hat with the offsets from Heaven Studio's own Idle clip,
fits every result into our existing cel boxes (so origins/timing/camera are
unchanged), packs a 4x atlas, and writes the HD room as a 1024x1024 affine map.
"""
import json, re, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
HS = Path(r"E:\360Downloads\nova\HelloIPAProject\extracted\HeavenStudio-SpaceBall\Assets\Bundled\Games\SpaceBall")
OUR = ROOT / 'assets' / 'gba' / 'spaceball'
SCALE = 4

atlas = Image.open(HS / 'Sprites' / 'spaceball.png').convert('RGBA')
meta = (HS / 'Sprites' / 'spaceball.png.meta').read_text(encoding='utf-8', errors='ignore')
blocks = re.findall(r'name:\s*(\S+)\s*\n\s*rect:\s*\n\s*serializedVersion:\s*\d+\s*\n\s*x:\s*([\d.]+)\s*\n\s*y:\s*([\d.]+)\s*\n\s*width:\s*([\d.]+)\s*\n\s*height:\s*([\d.]+)', meta)
R = {}
for name, x, y, w, h in blocks:
    x, y, w, h = round(float(x)), round(float(y)), round(float(w)), round(float(h))
    R[name] = atlas.crop((x, atlas.height - y - h, x + w, atlas.height - y))

def tight(im):
    bb = im.getbbox()
    return im.crop(bb) if bb else im

BAT_OFF, BAT_SCALE = (14.6, 214.7), 0.5015
HAT_OFF, HAT_SCALE = (-36.4, 399.8), 0.5067

def composite(body_name, bat_name, hat_name):
    body = R[body_name]
    canvas = Image.new('RGBA', body.size, (0, 0, 0, 0))
    canvas.alpha_composite(body, (0, 0))
    cx, cy = body.width / 2, body.height / 2
    if bat_name:
        bat = R[bat_name]
        bw, bh = max(1, round(bat.width * BAT_SCALE)), max(1, round(bat.height * BAT_SCALE))
        bat = bat.resize((bw, bh), Image.LANCZOS)
        canvas.alpha_composite(bat, (round(cx + BAT_OFF[0] - bw / 2), round(cy + BAT_OFF[1] - bh / 2)))
    if hat_name:
        hat = R[hat_name]
        hw, hh = max(1, round(hat.width * HAT_SCALE)), max(1, round(hat.height * HAT_SCALE))
        hat = hat.resize((hw, hh), Image.LANCZOS)
        canvas.alpha_composite(hat, (round(cx + HAT_OFF[0] - hw / 2), round(cy + HAT_OFF[1] - hh / 2)))
    return tight(canvas)

# our cel -> composite spec (body, bat, hat)
P = lambda i: 'spaceball_player_%d' % i
B = lambda i: 'spaceball_bat_%d' % i
H1 = lambda i: 'spaceball_hat_1_%d' % i
SPEC = {}
for i in range(5):
    SPEC[1 + i] = (P(i), B(i), None)          # costume 0 standard
    SPEC[9 + i] = (P(i), B(i), H1(i))         # costume 1 red mask
    SPEC[30 + i] = (P(i), B(i), 'spaceball_hat_0_0')  # costume 2 bunny
# far cels reuse the same art (renderer scales them)
for i in range(5):
    SPEC[44 + (0 if i < 2 else 1 if i < 4 else 2)] = (P(i), B(i), None)
    SPEC[47 + (0 if i < 2 else 1 if i < 4 else 2)] = (P(i), B(i), H1(i))
    SPEC[50 + (0 if i < 2 else 1 if i < 4 else 2)] = (P(i), B(i), 'spaceball_hat_0_0')
SPEC[6] = ('spaceball_ball', None, None)
SPEC[8] = ('spaceball_riceball', None, None)
SPEC[7] = ('star', None, None)                 # star.png lives in the same Sprites dir
SPEC[15] = ('spaceball_dispenser_0', None, None)
SPEC[16] = ('spaceball_dispenser_1', None, None)
SPEC[14] = ('spaceball_dispenser_2', None, None)
SPEC[24] = ('spaceball_dust_0', None, None)
SPEC[25] = ('spaceball_dust_1', None, None)
SPEC[26] = ('spaceball_dust_2', None, None)
for i, u in enumerate([0, 1, 2, 3, 1, 2, 3, 2]):
    SPEC[53 + i] = ('spaceball_umpire_%d' % u, None, None)

# star.png is a separate file, not a slice of the atlas
star = Image.open(HS / 'Sprites' / 'star.png').convert('RGBA')

def art_for(cel):
    if cel in SPEC:
        body, bat, hat = SPEC[cel]
        if body == 'star':
            return tight(star)
        return composite(body, bat, hat)
    return None

# pristine cels for box/origin/bbox
manifest = json.loads((OUR / 'frames.json').read_text())
tiles = {}
for key, m in manifest.items():
    idx = int(key)
    W, H = m['width'], m['height']
    orig = Image.open(OUR / m['file']).convert('RGBA')
    obb = orig.getbbox() or (0, 0, W, H)
    new = art_for(idx)
    if new is None:
        new = orig.resize((W * SCALE, H * SCALE), Image.NEAREST)
        tiles[idx] = new
        continue
    # fit the HD art into the original content bbox (x4), bottom-centre aligned
    tw, th = obb[2] - obb[0], obb[3] - obb[1]
    scale = min((tw * SCALE) / new.width, (th * SCALE) / new.height)
    nw, nh = max(1, round(new.width * scale)), max(1, round(new.height * scale))
    new = new.resize((nw, nh), Image.LANCZOS)
    tile = Image.new('RGBA', (W * SCALE, H * SCALE), (0, 0, 0, 0))
    px = obb[0] * SCALE + (tw * SCALE - nw) // 2
    py = obb[1] * SCALE + th * SCALE - nh
    tile.alpha_composite(new, (px, py))
    tiles[idx] = tile

# pack into a 4x atlas (1024 wide, 8px padding)
PAD = 8
width = 1024
x = y = row_h = 0
placements = {}
for idx in sorted(tiles):
    im = tiles[idx]
    if x and x + im.width > width:
        x = 0; y += row_h + PAD; row_h = 0
    placements[idx] = (x, y)
    x += im.width + PAD
    row_h = max(row_h, im.height)
sheet = Image.new('RGBA', (width, y + row_h), (0, 0, 0, 0))
for idx, (px, py) in placements.items():
    sheet.alpha_composite(tiles[idx], (px, py))
sheet.save(OUR / 'atlas.png')

# rewrite frames.json: keep native units, atlasX/atlasY in native units (x4 / 4)
for key, m in manifest.items():
    idx = int(key)
    px, py = placements[idx]
    m['atlasX'] = px // SCALE
    m['atlasY'] = py // SCALE
(OUR / 'frames.json').write_text(json.dumps(manifest, indent=2))

# HD room -> 1024x1024 affine map (256x256 at 4x)
room = R['spaceball_room']
room.resize((1024, 1024), Image.LANCZOS).save(OUR / 'spaceball_bg_map.png')

print('imported', len(tiles), 'cels; atlas', sheet.size, '; replaced', len(SPEC), 'cels')