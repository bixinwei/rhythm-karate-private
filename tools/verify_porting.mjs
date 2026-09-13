import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets', 'gba');
const game = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const readJson = name => JSON.parse(fs.readFileSync(path.join(assets, name), 'utf8'));
const timeline = id => readJson(`${id}_timeline.json`);
const events = (data, op) => data.events.filter(event => event.op === op);

// Every ported game must have a deterministic timeline and at least one music
// start. This catches incomplete exports before a browser run.
for (const id of ['spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy']) {
  const data = timeline(id);
  check(Number.isFinite(data.endTick) && data.endTick > 0, `${id}: invalid endTick`);
  check(events(data, 'spawn_cue').length > 0, `${id}: no spawn_cue events`);
  check(events(data, 'play_music').length > 0, `${id}: no play_music events`);
  check(events(data, 'set_tempo').length > 0, `${id}: no set_tempo events`);
}

// Samurai Slice: every demon-create event is paired with the following cue
// after exactly five beats (120 ticks), as in the original BeatScript.
const samurai = timeline('samurai_slice');
const samuraiCreate = events(samurai, 'samurai_slice_event02');
const samuraiCues = events(samurai, 'spawn_cue');
check(samuraiCreate.length === samuraiCues.length, `samurai: ${samuraiCreate.length} event02 vs ${samuraiCues.length} cues`);
for (let i = 0; i < Math.min(samuraiCreate.length, samuraiCues.length); i++) {
  check(samuraiCues[i].tick - samuraiCreate[i].tick === 120, `samurai: pair ${i} offset ${samuraiCues[i].tick - samuraiCreate[i].tick}, expected 120`);
}
check(game.includes('cue.visualSpawn + 192'), 'samurai: movement is not using source 0xC0 lifetime');
check(game.includes('event02') && game.includes('expectedSpawnTick'), 'samurai: event02-to-cue resolver missing');

// Night Walk: gap jumps are the only operation allowed to move the shared
// world origin; ordinary jumps must remain actor-only.
check(game.includes('if (!cue.endOfBridge || cue.state !== \'hit\''), 'night_walk: jump world-offset guard missing');
check(game.includes('return -completed * 16'), 'night_walk: shared origin sign does not match GBA');
check(game.includes('const y = 120 + nightWalkWorldShift(tick)'), 'night_walk: bridge does not use shared origin');

// Verify every configured music/SFX JSON exists, preventing silent cues.
for (const match of game.matchAll(/music:\s*\[((?:.|\n)*?)\],\s*sfx:\s*\{([^}]*)\}/g)) {
  const names = [...match[1].matchAll(/'([^']+_events)'/g), ...match[2].matchAll(/'([^']+_events)'/g)].map(m => m[1]);
  for (const name of names) check(fs.existsSync(path.join(assets, `${name}.json`)), `missing audio asset ${name}.json`);
}

if (failures.length) {
  console.error(`Porting audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Porting audit passed: timelines, Samurai pair offsets, Night Walk world-offset guards, and configured audio assets.');
