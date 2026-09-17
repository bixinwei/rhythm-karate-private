"""Export original Rhythm Tweezers MIDI events with their GBA PCM samples."""
from __future__ import annotations
import json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / 'reference' / 'rhythmtengoku-upstream'
sys.path.insert(0, str(ROOT / 'tools'))
from export_karate_midi import parse_track

SEQUENCES = {
    'tweezers_bgm_events': ('s_datumo_bgm.mid', 10),
    'tweezers_appear_events': ('s_hanabi_pon.mid', 7),
    'tweezers_long_appear_events': ('s_f_hair_appear_long.mid', 56),
    'tweezers_hit_events': ('s_datumo_nuki.mid', 2),
    'tweezers_barely_events': ('s_f_hair_kegire.mid', 56),
    'tweezers_long_hit_events': ('s_witch_furu.mid', 2),
    'tweezers_long_pull_events': ('s_f_hair_tuneru.mid', 56),
    'tweezers_next_events': ('s_f_hair_next.mid', 56),
}

def instruments(bank):
    text = (UP / 'audio' / 'instruments' / f'instruments_bank{bank:02d}.inc.c').read_text()
    return {int(i): (int(sample), 'FIXED' in kind) for i, kind, sample in re.findall(r'struct InstrumentPCM instrument_pcm_(\d+) = \{(.*?)&sample_(\d+)_data', text, re.S)}

def bank_entries(bank):
    text = (UP / 'audio' / 'instrument_banks.inc.c').read_text()
    block = re.search(rf'union Instrument inst_bank_{bank:02d}\[\].*?\n\}};', text, re.S).group()
    values = []
    for kind, number, null in re.findall(r'\{\s*\.(pcm|rhy|psg|spl)\s*=\s*&instrument_\w+?_(\d+)\s*\}|\b(NULL)\b', block):
        values.append((kind, int(number)) if kind else None)
    return values

def resolve(event, bank, data):
    program, note = event['program'], event['note']
    # s_hanabi_pon uses Bank 7's program 127, a rhythm instrument which
    # redirects to sub-bank 54. It is not the Bank 47 rhythm mapping used by
    # Karate's music tracks.
    if bank == 7 and program == 127:
        entries, pcm = data[54]
        index = note - 36
        if not (0 <= index < len(entries)) or not entries[index] or entries[index][0] != 'pcm': return None
        return pcm.get(entries[index][1])
    # Rhythm programs in this song point to the same sub-banks as Karate's
    # music bank: 125 -> bank 50, 127 -> bank 47, indexed from MIDI key 36.
    if program in (125, 127):
        entries, pcm = data[50 if program == 125 else 47]
        index = note - 36
    else:
        entries, pcm = data[bank]
        index = program
    if not (0 <= index < len(entries)) or not entries[index] or entries[index][0] != 'pcm': return None
    return pcm.get(entries[index][1])

def midi_notes(filename):
    raw = (UP / 'audio' / 'sequences' / filename).read_bytes(); pos = 14; notes = []
    for _ in range(int.from_bytes(raw[10:12], 'big')):
        length = int.from_bytes(raw[pos + 4:pos + 8], 'big')
        notes.extend(parse_track(raw[pos + 8:pos + 8 + length])); pos += 8 + length
    return notes

def main():
    out = ROOT / 'assets' / 'gba'; samples = out / 'samples'; samples.mkdir(parents=True, exist_ok=True)
    data = {bank: (bank_entries(bank), instruments(bank)) for bank in {2, 7, 10, 47, 50, 54, 56}}
    used = set()
    for output, (filename, bank) in SEQUENCES.items():
        notes = midi_notes(filename)
        for note in notes:
            resolved = resolve(note, bank, data)
            if resolved:
                note['sample'], note['fixed'] = resolved; used.add(resolved[0])
        notes.sort(key=lambda x: x['beat'])
        (out / f'{output}.json').write_text(json.dumps(notes, separators=(',', ':')))
    for sample in used:
        source = UP / 'audio' / 'samples' / f'sample_{sample:03d}.wav'
        if source.exists(): shutil.copy2(source, samples / source.name)
    print(f'exported {len(SEQUENCES)} sequences and {len(used)} PCM samples')

if __name__ == '__main__': main()
