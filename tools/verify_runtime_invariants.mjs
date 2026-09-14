import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const game = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'assets', 'gba', name), 'utf8'));
const fail = [];
const check = (ok, message) => { if (!ok) fail.push(message); };

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
