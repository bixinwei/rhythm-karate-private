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

// Source cue definitions use these exact total durations (ticks). Keep the
// browser configuration from silently drifting during later visual tweaks.
check(game.includes('CUE_FIRST:24') && game.includes('CUE_SECOND:24'), 'samurai: cue duration differs from source');
check(game.includes('CUE_KICK:192') && game.includes('CUE_STAR_WAND:192'), 'night_walk: cue duration differs from source');
check(game.includes('CUE_LOW_FAST:12') && game.includes('CUE_HIGH:48'), 'spaceball: cue duration differs from source');
check(game.includes('const arcFrames = framesBetweenTicks(cue.spawn, cue.hit)') && game.includes('const landingFrames = 2 * arcFrames'), 'spaceball: flight must use ticks_to_frames-equivalent frame math');
const karateSpawns = [...game.matchAll(/spawnChart\s*=\s*\[/g)].length;
check(karateSpawns === 1 && game.includes('[14,\'pot\']') && game.includes('[153,\'rock\']'), 'karate: spawn chart missing or truncated');

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
check(game.includes('192 * 150'), 'samurai: movement is not using source 0xC0 lifetime');
check(game.includes('hop = 24 * 4 * phase * (1-phase)'), 'samurai: func_08031c68 parabola factor missing');
check(game.includes('const spawnTempo = tempoAtTick(cue.visualSpawn)') && game.includes('192 * 150'), 'samurai: movement lifetime must lock spawn tempo');
check(game.includes('event02') && game.includes('expectedSpawnTick'), 'samurai: event02-to-cue resolver missing');
check(game.includes('samuraiSpawns.find(item => item.tick === expectedSpawnTick)') && !game.includes('samuraiSpawns.filter(item => item.tick <= event.tick)'), 'samurai: visual spawn must use exact event02 pairing');
check(game.includes('tempoAtTick(event.tick)/120'), 'samurai: phrase SFX tempo conversion mismatch');

// Night Walk: gap jumps are the only operation allowed to move the shared
// world origin; ordinary jumps must remain actor-only.
check(game.includes('if (!cue.endOfBridge || cue.state !== \'hit\''), 'night_walk: jump world-offset guard missing');
check(game.includes('return -completed * 16'), 'night_walk: shared origin sign does not match GBA');
check(game.includes('const y = 120 + nightWalkWorldShift(tick)'), 'night_walk: bridge does not use shared origin');
check(game.includes('signedFramesBetweenTicks') && game.includes('timingOffset'), 'night_walk: jump timing offset is not applied');
check(game.includes('framesBetweenTicks(cue.hit, cue.hit + 20) - timingOffset') && game.includes('framesBetweenTicks(actionBase, actionBase + 20) - actionOffset'), 'night_walk: jump timing offset sign differs from source');
check(game.includes('192 + fadeTicks + 48'), 'night_walk: end script duration is shorter than source');
check(game.includes('framesBetweenTicks(ported.failedAt + 192, tick) / 12'), 'night_walk: screen fade phase missing');
check(game.includes('function gbaRandom(max)') && game.includes('gbaRandom(4) === 0'), 'night_walk: random platform does not use GBA LCG semantics');
check(game.includes('night_walk_init_balloons') && game.includes('ported.balloons.push') && game.includes('balloon.palette * 1000'), 'night_walk: balloon palette namespaces are not applied');
check(game.includes('drawPortedCell(92 + balloon.palette * 1000, balloon.x, balloon.y, 4)') && game.includes('framesBetweenTicks(pop.tick, tick) >= 2'), 'night_walk: balloon pop cel/lifetime missing');

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
