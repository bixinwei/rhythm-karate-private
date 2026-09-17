import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Karate Man is the one level whose script is expanded by hand in game.js.
// This audit re-expands games/karate_man/karate_man.bs, then compares the
// browser's tables (cue chart, warning cels, tempo segments, script music
// volume, Joe's cel animations) and every Karate audio asset against it, so a
// hand edit or a partial re-export cannot silently drift away from the ROM.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'reference', 'rhythmtengoku-upstream');
const assets = path.join(root, 'assets', 'gba');
const game = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const show = value => JSON.stringify(value);

// --- Expand script_karate_man_main exactly as the engine does ---------------
const scripts = new Map();
{
  const lines = fs.readFileSync(path.join(upstream, 'games/karate_man/karate_man.bs'), 'utf8').split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/@.*$/, '').trim();
    if (!line) continue;
    const script = /^script\s+(\S+)/.exec(line);
    if (script) { current = script[1]; scripts.set(current, []); continue; }
    if (/^\.end\b/.test(line)) { current = null; continue; }
    if (current) scripts.get(current).push(line);
  }
}
const TIMED_OPS = new Set(['spawn_cue', 'print_text_f', 'clear_text_f', 'set_tempo', 'set_music_volume', 'mod_music_volume', 'beat_anim', 'play_music']);
const timeline = [];
let tick = 0;
const walk = (name) => {
  const body = scripts.get(name);
  if (!body) throw new Error(`karate_man.bs has no script ${name}`);
  for (const line of body) {
    const head = line.split(/\s+/)[0];
    const rest = line.slice(head.length).trim();
    if (head === 'rest') { tick += Number(rest); continue; }
    if (TIMED_OPS.has(head)) { timeline.push({ tick, op: head, arg: rest }); continue; }
    if (head === 'call') { walk(rest); continue; }
    if (head === 'goto') { walk(rest); return; }
    if (head === 'return') return;
  }
};
walk('script_karate_man_main');
const sourceEndTick = tick;

const CUE_TYPES = { CUE_POT: 'pot', CUE_ROCK: 'rock', CUE_SOCCER_BALL: 'football', CUE_LIGHT_BULB: 'bulb', CUE_BOMB: 'bomb' };
const sourceSpawns = timeline.filter(e => e.op === 'spawn_cue').map(e => ({ beat: e.tick / 24, type: CUE_TYPES[e.arg] ?? e.arg.toLowerCase() }));
const sourceWarnings = timeline.filter(e => e.op === 'print_text_f').map(e => {
  const clear = timeline.find(next => next.op === 'clear_text_f' && next.tick > e.tick);
  return { beat: e.tick / 24, id: Number(e.arg), duration: (clear.tick - e.tick) / 24 };
});
const sourceTempos = timeline.filter(e => e.op === 'set_tempo').map(e => ({ beat: e.tick / 24, bpm: Number(e.arg) }));
const sourceVolumes = timeline.filter(e => e.op === 'set_music_volume' || e.op === 'mod_music_volume').map(e => {
  const [first, second] = e.arg.split(',').map(part => Number(part.trim()));
  return e.op === 'set_music_volume' ? { beat: e.tick / 24, value: first } : { beat: e.tick / 24, rampTo: first, span: second / 24 };
});
const sourceFanBeat = timeline.filter(e => e.op === 'play_music')[1]?.tick / 24;

// --- The committed timeline must agree with a fresh expansion ---------------
const section = (start, end) => {
  const from = game.indexOf(start);
  const to = game.indexOf(end, from);
  check(from >= 0 && to > from, `game.js: cannot locate ${start}`);
  return from < 0 ? '' : game.slice(from, to);
};
const karateTimeline = JSON.parse(fs.readFileSync(path.join(assets, 'karate_man_timeline.json'), 'utf8'));
const timelineEvents = karateTimeline.events;
// The ending tail is fade_music_out + fade_screen_out + two rests; fades do not
// consume script time, so the script ends 48 ticks after the main script.
const TAIL_TICKS = 48;
check(karateTimeline.entry === 'script_karate_man_main', `karate: timeline entry is ${karateTimeline.entry}`);
check(karateTimeline.endTick === sourceEndTick + TAIL_TICKS,
  `karate: timeline endTick ${karateTimeline.endTick} should be the main script end ${sourceEndTick} + ${TAIL_TICKS}`);
const portSpawns = timelineEvents.filter(e => e.op === 'spawn_cue').map(e => ({ beat: e.tick / 24, type: CUE_TYPES[e.args[0]] ?? String(e.args[0]).toLowerCase() }));
const portWarnings = timelineEvents.filter(e => e.op === 'print_text_f').map(e => {
  const clear = timelineEvents.find(next => next.op === 'clear_text_f' && next.tick > e.tick);
  return { beat: e.tick / 24, id: Number(e.args[0]), duration: ((clear?.tick ?? e.tick + 24) - e.tick) / 24 };
});
const portTempos = timelineEvents.filter(e => e.op === 'set_tempo').map(e => ({ beat: e.tick / 24, bpm: Number(e.args[0]) }));
const portVolumes = timelineEvents.filter(e => ['set_music_volume', 'mod_music_volume', 'fade_music_out'].includes(e.op)).map(e => {
  const beat = e.tick / 24;
  if (e.op === 'set_music_volume') return { beat, value: Number(e.args[0]) };
  return e.op === 'mod_music_volume'
    ? { beat, rampTo: Number(e.args[0]), span: Number(e.args[1]) / 24 }
    : { beat, rampTo: 0, span: Number(e.args[0]) / 24 };
});
const portSongEnd = karateTimeline.endTick / 24;
const portFanBeat = timelineEvents.find(e => e.op === 'play_music' && String(e.args[0]).includes('karate_fan'))?.tick / 24;
const portAnimations = {};
for (const match of section('const KARATE_ANIMATIONS = {', '};').matchAll(/(\w+):\s*(\[\[[\s\S]*?\]\])/g)) {
  portAnimations[match[1]] = [...match[2].matchAll(/\[(\d+),\s*(\d+)\]/g)].map(frame => [Number(frame[1]), Number(frame[2])]);
}

// --- Cue chart, warnings, tempo and script volume must match the source -----
const sourceCueTypes = sourceSpawns.map(cue => cue.type);
check(portSpawns.length === sourceSpawns.length && sourceSpawns.every((cue, index) => cue.beat === portSpawns[index]?.beat && sourceCueTypes[index] === portSpawns[index]?.type),
  `karate: timeline cue chart differs from karate_man.bs\n    source ${show(sourceSpawns)}\n    timeline ${show(portSpawns)}`);
check(sourceWarnings.every((warning, index) => warning.beat === portWarnings[index]?.beat && warning.id === portWarnings[index]?.id && Math.abs(warning.duration - portWarnings[index]?.duration) < 1e-6),
  `karate: timeline print_text_f warnings differ from karate_man.bs\n    source ${show(sourceWarnings)}\n    timeline ${show(portWarnings)}`);
check(sourceTempos.every((tempo, index) => tempo.beat === portTempos[index]?.beat && tempo.bpm === portTempos[index]?.bpm),
  `karate: timeline tempo segments differ from karate_man.bs\n    source ${show(sourceTempos)}\n    timeline ${show(portTempos)}`);
check(sourceVolumes.every((volume, index) => volume.beat === portVolumes[index]?.beat && volume.value === portVolumes[index]?.value && volume.rampTo === portVolumes[index]?.rampTo && volume.span === portVolumes[index]?.span),
  `karate: timeline music volume automation differs from karate_man.bs\n    source ${show(sourceVolumes)}\n    timeline ${show(portVolumes)}`);
check(portVolumes.at(-1)?.rampTo === 0, 'karate: the timeline has no closing fade_music_out');
check(portSongEnd === (sourceEndTick + TAIL_TICKS) / 24, `karate: SONG_END ${portSongEnd} must be the script end ${(sourceEndTick + TAIL_TICKS) / 24} beats`);
check(portFanBeat === sourceFanBeat, `karate: s_karate_fan starts at beat ${portFanBeat}, script plays it at ${sourceFanBeat}`);
check(timelineEvents.some(e => e.op === 'fade_screen_out'), 'karate: the timeline has no fade_screen_out ending');
check(timelineEvents.filter(e => e.op === 'beat_anim').length === timeline.filter(e => e.op === 'beat_anim').length,
  'karate: the timeline beat_anim grid differs from the script');
check(game.includes("fetch('assets/gba/karate_man_timeline.json')") && game.includes('karateTimelineLoadPromise')
  && game.includes('karateBeatAnimTicks') && game.includes('karateScreenFadeAlpha(beat)'),
  'karate: game.js no longer derives its cue chart, beat_anim grid and ending fade from the timeline');
check(!game.includes('const spawnChart') && !game.includes('const cueWarnings') && !game.includes('const tempoSegments'),
  'karate: the hand-written script tables are back in game.js');

// --- Every level's timeline must carry its scene entry ending ---------------
for (const id of ['spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy']) {
  const data = JSON.parse(fs.readFileSync(path.join(assets, `${id}_timeline.json`), 'utf8'));
  const fadedMusic = data.events.filter(e => e.op === 'fade_music_out');
  const fadedScreen = data.events.filter(e => e.op === 'fade_screen_out');
  check(fadedMusic.length === 1 && fadedScreen.length === 1, `${id}: expected one fade_music_out and one fade_screen_out, found ${fadedMusic.length}/${fadedScreen.length}`);
  const lastGameplay = data.events.filter(e => e.op === 'spawn_cue').at(-1)?.tick ?? 0;
  check((fadedScreen[0]?.tick ?? 0) > lastGameplay, `${id}: the screen fade happens before the last cue`);
  check(data.endTick === (fadedScreen[0]?.tick ?? 0) + 48, `${id}: endTick ${data.endTick} should be the screen fade ${fadedScreen[0]?.tick} + 48 ticks of held black`);
}
check(game.includes("event.op === 'fade_music_out'") && game.includes('function portedScreenFade('),
  'game.js: the ported engine no longer applies the scripted music and screen fades');

// --- The ROM's software reverb must stay derived, not guessed ---------------
const reverbSource = fs.readFileSync(path.join(root, 'reverb-worklet.js'), 'utf8');
check(fs.existsSync(path.join(root, 'reverb-worklet.js')), 'missing reverb-worklet.js');
// midi.h: AUDIO_SAMPLE_RATE / DMA_SAMPLE_BUFFER_SIZE; psg.c/player.c: gameplay_set_reverb
// -> midi_player_set_reverb(clamp(level + 35, 0, 127), 2, 2, 4).
check(/const ROM_SAMPLE_RATE = 13379;/.test(reverbSource) && /const ROM_RING_SAMPLES = 1568;/.test(reverbSource),
  'reverb-worklet.js: the ring no longer uses AUDIO_SAMPLE_RATE 13379 and the 1568-sample DMA buffer');
check(/const ROM_POLE_DECAY = 2;/.test(reverbSource) && /const ROM_WET_SHIFT = 2;/.test(reverbSource) && /const ROM_SCRATCH_TO_SAMPLE = 128;/.test(reverbSource),
  'reverb-worklet.js: lowCut/decay/wet shift or the gMidiSampleTable scaling changed');
check(/this\.pole \* this\.low\[index\] \+ delayed/.test(reverbSource) && /delayed - alpha \* low/.test(reverbSource)
  && /this\.pole \* this\.accumulator\[index\] \+ highPassed/.test(reverbSource) && /ring\[this\.position\] = dry \+ wetSample;/.test(reverbSource),
  'reverb-worklet.js: the two one-pole sections or the dry+wet ring feedback changed');
const scriptReverb = [...fs.readFileSync(path.join(upstream, 'games/karate_man/karate_man.bs'), 'utf8')
  .matchAll(/run gameplay_set_reverb,\s*(\d+)/g)].map(match => ({ level: Number(match[1]) }));
const timelineReverb = timelineEvents.filter(e => e.op === 'run' && e.args[0] === 'gameplay_set_reverb')
  .map(e => ({ tick: e.tick, level: Number(e.args[1]) }));
check(timelineReverb.length === scriptReverb.length && scriptReverb.every((entry, index) => entry.level === timelineReverb[index]?.level),
  `karate: gameplay_set_reverb events differ from the script (${show(scriptReverb)} vs ${show(timelineReverb)})`);
check(timelineReverb.some(entry => entry.level === 40) && timelineReverb.at(-1)?.level === 0,
  'karate: the finale no longer enables the reverb and switches it off again');
check(game.includes('karateReverbEvents') && game.includes('setReverbLevel(karateReverbEvents') && game.includes('connect(master())'),
  'game.js: the reverb is not driven by the timeline or voices bypass the master bus');

// --- Every script text box must have a port string --------------------------
// The ROM prints these with its text printer (1bpp glyphs over a filled box, see
// text_printer_data.c), so the port renders the translated lines itself; the guard
// is that no timeline may reference a box the port does not know about.
const portStrings = new Set([...section('const TEXT_BOX_STRINGS = {', '};').matchAll(/(D_[0-9a-f]+):/g)].map(m => m[1]));
check(portStrings.size === 5, `game.js: expected 5 text-box strings, found ${portStrings.size}`);
const boxLayouts = section('const TEXT_BOX_LAYOUTS = {', '};');
for (const [id, centreX, y] of [['karate', '124', '32'], ['night_walk', '120', '40'], ['power_calligraphy', '128', '146']]) {
  check(boxLayouts.includes(`${id}: { centreX: ${centreX}, y: ${y}`), `game.js: ${id} text box is not anchored at (${centreX}, ${y})`);
}
const scriptBoxes = [];
for (const id of ['karate_man', 'spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy']) {
  const data = JSON.parse(fs.readFileSync(path.join(assets, `${id}_timeline.json`), 'utf8'));
  const opens = data.events.filter(e => /^(karate_man_print_textbox|print_text_[sf])$/.test(e.op));
  const closes = data.events.filter(e => /^(karate_man_clear_textbox|clear_text_[sf])$/.test(e.op));
  for (const event of opens) {
    const label = event.args[0];
    // karate's `print_text_f 1..4` are the warning cels, not text.
    if (/^D_/.test(label ?? '')) {
      check(portStrings.has(label), `${id}: text box ${label} has no ported string (game.js TEXT_BOX_STRINGS)`);
      scriptBoxes.push({ id, label, tick: event.tick });
    }
  }
  check(closes.length >= opens.filter(e => /^D_/.test(e.args[0] ?? '')).length, `${id}: a text box is never cleared`);
}
check(scriptBoxes.length === 5, `expected 5 scripted text boxes, found ${scriptBoxes.length} (${show(scriptBoxes)})`);
check(scriptBoxes.filter(box => box.id === 'karate_man').length === 1 && scriptBoxes.filter(box => box.id === 'night_walk').length === 3
  && scriptBoxes.filter(box => box.id === 'power_calligraphy').length === 1,
  `text boxes per level changed: ${show(scriptBoxes)}`);
check(game.includes('setActiveTextBox(') && game.includes('drawTextBox()') && game.includes('TEXT_BOX_FONT'),
  'game.js: the script text boxes are no longer drawn');

// The script's Cue definitions all last 0x18 ticks, i.e. exactly one beat, so
// the browser chart must spawn one beat before each required punch.
const engine = fs.readFileSync(path.join(upstream, 'games/karate_man/engine.c'), 'utf8');
const durations = [...engine.matchAll(/\/\* Total Duration {2}\*\/ (0x[0-9A-Fa-f]+|\d+)/g)].map(m => Number(m[1]));
check(durations.length > 0 && durations.every(value => value === 0x18), `karate: cue durations in engine.c are not all 0x18 (${show(durations)})`);
check(/const TRAVEL_BEATS = 1;/.test(game) && /\[event\.tick \/ 24 \+ TRAVEL_BEATS, KARATE_CUE_TYPES\[event\.args\[0\]\]/.test(game),
  'karate: the timeline cues no longer turn each 0x18-tick spawn into the punch one beat later');

// --- Joe's cel animations must be the decomp's animation tables -------------
const animSource = fs.readFileSync(path.join(upstream, 'games/karate_man/graphics/karate_man_anim.c'), 'utf8');
const SOURCE_ANIMATIONS = {
  stand: 'anim_karate_joe_stand', beat: 'anim_karate_joe_beat', punchLow: 'anim_karate_joe_punch_low',
  punchHigh: 'anim_karate_joe_punch_high', punchOuch: 'anim_karate_joe_punch_ouch', barely: 'anim_karate_joe_barely',
  miss: 'anim_karate_joe_miss', smirk: 'anim_karate_joe_smirk', happy: 'anim_karate_joe_happy'
};
for (const [name, symbol] of Object.entries(SOURCE_ANIMATIONS)) {
  const body = new RegExp(`struct Animation ${symbol}\\[\\] = \\{([\\s\\S]*?)\\n\\};`).exec(animSource)?.[1] ?? '';
  const frames = [...body.matchAll(/karate_man_cel(\d+),\s*(\d+)/g)].map(frame => [Number(frame[1]), Number(frame[2])]);
  check(frames.length > 0, `karate: cannot read ${symbol} from the decomp`);
  check(show(frames) === show(portAnimations[name]), `karate: ${name} cels differ from ${symbol}\n    source ${show(frames)}\n    game.js ${show(portAnimations[name])}`);
}
for (const cel of Object.values(portAnimations).flat().map(frame => frame[0])) {
  check(fs.existsSync(path.join(assets, `cel${String(cel).padStart(3, '0')}.png`)), `karate: animation uses missing cel${String(cel).padStart(3, '0')}.png`);
}

// --- Every Karate audio asset must keep its ROM sample and header volume ----
const headers = fs.readFileSync(path.join(upstream, 'audio/song_headers.inc.c'), 'utf8');
const headerVolume = name => {
  const body = new RegExp(`struct SongHeader ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(headers)?.[1];
  check(Boolean(body), `karate: SongHeader ${name} is missing from the decomp`);
  return Number(/Volume\s+\*\/\s*(\d+)/.exec(body ?? '')?.[1]);
};
const KARATE_SFX = {
  fly: 's_f_boxing_fly_nml_seqData', pot: 's_f_boxing_just_hati_seqData', rock: 's_f_boxing_just_rock_seqData',
  ball: 's_f_boxing_just_ball_seqData', bulb: 's_f_boxing_just_light_seqData', bomb: 's_f_boxing_just_bomb_seqData',
  normal: 's_f_boxing_normal_seqData', punch: 's_f_boxing_punch_seqData', barely: 's_witch_donats_seqData',
  hard: 's_f_boxing_hard_seqData', miss_voice: 's_f_boxing_v_nua_seqData',
  score_up: 's_f_boxing_score_up_seqData', score_down: 's_f_boxing_score_down_seqData'
};
const readEvents = name => {
  const file = path.join(assets, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { volume: payload.volume, events: payload.events ?? payload };
};
for (const [name, header] of Object.entries(KARATE_SFX)) {
  const payload = readEvents(`karate_${name}_events`);
  if (!payload) { check(false, `karate: missing assets/gba/karate_${name}_events.json`); continue; }
  check(payload.events.length > 0, `karate: karate_${name}_events.json has no notes`);
  check(payload.volume === headerVolume(header), `karate: karate_${name}_events.json volume ${payload.volume} must be SongHeader ${header} volume ${headerVolume(header)}`);
  for (const event of payload.events) {
    check(Number.isFinite(event.sample) || event.wave, `karate: karate_${name}_events.json has a note without sample/wave (program ${event.program})`);
    if (Number.isFinite(event.sample)) check(fs.existsSync(path.join(assets, 'samples', `sample_${String(event.sample).padStart(3, '0')}.wav`)), `karate: missing PCM sample ${event.sample} for ${name}`);
  }
}
// The music tracks are written by export_karate_midi.py and only afterwards get
// their bank-47/50 PCM mapping.  Losing that step silences the whole level.
for (const name of ['karate_bgm_events', 'karate_fan_events']) {
  const payload = readEvents(name);
  check(Boolean(payload), `karate: missing assets/gba/${name}.json`);
  const orphan = payload?.events.filter(event => !Number.isFinite(event.sample) && !event.wave).length ?? 0;
  check(orphan === 0, `karate: ${orphan} notes in ${name}.json have no PCM sample - run tools/export_karate_bgm_samples.py`);
}

// --- PSG noise voices must keep the ROM's SOUND4CNT_L register --------------
const noiseTable = (() => {
  const body = /midi_psg_noise_freq_table\[\]\s*=\s*\{([\s\S]*?)\};/.exec(
    fs.readFileSync(path.join(upstream, 'data/lib_midi_data.c'), 'utf8'))?.[1] ?? '';
  return [...body.matchAll(/0x([0-9A-Fa-f]{2})/g)].map(match => Number.parseInt(match[1], 16));
})();
check(noiseTable.length === 60, `karate: expected 60 entries in midi_psg_noise_freq_table, found ${noiseTable.length}`);
const bomb = readEvents('karate_bomb_events');
const noiseNotes = bomb?.events.filter(event => event.wave === 'noise') ?? [];
check(noiseNotes.length === 1, `karate: the bomb's PSG noise program should export exactly one noise voice, found ${noiseNotes.length}`);
for (const note of noiseNotes) {
  // midi_psg_update_id(): noise = clamp(key, 21, 80); register = table[key - 21].
  const expected = noiseTable[Math.max(21, Math.min(80, note.note)) - 21];
  check(note.noiseRegister === expected, `karate: bomb noise register ${note.noiseRegister} != table[${note.note}] = ${expected}`);
}
check(!bomb?.events.some(event => event.wave === 'square' && event.program === 45),
  'karate: the bomb PSG noise program is still rendered as a square wave');
check(/function gbaNoiseBuffer\(/.test(game) && /GBA_NOISE_DIVIDERS/.test(game) && /524288 \/ divider/.test(game),
  'karate: the GBA noise channel LFSR is missing from the browser voice path');

// --- Background palette row 4 follows karate_flow_palette_low/high ----------
const flowLow = /u8 karate_flow_palette_low\[\]\s*=\s*\{([^}]*)\}/.exec(engine)?.[1].split(',').map(part => Number(part.trim())) ?? [];
const flowHigh = /u8 karate_flow_palette_high\[\]\s*=\s*\{([^}]*)\}/.exec(engine)?.[1].split(',').map(part => Number(part.trim())) ?? [];
check(flowLow[0] === 5, `karate: karate_flow_palette_low starts with ${flowLow[0]}, expected palette 5`);
check(flowHigh[0] === 6 && flowHigh[1] === 7, `karate: karate_flow_palette_high is ${show(flowHigh.slice(0, 3))}, expected 6, 7, -1`);
check(/BG_PALETTE_BUFFER\(p\)\s+\(\(u16 \*\)D_03004b10\.bgPalette\)\s+\+ \(\(u32\)\(\(p\) \* 16\)\)/.test(fs.readFileSync(path.join(upstream, 'include/graphics.h'), 'utf8')),
  'karate: BG_PALETTE_BUFFER no longer selects a 16-colour palette row');
for (const name of ['low', 'high_a', 'high_b']) {
  check(fs.existsSync(path.join(assets, `karate_man_stage_${name}.png`)), `karate: missing assets/gba/karate_man_stage_${name}.png (run tools/export_karate_frames.py)`);
}
check(!fs.existsSync(path.join(assets, 'karate_man_stage.png')),
  'karate: karate_man_stage.png renders palette 4, which karate_init_gfx3() overwrites before the first frame');
check(game.includes('karateStages[karateStagePalette]') && game.includes("karateStagePalette = karateStagePalette === 'high_a' ? 'high_b' : 'high_a'"),
  'karate: the stage does not alternate the High Flow palettes every beat_anim');
check(game.includes("if (flowLevel <= 2) { karateStagePalette = 'low'; return; }"),
  'karate: the stage does not fall back to the Low Flow palette');

// --- Karate music must not be inserted as one whole-song batch --------------
check(game.includes('KARATE_AUDIO_LOOKAHEAD_BEATS') && game.includes('function scheduleKarateMusic()') && game.includes('startKarateAudioScheduler(run)'),
  'karate: music is no longer scheduled through the audio-clock look-ahead queue');
check(!game.includes('function scheduleOriginalMusic(') && !game.includes('scheduleOriginalBgm('),
  'karate: the whole song is still handed to Web Audio in one call');

if (failures.length) {
  console.error(`Karate script audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Karate script audit passed: ${sourceSpawns.length} cues, ${sourceWarnings.length} warning cels, ${sourceTempos.length} tempo segments, ${Object.keys(SOURCE_ANIMATIONS).length} cel animations and ${Object.keys(KARATE_SFX).length} audio sequences match the decomp.`);
