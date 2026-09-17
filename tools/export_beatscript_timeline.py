"""Expand a local GBA BeatScript into an auditable, flat event timeline.

Only source directives that affect gameplay time or engine state are retained.
Calls are expanded recursively, so the generated JSON can be mechanically
compared with the original script instead of maintaining a hand-written chart.
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
GAME=sys.argv[1]
ENTRY=sys.argv[2]
game_dir=ROOT/'reference'/'rhythmtengoku-upstream'/'games'/GAME
# Power Calligraphy's main sheet includes its executable subroutines from a
# companion file; combine every local BeatScript source before resolving calls.
source='\n'.join(path.read_text() for path in game_dir.glob('*.bs'))
out=ROOT/'assets'/'gba'/f'{GAME}_timeline.json'
scripts={m.group(1):m.group(2) for m in re.finditer(r'^script\s+(\w+)\s*\n(.*?)(?=^script\s+|\Z)',source,re.M|re.S)}
events=[]

def walk(name,tick=0,depth=0):
    if depth>80: raise ValueError(f'runaway call at {name}')
    for raw in scripts[name].splitlines():
        line=raw.split('@')[0].strip()
        if not line or line in {'return','stop','loop_start','loop_end'}: continue
        args=line.replace(',',' ').split(); op=args[0]
        if op=='rest': tick += int(args[1],0); continue
        if op=='call': tick=walk(args[1],tick,depth+1); continue
        # Preserve every timed command (including game-specific macros such as
        # brush position/cel changes) for a one-to-one audit in the browser.
        events.append({'tick':tick,'op':op,'args':args[1:]})
    return tick

end=walk(ENTRY)
out.write_text(json.dumps({'entry':ENTRY,'endTick':end,'events':events},indent=2))
print(GAME,ENTRY,'events',len(events),'end',end,'ticks')
