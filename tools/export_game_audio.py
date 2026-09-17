"""Export authoritative GBA MIDI note timelines and their PCM sample mapping.

The source sequence, SongHeader bank and InstrumentPCM/SubRhythm definitions
are all read from the local decomp; Web code only schedules this extracted data
against its shared AudioContext clock.
"""
from __future__ import annotations
import json, re, shutil, sys, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UP = ROOT / 'reference' / 'rhythmtengoku-upstream'
OUT = ROOT / 'assets' / 'gba'
# midi_psg_noise_freq_table (data/lib_midi_data.c), loaded by main().
NOISE_TABLE = []
SONGS = {
    'spaceball_bgm_events': ('s_shibafu1_bgm.mid', 20, 75),
    'samurai_bgm1_events': ('s_iai_bgm1.mid', 2, 100),
    'samurai_bgm2_events': ('s_iai_bgm2.mid', 2, 100),
    'samurai_bgm3_events': ('s_iai_bgm3.mid', 2, 100),
    'samurai_result_events': ('s_iai_result.mid', 2, 100),
    'night_walk_bgm_events': ('s_4beat_bgm.mid', 36, 80),
    'calligraphy_bgm1_events': ('s_shuji_bgm1.mid', 26, 80),
    'calligraphy_bgm2_events': ('s_shuji_bgm2.mid', 26, 80),
    'calligraphy_bgm3_events': ('s_shuji_bgm3.mid', 26, 80),
    'calligraphy_end_events': ('s_shuji_bgm_end.mid', 26, 80),
}
SFX = {
    'karate_fly_events': 's_f_boxing_fly_nml_seqData', 'karate_pot_events': 's_f_boxing_just_hati_seqData',
    'karate_rock_events': 's_f_boxing_just_rock_seqData', 'karate_ball_events': 's_f_boxing_just_ball_seqData',
    'karate_bulb_events': 's_f_boxing_just_light_seqData', 'karate_bomb_events': 's_f_boxing_just_bomb_seqData',
    'karate_normal_events': 's_f_boxing_normal_seqData', 'karate_punch_events': 's_f_boxing_punch_seqData',
    'karate_barely_events': 's_witch_donats_seqData', 'karate_hard_events': 's_f_boxing_hard_seqData',
    'karate_miss_voice_events': 's_f_boxing_v_nua_seqData',
    'karate_score_up_events': 's_f_boxing_score_up_seqData', 'karate_score_down_events': 's_f_boxing_score_down_seqData',
    'spaceball_throw_events': 's_batter_mit_seqData', 'spaceball_high_events': 's_f_batter_ball_high_seqData', 'spaceball_hit_events': 's_batter_hit_seqData', 'spaceball_barely_events': 's_witch_donats_seqData', 'spaceball_land_events': 's_f_batter_ball_land_seqData',
    'samurai_appear_events': 's_kuma_sakana_seqData', 'samurai_cut1_events': 's_f_iai_cut_seqData', 'samurai_cut2_events': 's_f_iai_cut2_seqData', 'samurai_miss_events': 's_iai_miss_seqData',
    'samurai_phrase1a_events': 's_iai_frase1a_seqData', 'samurai_phrase2a_events': 's_iai_frase2a_seqData', 'samurai_phrase3a_events': 's_iai_frase3a_seqData',
    'samurai_phrase1b_events': 's_iai_frase1b_seqData', 'samurai_phrase2b_events': 's_iai_frase2b_seqData', 'samurai_phrase3b_events': 's_iai_frase3b_seqData',
    'calligraphy_hit_events': 's_sword_orya_seqData', 'calligraphy_hit2_events': 's_sword_hi_seqData', 'calligraphy_barely_events': 's_f_shuji_v_nuaa_seqData', 'calligraphy_miss_events': 's_f_shuji_v_nuahaha_seqData',
    'calligraphy_ho_events': 's_shuji_ho_seqData', 'calligraphy_start_events': 's_f_shuji_start_seqData',
    'calligraphy_swing1_events': 's_f_shuji_swing1_seqData', 'calligraphy_charge_voice_events': 's_f_shuji_v_funuue_seqData',
    'calligraphy_ha1_events': 's_f_shuji_v_ha1_seqData', 'calligraphy_ha2_events': 's_f_shuji_v_ha2_seqData',
    'calligraphy_ha3_events': 's_f_shuji_v_ha3_seqData', 'calligraphy_break_events': 's_rabbit_break2_seqData',
    'calligraphy_swing2_events': 's_f_shuji_swing2_seqData', 'calligraphy_furi_events': 's_furi_seqData',
    'calligraphy_unuu_events': 's_f_shuji_v_unuu_seqData', 'calligraphy_ouch_events': 's_f_shuji_v_ouch_seqData',
    'night_walk_count_events': 's_dontan_count_seqData', 'night_walk_kick_events': 's_BD1_seqData',
    'night_walk_snare_events': 's_SD2_seqData', 'night_walk_cymbal_events': 's_CC4_seqData',
    'night_walk_default_events': 's_f_drum_BD_1_seqData', 'night_walk_roll_events': 's_f_drum_SD_1_seqData',
    'night_walk_barely_snare_events': 's_f_test_drum_SD_B_seqData',
    'night_walk_open_events': 's_4beat_open_seqData',
    'night_walk_barely_events': 's_f_test_drum_BD_B_seqData', 'night_walk_miss_events': 's_f_drumtech_miss_seqData',
    'night_walk_fall_events': 's_f_drumtech_fall_seqData', 'night_walk_damage_events': 's_f_drumtech_damage_seqData',
}

def vlq(data, p):
    v = 0
    while True:
        b = data[p]; p += 1; v = (v << 7) | (b & 127)
        if not b & 128: return v, p

def track(data):
    p = tick = 0; running = None; programs = [0] * 16; active = {}; out = []; markers = []
    # midi_channel_init() starts volume at 100 (not General MIDI's 127).
    controls = [dict(volume=100, expression=127, panning=64, pitchWheel=0x2000, pitchRange=2) for _ in range(16)]

    def update_active(channel, key, value):
        controls[channel][key] = value
        for notes in active.values():
            for note in notes:
                if note['channel'] != channel: continue
                point = {'beat': (tick - note['start']) / 24, key: value}
                if point['beat'] >= 0: note['automation'].append(point)
    while p < len(data):
        delta, p = vlq(data, p); tick += delta; first = data[p]
        if first < 128: status = running
        else: status = first; p += 1; running = status
        if status == 0xff:
            meta_type = data[p]; p += 1; n, p = vlq(data, p); payload = data[p:p+n]; p += n
            if meta_type == 0x06: markers.append((tick, payload))
            continue
        if status in (0xf0, 0xf7):
            n, p = vlq(data, p); p += n; continue
        count = 1 if 0xc0 <= status <= 0xdf else 2
        if first < 128: msg = [first, *data[p:p + count - 1]]; p += count - 1
        else: msg = list(data[p:p + count]); p += count
        ch, kind = status & 15, status & 0xf0
        if kind == 0xc0: programs[ch] = msg[0]
        elif kind == 0xb0:
            controller, value = msg
            if controller == 0x07: update_active(ch, 'volume', value)
            elif controller == 0x0A: update_active(ch, 'panning', value)
            elif controller == 0x0B: update_active(ch, 'expression', value)
            elif controller == 0x14: update_active(ch, 'pitchRange', value)
        elif kind == 0xe0:
            update_active(ch, 'pitchWheel', (msg[0] & 0x7f) | ((msg[1] & 0x7f) << 7))
        elif kind == 0x90 and msg[1]:
            state = controls[ch]
            active.setdefault((ch,msg[0]), []).append({
                'start': tick, 'velocity': msg[1], 'program': programs[ch], 'channel': ch,
                'volume': state['volume'], 'expression': state['expression'], 'panning': state['panning'],
                'pitchWheel': state['pitchWheel'], 'pitchRange': state['pitchRange'], 'automation': []
            })
        elif kind in (0x80, 0x90):
            key=(ch,msg[0])
            if active.get(key):
                note=active[key].pop(0); start=note.pop('start'); automation=note.pop('automation')
                event={'beat':start/24,'length':max(1,tick-start)/24,'note':msg[0],**note}
                if automation: event['automation']=automation
                out.append(event)
    return out, markers

def parse_midi(filename):
    data=(UP/'audio'/'sequences'/filename).read_bytes(); tracks=int.from_bytes(data[10:12],'big'); p=14; notes=[]; markers=[]
    for _ in range(tracks):
        assert data[p:p+4] == b'MTrk'; n=int.from_bytes(data[p+4:p+8],'big'); track_notes, track_markers = track(data[p+8:p+8+n]); notes.extend(track_notes); markers.extend(track_markers); p += 8+n
    starts=[tick for tick,label in markers if label == b'[']; ends=[tick for tick,label in markers if label == b']']
    loop_start = starts[0] if starts and ends and ends[0] > starts[0] else None
    loop_ticks = (ends[0] - loop_start) if loop_start is not None else None
    return sorted(notes,key=lambda x:x['beat']), (loop_start / 24 if loop_start is not None else None), (loop_ticks / 24 if loop_ticks else None)

def all_banks():
    text=(UP/'audio'/'instrument_banks.inc.c').read_text()
    banks={}
    for n,body in re.findall(r'union Instrument inst_bank_(\d+)\[\].*?\{(.*?)\n\};',text,re.S):
        vals=[]
        # Keep every table slot, including PSG/split instruments that cannot
        # be rendered from PCM.  Dropping them shifts every later program and
        # silently maps valid rhythm instruments to the wrong sample.
        for kind,num,is_null in re.findall(r'\.(\w+)\s*=\s*&instrument_\w+_(\d+)|(\bNULL\b)',body):
            vals.append(None if is_null else (kind,int(num)))
        banks[int(n)]=vals
    return banks

def noise_freq_table():
    """midi_psg_noise_freq_table: SOUND4CNT_L value per note number 21..80."""
    text = (UP / 'data' / 'lib_midi_data.c').read_text()
    body = re.search(r'midi_psg_noise_freq_table\[\]\s*=\s*\{(.*?)\};', text, re.S).group(1)
    return [int(value, 16) for value in re.findall(r'0x([0-9A-Fa-f]{2})', body)]


def apply_psg(event, instrument, note):
    """Mirror midi_psg_update_id(): the PSG channel decides how a note is voiced."""
    channel = instrument.get('channel')
    if channel == 'PSG_NOISE_CHANNEL':
        # soundChannel->frequency = key for the noise channel, then the table is
        # indexed with it clamped to 21..80; PSG_NOISE_COUNTER_7 sets bit 3.
        index = max(0, min(len(NOISE_TABLE) - 1, max(21, min(80, note)) - 21))
        event['wave'] = 'noise'
        event['noiseRegister'] = NOISE_TABLE[index]
        event['noiseShort'] = instrument.get('noise') == 'PSG_NOISE_COUNTER_7'
    else:
        # Only the two pulse channels (and the unused wave channel) remain.
        # PSG_TONE_DUTY_12/25/50/75 -> the GBA duty selector 0..3; Web Audio's
        # square oscillator is exactly the 50% entry the ROM uses.
        event['wave'] = 'square'
        duty = re.search(r'DUTY_(\d+)', instrument.get('tone') or '')
        if duty:
            event['duty'] = {12: 0, 25: 1, 50: 2, 75: 3}.get(int(duty.group(1)))
    event.update({key: value for key, value in instrument.items() if key.startswith('adsr')})


def pcm_map():
    result={}; sub={}; psgs={}
    for file in (UP/'audio'/'instruments').glob('instruments_bank*.inc.c'):
        text=file.read_text()
        for ident,body in re.findall(r'struct InstrumentPCM instrument_pcm_(\d+)\s*=\s*\{(.*?)\n\};',text,re.S):
            sample=re.search(r'&sample_(\d+)_data',body)
            key=re.search(r'Key\s+\*/\s*0x([0-9A-Fa-f]+)',body)
            adsr={name:int(match.group(1),16) for name,label in (
                ('adsrInit','Init'),('adsrSustain','Sus'),('adsrAttack','Atk'),
                ('adsrDecay','Dec'),('adsrFade','Fade'),('adsrRelease','Rel')
            ) if (match:=re.search(rf'ADSR {label}\s+\*/\s*0x([0-9A-Fa-f]+)',body))}
            if sample:
                result[int(ident)]={'sample':int(sample.group(1)), 'fixed':'INSTRUMENT_PCM_FIXED' in body, 'key':int(key.group(1),16) if key else 60, **adsr}
        for ident, body in re.findall(r'struct InstrumentPSG instrument_psg_(\d+)\s*=\s*\{(.*?)\n\};', text, re.S):
            adsr = {name: int(match.group(1), 16) for name, label in (
                ('adsrInit', 'Init'), ('adsrSustain', 'Sus'), ('adsrAttack', 'Atk'),
                ('adsrDecay', 'Dec'), ('adsrFade', 'Fade'), ('adsrRelease', 'Rel')
            ) if (match := re.search(rf'ADSR {label}\s+\*/\s*0x([0-9A-Fa-f]+)', body))}
            def field(label):
                match = re.search(rf'/\* {label}\s+\*/\s*([^,\n]+)', body)
                return match.group(1).strip() if match else None
            # The PSG channel type, pulse duty and noise counter mode decide how
            # the note is voiced; keep the ROM values instead of assuming square.
            psgs[int(ident)] = {**adsr, 'channel': field('PSG Chnl'), 'tone': field('PSG Tone'),
                                'noise': field('PSG Noise'), 'waveTable': field('PSG Wave'),
                                'length': field('PSG Len')}
        sub.update({int(a):(int(b),int(c)) for a,b,c in re.findall(r'instrument_rhy_(\d+).*?Base Key\s+\*/\s*(\d+).*?inst_bank_(\d+)',text,re.S)})
    return result,sub,psgs

def sample_for(bank, program, note, banks, pcms, subs, psgs, percussion=False):
    entry=banks.get(bank,[None]*128)[program] if program < len(banks.get(bank,[])) else None
    if not entry: return None
    kind, ident=entry
    if kind == 'pcm':
        pcm=pcms.get(ident)
        if not pcm: return None
        return {**pcm, 'kind':'pcm', 'playNote':pcm['key'] if percussion else note}
    if kind == 'psg':
        return {**psgs.get(ident,{}), 'kind':'psg'}
    if kind == 'rhy':
        base,subbank=subs[ident]; return sample_for(subbank, note-base, note, banks, pcms, subs, psgs, True)
    return None

def pitch_number(name):
    names=('C','C#','D','D#','E','F','F#','G','G#','A','A#','B')
    note=name[:-1]; return names.index(note)+int(name[-1])*12

def main():
    global NOISE_TABLE
    NOISE_TABLE = noise_freq_table()
    headers=(UP/'audio'/'song_headers.inc.c').read_text()
    dynamic={}
    for output, header in SFX.items():
        match=re.search(rf'struct SongHeader {header}\s*=\s*\{{(.*?)\n\}};',headers,re.S)
        if not match: raise ValueError(f'Missing SongHeader {header}')
        body=match.group(1); midi=re.search(r'MIDI Sequence\s+\*/\s*(\w+)_mid',body).group(1)
        bank=int(re.search(r'INST_BANK_(\d+)',body).group(1)); volume=int(re.search(r'Volume\s+\*/\s*(\d+)',body).group(1))
        dynamic[output]=(f'{midi}.mid',bank,volume)
    songs={**SONGS,**dynamic}
    wanted=sys.argv[1:] or songs.keys(); banks=all_banks(); pcms,subs,psgs=pcm_map(); used=set()
    sample_table=json.loads((UP/'audio'/'sample_table.json').read_text())['samples']; sample_rates={}
    for out in wanted:
        filename,bank,volume=songs[out]; notes,loop_start_beats,loop_beats=parse_midi(filename)
        for event in notes:
            instrument=sample_for(bank,event['program'],event['note'],banks,pcms,subs,psgs)
            if instrument is not None and instrument['kind'] == 'pcm':
                sample=instrument['sample']; meta=sample_table[sample-1]
                if sample not in sample_rates:
                    with wave.open(str(UP/'audio'/'samples'/meta['sample'])) as wav: sample_rates[sample]=wav.getframerate()
                event.update(sample=sample,fixed=instrument['fixed'],playNote=instrument['playNote'],baseNote=pitch_number(meta['pitch']),sampleRate=sample_rates[sample])
                event.update({key:value for key,value in instrument.items() if key.startswith('adsr')})
                if 'loop' in meta: event['sampleLoop']=meta['loop']
                used.add(sample)
            elif instrument is not None and instrument['kind'] == 'psg':
                apply_psg(event, instrument, event['note'])
            else:
                entry=banks.get(bank,[])[event['program']] if event['program'] < len(banks.get(bank,[])) else None
                if entry and entry[0] == 'psg':
                    apply_psg(event, psgs.get(entry[1], {}), event['note'])
        payload={'volume':volume,'events':notes}
        if loop_beats:
            payload['loopStartBeats']=loop_start_beats
            payload['loopBeats']=loop_beats
        (OUT/f'{out}.json').write_text(json.dumps(payload,separators=(',',':')))
        print(out,len(notes),sum('sample' in n for n in notes))
    (OUT/'samples').mkdir(exist_ok=True)
    for sample in used: shutil.copy2(UP/'audio'/'samples'/f'sample_{sample:03d}.wav',OUT/'samples'/f'sample_{sample:03d}.wav')

if __name__ == '__main__': main()
