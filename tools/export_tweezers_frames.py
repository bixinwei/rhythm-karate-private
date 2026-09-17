"""Export Rhythm Tweezers GBA OBJ cells and backgrounds."""
from __future__ import annotations
import json, re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'reference' / 'rhythmtengoku-upstream' / 'games' / 'rhythm_tweezers' / 'graphics'
OUT = ROOT / 'assets' / 'gba' / 'tweezers'
SIZES = {0: [(8,8),(16,16),(32,32),(64,64)], 1: [(16,8),(32,8),(32,16),(64,32)], 2: [(8,16),(8,32),(16,32),(32,64)]}

def signed(v,b): return v-(1<<b) if v & (1<<(b-1)) else v

def palette():
    vals = re.findall(r'TO_RGB555\(0x([0-9A-Fa-f]+)\)', (SRC/'rhythm_tweezers_pal.c').read_text())
    out=[]
    for i,v in enumerate(vals[:160]):
        n=int(v,16); out.append(((n>>16)&255,(n>>8)&255,n&255,0 if i%16==0 else 255))
    return [out[i:i+16] for i in range(0,len(out),16)]

def tile(raw, idx, pal, transparent=True):
    im=Image.new('RGBA',(8,8)); p=im.load(); at=idx*32
    for y in range(8):
        for x in range(8):
            b=raw[at+y*4+x//2]; colour=b>>4 if x&1 else b&15
            r,g,bl,a=pal[colour]; p[x,y]=(r,g,bl,0 if transparent and colour == 0 else 255)
    return im

def cells():
    txt=(SRC/'rhythm_tweezers_anim_cells.inc.c').read_text()
    found=re.findall(r'AnimationCel rhythm_tweezers_cel(\d+)\[\] = \{\s*/\* Len \*/ (\d+),(.*?)\n\};',txt,re.S)
    out={}
    for num,length,body in found:
        words=[int(v,16) for v in re.findall(r'0x([0-9a-fA-F]{4})',body)]
        out[int(num)]=[tuple(words[i:i+3]) for i in range(0,int(length)*3,3)]
    return out

def compose(entries,raw,banks):
    parts=[]; bounds=[9999,9999,-9999,-9999]
    for a0,a1,a2 in entries:
        x,y=signed(a1&0x1ff,9),signed(a0&0xff,8)
        shape,size=(a0>>14)&3,(a1>>14)&3; w,h=SIZES[shape][size]
        bank=(a2>>12)&15; base=a2&0x3ff
        part=Image.new('RGBA',(w,h))
        for py in range(0,h,8):
            for px in range(0,w,8): part.alpha_composite(tile(raw,base+(py//8)*32+px//8,banks[bank]),(px,py))
        if a1&0x1000: part=part.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if a1&0x2000: part=part.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        parts.append((part,x,y)); bounds=[min(bounds[0],x),min(bounds[1],y),max(bounds[2],x+w),max(bounds[3],y+h)]
    pad=3; im=Image.new('RGBA',(bounds[2]-bounds[0]+pad*2,bounds[3]-bounds[1]+pad*2))
    for part,x,y in reversed(parts): im.alpha_composite(part,(x-bounds[0]+pad,y-bounds[1]+pad))
    return im, {'originX':-bounds[0]+pad,'originY':-bounds[1]+pad}

def bg(raw,mapraw,banks):
    im=Image.new('RGBA',(256,256))
    for i in range(1024):
        e=int.from_bytes(mapraw[i*2:i*2+2],'little'); t=tile(raw,e&0x3ff,banks[(e>>12)&15],False)
        if e&0x400:t=t.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if e&0x800:t=t.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        im.alpha_composite(t,((i%32)*8,(i//32)*8))
    return im.crop((0,0,240,160))

def main():
    OUT.mkdir(parents=True,exist_ok=True); banks=palette(); raw=(SRC/'rhythm_tweezers_obj.4bpp').read_bytes(); manifest={}
    for n,e in cells().items():
        im,meta=compose(e,raw,banks); fn=f'cel{n:03d}.png'; im.save(OUT/fn); manifest[str(n)]={'file':fn,**meta,'width':im.width,'height':im.height}
    (OUT/'frames.json').write_text(json.dumps(manifest,indent=2))
    bgraw=(SRC/'rhythm_tweezers_bg_tiles.4bpp').read_bytes()
    for veg in ('onion','turnip','potato'):
        bg(bgraw,(SRC/f'rhythm_tweezers_bg_map_{veg}.tilemap').read_bytes(),banks).save(OUT/f'bg_{veg}.png')
    print('exported',len(manifest),'cells')
if __name__=='__main__': main()
