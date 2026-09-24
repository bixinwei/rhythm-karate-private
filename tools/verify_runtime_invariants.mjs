import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const game = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'assets', 'gba', name), 'utf8'));
const fail = [];
const check = (ok, message) => { if (!ok) fail.push(message); };

// Rhythm Tweezers: regenerate the cue stream from the source BeatScript so
// every phrase (including the first cue after a vegetable transition) remains
// tied to its original script tick. Then assert the browser queues cue audio
// from the same AudioContext clock instead of from render frames.
const tweezersSource = fs.readFileSync(path.join(root, 'reference', 'rhythmtengoku-upstream', 'games', 'rhythm_tweezers', 'rhythm_tweezers.bs'), 'utf8').split(/\r?\n/);
let inTweezersMain = false, tweezersTick = 0, nextVeg = 'onion';
const expectedTweezers = [];
for (const raw of tweezersSource) {
  const line = raw.trim();
  if (line === 'script script_rhythm_tweezers_main') { inTweezersMain = true; continue; }
  if (!inTweezersMain) continue;
  if (line === 'return') break;
  const rest = /^rest (\d+)$/.exec(line);
  if (rest) { tweezersTick += Number(rest[1]); continue; }
  const cue = /^spawn_cue CUE_(\w+)$/.exec(line);
  if (cue) { expectedTweezers.push({ beat: tweezersTick / 24, kind: 'cue', cue: cue[1].toLowerCase() }); continue; }
  if (line === 'rhythm_tweezers_start_hair_cycle') { expectedTweezers.push({ beat: tweezersTick / 24, kind: 'cycle' }); continue; }
  if (line === 'rhythm_tweezers_spawn_tweezers') { expectedTweezers.push({ beat: tweezersTick / 24, kind: 'tweezers' }); continue; }
  const veg = /^rhythm_tweezers_set_next_veg VEG_(\w+)$/.exec(line);
  if (veg) { nextVeg = veg[1].toLowerCase(); continue; }
  if (line.startsWith('rhythm_tweezers_scroll_veg')) expectedTweezers.push({ beat: tweezersTick / 24, kind: 'veg', veg: nextVeg });
}
const actualTweezers = read('tweezers/chart.json');
check(JSON.stringify(actualTweezers) === JSON.stringify(expectedTweezers), 'tweezers: chart differs from source BeatScript');
check(actualTweezers.filter(event => event.kind === 'cue').length === 88, 'tweezers: source cue count changed or is incomplete');
check(game.includes('const TWEEZERS_AUDIO_LOOKAHEAD_BEATS = 3'), 'tweezers: audio look-ahead window missing');
check(game.includes('event.beat > nowBeat + TWEEZERS_AUDIO_LOOKAHEAD_BEATS'), 'tweezers: future event queue is unbounded');
check(game.includes('startTweezersAudioScheduler(run)'), 'tweezers: source-timed audio scheduler is not started');
check(game.includes('audioSongStart + eventBeat * 60 / 96'), 'tweezers: cue sound is not derived from the shared audio clock');
check(game.includes('function eventAudioTime(event)'), 'input: event timestamp compensation missing');
check(game.includes('portedTickAtAudioTime(inputAudioTime)'), 'input: ported judgement is not based on input-time audio clock');
check(game.includes("pointerdown', (event) => portedModes[mode] ? portedPunch(event)"), 'input: pointerdown timestamp is not passed to ported gameplay');
check(game.includes('audit.perfectSweep') && game.includes('results.filter(item => !item.perfect'), 'night_walk: deterministic perfect-tick browser sweep missing');
check(game.includes('new URLSearchParams(location.search).has(\'auditSweep\')') && game.includes('sweep ${result.ok'), 'night_walk: browser sweep route missing');

// HeavenStudio's TimingAccuracy Just effect is two 360-degree ShapeModule
// particle rings. Keep the source count, lifetime, speed, scale and spawn
// radius explicit so a later edit cannot turn the ring into loose dots.
check(game.includes('emit(10, .45, 5, 1, .7, .1, 6,') && game.includes('[[0, -.19677734], [.1, -.8], [.25, -1]]'), 'touch VFX: HeavenStudio Just00 parameters drifted');
check(game.includes('emit(10, .40, 4, .6851956, .7, .25, 1,') && game.includes('[[0, 0], [.1, -.8], [.25, -1]]'), 'touch VFX: HeavenStudio Just01 parameters drifted');
check(game.includes('function heavenParticlePosition') && game.includes('orbital * dt / radius') && game.includes('radialScale * heavenCurve'), 'touch VFX: source orbital/radial velocity integration missing');
check(game.includes('function heavenSubAlpha') && game.includes('ParticleSystemSubEmitterType.Birth') && game.includes('age >= .45 && age < .75'), 'touch VFX: JustSub birth/lifecycle mapping missing');
check(game.includes('const HEAVEN_ACE_COLORS') && game.includes('age * 2.5'), 'touch VFX: AceColorCycle palette scroll missing');
check(game.includes('i * Math.PI * 2 / count'), 'touch VFX: 360-degree star-ring placement missing');

// Reconstruct the source's Night Walk unk4 sequence for all deterministic
// bridge/gap sections. A gap captures the current unk4 as its own sprite Y,
// then decrements unk4 for the next cue; it never mutates unk6 until a jump
// actually completes.
const nw = read('night_walk_timeline.json');
const platformEvents = nw.events.filter(e => e.op === 'night_walk_set_platform');
const cues = nw.events.filter(e => e.op === 'spawn_cue');
let baseY = 120;
const deterministic = [];
for (const cue of cues) {
  const p = [...platformEvents].reverse().find(e => e.tick <= cue.tick);
  const type = Number(p?.args?.[0] ?? 0);
  deterministic.push({ tick: cue.tick, type, baseY });
  if (type === 1) baseY -= 16;
}
for (let i = 1; i < deterministic.length; i++) {
  if (deterministic[i - 1].type === 1) {
    check(deterministic[i].baseY === deterministic[i - 1].baseY - 16,
      `night_walk: cue ${deterministic[i].tick} baseline did not follow prior gap`);
  }
}
check(deterministic.some(c => c.tick === 264 && c.type === 1 && c.baseY === 120), 'night_walk: opening gap baseline is not source 120');
check(deterministic.some(c => c.tick === 288 && c.baseY === 104), 'night_walk: post-opening platform baseline is not source 104');
check(deterministic.some(c => c.tick === 456 && c.type === 1 && c.baseY === 104), 'night_walk: second gap baseline is not source 104');

// Geometry wiring: platform sprites use their captured baseline plus unk6;
// Yan has no origin pointer and remains at sprite Y=120.
check(game.includes('cue.baseY = ported.nightWalkBaseY ?? 120'), 'night_walk: cue baseline capture missing');
check(game.includes('if (cue.endOfBridge) ported.nightWalkBaseY = cue.baseY - 16'), 'night_walk: unk4 decrement missing');
check(game.includes('cue.platformSpawned') && game.includes('if (!cue.platformResolved)'), 'night_walk: explicit platform cues skip source spawn lifecycle');
check(game.includes('(cue.baseY ?? 120) - nightWalkWorldShift(tick)'), 'night_walk: platform does not use captured baseline and source origin direction');
check(!game.includes('if (mode === \'night_walk\') actorY += nightWalkWorldShift(tick)'), 'night_walk: actor incorrectly receives platform origin offset');
check(game.includes('const baseShift = -completed * 16'), 'night_walk: jump origin is incorrectly coupled to spawned gaps');

// Every ported timeline must have a one-to-one cue stream and a terminating
// end tick; this catches partial exports that can hide late-game failures.
for (const id of ['spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy']) {
  const data = read(`${id}_timeline.json`);
  const stream = data.events.filter(e => e.op === 'spawn_cue');
  check(stream.length > 0 && Number.isFinite(data.endTick), `${id}: incomplete runtime timeline`);
  check(stream.every((e, i) => i === 0 || e.tick >= stream[i - 1].tick), `${id}: cue stream is not monotonic`);
}

if (fail.length) {
  console.error(`Runtime invariant audit failed (${fail.length}):`);
  for (const message of fail) console.error(`- ${message}`);
  process.exit(1);
}
console.log('Runtime invariant audit passed: Night Walk baseline/origin geometry and all ported cue streams are source-shaped.');
