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
check(game.includes('function resetSpaceballStar(index, zoom)') && game.includes('updateSpaceballStars(zoom)') && game.includes('star.z -= 8 / 256'), 'spaceball: stars are not persistent GBA z-lifecycle objects');
check(game.includes('drawPortedCell(27, 120 + star.x * scale, 80 + star.y * scale, 4 * scale)'), 'spaceball: star affine scale is not derived from z');
check(game.includes('drawSpaceballEntity(poof,34,52,0,zoom)') && game.includes('drawSpaceballEntity(poof,2,52,0,zoom)'), 'spaceball: landing poofs do not share source entity transform');
const karateSpawns = [...game.matchAll(/spawnChart\s*=\s*\[/g)].length;
check(karateSpawns === 1 && game.includes('[14,\'pot\']') && game.includes('[153,\'rock\']'), 'karate: spawn chart missing or truncated');

// Every ported game must have a deterministic timeline and at least one music
// start. This catches incomplete exports before a browser run.
for (const id of ['spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy']) {
  const data = timeline(id);
  check(data.events.every((event, index) => index === 0 || event.tick >= data.events[index - 1].tick), `${id}: timeline events are not sorted by tick`);
  check(Number.isFinite(data.endTick) && data.endTick > 0, `${id}: invalid endTick`);
  check(events(data, 'spawn_cue').length > 0, `${id}: no spawn_cue events`);
  check(events(data, 'play_music').length > 0, `${id}: no play_music events`);
  check(events(data, 'set_tempo').length > 0, `${id}: no set_tempo events`);
  check(events(data, 'set_tempo').every(event => Number.isFinite(Number(event.args[0])) && Number(event.args[0]) > 0), `${id}: invalid tempo value`);
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
const samuraiResultEvents = events(samurai, 'samurai_slice_event06');
check(samuraiResultEvents.length === 4 && samuraiResultEvents.every((event, i) => Number(event.args[0]) === i + 1), 'samurai: result-phase event06 sequence differs from source');
check(samuraiResultEvents[0]?.tick > samuraiCues.at(-1)?.tick, 'samurai: result-phase event06 begins before final gameplay cue');

// Night Walk: gap jumps are the only operation allowed to move the shared
// world origin; ordinary jumps must remain actor-only.
check(game.includes('if (!cue.endOfBridge || cue.state !== \'hit\''), 'night_walk: jump world-offset guard missing');
check(game.includes('return -completed * 16'), 'night_walk: shared origin sign does not match GBA');
check(game.includes('const y = 120 + nightWalkWorldShift(tick)'), 'night_walk: bridge does not use shared origin');
check(game.includes('signedFramesBetweenTicks') && game.includes('timingOffset'), 'night_walk: jump timing offset is not applied');
check(game.includes('framesBetweenTicks(cue.hit, cue.hit + 20) - timingOffset') && game.includes('framesBetweenTicks(actionBase, actionBase + 20) - actionOffset'), 'night_walk: jump timing offset sign differs from source');
check(game.includes('const timingOffset = cue.actionTick - cue.hit') && game.includes('const actionOffset = ported.actionCue ? ported.actionAt - ported.actionCue.hit'), 'night_walk: hit offset must remain in source tick units');
check(game.includes('const hitOffsetTicks = (beat - hair.hitBeat) * 24'), 'tweezers: pull timing offset must use source tick units');
check(game.includes('tempoAtTick(event.tick) / 120') && game.includes('Calligraphy changes tempo mid-song'), 'calligraphy: timeline SFX ignore active tempo');
check(game.includes('192 + fadeTicks + 48'), 'night_walk: end script duration is shorter than source');
check(game.includes('framesBetweenTicks(ported.failedAt + 192, tick) / 12'), 'night_walk: screen fade phase missing');
check(game.includes('28 * fallFrames * (fallFrames + 1) / 2') && game.includes('actorY += Math.min(110'), 'night_walk: fall state does not advance yDistance');
check(game.includes("fall:'night_walk_fall_events'") && game.includes("playPortedSfx('fall', tick)"), 'night_walk: gap fall uses wrong SFX');
check(game.includes('function gbaRandom(max)') && game.includes('gbaRandom(4) === 0'), 'night_walk: random platform does not use GBA LCG semantics');
check(game.includes('night_walk_init_balloons') && game.includes('ported.balloons.push') && game.includes('balloon.palette * 1000'), 'night_walk: balloon palette namespaces are not applied');
check(game.includes('drawPortedCell(92 + balloon.palette * 1000, balloon.x, balloon.y, 4)') && game.includes('framesBetweenTicks(pop.tick, tick) >= 2'), 'night_walk: balloon pop cel/lifetime missing');
const nightManifest = readJson('night_walk/frames.json');
for (const palette of [1, 2, 3, 4]) for (const cel of [89, 90, 91, 92]) {
  check(nightManifest[String(cel + palette * 1000)] != null, `night_walk: missing exported palette cel ${cel + palette * 1000}`);
}

// Verify every configured music/SFX JSON exists, preventing silent cues.
for (const match of game.matchAll(/music:\s*\[((?:.|\n)*?)\],\s*sfx:\s*\{([^}]*)\}/g)) {
  const names = [...match[1].matchAll(/'([^']+_events)'/g), ...match[2].matchAll(/'([^']+_events)'/g)].map(m => m[1]);
  for (const name of names) {
    const file = path.join(assets, `${name}.json`);
    check(fs.existsSync(file), `missing audio asset ${name}.json`);
    if (fs.existsSync(file)) {
      const audio = JSON.parse(fs.readFileSync(file, 'utf8'));
      const events = audio.events ?? audio;
      check(Array.isArray(events) && events.length > 0, `empty audio event list ${name}.json`);
      check(Array.isArray(events) && events.every(event => Number.isFinite(event.sample) || event.wave), `audio event without sample/wave ${name}.json`);
      if (Array.isArray(events)) for (const event of events) if (Number.isFinite(event.sample)) {
        const sample = path.join(assets, 'samples', `sample_${String(event.sample).padStart(3, '0')}.wav`);
        check(fs.existsSync(sample), `missing PCM sample ${event.sample} referenced by ${name}.json`);
      }
    }
  }
}

if (failures.length) {
  console.error(`Porting audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Porting audit passed: timelines, Samurai pair offsets, Night Walk world-offset guards, and configured audio assets.');
