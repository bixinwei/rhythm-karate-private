const $ = (selector) => document.querySelector(selector);

const menu = $('#menu');
const game = $('#game');
const stage = $('#stage');
const ctx = stage.getContext('2d');
const touch = $('#lower');
const touchCtx = touch.getContext('2d');
let mode = 'karate';

const sprites = {};
// Local exports composed from the GBA decomp's original 4bpp tiles, palette
// banks and animation cells.  These replace the temporary hand-drawn sheet.
const gba = {};
for (const cell of [0, 1, 2, 15, 16, 17, 18, 19, 20, 21, 22, 23, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 64, 65, 66, 67]) {
  const image = new Image();
  image.src = `assets/gba/cel${String(cell).padStart(3, '0')}.png?v=obj2d`;
  gba[cell] = image;
}
sprites.stage = new Image();
sprites.stage.src = 'assets/gba/karate_man_stage.png?v=stage3';

const BPM = 120;
const BEAT_MS = 60000 / BPM;
// CueDefinition uses hit ±3 ticks and barely ±5 ticks; a beat is 24 ticks.
const PERFECT_WINDOW = 3 / 24;
const HIT_WINDOW = 5 / 24;
const TRAVEL_BEATS = 1;
// Spawn beats transcribed from games/karate_man/karate_man.bs. Karate's Cue
// definition has a duration of 0x18 (one beat at 120 BPM), so each punch is
// exactly one beat after its spawn, matching the original cue system.
const spawnChart = [
  [14,'pot'], [22,'pot'], [30,'pot'], [38,'pot'], [46,'pot'], [50,'rock'],
  [58,'pot'], [62,'pot'], [66,'pot'], [70,'pot'], [74,'football'], [79,'bulb'], [86,'pot'], [90,'rock'],
  [96,'pot'], [98,'pot'], [100,'pot'], [102,'pot'], [104,'football'], [108,'bulb'], [109,'bulb'], [110,'rock'],
  [112,'pot'], [114,'pot'], [116,'pot'], [118,'pot'], [120,'pot'], [122,'pot'], [124,'pot'], [126,'pot'],
  [128,'pot'], [130,'rock'], [132,'bulb'], [133,'bomb'], [153,'rock']
];
const chart = spawnChart.map(([spawnBeat, type]) => [spawnBeat + 1, type]);
// These are the original `print_text_f` commands in karate_man.bs.  They are
// not web-font text: IDs 1–4 select the corresponding GBA warning cels.
const cueWarnings = [
  { beat: 78, id: 1, duration: 1 },
  { beat: 107, id: 3, duration: 1 },
  { beat: 131, id: 2, duration: 1.5 },
  { beat: 147, id: 4, duration: 3 }
];
const SONG_END = 158;
const tempoSegments = [{ from: 0, bpm: 120 }, { from: 135, bpm: 150 }, { from: 147, bpm: 140 }];
function elapsedForBeat(target) {
  let ms = 0;
  for (let i = 0; i < tempoSegments.length; i++) {
    const s = tempoSegments[i], e = tempoSegments[i + 1]?.from ?? target;
    if (target <= s.from) break;
    const span = Math.min(target, e) - s.from;
    if (span > 0) ms += span * 60000 / s.bpm;
    if (target <= e) break;
  }
  return ms;
}
function beatAtElapsed(ms) {
  let beat = 0;
  for (let i = 0; i < tempoSegments.length; i++) {
    const s = tempoSegments[i], next = tempoSegments[i + 1];
    const span = next ? (next.from - s.from) * 60000 / s.bpm : Infinity;
    if (ms <= span) return s.from + ms * s.bpm / 60000;
    ms -= span; beat = next.from;
  }
  return beat;
}

// The event type is visual only; every object uses a crop from the supplied sheet.

let startAt = 0;
let chartIndex = 0;
let score = 0;
let combo = 0;
let flowLevel = 0;
let best = Number(localStorage.karateBest || 0);
let running = false;
let perfectRun = true;
let cheat = false;
let lastPunchAt = -Infinity;
let lastPunchHigh = false;
let lastBeat = -1;
let judgement = '';
let active = [];
let touchFx = [];
let frame = 0;
let audioCtx;
let lastMusicBeat = -99;
let originalBgmEvents = [];
let originalFanEvents = [];
let tweezersBgmEvents = [];
const tweezersSfx = {};
let originalSamples = {};
const sampleLoads = new Map();
let audioSongStart = 0;
let scheduledMusicNodes = [];
let scheduledTweezersEvents = new Set();
let songRun = 0;
const bgmLoadPromise = fetch('assets/gba/karate_bgm_events.json').then((response) => response.json()).then((events) => { originalBgmEvents = events; }).catch(() => []);
const fanLoadPromise = fetch('assets/gba/karate_fan_events.json').then((response) => response.json()).then((events) => { originalFanEvents = events; }).catch(() => []);
const tweezersBgmLoadPromise = fetch('assets/gba/tweezers_bgm_events.json').then((response) => response.json()).then((events) => { tweezersBgmEvents = events; }).catch(() => []);
const tweezersSfxLoadPromise = Promise.all(['appear', 'long_appear', 'hit', 'barely', 'long_hit', 'long_pull', 'next'].map((name) =>
  fetch(`assets/gba/tweezers_${name}_events.json`).then((response) => response.json()).then((events) => { tweezersSfx[name] = events; }).catch(() => {})
));
const originalSfx = {};
let previewAudios = [];
for (const name of ['fly', 'pot', 'rock', 'ball', 'bulb', 'bomb', 'normal', 'punch']) {
  fetch(`assets/gba/boxing_${name}_events.json`).then((response) => response.json()).then((events) => { originalSfx[name] = events; }).catch(() => {});
}

function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(freq, length, type = 'sine', volume = .05, offset = 0) {
  const ac = audio(); const at = ac.currentTime + offset;
  const osc = ac.createOscillator(); const gain = ac.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(volume, at + .008);
  gain.gain.exponentialRampToValueAtTime(.0001, at + length);
  osc.connect(gain).connect(ac.destination); osc.start(at); osc.stop(at + length + .02);
}

// Bank 56 is the original Karate Man effects bank.  These are the PCM sample
// numbers used by the exact programs present in the exported effect MIDI.
const karateSfxSamples = {
  1: 819, 35: 824, 36: 509, 37: 840, 39: 818, 40: 841, 41: 823,
  42: 127, 44: 835, 46: 819, 49: 845, 50: 846, 51: 839, 52: 847,
  53: 848, 54: 849, 55: 429
};

function loadOriginalSamples(neededNumbers) {
  const ac = audio();
  const bgmNumbers = [...originalBgmEvents, ...originalFanEvents, ...tweezersBgmEvents, ...Object.values(tweezersSfx).flat()].map((event) => event.sample).filter(Number.isFinite);
  const allNumbers = [...new Set([...Array.from({ length: 13 }, (_, index) => index + 1), ...Object.values(karateSfxSamples), ...bgmNumbers])];
  const numbers = neededNumbers ?? allNumbers;
  return Promise.allSettled(numbers.map((number) => {
    if (originalSamples[number]) return Promise.resolve();
    if (sampleLoads.has(number)) return sampleLoads.get(number);
    const name = String(number).padStart(3, '0');
    const load = fetch(`assets/gba/samples/sample_${name}.wav`).then(async (response) => {
      if (!response.ok) throw new Error(`Missing original sample ${name}`);
      originalSamples[number] = await ac.decodeAudioData(await response.arrayBuffer());
    });
    sampleLoads.set(number, load);
    return load;
  }));
}

function playMusic(wholeBeat) {
  if (wholeBeat < 0 || wholeBeat === lastMusicBeat) return;
  lastMusicBeat = wholeBeat;
  // The complete original note timeline is scheduled at start. Keep this only
  // as a safe fallback if its local JSON has not loaded yet.
  if (!originalBgmEvents.length) tone(wholeBeat % 4 === 0 ? 92 : 116, .1, 'triangle', .035);
}

function scheduleOriginalMusic(events, startBeat = 0) {
  if (!events.length) return;
  const ac = audio();
  for (const event of events) {
    const absoluteBeat = startBeat + event.beat;
    if (absoluteBeat >= SONG_END) continue;
    const endBeat = Math.min(SONG_END, absoluteBeat + event.length);
    const duration = Math.max(.025, (elapsedForBeat(endBeat) - elapsedForBeat(absoluteBeat)) / 1000);
    const percussion = event.program === 127 || event.program === 119 || event.program === 41;
    // Confirmed from the isolated original-MIDI audition: Bank 125, channel 0
    // is Karate Man's background vocal/call-and-response track.  Keep only
    // this track in the foreground; all prior guessed sample boosts are gone.
    const isVocal = event.program === 125 && event.channel === 0;
    const voiceBoost = isVocal ? 2.5 : 1;
    const volume = Math.min(isVocal ? .085 : .046, (.004 + event.velocity / 127 * (percussion ? .015 : .02)) * voiceBoost);
    const sample = originalSamples[event.sample];
    const when = Math.max(ac.currentTime + .01, audioSongStart + elapsedForBeat(absoluteBeat) / 1000);
    if (sample) {
      const source = ac.createBufferSource(); const gain = ac.createGain();
      source.buffer = sample; source.playbackRate.value = event.fixed ? 1 : Math.pow(2, (event.note - 60) / 12);
      gain.gain.value = volume * 1.8;
      source.connect(gain).connect(ac.destination);
      scheduledMusicNodes.push(source);
      // The old universal 0.48 s cap was cutting the original call-and-
      // response samples far before their MIDI note-off (many vocals sustain
      // for 1.5–3.75 beats).  Respect the score duration; the buffer still
      // naturally ends at its own sample boundary.
      source.start(when); source.stop(when + duration);
    }
  }
}

function scheduleOriginalBgm() {
  scheduleOriginalMusic(originalBgmEvents);
  // The original script switches to s_karate_fan exactly after the `4` cue.
  scheduleOriginalMusic(originalFanEvents, 151);
}

function scheduleTweezersMusic() {
  const ac = audio();
  const nowBeat = Math.max(0, (ac.currentTime - audioSongStart) * 96 / 60);
  for (const [index, event] of tweezersBgmEvents.entries()) {
    // Samples may finish decoding after gameplay has begun.  Never attempt
    // to schedule a note already in the past; future notes are added as soon
    // as their shared sample bank is ready.
    if (event.beat > 116 || event.beat < nowBeat - .04 || scheduledTweezersEvents.has(index)) continue;
    const sample = originalSamples[event.sample];
    const when = audioSongStart + event.beat * 60 / 96;
    const duration = Math.max(.025, event.length * 60 / 96);
    if (sample) {
      const source = ac.createBufferSource(); const gain = ac.createGain(); const cleanup = ac.createBiquadFilter(); const clarity = ac.createBiquadFilter(); source.buffer = sample;
      source.playbackRate.value = Math.pow(2, (event.note - 60) / 12);
      // The ROM samples are intentionally kept intact.  A modest shelf only
      // compensates for the duller Web Audio/browser speaker path.
      gain.gain.value = Math.min(.16, .009 + event.velocity / 127 * (event.program === 125 ? .06 : .039));
      // Keeping every original PCM voice in a direct path was allowing their
      // low ends to build up on phone speakers.  This is a playback-only
      // correction: no samples, notes, lengths, or beat positions are changed.
      cleanup.type = 'highpass'; cleanup.frequency.value = 92; cleanup.Q.value = .45;
      clarity.type = 'highshelf'; clarity.frequency.value = 2200; clarity.gain.value = 5.5;
      source.connect(gain).connect(cleanup).connect(clarity).connect(ac.destination); source.start(when); source.stop(when + duration); scheduledMusicNodes.push(source);
      scheduledTweezersEvents.add(index);
    }
  }
}

function playTweezersSfx(name, eventBeat = null) {
  const events = tweezersSfx[name]; if (!events?.length) return;
  const ac = audio();
  // In the GBA engine the sound command is emitted on the beat-script
  // tick.  Schedule from the song clock instead of the JS frame that happens
  // to notice the event; otherwise a busy frame shifts the hair-appearance
  // sound behind the visual cue.
  const baseWhen = eventBeat == null ? ac.currentTime : audioSongStart + eventBeat * 60 / 96;
  for (const event of events) {
    const offset = event.beat * 60 / 96; const sample = originalSamples[event.sample];
    if (sample) {
      const source = ac.createBufferSource(), gain = ac.createGain(); source.buffer = sample;
      // rhythm_tweezers.c calls play_sound_w_pitch_volume(..., 0xD0, 0):
      // 0xD0 is the volume parameter, while pitch remains neutral.
      source.playbackRate.value = event.rate ?? (event.fixed ? 1 : Math.pow(2, (event.note - 60) / 12));
      gain.gain.value = .13 * (event.velocity / 127) * (name === 'appear' ? 0xd0 / 0x100 : 1); source.connect(gain).connect(ac.destination);
      const when = Math.max(ac.currentTime + .005, baseWhen + offset);
      source.start(when); source.stop(when + Math.max(.45, event.length * 60 / 96 + .2));
    } else {
      const delay = Math.max(0, baseWhen + offset - ac.currentTime);
      tone(280 * Math.pow(2, (event.note - 60) / 12), Math.max(.04, event.length * 60 / 96), 'triangle', .04, delay);
    }
  }
}

function playOriginalSfx(name) {
  const events = originalSfx[name];
  if (!events?.length) return false;
  const ac = audio();
  let usedOriginalPcm = false;
  for (const event of events) {
    const sample = originalSamples[karateSfxSamples[event.program]];
    const offset = event.beat * .5;
    if (sample) {
      const source = ac.createBufferSource(); const gain = ac.createGain();
      source.buffer = sample;
      source.playbackRate.value = Math.pow(2, (event.note - 60) / 12);
      gain.gain.value = .16 * (event.velocity / 127);
      source.connect(gain).connect(ac.destination);
      source.start(ac.currentTime + offset);
      source.stop(ac.currentTime + offset + Math.min(1.35, Math.max(.12, event.length * .5 + .28)));
      usedOriginalPcm = true;
      continue;
    }
    const freq = 440 * Math.pow(2, (event.note - 69) / 12);
    const percussion = event.program >= 119 || event.program === 127;
    tone(Math.min(1400, freq), Math.max(.025, Math.min(.42, event.length * .5)), percussion ? 'square' : 'triangle', .018 + event.velocity / 127 * .042, offset);
  }
  return usedOriginalPcm || events.length > 0;
}

function punchSound() { if (!playOriginalSfx('punch')) { tone(145, .07, 'sawtooth', .08); tone(300, .04, 'square', .025, .015); } }
function hitSound(perfect) { tone(perfect ? 660 : 410, .16, 'triangle', .07); if (perfect) tone(990, .2, 'sine', .035, .04); }
function missSound() { tone(110, .18, 'sawtooth', .04); }
// A two-note call is played exactly one beat before each required punch.
// This is the playable rhythm cue: no call means do not punch on the next beat.
function throwCue(type) {
  const root = type === 'bomb' ? 196 : type === 'rock' ? 246.94 : type === 'football' ? 329.63 : type === 'bulb' ? 392 : 293.66;
  tone(root, .09, 'triangle', .075);
  tone(root * 1.5, .11, 'triangle', .06, .16);
}
function launchSound(type) {
  const root = type === 'bomb' ? 164.81 : type === 'rock' ? 207.65 : type === 'football' ? 277.18 : type === 'bulb' ? 329.63 : 246.94;
  tone(root, .12, 'triangle', .04);
}
function hitAccent(type) {
  const root = type === 'bomb' ? 233.08 : type === 'rock' ? 293.66 : type === 'football' ? 392 : type === 'bulb' ? 440 : 349.23;
  tone(root, .055, 'square', .065);
  tone(root * 2, .11, 'triangle', .035, .025);
}

function start() {
  audio();
  game.classList.remove('tweezers-mode');
  const run = ++songRun;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} }
  scheduledMusicNodes = [];
  menu.classList.add('hidden');
  game.classList.remove('hidden');
  // Do not let the countdown run ahead of asynchronous PCM decoding.  Starting
  // only after all original instruments are ready prevents a thin oscillator
  // fallback or a burst of late notes on a first visit / iPad refresh.
  running = false;
  chartIndex = score = combo = 0;
  flowLevel = 0;
  perfectRun = true;
  active = [];
  touchFx = [];
  judgement = '';
  lastBeat = -1;
  lastMusicBeat = -99;
  Promise.all([bgmLoadPromise, fanLoadPromise]).then(() => loadOriginalSamples()).then(() => {
    if (run !== songRun) return;
    startAt = performance.now() + elapsedForBeat(3);
    audioSongStart = audio().currentTime + elapsedForBeat(3) / 1000;
    running = true;
    scheduleOriginalBgm();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  });
}

function quit() {
  running = false;
  songRun += 1;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} }
  scheduledMusicNodes = [];
  cancelAnimationFrame(frame);
  game.classList.add('hidden');
  menu.classList.remove('hidden');
}

function songBeat() {
  return mode === 'tweezers' ? (performance.now() - startAt) / tweezersBeatMs : beatAtElapsed(performance.now() - startAt);
}

function loop() {
  const beat = songBeat();
  if (mode === 'tweezers') return tweezersLoop(beat);
  if (beat > SONG_END) return finish();
  update(beat);
  render(beat);
  frame = requestAnimationFrame(loop);
}

// Rhythm Tweezers runtime. The timeline, cell art, and sprite layout are
// taken from the decomp's rhythm_tweezers engine and main beatscript.
const tweezers = { cells: {}, events: [], active: [], falling: [], veg: 'onion', nextVeg: 'onion', scrollStart: -1, scrollDuration: .5, scrollDirection: 1, rotation: 0, cycleAt: -1, tweezersAt: -1, lastEvent: -1 };
for (let i = 0; i <= 90; i++) { const image = new Image(); image.src = `assets/gba/tweezers/cel${String(i).padStart(3,'0')}.png?v=1`; tweezers.cells[i] = image; }
const tweezersBg = {}; for (const veg of ['onion','turnip','potato']) { const image = new Image(); image.src = `assets/gba/tweezers/bg_${veg}.png?v=1`; tweezersBg[veg] = image; }
fetch('assets/gba/tweezers/chart.json').then((r) => r.json()).then((v) => { tweezers.events = v; }).catch(() => {});
const tweezersBeatMs = 60000 / 96;
const tweezersProgramSamples = { 23: 2, 26: 3, 37: 5, 38: 7, 39: 10, 41: 5, 42: 8, 125: 1, 127: 11 };
function tweezersStart() {
  audio(); mode = 'tweezers'; running = false; songRun += 1; const run = songRun;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} } scheduledMusicNodes = [];
  menu.classList.add('hidden'); game.classList.remove('hidden'); game.classList.remove('tweezers-mode');
  // `rhythm_tweezers_init_tweezers` creates one visible sprite at -0x200.
  // The beat event starts its orbit; it does not create or reveal it.
  tweezers.active = []; tweezers.falling = []; tweezers.veg = 'onion'; tweezers.nextVeg = 'onion'; tweezers.scrollStart = -1; tweezers.scrollDirection = 1; tweezers.rotation = -0x200; tweezers.tweezersAt = -1; tweezers.cycleAt = -1; tweezers.lastEvent = -1; tweezers.tweezerAction = null; touchFx = []; scheduledTweezersEvents = new Set();
  // Show the game immediately.  Audio decoding must not leave the player on
  // an empty black screen, and this mode only needs its own small sample set.
  tweezersRender(-3);
  Promise.all([tweezersBgmLoadPromise, tweezersSfxLoadPromise]).then(() => {
    if (run !== songRun || mode !== 'tweezers') return;
    // The first hair cue must use the original PCM (s_hanabi_pon / long
    // hair-appear), never the oscillator fallback. Decode all tweezers SFX
    // before opening the three-beat lead-in; the canvas is already visible.
    const sfxNumbers = [...new Set(Object.values(tweezersSfx).flat().map((event) => event.sample).filter(Number.isFinite))];
    return loadOriginalSamples(sfxNumbers).then(() => {
      if (run !== songRun || mode !== 'tweezers') return;
      startAt = performance.now() + tweezersBeatMs * 3; audioSongStart = audio().currentTime + tweezersBeatMs * 3 / 1000;
      running = true;
    // Do not hold the first game frame behind every music sample.  The first
    // few actions can use the existing oscillator fallback; decoded original
    // PCM is scheduled into all still-future beats once it arrives.
    const allEvents = [...tweezersBgmEvents, ...Object.values(tweezersSfx).flat()];
    const needed = allEvents.map((event) => event.sample).filter(Number.isFinite);
    // The opening eight beats use only four samples.  Decode them first so
    // the actual GBA backing track begins during the three-beat lead-in,
    // rather than waiting for every sample used in the whole level.
    const opening = [...new Set(tweezersBgmEvents.filter((event) => event.beat < 8).map((event) => event.sample))];
    loadOriginalSamples(opening).then(() => {
      if (run === songRun && mode === 'tweezers' && running) scheduleTweezersMusic();
    });
    loadOriginalSamples([...new Set(needed)]).then(() => {
      if (run === songRun && mode === 'tweezers' && running) scheduleTweezersMusic();
    });
      cancelAnimationFrame(frame); frame = requestAnimationFrame(loop);
    });
  });
}
function tweezersLoop(beat) {
  if (beat > 120) return finish();
  tweezersUpdate(beat); tweezersRender(beat); frame = requestAnimationFrame(loop);
}
function tweezersUpdate(beat) {
  while (tweezers.events.length && tweezers.events[tweezers.lastEvent + 1]?.beat <= beat) {
    const event = tweezers.events[++tweezers.lastEvent];
    if (event.kind === 'cycle') tweezers.cycleAt = event.beat;
    if (event.kind === 'tweezers') tweezers.tweezersAt = event.beat;
    if (event.kind === 'veg') { tweezers.nextVeg = event.veg; tweezers.scrollStart = event.beat; tweezers.scrollDuration = .5; playTweezersSfx('next', event.beat); }
    if (event.kind === 'cue') {
      const long = event.cue === 'long';
      // Cue durations are 0x60 script ticks = four beats. `spawn_cue` is
      // when the hair starts appearing, not the moment the player plucks it.
      // `cue_spawn` calculates this orbit once, then leaves the sprite at
      // that position.  The later hairs do not rotate around the vegetable.
      const cycleBeat = event.beat - (tweezers.cycleAt < 0 ? event.beat : tweezers.cycleAt);
      // The engine advances this integer counter once per GBA frame.  Keep
      // that quantisation instead of interpolating by JavaScript time.
      const cycleFrames = Math.floor(cycleBeat * 37.5);
      const cycleTarget = 112; // ticks_to_frames(0x48) at 96 BPM
      const orbitRotation = 0x340 - Math.floor(0x280 * cycleFrames / cycleTarget);
      tweezers.active.push({ beat: event.beat, hitBeat: event.beat + 4, type: long ? 'long' : 'short', fast: event.cue === 'fast', orbitRotation, state: 'fresh', hitAt: -1 });
      playTweezersSfx(long ? 'long_appear' : 'appear', event.beat);
    }
  }
  for (const hair of tweezers.active) {
    const missWindow = hair.fast ? 6 / 24 : hair.type === 'long' ? 4 / 24 : 5 / 24;
    // `rhythm_tweezers_cue_miss` only re-enables the beat-script loop.  It
    // does not create a falling hair or an extra tweezers sprite; the cue's
    // own hair remains until update_short/update_long despawns it at 2x time.
    if (hair.state === 'fresh' && beat - hair.hitBeat > missWindow) hair.state = 'miss';
    // The source retains long-hair cues for two cue lengths.  Its half-beat
    // pull then changes to a stubble cel and starts the normal recovery.
    if (hair.type === 'long' && hair.pull && !hair.pullComplete && beat - hair.pullAt >= hair.pullDuration) {
      hair.pullComplete = true;
      hair.stubbleAt = beat;
      tweezers.tweezerAction = { kind: 'hit', at: hair.pullAt + hair.pullDuration };
    }
    // The engine releases a short hair at the penultimate pluck cel, not at
    // the instant of input. The cue sprite remains alive until its normal
    // two-duration expiry; the falling strand is a separate sprite.
    if (hair.type === 'short' && hair.state === 'hit' && !hair.fallingSpawned && beat - hair.hitAt >= 13 / 37.5) {
      hair.fallingSpawned = true;
      const pos = tweezersOrbitAt(beat);
      // Falling hairs preserve the plucker's orbit angle and use the same
      // base -0x200 affine rotation as the GBA engine.
      tweezers.falling.push({ x: pos.x, y: pos.y, spawnedAt: beat, orbitRotation: pos.rotation,
        rotationSpeed: Math.floor(Math.random() * 31) - 15 });
    }
    if (hair.type === 'long' && hair.pullComplete) hair.state = 'done';
    if ((hair.state === 'hit' || hair.state === 'miss') && beat - hair.beat > 8) hair.state = 'done';
  }
  tweezers.active = tweezers.active.filter((h) => h.state !== 'done');
  tweezers.falling = tweezers.falling.filter((hair) => {
    const frames = Math.max(0, Math.floor((beat - hair.spawnedAt) * 37.5));
    // Original fixed-point trajectory: distance += speed += 0x20 each GBA
    // frame, then the sprite receives distance >> 8 as its base Y.
    return hair.y + frames * (frames + 1) / 16 < 190;
  });
}
function tweezersPunch() {
  if (!running || mode !== 'tweezers') return;
  const beat = songBeat(); const hair = tweezers.active.find((h) => h.state === 'fresh' && Math.abs(h.hitBeat - beat) <= (h.fast ? 6 / 24 : h.type === 'long' ? 4 / 24 : 5 / 24));
  if (!hair) { tweezers.tweezerAction = { kind: 'miss', at: beat }; missSound(); createImpact('empty'); return; }
  const perfectWindow = hair.fast || hair.type === 'long' ? 4 / 24 : 3 / 24;
  const perfect = Math.abs(hair.hitBeat - beat) <= perfectWindow; hair.state = 'hit'; hair.hitAt = beat; hair.perfect = perfect;
  if (hair.type === 'long') {
    const hitOffsetFrames = (beat - hair.hitBeat) * 37.5;
    hair.pull = true; hair.pullAt = beat; hair.pullRotation = tweezersOrbitAt(beat).rotation;
    // Source: ticks_to_frames(0x0C) - gameplay_get_last_hit_offset().
    hair.pullDuration = Math.max(1, 18.75 - hitOffsetFrames) / 37.5;
    tweezers.tweezerAction = { kind: 'hidden', at: beat };
  }
  else tweezers.tweezerAction = { kind: perfect ? 'hit' : 'barely', at: beat };
  if (hair.type === 'long') { playTweezersSfx('long_hit'); playTweezersSfx('long_pull'); }
  else playTweezersSfx(perfect ? 'hit' : 'barely');
  createImpact(perfect ? 'perfect' : 'normal');
}
function drawTweezersCell(cell, x, y, scale = 4, alpha = 1, angle = 0) {
  const image = tweezers.cells[cell], meta = tweezersManifest[cell]; if (!image?.complete || !meta) return;
  ctx.save(); ctx.imageSmoothingEnabled = false; ctx.globalAlpha = alpha; ctx.translate(x * scale, y * scale); ctx.rotate(angle);
  ctx.drawImage(image, -meta.originX * scale, -meta.originY * scale, image.naturalWidth * scale, image.naturalHeight * scale); ctx.restore();
}
function tweezersOrbitAt(beat) {
  // Source: cycleTarget = ticks_to_frames(0xA8).  At 96 BPM, deltaTime is
  // 0.64 tatums/frame, so this is 262.5 GBA frames, or exactly seven beats.
  // Before the first event, the initialized sprite remains at -0x200.
  let rotation = -0x200;
  if (tweezers.tweezersAt >= 0) {
    const elapsedFrames = Math.max(0, Math.floor((beat - tweezers.tweezersAt) * 37.5));
    rotation = 0x4ea - Math.floor(0x5d5 * Math.min(262, elapsedFrames) / 262);
  }
  const angle = rotation * Math.PI * 2 / 0x800;
  return { rotation, angle, x: 120 + Math.cos(angle) * 76, y: 16 + Math.sin(angle) * 76 };
}
let tweezersManifest = {};
fetch('assets/gba/tweezers/frames.json').then((r) => r.json()).then((v) => { tweezersManifest = Object.fromEntries(Object.entries(v).map(([k,val]) => [Number(k),val])); }).catch(() => {});
function tweezersRender(beat) {
  ctx.clearRect(0,0,stage.width,stage.height); ctx.imageSmoothingEnabled = false;
  const scrolling = tweezers.scrollStart >= 0 && beat < tweezers.scrollStart + tweezers.scrollDuration;
  if (tweezers.scrollStart >= 0 && !scrolling) { tweezers.veg = tweezers.nextVeg; tweezers.scrollStart = -1; }
  const t = scrolling ? Math.max(0, Math.min(1, (beat - tweezers.scrollStart) / tweezers.scrollDuration)) : 0;
  const slide = scrolling ? (1 - Math.cos(Math.PI * t)) * .5 * stage.width * tweezers.scrollDirection : 0;
  ctx.save();
  ctx.translate(-slide, 0);
  const bg = tweezersBg[tweezers.veg]; if (bg?.complete) ctx.drawImage(bg, 0, 0, stage.width, stage.height); else { ctx.fillStyle='#fff'; ctx.fillRect(0,0,stage.width,stage.height); }
  // The engine's affine angle unit is one turn per 0x800, and the orbit
  // distance in rhythm_tweezers.c is 0x4c — 76 native screen pixels.
  // Keeping both values intact puts the tweezers around the vegetable face
  // instead of collapsed in the centre.
  const orbit = tweezersOrbitAt(beat); const orbitX = orbit.x, orbitY = orbit.y;
  const vegCell = tweezers.veg === 'turnip' ? 3 : tweezers.veg === 'potato' ? 6 : 0;
  drawTweezersCell(vegCell,120,16,4,1); // vegetable face, native sprite origin
  for (const hair of tweezers.active) {
    if (hair.state === 'done') continue;
    const hAngle = hair.orbitRotation * Math.PI * 2 / 0x800;
    const x = 120 + Math.cos(hAngle) * 76, y = 16 + Math.sin(hAngle) * 76;
    const cell = hair.type === 'long' ? tweezersLongHairCell(hair, beat) :
      (hair.state === 'hit' ? (hair.perfect ? 42 : 41) : tweezersShortHairCell(hair, beat));
    // create_affine_sprite() gives every hair a base rotation of -0x200;
    // rotate_with_orbit then adds its fixed orbit angle.  Leaving out that
    // base term was the 90° mismatch that put hairs across the face.
    // On a long pull, the ROM changes the sprite's own rotation relative to
    // the plucker while keeping this hair's original orbit angle.  The two
    // terms must both be present; otherwise the curl either snaps or drifts.
    let rotation = hair.orbitRotation - 0x200;
    if (hair.type === 'long' && hair.pull && !hair.pullComplete) {
      rotation = orbit.rotation - hair.pullRotation - 0x200 + hair.orbitRotation;
    }
    drawTweezersCell(cell, x, y, 4, 1, rotation * Math.PI * 2 / 0x800);
  }
  if (tweezers.tweezerAction?.kind !== 'hidden') {
    drawTweezersCell(tweezersActionCell(beat), orbitX, orbitY, 4, 1, (orbit.rotation - 0x200) * Math.PI * 2 / 0x800);
  }
  for (const hair of tweezers.falling) {
    const frames = Math.max(0, Math.floor((beat - hair.spawnedAt) * 37.5));
    const y = hair.y + frames * (frames + 1) / 16;
    drawTweezersCell(18, hair.x, y, 4, 1,
      (-0x200 + frames * hair.rotationSpeed + hair.orbitRotation) * Math.PI * 2 / 0x800);
  }
  if (scrolling) {
    ctx.save(); ctx.translate(tweezers.scrollDirection * stage.width, 0);
    const nextBg = tweezersBg[tweezers.nextVeg];
    if (nextBg?.complete) ctx.drawImage(nextBg, 0, 0, stage.width, stage.height);
    const nextCell = tweezers.nextVeg === 'turnip' ? 3 : tweezers.nextVeg === 'potato' ? 6 : 0;
    drawTweezersCell(nextCell, 120, 16, 4, 1);
    ctx.restore();
  }
  ctx.restore();
  drawTouchScreen();
}

function tweezersShortHairCell(hair, beat) {
  const cells = [35, 36, 37, 38, 39, 40, 39];
  return cells[Math.min(cells.length - 1, Math.max(0, Math.floor((beat - hair.beat) * 60 / 96 * 60)))];
}

function tweezersLongHairCell(hair, beat) {
  // `rhythm_tweezers_cue_update_long` explicitly maps all 32 pull cels over
  // ticks_to_frames(0x0C): half a beat at 96 BPM.  The animation metadata is
  // bypassed by the original cue updater, so its idle cel durations do not
  // determine this motion.
  if (hair.pull) {
    return 59 + Math.min(31, Math.floor((beat - hair.pullAt) / hair.pullDuration * 31));
  }
  const frames = [[35,1],[36,1],[37,1],[38,1],[39,1],[40,1],[52,1],[50,1],[48,2],[46,3],[43,6],[44,5],[45,5],[46,5],[48,10],[47,10],[46,10],[45,10],[44,10],[43,40]];
  let at = Math.max(0, (beat - hair.beat) * 37.5);
  for (const [cell, duration] of frames) { if (at < duration) return cell; at -= duration; }
  return 43;
}

function tweezersActionCell(beat) {
  const action = tweezers.tweezerAction;
  if (!action) return 9;
  const sequences = {
    hit: [[11,2],[12,1],[13,1],[14,2],[15,2],[16,3],[17,3]],
    barely: [[19,2],[20,1],[21,1],[22,2],[23,2],[24,3],[25,3]],
    miss: [[27,2],[28,1],[29,1],[30,2],[31,2],[32,3],[34,3]]
  };
  const sequence = sequences[action.kind]; if (!sequence) return 9;
  let frame = Math.max(0, (beat - action.at) * 37.5);
  for (const [cell, duration] of sequence) { if (frame < duration) return cell; frame -= duration; }
  return 9;
}

function update(beat) {
  const currentWholeBeat = Math.floor(beat);
  if (currentWholeBeat !== lastBeat) {
    lastBeat = currentWholeBeat;
    playMusic(currentWholeBeat);
  }
  while (chartIndex < chart.length && chart[chartIndex][0] - beat <= TRAVEL_BEATS) {
    const [hitBeat, type] = chart[chartIndex++];
    active.push({ hitBeat, spawnBeat: hitBeat - 1, type, state: 'flying', impact: 0, cuePlayed: false, accentPlayed: false, missed: false });
    if (!playOriginalSfx('fly')) launchSound(type);
  }
  for (const item of active) {
    if (item.state === 'flying' && !item.cuePlayed && beat >= item.hitBeat - 1) {
      item.cuePlayed = true;
      if (!originalSfx.fly?.length) throwCue(item.type);
    }
    const cueTime = beat - item.spawnBeat;
    // The source engine does not despawn at the input window.  A missed
    // object carries on from t=1 through t=2, lands, and the Cue itself can
    // remain alive until 0x78 script ticks (five beats at this tempo).
    if (item.state === 'flying' && !item.missed && cueTime > 1.5) {
      item.missed = true;
      item.impact = performance.now();
      combo = 0;
      flowLevel = 0;
      perfectRun = false;
      judgement = 'MISS';
      missSound();
    }
    if (item.state === 'flying' && cueTime > 2) {
      item.state = 'landed';
      item.landBeat = beat;
      // The object has now visibly reached the floor: show the miss label,
      // but no touch-screen star burst.
      if (item.missed) createImpact('land');
    }
  }
  active = active.filter((item) => beat - item.spawnBeat < 5);
}

function punch() {
  if (!running) return;
  const beat = songBeat();
  if (beat < 0) return;
  const candidate = active.find((item) => item.state === 'flying' && Math.abs(item.hitBeat - beat) <= HIT_WINDOW);
  punchSound();
  lastPunchAt = performance.now();
  lastPunchHigh = flowLevel > 2;
  if (!candidate && !cheat) {
    combo = 0;
    flowLevel = 0;
    perfectRun = false;
    judgement = 'MISS';
    // An empty punch is acknowledged only by the small yellow star.
    createImpact('empty');
    missSound();
    return;
  }
  const perfect = cheat || Math.abs(candidate.hitBeat - beat) <= PERFECT_WINDOW;
  if (candidate) {
    candidate.state = 'hit';
    candidate.hitAt = performance.now();
    candidate.impactPos = objectPosition(1);
  }
  score += perfect ? 100 : 60;
  combo += 1;
  // The original Flow Meter has six cels: empty plus five fill levels.
  flowLevel = Math.min(5, flowLevel + 1);
  best = Math.max(best, combo);
  judgement = perfect ? 'PERFECT' : 'OK!';
  if (!perfect) perfectRun = false;
  localStorage.karateBest = best;
  if (!playOriginalSfx(candidate?.type === 'football' ? 'ball' : candidate?.type ?? 'normal')) hitSound(perfect);
  createImpact(perfect ? 'perfect' : 'normal');
  const flash = $('#upperFlash');
  flash.className = perfect ? 'good' : 'ok';
  setTimeout(() => { flash.className = ''; }, 180);
}

function createImpact(kind) {
  // The 3DS lower screen has three distinct result animations.
  // At their largest, the outer stars reach about 181px from the origin.
  // Constrain the random origin by that radius so the completed ring remains
  // entirely inside the 640 × 480 lower screen.
  const safeRadius = 181;
  touchFx.push({
    life: 1,
    kind,
    label: kind === 'perfect' ? 'PERFECT' : kind === 'land' ? 'MISS' : '',
    x: safeRadius + Math.random() * (touch.width - safeRadius * 2),
    y: safeRadius + Math.random() * (touch.height - safeRadius * 2)
  });
}

function render(beat) {
  drawTop(beat);
  drawTouchScreen();
}

function drawTop(beat) {
  const w = stage.width;
  const h = stage.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  if (sprites.stage.complete) ctx.drawImage(sprites.stage, 0, 0, w, h);
  else { ctx.fillStyle = '#ff7418'; ctx.fillRect(0, 0, w, h); }
  drawFlowMeter();
  // Native game positions: Joe at (80, 88), hit effect at (158, 54).
  drawFighter(320, 352, performance.now() - lastPunchAt < 150, beat);
  drawItems(beat);
  drawOriginalHitEffects(beat);
  drawCueWarning(beat);
}

function drawCueWarning(beat) {
  const warning = cueWarnings.find((entry) => beat >= entry.beat && beat < entry.beat + entry.duration);
  if (!warning) return;
  const cell = warning.id === 4 ? 64 : 64 + warning.id;
  const image = gba[cell];
  if (!image?.complete) return;
  // sprite_create(... anim_karate_cue_warning, 0, 120, 24, ...) in the ROM.
  // Exported cels preserve their GBA footprint, so they are drawn at native 4×.
  const originX = { 64: 16, 65: 12, 66: 16, 67: 16 }[cell];
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, (120 - originX) * 4, (24 - 10) * 4, image.naturalWidth * 4, image.naturalHeight * 4);
  ctx.restore();
}

function drawFlowMeter() {
  // sprite_create(... anim_karate_flow_meter, level, 36, 16, ...) in the
  // original engine.  Cels 044–049 are the exact empty-to-full meter art.
  const image = gba[44 + flowLevel];
  if (!image?.complete) return;
  const scale = 4;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 36 * scale - 19 * scale, 16 * scale - 3 * scale,
    image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.restore();
}

function drawOriginalHitEffects(beat) {
  const image = gba[43];
  if (!image?.complete) return;
  for (const item of active) {
    // anim_karate_hit_effect is precisely cel043 for two GBA frames.
    // No scaling, fading, particles, or extra animation is present in ROM.
    if (item.state !== 'hit' || performance.now() - item.hitAt > 1000 / 30) continue;
    ctx.save(); ctx.imageSmoothingEnabled = false;
    // sprite_create places the original effect at (158, 54); cels are
    // exported around their native origin and then mapped at 4×.
    const scale = 4;
    ctx.drawImage(image, 158 * scale - 27 * scale, 54 * scale - 32 * scale,
      image.naturalWidth * scale, image.naturalHeight * scale);
    ctx.restore();
  }
}

function drawFighter(x, y, punching, beat) {
  const punchAge = performance.now() - lastPunchAt;
  // The source uses Low Flow first, only switching to High Flow after three
  // successful hits.  The two sequences use distinct body/head cels.
  const punchFrames = lastPunchHigh
    ? [20, 19, 19, 19, 21, 21, 22, 22, 23, 23, 2, 1, 0]
    : [15, 15, 15, 15, 16, 16, 17, 17, 18, 18, 2, 1, 0];
  // anim_karate_joe_beat is cel002 for 3 frames, cel001 for 3 frames,
  // then cel000 for 24 frames. Its total is exactly one 120 BPM beat.
  const beatFrame = Math.floor(((beat % 1 + 1) % 1) * 30);
  const idleCell = beatFrame < 3 ? 2 : beatFrame < 6 ? 1 : 0;
  const cell = punching ? punchFrames[Math.min(punchFrames.length - 1, Math.floor(punchAge / 16))] : idleCell;
  const image = gba[cell]; const scale = 4;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  const origins = { 0: [35,75], 1: [35,74], 2: [35,73], 15: [35,71], 16: [35,72], 17: [35,73], 18: [35,73], 19: [34,64], 20: [34,64], 21: [35,67], 22: [35,67], 23: [35,67] };
  const [originX, originY] = origins[cell] ?? origins[0];
  if (image?.complete) ctx.drawImage(image, x - originX * scale, y - originY * scale, image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.restore();
}

function drawItems(beat) {
  for (const item of active) {
    if (item.state === 'hit') {
      const knockBack = Math.max(0, beat - item.hitBeat);
      if (knockBack > .72) continue;
      const x = (item.impactPos?.x ?? objectPosition(1).x) + knockBack * 700;
      const y = (item.impactPos?.y ?? objectPosition(1).y) - knockBack * 115 + knockBack * knockBack * 160;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(knockBack * 2.4);
      ctx.globalAlpha = Math.max(0, 1 - knockBack / .72);
      ctx.scale(1 + knockBack * .7, 1 - Math.min(.22, knockBack * .35));
      drawObject(item.type);
      ctx.restore(); ctx.globalAlpha = 1;
      continue;
    }
    if (item.state === 'landed' && beat - item.landBeat > .55) continue;
    // t is the same distance parameter used by karate_cue_update().  It
    // deliberately continues beyond the punch point to the floor at t=2.
    const progress = Math.max(0, Math.min(2, beat - item.spawnBeat));
    if (progress < .5) continue; // Original engine hides the far half of the launch.
    const position = objectPosition(progress, item.type);
    const { x, y } = position;
    if (item.state === 'hit') continue;
    ctx.save();
    drawObjectShadow(position);
    ctx.translate(x, y);
    ctx.globalAlpha = 1;
    drawObject(item.type, position.scale);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

function objectPosition(progress, type = 'pot') {
  // Equivalent of karate_cue_update_launched_object(): t is its original
  // distance parameter.  The game only reveals the object after t = 0.5.
  const t = Math.max(.5, progress);
  const originalY = 80 + (-28 + 81 * (t - 1) * (t - 1)) / t;
  return {
    x: 624 + 144 * (1 / t - 1),
    y: 216 + (originalY - 52) * 4 + (type === 'rock' ? -28 : type === 'bomb' ? 18 : 0),
    scale: 4 / t
  };
}

function drawObject(type, scale = 2.25) {
  // anim_karate_object in the decomp maps: pot 035, rock 039, football 037,
  // bomb 038, bulb 036.  Every incoming item is therefore an original cell.
  const cells = { pot: 35, rock: 39, football: 37, bomb: 38, bulb: 36 };
  const image = gba[cells[type] ?? 35];
  if (image?.complete) ctx.drawImage(image, -19 * scale, -19 * scale, image.naturalWidth * scale, image.naturalHeight * scale);
}

function drawObjectShadow(position) {
  const image = gba[40];
  if (!image?.complete) return;
  const scale = position.scale;
  // The original shadow is its own affine sprite at y = 80 + 53 / t.
  const t = 4 / scale;
  const shadowY = (80 + 53 / t) * 4;
  ctx.save();
  ctx.globalAlpha = .72;
  ctx.drawImage(image, position.x - 19 * scale, shadowY - 2 * scale, image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.restore();
}

function draw3dsStar(context, x, y, radius, color, alpha = 1, rotation = 0) {
  // Five-point, soft-glowing 3DS star sprite silhouette.
  context.save(); context.translate(x, y); context.rotate(rotation);
  context.globalAlpha = alpha;
  context.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 ? radius * .47 : radius;
    if (i) context.lineTo(Math.cos(a) * r, Math.sin(a) * r); else context.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  context.closePath();
  context.shadowColor = color; context.shadowBlur = radius * .72;
  context.fillStyle = color; context.fill();
  context.shadowBlur = 0;
  context.restore();
}

// The captures show a single ten-star circle for a perfect hit.
const PERFECT_COLORS = ['#d8ff20', '#ff20d4', '#14f5ff', '#4dff7e', '#b6ff18', '#fff000', '#ff32d7', '#ffd91a', '#2dff8d', '#ff8a25'];

function drawTouchScreen() {
  const w = touch.width, h = touch.height, gap = 4, cols = 8, rows = 6;
  // The 8 × 6 board uses the full 4:3 touch display; only the intentional
  // dark grid seams remain, with no outer black matte.
  const left = 0, top = 0, cellW = (w - gap * (cols - 1)) / cols, cellH = (h - gap * (rows - 1)) / rows;
  touchCtx.fillStyle = '#070709'; touchCtx.fillRect(0, 0, w, h);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      touchCtx.fillStyle = (row + col) % 2 ? '#24242b' : '#111116';
      touchCtx.fillRect(left + col * (cellW + gap), top + row * (cellH + gap), cellW, cellH);
      touchCtx.fillStyle = '#34343d'; touchCtx.fillRect(left + col * (cellW + gap) + 3, top + row * (cellH + gap) + 3, 2, 2);
    }
  }
  // Permanent markings visible in the reference lower display.
  // These are positioned within their board cells, rather than against the
  // canvas, so the decoration stays aligned when the grid fills the screen.
  const badgeX = left + cellW * .34, badgeY = top + cellH * .41;
  const mascotX = left + 7 * (cellW + gap) + cellW * .42;
  const mascotY = top + (cellH + gap) + cellH * .34;
  touchCtx.strokeStyle = '#d8d6dc'; touchCtx.lineWidth = 3; touchCtx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 7 : 14;
    if (i) touchCtx.lineTo(badgeX + Math.cos(a) * r, badgeY + Math.sin(a) * r); else touchCtx.moveTo(badgeX + Math.cos(a) * r, badgeY + Math.sin(a) * r);
  }
  touchCtx.closePath(); touchCtx.stroke();
  touchCtx.fillStyle = '#1b42ed'; touchCtx.beginPath(); touchCtx.arc(mascotX, mascotY, 15, 0, Math.PI * 2); touchCtx.fill();
  touchCtx.strokeStyle = '#11121c'; touchCtx.lineWidth = 3; touchCtx.stroke();
  touchCtx.fillStyle = '#e4dbff'; touchCtx.beginPath(); touchCtx.arc(mascotX - 6, mascotY - 16, 5, 0, Math.PI * 2); touchCtx.arc(mascotX + 8, mascotY - 16, 5, 0, Math.PI * 2); touchCtx.fill();
  touchCtx.fillStyle = '#17121b'; touchCtx.beginPath(); touchCtx.arc(mascotX - 6, mascotY - 16, 2, 0, Math.PI * 2); touchCtx.arc(mascotX + 8, mascotY - 16, 2, 0, Math.PI * 2); touchCtx.fill();
  const noteCells = [[1,2],[5,2],[2,3],[6,3],[1,5],[5,5]];
  touchCtx.fillStyle = '#050509'; touchCtx.font = '700 45px sans-serif';
  for (const [col, row] of noteCells) touchCtx.fillText('♪', left + col * (cellW + gap) + 12, top + row * (cellH + gap) + 54);
  touchCtx.fillStyle = '#f4f3f4'; touchCtx.font = '600 22px sans-serif'; touchCtx.textAlign = 'right'; touchCtx.fillText('TOUCH', w - 26, h - 25); touchCtx.textAlign = 'left';
  for (const fx of touchFx) {
    fx.life -= .036;
    const progress = 1 - fx.life, cx = fx.x, cy = fx.y;
    if (fx.kind === 'perfect') {
      // Unlike the normal yellow ring, perfect stars keep travelling past
      // the checkerboard and finally leave the lower screen.
      const travel = Math.min(1, progress);
      const ease = travel;
      for (let i = 0; i < PERFECT_COLORS.length; i++) {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / PERFECT_COLORS.length;
        const targetX = cx + Math.cos(angle) * 150, targetY = cy + Math.sin(angle) * 150;
        const startX = cx + Math.cos(angle) * 34, startY = cy + Math.sin(angle) * 34;
        const x = startX + (targetX - startX) * ease, y = startY + (targetY - startY) * ease;
        const spin = i * .19;
        // Stars begin small in the centre cluster, growing continuously as
        // the ring expands to its final diameter.
        const scale = .55 + travel * .68;
        draw3dsStar(touchCtx, x, y, 22.88 * scale, PERFECT_COLORS[i], Math.max(0, fx.life), spin);
      }
    } else if (fx.kind === 'normal') {
      const travel = Math.min(1, progress / .72), ease = 1 - Math.pow(1 - travel, 3);
      for (let i = 0; i < 8; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 4;
        const x = cx + Math.cos(angle) * 150 * ease, y = cy + Math.sin(angle) * 150 * ease;
        draw3dsStar(touchCtx, x, y, 8.712 + travel * 13.464, '#ffe229', Math.max(0, fx.life), 0);
        draw3dsStar(touchCtx, cx + Math.cos(angle) * 78 * ease, cy + Math.sin(angle) * 78 * ease, 2.376 + travel * 3.96, '#ffe229', Math.max(0, fx.life * .9), 0);
      }
    } else if (fx.kind === 'empty') {
      // An empty punch produces only the single yellow centre star.
      const pop = progress < .2 ? .7 + progress * 2.2 : 1.14 - (progress - .2) * .5;
      draw3dsStar(touchCtx, cx, cy, 19.008 * pop, '#ffe229', Math.max(0, fx.life), 0);
    }
    // Judgement belongs to the touch display, not over the GBA playfield.
    if (fx.label) {
      touchCtx.save();
      touchCtx.globalAlpha = Math.max(0, fx.life);
      // 3DS-style result hierarchy: a perfect carries colour, while a miss
      // stays plain white. A normal hit has no text label.
      touchCtx.fillStyle = fx.kind === 'perfect' ? '#ff4cdb' : '#ffffff';
      touchCtx.shadowColor = '#000000'; touchCtx.shadowBlur = 5;
      touchCtx.font = '700 29px DM Mono, monospace'; touchCtx.textAlign = 'center';
      touchCtx.fillText(fx.label, cx, cy + 96);
      touchCtx.restore();
    }
  }
  touchCtx.globalAlpha = 1;
  touchFx = touchFx.filter((fx) => fx.life > 0);
}

function finish() {
  running = false;
  setTimeout(quit, 120);
}

$('#startBtn').onclick = () => { mode = 'karate'; start(); };
$('#tweezersBtn').onclick = tweezersStart;
// Original GBA Rhythm Tweezers SFX audition. Each button plays the exported
// sequence once, using the same PCM, pitch and timing as in-game playback.
for (const button of document.querySelectorAll('[data-tw-sfx]')) {
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const name = button.dataset.twSfx;
    await tweezersSfxLoadPromise;
    const numbers = [...new Set((tweezersSfx[name] || []).map((e) => e.sample).filter(Number.isFinite))];
    await loadOriginalSamples(numbers);
    // Safari/Chrome may keep the shared context suspended until the first
    // gesture. Wait for the resume promise before starting the audition node.
    const ac = audio();
    if (ac.state === 'suspended') await ac.resume();
    // Keep the WebAudio audition, but also use native WAV playback as a
    // reliable fallback on Safari builds that decode these GBA PCM headers
    // yet produce no audible BufferSource output.
    previewAudios.forEach((player) => { player.pause(); player.currentTime = 0; });
    previewAudios = [];
    const sequence = name === 'appear_loop'
      ? [0, 1, 2, 3].map((beat) => ({ ...(tweezersSfx.appear?.[0] || {}), beat }))
      : (tweezersSfx[name] || []);
    for (const eventData of sequence) {
      const player = new Audio(`assets/gba/samples/sample_${String(eventData.sample).padStart(3, '0')}.wav`);
      player.volume = Math.max(.2, eventData.velocity / 127);
      player.playbackRate = eventData.rate ?? (eventData.fixed ? 1 : Math.pow(2, (eventData.note - 60) / 12));
      previewAudios.push(player);
      window.setTimeout(() => player.play().catch(() => {}), eventData.beat * 60000 / 96);
    }
  });
}
stage.addEventListener('pointerdown', () => mode === 'tweezers' ? tweezersPunch() : punch());
touch.addEventListener('pointerdown', () => mode === 'tweezers' ? tweezersPunch() : punch());
// iOS Safari still recognises a double-tap zoom gesture on some canvas builds
// even with viewport constraints.  The game owns touch-end on both screens.
for (const canvas of [stage, touch]) canvas.addEventListener('touchend', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (game.classList.contains('hidden')) start(); else mode === 'tweezers' ? tweezersPunch() : punch(); }
  if (event.code === 'F1' && !game.classList.contains('hidden')) { event.preventDefault(); mode === 'tweezers' ? tweezersStart() : start(); }
  if (event.code === 'F2') cheat = !cheat;
});
