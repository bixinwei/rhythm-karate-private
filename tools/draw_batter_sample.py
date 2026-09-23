"""Procedurally draw an original chibi batter (4x native) for evaluation.

Nothing here is traced from any retail sprite: every shape is drawn from
primitives.  The point of this script is to establish the quality ceiling of
code-drawn art before committing to an asset route.

    python tools/draw_batter_sample.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'captures' / 'sample-batter.png'
S = 4                      # native 56x130 -> 224x520
W, H = 56 * S, 130 * S
OUTLINE = (91, 74, 99)
SKIN = (255, 217, 199)
BLUSH = (255, 158, 176)
JERSEY = (255, 158, 196)
JERSEY_DARK = (226, 106, 158)
TRIM = (255, 247, 250)
CAP = (255, 201, 224)
BAT = (232, 184, 122)
SHOE = (143, 168, 232)
HAIR = (108, 74, 92)


def rrect(d, box, radius, fill, outline=OUTLINE, width=2 * S):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # bat, held up behind the shoulder
    d.line([(150 * S / 4 * 4 / 4 * 1, 0)], fill=None)  # no-op keeps linters quiet
    d.polygon([(150, 96), (186, 44), (200, 52), (164, 104)], fill=BAT, outline=OUTLINE)
    d.line([(150, 96), (186, 44)], fill=OUTLINE, width=2 * S)
    d.line([(164, 104), (200, 52)], fill=OUTLINE, width=2 * S)

    # legs + shoes
    rrect(d, (78, 300, 108, 440), 14 * S // 2, SKIN)
    rrect(d, (120, 300, 150, 440), 14 * S // 2, SKIN)
    rrect(d, (66, 428, 116, 470), 10 * S, SHOE)
    rrect(d, (116, 428, 166, 470), 10 * S, SHOE)

    # shorts
    rrect(d, (72, 250, 156, 320), 8 * S, TRIM)

    # torso / jersey
    rrect(d, (68, 150, 160, 268), 10 * S, JERSEY)
    d.polygon([(112, 150), (160, 150), (160, 210), (112, 210)], fill=JERSEY_DARK)  # side panel
    d.line([(112, 150), (112, 210)], fill=OUTLINE, width=2 * S)
    rrect(d, (96, 158, 134, 186), 4 * S, TRIM, width=2 * S)                        # collar patch

    # arms
    rrect(d, (34, 160, 74, 246), 8 * S, JERSEY)
    rrect(d, (40, 238, 76, 274), 8 * S, SKIN)                                      # glove hand
    rrect(d, (152, 168, 190, 230), 8 * S, JERSEY)
    rrect(d, (150, 222, 186, 256), 8 * S, SKIN)

    # head
    d.ellipse([(56, 26), (176, 146)], fill=SKIN, outline=OUTLINE, width=2 * S)
    d.ellipse([(52, 20), (180, 78)], fill=CAP, outline=OUTLINE, width=2 * S)       # cap crown
    d.polygon([(52, 64), (188, 64), (206, 78), (52, 78)], fill=CAP, outline=OUTLINE)  # brim
    d.ellipse([(64, 74), (168, 84)], fill=HAIR)                                    # fringe shadow

    # face
    d.ellipse([(84, 94), (100, 112)], fill=OUTLINE)
    d.ellipse([(132, 94), (148, 112)], fill=OUTLINE)
    d.ellipse([(90, 98), (96, 104)], fill=(255, 255, 255))
    d.ellipse([(138, 98), (144, 104)], fill=(255, 255, 255))
    d.ellipse([(70, 112), (88, 122)], fill=BLUSH)
    d.ellipse([(146, 112), (164, 122)], fill=BLUSH)
    d.arc([(104, 106), (130, 128)], start=10, end=170, fill=OUTLINE, width=2 * S)  # smile

    img.save(OUT)
    img.resize((W // 4, H // 4), Image.NEAREST).save(OUT.with_name('sample-batter-native.png'))
    print('wrote', OUT.relative_to(ROOT), img.size, '+ native', (W // 4, H // 4))


if __name__ == '__main__':
    main()