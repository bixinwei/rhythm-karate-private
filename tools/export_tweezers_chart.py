"""Transcribe the playable Rhythm Tweezers main beatscript to web JSON."""
from __future__ import annotations
import json, re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
src=(ROOT/'reference'/'rhythmtengoku-upstream'/'games'/'rhythm_tweezers'/'rhythm_tweezers.bs').read_text().splitlines()
inside=False; tick=0; events=[]; next_veg='onion'
for line in src:
    line=line.strip()
    if line == 'script script_rhythm_tweezers_main': inside=True; continue
    if not inside: continue
    if line == 'return': break
    rest=re.match(r'rest (\d+)',line)
    if rest: tick+=int(rest.group(1)); continue
    cue=re.match(r'spawn_cue (CUE_\w+)',line)
    if cue: events.append({'beat':tick/24,'kind':'cue','cue':cue.group(1).replace('CUE_','').lower()}); continue
    if line == 'rhythm_tweezers_start_hair_cycle': events.append({'beat':tick/24,'kind':'cycle'}); continue
    if line == 'rhythm_tweezers_spawn_tweezers': events.append({'beat':tick/24,'kind':'tweezers'}); continue
    veg=re.match(r'rhythm_tweezers_set_next_veg VEG_(\w+)',line)
    if veg: next_veg=veg.group(1).lower(); continue
    if line.startswith('rhythm_tweezers_scroll_veg'): events.append({'beat':tick/24,'kind':'veg','veg':next_veg})
(ROOT/'assets'/'gba'/'tweezers'/'chart.json').write_text(json.dumps(events,separators=(',',':')))
print('exported',len(events),'events; end beat',tick/24)
