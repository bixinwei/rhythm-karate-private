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
const TIMED_OPS = new Set(['spawn_cue', 'print_text_f', 'clear_text_f', 'set_tempo', 'set_music_volume', 'mod_music_volume', 'play_music']);
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

// --- Read the browser's hand-written tables ---------------------------------
const section = (start, end) => {
  const from = game.indexOf(start);
  const to = game.indexOf(end, from);
  check(from >= 0 && to > from, `game.js: cannot locate ${start}`);
  return from < 0 ? '' : game.slice(from, to);
};
const portSpawns = [...section('const spawnChart = [', 'const chart =').matchAll(/\[(\d+)\s*,\s*'(\w+)'\]/g)].map(m => ({ beat: Number(m[1]), type: m[2] }));
const portWarnings = [...section('const cueWarnings = [', 'const SONG_END').matchAll(/\{\s*beat:\s*(\d+),\s*id:\s*(\d+),\s*duration:\s*([\d.]+)\s*\}/g)].map(m => ({ beat: Number(m[1]), id: Number(m[2]), duration: Number(m[3]) }));
const portTempos = [...section('const tempoSegments = [', 'function elapsedForBeat').matchAll(/\{\s*from:\s*(\d+),\s*bpm:\s*(\d+)\s*\}/g)].map(m => ({ beat: Number(m[1]), bpm: Number(m[2]) }));
const portVolumes = [...section('const karateMusicVolumeEvents = [', 'function karateMusicVolumeAt').matchAll(/\{\s*beat:\s*(\d+),\s*(?:value:\s*(\d+)|rampTo:\s*(\d+),\s*span:\s*(\d+))\s*\}/g)]
  .map(m => m[2] != null ? { beat: Number(m[1]), value: Number(m[2]) } : { beat: Number(m[1]), rampTo: Number(m[3]), span: Number(m[4]) });
const portSongEnd = Number(/const SONG_END = (\d+)/.exec(game)?.[1]);
const portFanBeat = Number(/scheduleOriginalMusic\(originalFanEvents,\s*(\d+)\)/.exec(game)?.[1]);
const portAnimations = {};
for (const match of section('const KARATE_ANIMATIONS = {', '};').matchAll(/(\w+):\s*(\[\[[\s\S]*?\]\])/g)) {
  portAnimations[match[1]] = [...match[2].matchAll(/\[(\d+),\s*(\d+)\]/g)].map(frame => [Number(frame[1]), Number(frame[2])]);
}

// --- Cue chart, warnings, tempo and script volume must match the source -----
check(portSpawns.length === sourceSpawns.length && sourceSpawns.every((cue, index) => cue.beat === portSpawns[index]?.beat && cue.type === portSpawns[index]?.type),
  `karate: spawn chart differs from karate_man.bs\n    source ${show(sourceSpawns)}\n    game.js ${show(portSpawns)}`);
check(sourceWarnings.every((warning, index) => warning.beat === portWarnings[index]?.beat && warning.id === portWarnings[index]?.id && Math.abs(warning.duration - portWarnings[index]?.duration) < 1e-6),
  `karate: print_text_f warnings differ from karate_man.bs\n    source ${show(sourceWarnings)}\n    game.js ${show(portWarnings)}`);
check(sourceTempos.every((tempo, index) => tempo.beat === portTempos[index]?.beat && tempo.bpm === portTempos[index]?.bpm),
  `karate: tempo segments differ from karate_man.bs\n    source ${show(sourceTempos)}\n    game.js ${show(portTempos)}`);
check(sourceVolumes.every((volume, index) => volume.beat === portVolumes[index]?.beat && volume.value === portVolumes[index]?.value && volume.rampTo === portVolumes[index]?.rampTo && volume.span === portVolumes[index]?.span),
  `karate: music volume automation differs from karate_man.bs\n    source ${show(sourceVolumes)}\n    game.js ${show(portVolumes)}`);
check(portSongEnd === sourceEndTick / 24, `karate: SONG_END ${portSongEnd} must be the script's final tick ${sourceEndTick} (${sourceEndTick / 24} beats)`);
check(portFanBeat === sourceFanBeat, `karate: s_karate_fan starts at beat ${portFanBeat}, script plays it at ${sourceFanBeat}`);

// The script's Cue definitions all last 0x18 ticks, i.e. exactly one beat, so
// the browser chart must spawn one beat before each required punch.
const engine = fs.readFileSync(path.join(upstream, 'games/karate_man/engine.c'), 'utf8');
const durations = [...engine.matchAll(/\/\* Total Duration {2}\*\/ (0x[0-9A-Fa-f]+|\d+)/g)].map(m => Number(m[1]));
check(durations.length > 0 && durations.every(value => value === 0x18), `karate: cue durations in engine.c are not all 0x18 (${show(durations)})`);
check(/const TRAVEL_BEATS = 1;/.test(game) && /const chart = spawnChart\.map\(\(\[spawnBeat, type\]\) => \[spawnBeat \+ 1, type\]\)/.test(game),
  'karate: the cue chart no longer turns each 0x18-tick spawn into the punch one beat later');

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

if (failures.length) {
  console.error(`Karate script audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Karate script audit passed: ${sourceSpawns.length} cues, ${sourceWarnings.length} warning cels, ${sourceTempos.length} tempo segments, ${Object.keys(SOURCE_ANIMATIONS).length} cel animations and ${Object.keys(KARATE_SFX).length} audio sequences match the decomp.`);
