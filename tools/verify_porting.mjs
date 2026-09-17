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
check(game.includes('for (let i = 0; i < 24; i++) resetSpaceballStar(i, initialZoom)'), 'spaceball: star field amount differs from source');
check(game.includes('const closeSeq = [[close[1],3],[close[2],3],[close[3],3],[close[4],20]]') && game.includes('const farSeq = [[far[1],3],[far[2],3],[far[3],3],[far[4],20]]'), 'spaceball: batter animation cel durations differ from source');
check(game.includes('framesBetweenTicks(ported.actionAt, ported.actionAt + 10)') && game.includes('swingFrames < swingDuration'), 'spaceball: swing timer differs from source 0x0A');
const karateTimeline = JSON.parse(fs.readFileSync(path.join(assets, 'karate_man_timeline.json'), 'utf8'));
const karateCues = karateTimeline.events.filter(event => event.op === 'spawn_cue').map(event => event.tick / 24);
check(karateCues.length === 35 && karateCues[0] === 14 && karateCues.at(-1) === 154, `karate: timeline cue chart missing or truncated (${karateCues.length} cues)`);

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
// func_08031c68 returns 4 * local * (span - local) * spanTicks / span^2, so its
// peak is the span in ticks (24/48 px), not the frame span.
check(game.includes('4 * clamped * (span - clamped) * spanTicks / (span * span)'), 'samurai: func_08031c68 parabola factor missing');
check(game.includes('function samuraiHopAt(cue, tick)') && game.includes('const framePerTick = 150 / Math.max(1, tempoAtTick(cue.visualSpawn))'), 'samurai: hop phase is not evaluated in spawn-tempo frame domain');
check(game.includes('const spawnTempo = tempoAtTick(cue.visualSpawn)') && game.includes('192 * 150'), 'samurai: movement lifetime must lock spawn tempo');
// func_08031c94 builds the lane from 0xA0 << 6 (40 px), not 0xA0 << 8 (160 px).
check(game.includes('baseY = 40 + 54 * travel') && !game.includes('baseY = 160 + 54 * travel'), 'samurai: demon lane origin must be the source 0xA0 << 6 (40 px)');
check(game.includes('e < frameAt(0xA0) ? parabola(e % frameAt(0x18), 0x18) : 0'), 'samurai: small-demon 0x18 hop chain differs from source');
check(game.includes('if (e < frameAt(0x60)) return parabola(e % frameAt(0x18), 0x18);') && game.includes('if (e < frameAt(0xA0)) return parabola(e - frameAt(0x60), 0x30);'), 'samurai: medium-demon hop segments differ from source');
check(game.includes('if (e >= frameAt(0x78) && e < frameAt(0xA0)) return parabola(e - frameAt(0x60), 0x30);') && game.includes('return 8 * wave + 8 + 64 * Math.min(1, e / lifetime);'), 'samurai: propeller/winged hover lift differs from source');
check(game.includes('return e >= frameAt(0x60) && e < frameAt(0xA0) ? parabola(e - frameAt(0x60), 0x30) : 0;'), 'samurai: large-demon parabola window differs from source');
check(game.includes('drawPortedCell(cue.objectType >= 4 ? 87 : 80, x, shadowY, 4)') && game.includes('const shadowY = baseY - 4 +'), 'samurai: every demon must draw its ground shadow at baseY - 4');
check(game.includes('event02') && game.includes('expectedSpawnTick'), 'samurai: event02-to-cue resolver missing');
check(game.includes('samuraiSpawns.find(item => item.tick === expectedSpawnTick)') && !game.includes('samuraiSpawns.filter(item => item.tick <= event.tick)'), 'samurai: visual spawn must use exact event02 pairing');
check(game.includes('tempoAtTick(event.tick)/120'), 'samurai: phrase SFX tempo conversion mismatch');
const samuraiResultEvents = events(samurai, 'samurai_slice_event06');
check(samuraiResultEvents.length === 4 && samuraiResultEvents.every((event, i) => Number(event.args[0]) === i + 1), 'samurai: result-phase event06 sequence differs from source');
check(samuraiResultEvents[0]?.tick > samuraiCues.at(-1)?.tick, 'samurai: result-phase event06 begins before final gameplay cue');

// Night Walk: gap jumps are the only operation allowed to move the shared
// world origin; ordinary jumps must remain actor-only.
check(game.includes('if (!cue.endOfBridge || cue.state !== \'hit\''), 'night_walk: jump world-offset guard missing');
check(game.includes('const baseShift = -completed * 16') && game.includes('return baseShift'), 'night_walk: shared origin sign does not match GBA');
check(game.includes('cue.baseY = ported.nightWalkBaseY ?? 120') && game.includes('ported.nightWalkBaseY = cue.baseY - 16') && game.includes('(cue.baseY ?? 120) - nightWalkWorldShift(tick)'), 'night_walk: platform baseline and jump origin are not separated');
check(game.includes('const y = (cue.baseY ?? 120) - nightWalkWorldShift(tick)'), 'night_walk: bridge does not use source origin direction');
check(!game.includes('nightWalkCommittedShift(tick)'), 'night_walk: actor incorrectly applies platform origin to sprite Y');
check(game.includes('signedFramesBetweenTicks') && game.includes('timingOffset'), 'night_walk: jump timing offset is not applied');
check(game.includes('framesBetweenTicks(cue.hit, cue.hit + 20) - timingOffset') && game.includes('framesBetweenTicks(actionBase, actionBase + 20) - actionOffset'), 'night_walk: jump timing offset sign differs from source');
check(game.includes('const timingOffset = cue.actionTick - cue.hit') && game.includes('const actionOffset = ported.actionCue ? ported.actionAt - ported.actionCue.hit'), 'night_walk: hit offset must remain in source tick units');
check(game.includes('const hitOffsetTicks = (beat - hair.hitBeat) * 24'), 'tweezers: pull timing offset must use source tick units');
check(game.includes('tweezersRandom(0x1f) - 15') && !game.includes('rotationSpeed: Math.floor(Math.random()'), 'tweezers: falling-hair rotation must use deterministic GBA RNG');
check(game.includes('tempoAtTick(event.tick) / 120') && game.includes('Calligraphy changes tempo mid-song'), 'calligraphy: timeline SFX ignore active tempo');
check(game.includes('const effectiveRateScale = atTick == null || rateScale !== 1 ? rateScale : tempoAtTick(atTick) / 120'), 'audio: ported SFX sequence offsets ignore trigger tempo');
check(game.includes('192 + fadeTicks + 48'), 'night_walk: end script duration is shorter than source');
check(game.includes('framesBetweenTicks(ported.failedAt + 192, tick) / 12'), 'night_walk: screen fade phase missing');
check(game.includes('28 * fallFrames * (fallFrames + 1) / 2') && game.includes('actorY += Math.min(110'), 'night_walk: fall state does not advance yDistance');
check(game.includes("fall:'night_walk_fall_events'") && game.includes("playPortedSfx('fall', tick)"), 'night_walk: gap fall uses wrong SFX');
check(game.includes('night_walk_init_balloons sets anim_play_yan_jump') && game.includes('openingFrames < 20'), 'night_walk: opening balloon jump animation missing');
check(game.includes('ported.nightStars.push') && game.includes('gbaRandom(8), x = gbaRandom(256)') && game.includes('initialCel = ported.nightStars[i].variant'), 'night_walk: persistent star initialization/animation missing');
check(game.includes('function gbaRandom(max)') && game.includes('gbaRandom(4) === 0'), 'night_walk: random platform does not use GBA LCG semantics');
check(game.includes('cue.platformResolved') && game.includes('cue.spawn > tick') && game.includes('const rollVariant = gbaRandom(4)'), 'night_walk: runtime RNG order for random platforms/roll phrases is not preserved');
check(game.includes("playPortedSfx('snare',tick + 4)") && game.includes("playPortedSfx('cymbal',tick + 12,128)"), 'night_walk: kick/snare/cymbal DrumTech deltas differ from source');
check(game.includes("future.state = 'disabled'") && game.includes('cueSpawningDisabled'), 'night_walk: failed gap does not stop future cue spawning');
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
      // PSG voices must carry the ROM's channel data: the noise channel needs its
      // SOUND4CNT_L register, everything else is a pulse channel.
      for (const event of (Array.isArray(events) ? events : [])) {
        if (event.wave === 'noise') check(Number.isFinite(event.noiseRegister), `${name}.json: noise voice without a SOUND4CNT_L register`);
        else if (event.wave) check(event.wave === 'square', `${name}.json: unexpected PSG wave type ${event.wave}`);
      }
      if (Array.isArray(events)) for (const event of events) if (Number.isFinite(event.sample)) {
        const sample = path.join(assets, 'samples', `sample_${String(event.sample).padStart(3, '0')}.wav`);
        check(fs.existsSync(sample), `missing PCM sample ${event.sample} referenced by ${name}.json`);
      }
    }
  }
}

// Karate Man's audio is loaded outside portedModes, so it needs its own guard.
// tools/export_karate_midi.py rewrites the two music tracks *without* their PCM
// mapping; only tools/export_karate_bgm_samples.py re-attaches it, and losing
// that step leaves the whole level silent without failing any other check.
const readKarateAudio = name => {
  const file = path.join(assets, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { volume: payload.volume, events: payload.events ?? payload };
};
for (const name of ['karate_bgm_events', 'karate_fan_events']) {
  const payload = readKarateAudio(name);
  check(Boolean(payload), `missing audio asset ${name}.json`);
  if (!payload) continue;
  const orphan = payload.events.filter(event => !Number.isFinite(event.sample) && !event.wave).length;
  check(orphan === 0, `${name}.json: ${orphan} notes lost their original PCM sample (run tools/export_karate_bgm_samples.py)`);
}
for (const name of ['fly', 'pot', 'rock', 'ball', 'bulb', 'bomb', 'normal', 'punch', 'barely', 'hard', 'miss_voice', 'score_up', 'score_down']) {
  const payload = readKarateAudio(`karate_${name}_events`);
  check(Boolean(payload), `missing Karate SFX asset karate_${name}_events.json (run tools/export_game_audio.py)`);
  if (!payload) continue;
  check(Number.isFinite(payload.volume), `karate_${name}_events.json: SongHeader volume missing`);
  for (const event of payload.events) {
    check(Number.isFinite(event.sample) || event.wave, `karate_${name}_events.json: note without sample/wave`);
    if (Number.isFinite(event.sample)) check(fs.existsSync(path.join(assets, 'samples', `sample_${String(event.sample).padStart(3, '0')}.wav`)), `missing PCM sample ${event.sample} for karate_${name}_events.json`);
  }
}
// The playing code must reference only assets that exist: no leftover
// boxing_* names and no hand-maintained program -> sample table.
check(!game.includes('boxing_'), 'game.js still references the superseded boxing_* effect assets');
check(!game.includes('karateSfxSamples'), 'game.js still resolves Karate SFX through a hand-maintained sample table');

if (failures.length) {
  console.error(`Porting audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Porting audit passed: timelines, Samurai pair offsets, Night Walk world-offset guards, and configured audio assets.');
