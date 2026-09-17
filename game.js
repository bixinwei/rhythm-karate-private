const $ = (selector) => document.querySelector(selector);

const menu = $('#menu');
const game = $('#game');
const stage = $('#stage');
const ctx = stage.getContext('2d');
const touch = $('#lower');
const touchCtx = touch.getContext('2d');
let mode = 'karate';
const localAuditPerfect = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  && new URLSearchParams(location.search).has('auditPerfect');

// Local exports composed from the GBA decomp's original 4bpp tiles, palette
// banks and animation cells.  These replace the temporary hand-drawn sheet.
const gba = {};
// Keep Karate Man on the same cel-origin path as every later port.  The
// exporter derives these anchors from the original OBJ cell definitions, so
// they must not be duplicated as a hand-maintained table in the renderer.
let karateManifest = {};
const karateManifestLoadPromise = fetch('assets/gba/karate_frames.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Failed to load Karate frame manifest (${response.status})`);
    return response.json();
  })
  .then((manifest) => { karateManifest = manifest; });
// anim_karate_joe_stand, joe_beat, joe_punch_low/high/ouch, joe_barely,
// joe_miss, joe_smirk and joe_happy cover cels 000-026; 035-049 are the
// objects, shadow, shards and flow meter, 064-067 the cue warnings.
for (const cell of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 64, 65, 66, 67]) {
  const image = new Image();
  image.src = `assets/gba/cel${String(cell).padStart(3, '0')}.png?v=obj2d`;
  gba[cell] = image;
}
// The stage tilemap only uses BG palette row 4, and karate_init_flow() points
// bgPalIndex at karate_flow_palette_low before karate_init_gfx3() copies
// palette 5 into that row - so the authored palette 4 of the tilemap is never
// displayed.  Low Flow keeps palette 5, High Flow alternates palettes 6 and 7
// on every beat_anim (the background stripe shimmer).
const karateStages = {};
for (const name of ['low', 'high_a', 'high_b']) {
  const image = new Image();
  image.src = `assets/gba/karate_man_stage_${name}.png?v=flow1`;
  karateStages[name] = image;
}
let karateStagePalette = 'low';

function karateUpdateBgPalette() {
  // karate_update_bg_palette(): BG palette row 4 <- BG_PALETTE_BUFFER(5|6|7).
  if (flowLevel <= 2) { karateStagePalette = 'low'; return; }
  karateStagePalette = karateStagePalette === 'high_a' ? 'high_b' : 'high_a';
}

const BPM = 120;
const BEAT_MS = 60000 / BPM;// GBA mixer values are 0..256 fixed-point.  The ROM sums every voice in its
// scratch domain and midi_directsound_init fills gMidiSampleTable with
// clamp(scratch >> 7, -128, 127), so one full-volume voice already reaches full
// scale and loud passages saturate at the DMA write.  Web Audio clamps the
// final float sum the same way, so the faithful calibration factor is 1: any
// smaller value is a browser-only attenuation the ROM does not have (0.48 made
// every voice 6.4 dB quiet).  tools/measure_mix_levels.mjs measures each level's
// exported bed in these units: at 1.0 the loudest bed peaks at -3.2 dBFS with no
// sample over full scale, i.e. the same headroom the ROM mixes into.
const GBA_MIX_SCALE = 1;
// Cue windows are frame counts, not tick counts (see framesBetweenTicks): every
// ported CueDefinition uses ±3 frames for a hit and ±5 for a barely.
const TRAVEL_BEATS = 1;
// Karate Man is expanded from games/karate_man/karate_man.bs by
// tools/export_beatscript_timeline.py (main script plus the scene entry's
// ending tail), exactly like the other five levels.  Nothing below is
// hand-transcribed any more: the cue chart, warning cels, tempo segments, the
// script's music-bus automation, the beat_anim grid and the ending fades all
// come from that expansion.
const KARATE_CUE_TYPES = { CUE_POT: 'pot', CUE_ROCK: 'rock', CUE_SOCCER_BALL: 'football', CUE_LIGHT_BULB: 'bulb', CUE_BOMB: 'bomb' };
let karateChart = [];
let karateWarnings = [];
let karateTempo = [{ from: 0, bpm: 120 }];
let karateVolumeEvents = [];
let karateBeatAnimTicks = [];
let karateReverbEvents = [];
let karateReverbIndex = 0;
// Pairs of `karate_man_print_textbox` / `_clear_textbox` from the expanded script.
let karateTextBoxEvents = [];
let karateSongEnd = 0;
let karateFanStartBeat = 0;
let karateScreenFade = null;
let karateTimelineReady = false;
const karateTimelineLoadPromise = fetch('assets/gba/karate_man_timeline.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Failed to load Karate timeline (${response.status})`);
    return response.json();
  })
  .then((timeline) => {
    const events = timeline.events;
    // The CueDefinition duration is 0x18 ticks, so each cue is punched one beat
    // after its spawn tick.
    karateChart = events.filter((event) => event.op === 'spawn_cue')
      .map((event) => [event.tick / 24 + TRAVEL_BEATS, KARATE_CUE_TYPES[event.args[0]] ?? String(event.args[0]).toLowerCase()]);
    karateWarnings = events.filter((event) => event.op === 'print_text_f').map((event) => {
      const clear = events.find((next) => next.op === 'clear_text_f' && next.tick > event.tick);
      return { beat: event.tick / 24, id: Number(event.args[0]), duration: ((clear?.tick ?? event.tick + 24) - event.tick) / 24 };
    });
    karateTempo = events.filter((event) => event.op === 'set_tempo').map((event) => ({ from: event.tick / 24, bpm: Number(event.args[0]) }));
    if (!karateTempo.length || karateTempo[0].from !== 0) karateTempo.unshift({ from: 0, bpm: 120 });
    karateVolumeEvents = events.filter((event) => ['set_music_volume', 'mod_music_volume', 'fade_music_out'].includes(event.op)).map((event) => {
      const beat = event.tick / 24;
      if (event.op === 'set_music_volume') return { beat, value: Number(event.args[0]) };
      return event.op === 'mod_music_volume'
        ? { beat, rampTo: Number(event.args[0]), span: Number(event.args[1]) / 24 }
        : { beat, rampTo: 0, span: Math.max(1, Number(event.args[0])) / 24 };
    });
    karateBeatAnimTicks = events.filter((event) => event.op === 'beat_anim').map((event) => event.tick);
    // `run gameplay_set_reverb, N` during the finale.
    karateReverbEvents = events.filter((event) => event.op === 'run' && event.args[0] === 'gameplay_set_reverb')
      .map((event) => ({ beat: event.tick / 24, level: Number(event.args[1] ?? 0) }));
    // The engine's text boxes: a print op opens a window that a clear op closes.
    karateTextBoxEvents = [];
    let openTextBox = null;
    for (const event of events) {
      if (event.op === 'karate_man_print_textbox' && event.args[0] && event.args[0] !== 'NULL') openTextBox = { label: event.args[0], from: event.tick / 24, mode: 'karate' };
      if (event.op === 'karate_man_clear_textbox' && openTextBox) { karateTextBoxEvents.push({ ...openTextBox, until: event.tick / 24 }); openTextBox = null; }
    }
    karateSongEnd = timeline.endTick / 24;
    const fan = events.find((event) => event.op === 'play_music' && String(event.args[0]).includes('karate_fan'));
    karateFanStartBeat = fan ? fan.tick / 24 : karateSongEnd;
    const fade = [...events].reverse().find((event) => event.op === 'fade_screen_out');
    karateScreenFade = fade ? {
      beat: fade.tick / 24,
      span: Math.max(1, Number(fade.args[0])) / 24,
      colour: String(fade.args[1] ?? 'BLACK').toUpperCase().includes('WHITE') ? '#fff' : '#000'
    } : null;
    karateTimelineReady = true;
  });
function karateMusicVolumeAt(beat) {
  let value = 256;
  for (const event of karateVolumeEvents) {
    if (event.beat > beat) break;
    if (event.rampTo != null) {
      if (beat < event.beat + event.span) return value + (event.rampTo - value) * (beat - event.beat) / event.span;
      value = event.rampTo;
      continue;
    }
    value = event.value;
  }
  return value;
}
// games/karate_man/graphics/karate_man_anim.c: every Joe animation, with its
// original cel order and per-cel frame durations.
const KARATE_ANIMATIONS = {
  stand: [[0, 24]],
  beat: [[2, 3], [1, 3], [0, 24]],
  punchLow: [[15, 4], [16, 2], [17, 2], [18, 2], [2, 1], [1, 1], [0, 40]],
  punchHigh: [[20, 1], [19, 3], [21, 2], [22, 2], [23, 2], [2, 1], [1, 1], [0, 15]],
  punchOuch: [[24, 3], [25, 2], [26, 2], [25, 2], [26, 2], [25, 2], [26, 2], [25, 2], [26, 2], [25, 2], [26, 2], [25, 2], [26, 20]],
  barely: [[5, 3], [4, 3], [3, 24]],
  miss: [[8, 3], [7, 3], [6, 24]],
  smirk: [[11, 3], [10, 3], [9, 24]],
  happy: [[14, 3], [13, 3], [12, 24]]
};
function elapsedForBeat(target) {
  let ms = 0;
  for (let i = 0; i < karateTempo.length; i++) {
    const s = karateTempo[i], e = karateTempo[i + 1]?.from ?? target;
    if (target <= s.from) break;
    const span = Math.min(target, e) - s.from;
    if (span > 0) ms += span * 60000 / s.bpm;
    if (target <= e) break;
  }
  return ms;
}
function beatAtElapsed(ms) {
  let beat = 0;
  for (let i = 0; i < karateTempo.length; i++) {
    const s = karateTempo[i], next = karateTempo[i + 1];
    const span = next ? (next.from - s.from) * 60000 / s.bpm : Infinity;
    if (ms <= span) return s.from + ms * s.bpm / 60000;
    ms -= span; beat = next.from;
  }
  return beat;
}
// Karate Man's cue windows are CueDefinition frame counts, not beats: ±3 frames
// for a hit and ±5 for a barely (see punch()).
const KARATE_HIT_FRAMES = 5;
const KARATE_PERFECT_FRAMES = 3;
function karateFramesBetween(fromBeat, toBeat) {
  return (elapsedForBeat(toBeat) - elapsedForBeat(fromBeat)) / 1000 * 60;
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
// Joe's punch animation is a source sprite animation started by the input, so
// it is measured on the shared AudioContext clock rather than on render frames.
let lastPunchAt = -Infinity;
let lastPunchHigh = false;
let lastPunchOuch = false;
// karate_joe_update() counts joe->miss/barely/smirk/happy down over
// ticks_to_frames(0x24) (1.5 beats) and 0x6c (4.5 beats) respectively.
const karateResultUntil = { miss: -Infinity, barely: -Infinity, smirk: -Infinity, happy: -Infinity };
// karate_common_beat_animation() is re-issued by every `beat_anim` command, so
// the current Joe animation is tracked with the audio-clock instant it started.
let karateBeatAnimKind = 'stand';
let karateBeatAnimStart = -Infinity;
let karateBeatAnimIndex = 0;
let lastBeat = -1;
let judgement = '';
let active = [];
let touchFx = [];
let frame = 0;
// No-op in normal gameplay. Local audit mode replaces this with a publisher
// so a browser replay can sample state without changing the visible UI.
let auditStatePublisher = () => {};
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
let scheduledTweezersCueEvents = new Set();
let tweezersAudioScheduler = 0;
// Keep a short Web Audio future queue. This avoids Safari rendering stalls
// from inserting an entire song at once while preserving audio-clock timing.
const TWEEZERS_AUDIO_LOOKAHEAD_BEATS = 3;
let songRun = 0;
const bgmLoadPromise = fetch('assets/gba/karate_bgm_events.json').then((response) => response.json()).then((events) => { originalBgmEvents = events; }).catch(() => []);
const fanLoadPromise = fetch('assets/gba/karate_fan_events.json').then((response) => response.json()).then((events) => { originalFanEvents = events; }).catch(() => []);
const tweezersBgmLoadPromise = fetch('assets/gba/tweezers_bgm_events.json').then((response) => { if (!response.ok) throw new Error(`Failed to load tweezers BGM (${response.status})`); return response.json(); }).then((events) => { tweezersBgmEvents = events; });
const tweezersSfxLoadPromise = Promise.all(['appear', 'long_appear', 'hit', 'barely', 'long_hit', 'long_pull', 'next'].map((name) =>
  fetch(`assets/gba/tweezers_${name}_events.json`).then((response) => { if (!response.ok) throw new Error(`Failed to load tweezers SFX ${name} (${response.status})`); return response.json(); }).then((events) => { tweezersSfx[name] = events; })
));
// Karate Man's effect sequences.  Each one is exported from its own primary
// SongHeader, so the SongHeader volume, MIDI velocity, channel volume and PSG
// instruments all come from the ROM instead of a hand-tuned browser table.
const KARATE_SFX_NAMES = ['fly', 'pot', 'rock', 'ball', 'bulb', 'bomb', 'normal', 'punch', 'barely', 'hard', 'miss_voice', 'score_up', 'score_down'];
const karateSfx = {};
const karateSfxLoadPromise = Promise.all(KARATE_SFX_NAMES.map((name) =>
  fetch(`assets/gba/karate_${name}_events.json`).then((response) => {
    if (!response.ok) throw new Error(`Failed to load Karate SFX ${name} (${response.status})`);
    return response.json();
  }).then((payload) => { karateSfx[name] = { volume: payload.volume ?? 256, events: payload.events ?? payload }; })
)).catch((error) => { console.error('Karate Man SFX load failed:', error); });

function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Anything the ROM plays from a sprite animation (Joe's punch, barely, miss,
// smirk and happy cels) is timed on the shared AudioContext clock so a dropped
// render frame cannot stretch or truncate it.
function audioClock() { return audioCtx ? audioCtx.currentTime : performance.now() / 1000; }

// The device delays what the player actually hears by its output buffer
// (AudioContext.outputLatency, ~20-60 ms on iOS).  Judgement, cue lifetime and
// the visuals must all be derived from that *heard* clock: otherwise an on-beat
// tap is judged late by exactly that latency - which is most of the ROM's
// ±5-tick (about ±100 ms at 128 BPM) Night Walk window - and a cue can be
// retired before the player has heard it.  Scheduling stays on the raw clock.
function outputLatency() {
  if (!audioCtx) return 0;
  const value = audioCtx.outputLatency ?? audioCtx.baseLatency ?? 0;
  return Number.isFinite(value) ? Math.max(0, Math.min(.25, value)) : 0;
}

// The ROM's reverb is fed by the whole mix (its DMA buffer holds dry + wet), so
// every voice goes through one master bus that also drives the reverb worklet.
const REVERB_WORKLET_URL = 'reverb-worklet.js?v=reverb1';
let masterBus = null;
let reverbNode = null;
let reverbWet = 0;
let reverbReady = false;

function master() {
  const ac = audio();
  if (!masterBus) {
    masterBus = ac.createGain();
    masterBus.connect(ac.destination);
    if (ac.audioWorklet) {
      ac.audioWorklet.addModule(REVERB_WORKLET_URL).then(() => {
        reverbNode = new AudioWorkletNode(ac, 'gba-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        reverbNode.parameters.get('wet').value = reverbWet;
        masterBus.connect(reverbNode).connect(ac.destination);
        reverbReady = true;
      }).catch((error) => console.error('Reverb worklet failed to load:', error));
    }
  }
  return masterBus;
}

// gameplay_set_reverb(level) -> midi_player_set_reverb(clamp(level + 35, 0, 127), 2, 2, 4);
// the worklet applies the ROM's `wet >> decay` multiplier and filter shifts.
// Note the ROM starts with gMidiReverb1Wet = 0 (midi_directsound_init) and the
// +35 offset only applies when the script itself calls gameplay_set_reverb, so
// the silent state and the scripted state are different values.
function setReverbLevel(level) {
  reverbWet = Math.max(0, Math.min(127, Number(level) + 35));
  if (reverbNode) reverbNode.parameters.get('wet').value = reverbWet;
}

function resetReverb() {
  reverbWet = 0;
  if (reverbNode) reverbNode.parameters.get('wet').value = reverbWet;
}

function tone(freq, length, type = 'sine', volume = .05, offset = 0) {
  const ac = audio(); const at = ac.currentTime + offset;
  const osc = ac.createOscillator(); const gain = ac.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(volume, at + .008);
  gain.gain.exponentialRampToValueAtTime(.0001, at + length);
  osc.connect(gain).connect(master()); osc.start(at); osc.stop(at + length + .02);
}

// GBA sound players run their sequences at the tempo set by
// `run gameplay_set_sound_tempo, 124` in script_karate_man_main, so a
// sequence beat is 60/124 s - not the 120 BPM the browser used to assume.
const KARATE_SOUND_BEAT_SECONDS = 60 / 124;

// Play one original Karate effect with the shared GBA voice path (sample,
// playback rate, ADSR, loop points and PSG square channels).
function playKarateSfx(name, offsetSeconds = 0) {
  const entry = karateSfx[name];
  if (!entry?.events?.length) return false;
  const ac = audio();
  const base = ac.currentTime + .005 + offsetSeconds;
  let started = false;
  for (const event of entry.events) {
    // PCM voices wait for their decoded sample; a not-yet-loaded sample must
    // never reach startPortedAudioItem(), which expects it to exist.
    if (event.wave == null && !originalSamples[event.sample]) continue;
    const when = Math.max(ac.currentTime + .005, base + event.beat * KARATE_SOUND_BEAT_SECONDS);
    const duration = Math.max(.02, event.length * KARATE_SOUND_BEAT_SECONDS);
    const level = GBA_MIX_SCALE * (event.velocity / 127) * (entry.volume / 256);
    startPortedAudioItem({ type: 'sfx', event, when, duration, level, automationSecondsPerBeat: KARATE_SOUND_BEAT_SECONDS });
    started = true;
  }
  return started;
}

function loadOriginalSamples(neededNumbers) {
  const ac = audio();
  const bgmNumbers = [...originalBgmEvents, ...originalFanEvents, ...tweezersBgmEvents, ...Object.values(tweezersSfx).flat()].map((event) => event.sample).filter(Number.isFinite);
  const karateNumbers = Object.values(karateSfx).flatMap((entry) => entry.events.map((event) => event.sample)).filter(Number.isFinite);
  const allNumbers = [...new Set([...Array.from({ length: 13 }, (_, index) => index + 1), ...karateNumbers, ...bgmNumbers])];
  const numbers = neededNumbers ?? allNumbers;
  return Promise.all(numbers.map((number) => {
    if (originalSamples[number]) return Promise.resolve();
    if (sampleLoads.has(number)) return sampleLoads.get(number);
    const name = String(number).padStart(3, '0');
    const load = fetch(`assets/gba/samples/sample_${name}.wav`).then(async (response) => {
      if (!response.ok) throw new Error(`Missing original sample ${name}`);
      const bytes = await response.arrayBuffer();
      // Safari's Promise-form decodeAudioData can remain pending for some of
      // the short GBA PCM buffers. Use the callback form, which reliably
      // settles for both valid and invalid buffers.
      originalSamples[number] = await new Promise((resolve, reject) => {
        ac.decodeAudioData(bytes, resolve, reject);
      });
    });
    sampleLoads.set(number, load);
    return load;
  }));
}

function playMusic(wholeBeat) {
  if (wholeBeat < 0 || wholeBeat === lastMusicBeat) return;
  lastMusicBeat = wholeBeat;
  // Notes are scheduled by the Karate look-ahead queue. Keep this only as a
  // safe fallback if the local JSON has not loaded yet.
  if (!originalBgmEvents.length) tone(wholeBeat % 4 === 0 ? 92 : 116, .1, 'triangle', .035);
}

// Karate Man's two music tracks are inserted through a short look-ahead queue on
// the shared audio clock.  Handing the complete song (1487 notes) to Web Audio
// in one call stalls Safari's renderer, which is why Rhythm Tweezers already
// uses this shape; the cursor also guarantees every note is placed exactly once.
const KARATE_AUDIO_LOOKAHEAD_BEATS = 3;
let karateMusicScheduler = 0;
const karateMusicCursor = { bgm: 0, fan: 0 };

function scheduleKarateNote(event, absoluteBeat) {
  const sample = originalSamples[event.sample];
  if (!sample) return;
  const ac = audio();
  const endBeat = Math.min(karateSongEnd, absoluteBeat + event.length);
  const duration = Math.max(.025, (elapsedForBeat(endBeat) - elapsedForBeat(absoluteBeat)) / 1000);
  // Confirmed from the isolated original-MIDI audition: Bank 125, channel 0
  // is Karate Man's background vocal/call-and-response track.  Keep only
  // this track in the foreground; all prior guessed sample boosts are gone.
  // SongHeader 90 x the script's own set_music_volume/mod_music_volume.
  const level = GBA_MIX_SCALE * (event.velocity / 127) * (90 / 256) * (karateMusicVolumeAt(absoluteBeat) / 256);
  const when = audioSongStart + elapsedForBeat(absoluteBeat) / 1000;
  const source = ac.createBufferSource(); const gain = ac.createGain();
  source.buffer = sample; source.playbackRate.value = event.fixed ? 1 : Math.pow(2, (event.note - 60) / 12);
  gain.gain.value = level;
  source.connect(gain).connect(master());
  scheduledMusicNodes.push(source);
  // Respect the score duration instead of the old universal 0.48 s cap, which
  // cut the call-and-response samples short (many sustain 1.5-3.75 beats).  The
  // buffer still ends at its own sample boundary.
  source.start(when); source.stop(when + duration);
  source.onended = () => {
    source.disconnect(); gain.disconnect();
    const index = scheduledMusicNodes.indexOf(source); if (index >= 0) scheduledMusicNodes.splice(index, 1);
  };
}

function scheduleKarateMusicTrack(track, events, startBeat, nowBeat, horizonBeat) {
  let cursor = karateMusicCursor[track];
  while (cursor < events.length) {
    const event = events[cursor];
    const absoluteBeat = startBeat + event.beat;
    if (absoluteBeat > horizonBeat) break;
    cursor += 1;
    // Advance past anything the render loop missed (backgrounded tab) rather
    // than dumping a burst of late notes into the mix.
    if (absoluteBeat >= karateSongEnd || absoluteBeat < nowBeat) continue;
    scheduleKarateNote(event, absoluteBeat);
  }
  karateMusicCursor[track] = cursor;
}

function scheduleKarateMusic() {
  if (!audioCtx || !audioSongStart) return;
  const nowBeat = beatAtElapsed((audio().currentTime - audioSongStart) * 1000);
  const horizonBeat = nowBeat + KARATE_AUDIO_LOOKAHEAD_BEATS;
  scheduleKarateMusicTrack('bgm', originalBgmEvents, 0, nowBeat, horizonBeat);
  // set_music_volume 150 / play_music s_karate_fan_seqData at tick 3648 (beat 152).
  scheduleKarateMusicTrack('fan', originalFanEvents, 152, nowBeat, horizonBeat);
}

function startKarateAudioScheduler(run) {
  stopKarateAudioScheduler();
  const queue = () => {
    if (run !== songRun || !running || mode !== 'karate') return;
    scheduleKarateMusic();
  };
  queue();
  karateMusicScheduler = setInterval(queue, 40);
}

function stopKarateAudioScheduler() {
  if (karateMusicScheduler) clearInterval(karateMusicScheduler);
  karateMusicScheduler = 0;
}

function scheduleTweezersMusic() {
  const ac = audio();
  const nowBeat = Math.max(0, (ac.currentTime - audioSongStart) * 96 / 60);
  for (const [index, event] of tweezersBgmEvents.entries()) {
    // Samples may finish decoding after gameplay has begun.  Never attempt
    // to schedule a note already in the past; future notes are added as soon
    // as their shared sample bank is ready.
    if (event.beat > 116 || event.beat > nowBeat + TWEEZERS_AUDIO_LOOKAHEAD_BEATS || event.beat < nowBeat - .04 || scheduledTweezersEvents.has(index)) continue;
    const sample = originalSamples[event.sample];
    const when = audioSongStart + event.beat * 60 / 96;
    const duration = Math.max(.025, event.length * 60 / 96);
    if (sample) {
      const source = ac.createBufferSource(); const gain = ac.createGain(); const cleanup = ac.createBiquadFilter(); const clarity = ac.createBiquadFilter(); source.buffer = sample;
      source.playbackRate.value = Math.pow(2, (event.note - 60) / 12);
      // The ROM samples are intentionally kept intact.  A modest shelf only
      // compensates for the duller Web Audio/browser speaker path.
      // The exported GBA PCM samples have a low peak level. Apply the
      // requested boost at the music bus while retaining the original note
      // velocities and playback rates.
      gain.gain.value = GBA_MIX_SCALE * (event.velocity / 127) * (127 / 256) * (220 / 256);
      // Keeping every original PCM voice in a direct path was allowing their
      // low ends to build up on phone speakers.  This is a playback-only
      // correction: no samples, notes, lengths, or beat positions are changed.
      cleanup.type = 'highpass'; cleanup.frequency.value = 92; cleanup.Q.value = .45;
      clarity.type = 'highshelf'; clarity.frequency.value = 2200; clarity.gain.value = 5.5;
      source.connect(gain).connect(cleanup).connect(clarity).connect(master()); source.start(when); source.stop(when + duration); scheduledMusicNodes.push(source);
      scheduledTweezersEvents.add(index);
    }
  }
}

function playTweezersSfx(name, eventBeat = null) {
  const events = tweezersSfx[name]; if (!events?.length) return;
  const sfxVolumes = { appear: 208, long_appear: 80, hit: 115, barely: 110, long_hit: 40, long_pull: 80, next: 60 };
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
      gain.gain.value = GBA_MIX_SCALE * (event.velocity / 127) * (sfxVolumes[name] / 256); source.connect(gain).connect(master());
      const when = Math.max(ac.currentTime + .005, baseWhen + offset);
      source.start(when); source.stop(when + Math.max(.45, event.length * 60 / 96 + .2));
      scheduledMusicNodes.push(source);
    } else {
      const delay = Math.max(0, baseWhen + offset - ac.currentTime);
      tone(280 * Math.pow(2, (event.note - 60) / 12), Math.max(.04, event.length * 60 / 96), 'triangle', .04, delay);
    }
  }
}

// The GBA beat-script invokes cue_spawn and the vegetable transition event
// from its tick scheduler. Pre-schedule those same events against the audio
// clock so a dropped render frame cannot make a sound disappear or drift.
function scheduleTweezersEventAudio() {
  const nowBeat = Math.max(0, (audio().currentTime - audioSongStart) * 96 / 60);
  // The source script emits the sound on the cue tick. Queue a small future
  // window from an audio scheduler, never from requestAnimationFrame.
  for (const [index, event] of tweezers.events.entries()) {
    if (scheduledTweezersCueEvents.has(index)) continue;
    if (event.beat > nowBeat + TWEEZERS_AUDIO_LOOKAHEAD_BEATS) continue;
    if (event.kind === 'cue') playTweezersSfx(event.cue === 'long' ? 'long_appear' : 'appear', event.beat);
    else if (event.kind === 'veg') playTweezersSfx('next', event.beat);
    scheduledTweezersCueEvents.add(index);
  }
}

function startTweezersAudioScheduler(run) {
  stopTweezersAudioScheduler();
  const queue = () => {
    if (run !== songRun || !running || mode !== 'tweezers') return;
    scheduleTweezersEventAudio();
    scheduleTweezersMusic();
  };
  queue();
  tweezersAudioScheduler = setInterval(queue, 40);
}

function stopTweezersAudioScheduler() {
  if (tweezersAudioScheduler) clearInterval(tweezersAudioScheduler);
  tweezersAudioScheduler = 0;
}

// The ROM's per-cue hit sound, barely sound and "ouch" sound are all separate
// sequences (see the karate CueDefinitions); an irrelevant input only gets the
// punch whoosh.
function punchSound() { if (!playKarateSfx('punch')) { tone(145, .07, 'sawtooth', .08); tone(300, .04, 'square', .025, .015); } }
function hitSound(perfect, type = 'normal', ouch = false) {
  const kind = ouch ? 'hard' : perfect ? (type === 'football' ? 'ball' : type) : 'barely';
  if (!playKarateSfx(kind)) { tone(perfect ? 660 : 410, .16, 'triangle', .07); if (perfect) tone(990, .2, 'sine', .035, .04); }
}
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
  lastPunchAt = -Infinity;
  lastPunchOuch = false;
  karateResultUntil.miss = karateResultUntil.barely = karateResultUntil.smirk = karateResultUntil.happy = -Infinity;
  karateBeatAnimKind = 'stand';
  karateBeatAnimStart = -Infinity;
  karateBeatAnimIndex = 0;
  karateReverbIndex = 0;
  resetReverb();
  activeTextBox = null;
  karateStagePalette = 'low';
  karateMusicCursor.bgm = 0;
  karateMusicCursor.fan = 0;
  Promise.all([bgmLoadPromise, fanLoadPromise, karateManifestLoadPromise, karateSfxLoadPromise, karateTimelineLoadPromise]).then(() => loadOriginalSamples()).then(() => {
    if (run !== songRun) return;
    startAt = performance.now() + elapsedForBeat(3);
    audioSongStart = audio().currentTime + elapsedForBeat(3) / 1000;
    running = true;
    startKarateAudioScheduler(run);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(loop);
  });
}

function quit() {
  running = false;
  songRun += 1;
  stopTweezersAudioScheduler();
  stopKarateAudioScheduler();
  activeTextBox = null;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} }
  scheduledMusicNodes = [];
  cancelAnimationFrame(frame);
  game.classList.add('hidden');
  menu.classList.remove('hidden');
}

function songBeat() {
  // Both games schedule audio on the Web Audio clock. Derive gameplay beat
  // from the same clock so visuals, object cues and input judgment cannot
  // drift away from the music over the course of a song - measured from the
  // moment the player actually hears it (see outputLatency()).
  if (audioCtx && audioSongStart) {
    const elapsedMs = (audioCtx.currentTime - outputLatency() - audioSongStart) * 1000;
    if (mode === 'tweezers') return elapsedMs / tweezersBeatMs;
    return beatAtElapsed(elapsedMs);
  }
  return mode === 'tweezers' ? (performance.now() - startAt) / tweezersBeatMs : beatAtElapsed(performance.now() - startAt);
}

function loop() {
  const beat = songBeat();
  if (portedModes[mode]) return portedLoop();
  if (mode === 'tweezers') return tweezersLoop(beat);
  if (beat > karateSongEnd) return finish();
  update(beat);
  render(beat);
  auditStatePublisher();
  frame = requestAnimationFrame(loop);
}

// Rhythm Tweezers runtime. The timeline, cell art, and sprite layout are
// taken from the decomp's rhythm_tweezers engine and main beatscript.
const tweezers = { cells: {}, events: [], active: [], falling: [], veg: 'onion', nextVeg: 'onion', scrollStart: -1, scrollDuration: .5, scrollDirection: 1, rotation: 0, cycleAt: -1, tweezersAt: -1, lastEvent: -1, faceState: 0, verticalOffset: 0, perfectHits: 0 };
for (let i = 0; i <= 90; i++) { const image = new Image(); image.src = `assets/gba/tweezers/cel${String(i).padStart(3,'0')}.png?v=1`; tweezers.cells[i] = image; }
const tweezersBg = {}; for (const veg of ['onion','turnip','potato']) { const image = new Image(); image.src = `assets/gba/tweezers/bg_${veg}.png?v=1`; tweezersBg[veg] = image; }
const tweezersChartLoadPromise = fetch('assets/gba/tweezers/chart.json').then((r) => { if (!r.ok) throw new Error(`Failed to load tweezers chart (${r.status})`); return r.json(); }).then((v) => { tweezers.events = v; });
// The opening cue uses cells 35–40.  Do not start its clock until those
// source frames and the first vegetable are decoded; otherwise a cold iPad
// cache can reveal only the final, already-grown hair cel.
function waitForImage(image) {
  if (image.complete && image.naturalWidth) return Promise.resolve();
  if (image.complete) return Promise.reject(new Error(`Failed to load ${image.src}`));
  return new Promise((resolve, reject) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', () => reject(new Error(`Failed to load ${image.src}`)), { once: true });
  });
}
const tweezersOpeningVisualsReady = Promise.all(Object.values(tweezers.cells).map(waitForImage).concat(Object.values(tweezersBg).map(waitForImage)));
const tweezersBeatMs = 60000 / 96;
const tweezersProgramSamples = { 23: 2, 26: 3, 37: 5, 38: 7, 39: 10, 41: 5, 42: 8, 125: 1, 127: 11 };
function tweezersStart() {
  const context = audio();
  const audioContextReady = context.state === 'suspended' ? context.resume() : Promise.resolve();
  mode = 'tweezers'; running = false; songRun += 1; const run = songRun;
  stopTweezersAudioScheduler();
  stopKarateAudioScheduler();
  activeTextBox = null;
  // Falling-hair rotation is driven by the GBA engine RNG, so reset the
  // standalone level to a deterministic stream for reproducible replays.
  tweezersRandomState = 0;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} } scheduledMusicNodes = [];
  menu.classList.add('hidden'); game.classList.remove('hidden'); game.classList.remove('tweezers-mode');
  // `rhythm_tweezers_init_tweezers` creates one visible sprite at -0x200.
  // The beat event starts its orbit; it does not create or reveal it.
  tweezers.active = []; tweezers.falling = []; tweezers.veg = 'onion'; tweezers.nextVeg = 'onion'; tweezers.scrollStart = -1; tweezers.scrollDirection = 1; tweezers.rotation = -0x200; tweezers.tweezersAt = -1; tweezers.cycleAt = -1; tweezers.lastEvent = -1; tweezers.faceState = 0; tweezers.verticalOffset = 0; tweezers.perfectHits = 0; tweezers.tweezerAction = null; touchFx = []; scheduledTweezersEvents = new Set();
  // Show the game immediately.  Audio decoding must not leave the player on
  // an empty black screen, and this mode only needs its own small sample set.
  tweezersRender(-3);
  Promise.all([audioContextReady, tweezersBgmLoadPromise, tweezersSfxLoadPromise, tweezersChartLoadPromise, tweezersOpeningVisualsReady, tweezersManifestLoadPromise]).then(() => {
    if (run !== songRun || mode !== 'tweezers') return;
    // Match the ROM's deterministic startup: decode every sample referenced
    // by this level before opening the lead-in. No late/cold-cache audio
    // insertion is allowed once the beat clock starts.
    const allEvents = [...tweezersBgmEvents, ...Object.values(tweezersSfx).flat()];
    const needed = [...new Set(allEvents.map((event) => event.sample).filter(Number.isFinite))];
    return loadOriginalSamples(needed).then(() => {
      if (run !== songRun || mode !== 'tweezers') return;
      startAt = performance.now() + tweezersBeatMs * 3; audioSongStart = audio().currentTime + tweezersBeatMs * 3 / 1000;
      running = true;
      scheduledTweezersCueEvents = new Set();
      startTweezersAudioScheduler(run);
      cancelAnimationFrame(frame); frame = requestAnimationFrame(loop);
    });
  }).catch((error) => {
    running = false;
    console.error('Rhythm Tweezers resource load failed:', error);
  });
}
function tweezersLoop(beat) {
  if (beat > 120) return finish();
  if (localAuditPerfect) {
    // Automated browser runs can advance the audio clock by several frames at
    // once. Replay the next fresh cue from its source tick instead of relying
    // on a single animation-frame-sized judgment window.
    const hair = tweezers.active
      .filter(item => item.state === 'fresh')
      .sort((a, b) => a.hitBeat - b.hitBeat)[0];
    if (hair && hair.hitBeat <= beat + 0.5) {
      audioSongStart = audio().currentTime - hair.hitBeat * tweezersBeatMs / 1000;
      tweezersPunch(hair.hitBeat);
    }
  }
  tweezersUpdate(beat);
  tweezersRender(beat); auditStatePublisher(); frame = requestAnimationFrame(loop);
}
function tweezersUpdate(beat) {
  if (tweezers.verticalOffset > 0) tweezers.verticalOffset = Math.max(0, tweezers.verticalOffset - 1 / 37.5);
  while (tweezers.events.length && tweezers.events[tweezers.lastEvent + 1]?.beat <= beat) {
    const event = tweezers.events[++tweezers.lastEvent];
    if (event.kind === 'cycle') tweezers.cycleAt = event.beat;
    if (event.kind === 'tweezers') tweezers.tweezersAt = event.beat;
    if (event.kind === 'veg') { tweezers.nextVeg = event.veg; tweezers.scrollStart = event.beat; tweezers.scrollDuration = .5; }
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
    }
  }
  for (const hair of tweezers.active) {
    // rhythm_tweezers_cue_* Barely Windows in frames: short ±5, long ±4,
    // fast ±6 (see framesBetweenBeats).
    const missFrames = hair.fast ? 6 : hair.type === 'long' ? 4 : 5;
    // `rhythm_tweezers_cue_miss` only re-enables the beat-script loop.  It
    // does not create a falling hair or an extra tweezers sprite; the cue's
    // own hair remains until update_short/update_long despawns it at 2x time.
    if (hair.state === 'fresh' && framesBetweenBeats(hair.hitBeat, beat, tweezersBeatMs) > missFrames) hair.state = 'miss';
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
        rotationSpeed: tweezersRandom(0x1f) - 15 });
    }
    // The long-cue updater keeps the cue sprite alive until duration * 2,
    // just like the short-cue updater. Pull completion only changes the cel
    // to the remaining black-point/stubble state; it must not despawn the cue
    // half a beat after the input.
    if (hair.type === 'long' && hair.pullComplete && hair.state === 'hit') hair.state = 'stubble';
    if ((hair.state === 'hit' || hair.state === 'stubble' || hair.state === 'miss') && beat - hair.beat > 8) hair.state = 'done';
  }
  tweezers.active = tweezers.active.filter((h) => h.state !== 'done');
  tweezers.falling = tweezers.falling.filter((hair) => {
    const frames = Math.max(0, Math.floor((beat - hair.spawnedAt) * 37.5));
    // Original fixed-point trajectory: distance += speed += 0x20 each GBA
    // frame, then the sprite receives distance >> 8 as its base Y.
    return hair.y + frames * (frames + 1) / 16 < 190;
  });
}
function tweezersPunch(targetBeat = null) {
  if (!running || mode !== 'tweezers') return;
  const beat = Number.isFinite(targetBeat) ? targetBeat : songBeat(); const hair = tweezers.active.find((h) => h.state === 'fresh' && Math.abs(framesBetweenBeats(h.hitBeat, beat, tweezersBeatMs)) <= (h.fast ? 6 : h.type === 'long' ? 4 : 5));
  if (!hair) { tweezers.tweezerAction = { kind: 'miss', at: beat }; missSound(); createImpact('empty'); return; }
  const perfectFrames = hair.fast || hair.type === 'long' ? 4 : 3;
  const perfect = Math.abs(framesBetweenBeats(hair.hitBeat, beat, tweezersBeatMs)) <= perfectFrames; hair.state = 'hit'; hair.hitAt = beat; hair.perfect = perfect;
  if (perfect) tweezers.perfectHits++;
  if (hair.type === 'long') {
    // gameplay_get_last_hit_offset() is the frame offset from gameplay_update_cue;
    // the ROM subtracts that frame count from ticks_to_frames(0x0C) = 18.75
    // frames at 96 BPM.
    const hitOffsetFrames = framesBetweenBeats(hair.hitBeat, beat, tweezersBeatMs);
    hair.pull = true; hair.pullAt = beat; hair.pullRotation = tweezersOrbitAt(beat).rotation;
    // Source: ticks_to_frames(0x0C) - gameplay_get_last_hit_offset().
    hair.pullDuration = Math.max(1, 18.75 - hitOffsetFrames) / 37.5;
    tweezers.tweezerAction = { kind: 'hidden', at: beat };
  }
  else tweezers.tweezerAction = { kind: perfect ? 'hit' : 'barely', at: beat };
  if (hair.type === 'short') {
    tweezers.faceState = 1;
    tweezers.verticalOffset = 2;
    if (!tweezers.active.some((item) => item !== hair && item.state === 'fresh')) tweezers.faceState = 2;
  }
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
const tweezersManifestLoadPromise = fetch('assets/gba/tweezers/frames.json').then((r) => { if (!r.ok) throw new Error(`Failed to load tweezers frame manifest (${r.status})`); return r.json(); }).then((v) => { tweezersManifest = Object.fromEntries(Object.entries(v).map(([k,val]) => [Number(k),val])); });
function tweezersRender(beat) {
  ctx.clearRect(0,0,stage.width,stage.height); ctx.imageSmoothingEnabled = false;
  const scrolling = tweezers.scrollStart >= 0 && beat < tweezers.scrollStart + tweezers.scrollDuration;
  if (tweezers.scrollStart >= 0 && !scrolling) {
    // rhythm_tweezers_update_scroll() calls gameplay_reset_cues() at the
    // destination. Every new vegetable starts with an empty face; old hair
    // sprites must not survive the transition into the next phrase.
    tweezers.active = [];
    tweezers.falling = [];
    tweezers.tweezerAction = null;
    tweezers.faceState = 0;
    tweezers.verticalOffset = 0;
    tweezers.veg = tweezers.nextVeg;
    tweezers.scrollStart = -1;
  }
  const t = scrolling ? Math.max(0, Math.min(1, (beat - tweezers.scrollStart) / tweezers.scrollDuration)) : 0;
  const slide = scrolling ? (1 - Math.cos(Math.PI * t)) * .5 * stage.width * tweezers.scrollDirection : 0;
  ctx.save();
  ctx.translate(0, tweezers.verticalOffset * 4);
  ctx.translate(-slide, 0);
  const bg = tweezersBg[tweezers.veg]; if (bg?.complete) ctx.drawImage(bg, 0, 0, stage.width, stage.height); else { ctx.fillStyle='#fff'; ctx.fillRect(0,0,stage.width,stage.height); }
  // The engine's affine angle unit is one turn per 0x800, and the orbit
  // distance in rhythm_tweezers.c is 0x4c — 76 native screen pixels.
  // Keeping both values intact puts the tweezers around the vegetable face
  // instead of collapsed in the centre.
  const orbit = tweezersOrbitAt(beat); const orbitX = orbit.x, orbitY = orbit.y;
  const vegCell = (tweezers.veg === 'turnip' ? 3 : tweezers.veg === 'potato' ? 6 : 0) + tweezers.faceState;
  drawTweezersCell(vegCell,120,16,4,1); // vegetable face, native sprite origin
  for (const hair of tweezers.active) {
    if (hair.state === 'done') continue;
    const hAngle = hair.orbitRotation * Math.PI * 2 / 0x800;
    const x = 120 + Math.cos(hAngle) * 76, y = 16 + Math.sin(hAngle) * 76;
    const cell = hair.type === 'long' ?
      (hair.state === 'stubble' ? (hair.perfect ? 42 : 41) : tweezersLongHairCell(hair, beat)) :
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
  // anim_rhythm_tweezers_short_hair: 35×1, 36×1, 37×1, 38×1,
  // 39×1, 40×3, then 39×40 frames.
  const frame = Math.max(0, Math.floor((beat - hair.beat) * 37.5));
  if (frame < 5) return 35 + frame;
  if (frame < 8) return 40;
  return 39;
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
  // `beat_anim` commands are consumed from the expanded script, so Joe's beat
  // animation restarts exactly when karate_common_beat_animation() would run
  // (the finale and the closing phrase have no beat_anim at all).
  while (karateBeatAnimIndex < karateBeatAnimTicks.length && karateBeatAnimTicks[karateBeatAnimIndex] <= beat * 24) {
    karateBeatAnimIndex++;
    karateBeatAnimation(beat);
  }
  while (karateReverbIndex < karateReverbEvents.length && karateReverbEvents[karateReverbIndex].beat <= beat) {
    setReverbLevel(karateReverbEvents[karateReverbIndex++].level);
  }
  setActiveTextBox(karateTextBoxEvents.find((entry) => beat >= entry.from && beat < entry.until));
  while (chartIndex < karateChart.length && karateChart[chartIndex][0] - beat <= TRAVEL_BEATS) {
    const [hitBeat, type] = karateChart[chartIndex++];
    active.push({ hitBeat, spawnBeat: hitBeat - 1, type, state: 'flying', impact: 0, cuePlayed: false, accentPlayed: false, missed: false });
    if (!playKarateSfx('fly')) launchSound(type);
  }
  for (const item of active) {
    if (item.state === 'flying' && !item.cuePlayed && beat >= item.hitBeat - 1) {
      item.cuePlayed = true;
      if (!karateSfx.fly?.events?.length) throwCue(item.type);
    }
    const cueTime = beat - item.spawnBeat;
    // The source engine does not despawn at the input window.  A missed
    // object carries on from t=1 through t=2, lands, and the Cue itself can
    // remain alive until 0x78 script ticks (five beats at this tempo).
    if (item.state === 'flying' && !item.missed && cueTime > 1.5) {
      item.missed = true;
      // karate_cue_update(): once the object leaves the player's range the cue
      // is flagged missed and Joe plays his miss face for ticks_to_frames(0x24).
      // The Flow Meter is not reset by a miss in the ROM.
      karateResultUntil.miss = beat + 1.5;
      combo = 0;
      perfectRun = false;
      judgement = 'MISS';
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

// karate_common_beat_animation(): restart Joe's beat animation, with the miss /
// happy / barely / smirk variants overriding it while their timers run.  The
// miss variant also plays the original "nua" voice, exactly as the ROM does
// each time the animation is (re)started.
function karateBeatAnimation(beat) {
  karateBeatAnimKind = beat < karateResultUntil.miss ? 'miss'
    : beat < karateResultUntil.happy ? 'happy'
    : beat < karateResultUntil.barely ? 'barely'
    : beat < karateResultUntil.smirk ? 'smirk'
    : 'beat';
  karateBeatAnimStart = audioClock();
  if (karateBeatAnimKind === 'miss') playKarateSfx('miss_voice');
  // karate_common_beat_animation() also advances the background palette.
  karateUpdateBgPalette();
}

// karate_increment_flow() / karate_decrement_flow(): six meter cels, a short
// jingle on entering High (3) or Low (2) Flow, and an immediate palette swap
// with bg reset to 0 before the next beat_anim continues the alternation.
function karateFlowLevel(next) {
  const value = Math.max(0, Math.min(5, next));
  if (value === flowLevel) return;
  flowLevel = value;
  if (value === 3) { karateStagePalette = 'high_a'; playKarateSfx('score_up'); }
  else if (value === 2) { karateStagePalette = 'low'; playKarateSfx('score_down'); }
  else if (value < 2) karateStagePalette = 'low';
}

function punch() {
  if (!running) return;
  const beat = songBeat();
  if (beat < 0) return;
  // karate_cue_* CueDefinitions use the same frame windows as every other game
  // (hit ±3, barely ±5 frames), and elapsedForBeat() is the karate beat clock's
  // real-time map, so the window stays 50/83.3 ms across the tempo changes.
  const candidate = active.find((item) => item.state === 'flying' && Math.abs(karateFramesBetween(item.hitBeat, beat)) <= KARATE_HIT_FRAMES);
  // karate_input_event(): every punch starts Joe's animation (low below flow 3,
  // high at 3+) and plays the punch whoosh, even when it hits nothing.
  punchSound();
  lastPunchAt = audioClock();
  lastPunchHigh = flowLevel > 2;
  lastPunchOuch = false;
  const wasHigh = flowLevel > 2;
  if (!candidate && !cheat) {
    // The ROM only plays the punch animation for an irrelevant input; the Flow
    // Meter is untouched (gameplay_assess_irrelevant_inputs handles grading).
    combo = 0;
    perfectRun = false;
    judgement = 'MISS';
    // An empty punch is acknowledged only by the small yellow star.
    createImpact('empty');
    return;
  }
  const timedPerfect = cheat || (candidate && Math.abs(karateFramesBetween(candidate.hitBeat, beat)) <= KARATE_PERFECT_FRAMES);
  // karate_cue_hit(): a rock or bomb punched below flow 3 is the "ouch" hit.
  // It still counts, but costs a flow level, plays the hard SFX and never
  // shows the normal punch cels.
  const ouch = !cheat && Boolean(candidate) && timedPerfect && !wasHigh
    && (candidate.type === 'rock' || candidate.type === 'bomb');
  const perfect = timedPerfect && !ouch;
  if (candidate) {
    candidate.state = 'hit';
    candidate.hitAt = audioClock();
    candidate.ouch = ouch;
    candidate.impactPos = objectPosition(1);
  }
  lastPunchOuch = ouch;
  if (ouch || !perfect) karateFlowLevel(flowLevel - 1);   // karate_cue_hit (ouch) / karate_cue_barely
  else karateFlowLevel(flowLevel + 1);                    // karate_increment_flow()
  if (!perfect) {
    // karate_cue_barely(): always shows the high punch cels plus the barely face.
    lastPunchHigh = true;
    karateResultUntil.barely = beat + 1.5;
  }
  if (perfect && wasHigh && candidate?.type === 'rock') karateResultUntil.smirk = beat + 1.5;
  if (perfect && wasHigh && candidate?.type === 'bomb') karateResultUntil.happy = beat + 4.5;
  score += perfect ? 100 : 60;
  combo += 1;
  best = Math.max(best, combo);
  judgement = perfect ? 'PERFECT' : 'OK!';
  if (!perfect) perfectRun = false;
  localStorage.karateBest = best;
  hitSound(perfect, candidate?.type ?? 'normal', ouch);
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
    startedAt: audioClock(),
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
  const stageImage = karateStages[karateStagePalette];
  if (stageImage?.complete) ctx.drawImage(stageImage, 0, 0, w, h);
  else { ctx.fillStyle = '#ff7418'; ctx.fillRect(0, 0, w, h); }
  drawFlowMeter();
  // Native game positions: Joe at (80, 88), hit effect at (158, 54).
  drawFighter(320, 352, beat);
  drawItems(beat);
  drawOriginalHitEffects(beat);
  drawCueWarning(beat);
  drawTextBox();
  // The scene entry's ending: fade_screen_out ramps the playfield to BLACK and
  // the trailing rests hold it until the script stops.
  const fade = karateScreenFadeAlpha(beat);
  if (fade > 0) {
    ctx.save(); ctx.globalAlpha = fade; ctx.fillStyle = karateScreenFade.colour;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

function karateScreenFadeAlpha(beat) {
  if (!karateScreenFade) return 0;
  return Math.max(0, Math.min(1, (beat - karateScreenFade.beat) / karateScreenFade.span));
}

// //  //  SCRIPT TEXT BOXES  //  //  //
// The scripts print the ROM's text printer for a fixed number of beats.  The
// printer settings are anchor/width/alignment, taken from each engine:
//   karate_man      text_printer_create_new(memID, 4, 112, 30) at (124, 32), centred
//   night_walk      text_printer_create_new(memID, 1, 240, 30) at (0, 40), centred, palette 6
//   power_calligraphy  text_printer_get_unformatted_line_anim(SMALL, bottom-centre) at (128, 146)
// The ROM strings are Shift-JIS glyph text (text_printer_data.c holds 1bpp glyphs
// over a filled tile box, so no image asset is involved), which is why the port
// renders the translated lines with its own font while keeping the ROM's timing,
// anchor, line breaks and lifetime.  The box uses the printer palette's dark entry
// and the glyphs its light entry (0x000000 / 0xF8F8F8 in these levels' palettes).
const TEXT_BOX_LAYOUTS = {
  karate: { centreX: 124, y: 32, maxWidth: 112, anchor: 'top', size: 11 },
  night_walk: { centreX: 120, y: 40, maxWidth: 240, anchor: 'top', size: 11 },
  power_calligraphy: { centreX: 128, y: 146, maxWidth: 232, anchor: 'bottom', size: 10 }
};
const TEXT_BOX_STRINGS = {
  // karate_man_print_textbox D_0805abc4
  D_0805abc4: ['别忘了　跟上节奏哦！'],
  // print_text_s D_0805b1fc / D_0805b220 / D_0805b250
  D_0805b1fc: ['跟着音乐　跳起来吧！'],
  D_0805b220: ['在音乐结束前　把天空铺满星星吧！'],
  D_0805b250: ['马上就要结束啦！'],
  // print_text_f D_0805d2dc
  D_0805d2dc: ['来吧！　写书法！！']
};
const TEXT_BOX_FONT = '600 %dpx "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
let activeTextBox = null;

function setActiveTextBox(entry) {
  activeTextBox = entry ? { lines: TEXT_BOX_STRINGS[entry.label] ?? [], layout: TEXT_BOX_LAYOUTS[entry.mode] ?? TEXT_BOX_LAYOUTS.karate } : null;
}

function drawTextBox() {
  if (!activeTextBox?.lines.length) return;
  const { lines, layout } = activeTextBox;
  const scale = 4;
  ctx.save();
  ctx.font = TEXT_BOX_FONT.replace('%d', String(layout.size * scale));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lineHeight = layout.size * scale * 1.2;
  const width = Math.min(layout.maxWidth * scale, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 16 * scale);
  const height = lineHeight * lines.length + 8 * scale;
  const centreX = layout.centreX * scale;
  const top = layout.anchor === 'bottom' ? layout.y * scale - height : layout.y * scale;
  ctx.fillStyle = 'rgba(0,0,0,.86)';
  ctx.fillRect(centreX - width / 2, top, width, height);
  ctx.fillStyle = '#f8f8f8';
  ctx.shadowColor = 'rgba(0,0,0,.7)';
  ctx.shadowOffsetY = 2;
  lines.forEach((line, index) => ctx.fillText(line, centreX, top + 4 * scale + index * lineHeight));
  ctx.restore();
}

function drawCueWarning(beat) {
  const warning = karateWarnings.find((entry) => beat >= entry.beat && beat < entry.beat + entry.duration);
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
    if (item.state !== 'hit' || (audioClock() - item.hitAt) > 2 / 60) continue;
    ctx.save(); ctx.imageSmoothingEnabled = false;
    // sprite_create places the original effect at (158, 54); cels are
    // exported around their native origin and then mapped at 4×.
    const scale = 4;
    ctx.drawImage(image, 158 * scale - 27 * scale, 54 * scale - 32 * scale,
      image.naturalWidth * scale, image.naturalHeight * scale);
    ctx.restore();
  }
}

function drawFighter(x, y, beat) {
  const cell = karateFighterCell();
  const image = gba[cell]; const scale = 4;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  const meta = karateManifest[cell] ?? karateManifest[0];
  if (!meta) { ctx.restore(); return; }
  const { originX, originY } = meta;
  if (image?.complete) ctx.drawImage(image, x - originX * scale, y - originY * scale, image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.restore();
}

// Pick Joe's cel the way karate_common_beat_animation() does: a punch animation
// owns the sprite until its final frames, then the beat animation (with the
// miss / happy / barely / smirk beat variants) takes over.
function karateFighterCell() {
  const punchAge = (audioClock() - lastPunchAt) * 60;
  const punch = lastPunchOuch ? KARATE_ANIMATIONS.punchOuch
    : lastPunchHigh ? KARATE_ANIMATIONS.punchHigh
    : KARATE_ANIMATIONS.punchLow;
  const punchTotal = punch.reduce((sum, frame) => sum + frame[1], 0);
  if (punchAge < punchTotal - 4) return animationCell(punch, punchAge);
  return animationCell(KARATE_ANIMATIONS[karateBeatAnimKind] ?? KARATE_ANIMATIONS.beat,
    (audioClock() - karateBeatAnimStart) * 60);
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
// Result animations run for ~28 rendered frames in the reference captures.
const TOUCH_FX_SECONDS = 28 / 60;

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
    // Result animations last ~28 rendered frames in the reference capture and
    // must not speed up on a 120 Hz display, so their age comes from the shared
    // clock instead of one step per animation frame.
    const life = 1 - (audioClock() - fx.startedAt) / TOUCH_FX_SECONDS;
    if (life <= 0) continue;
    const progress = 1 - life, cx = fx.x, cy = fx.y;
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
        draw3dsStar(touchCtx, x, y, 22.88 * scale, PERFECT_COLORS[i], Math.max(0, life), spin);
      }
    } else if (fx.kind === 'normal') {
      const travel = Math.min(1, progress / .72), ease = 1 - Math.pow(1 - travel, 3);
      for (let i = 0; i < 8; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 4;
        const x = cx + Math.cos(angle) * 150 * ease, y = cy + Math.sin(angle) * 150 * ease;
        draw3dsStar(touchCtx, x, y, 8.712 + travel * 13.464, '#ffe229', Math.max(0, life), 0);
        draw3dsStar(touchCtx, cx + Math.cos(angle) * 78 * ease, cy + Math.sin(angle) * 78 * ease, 2.376 + travel * 3.96, '#ffe229', Math.max(0, life * .9), 0);
      }
    } else if (fx.kind === 'empty') {
      // An empty punch produces only the single yellow centre star.
      const pop = progress < .2 ? .7 + progress * 2.2 : 1.14 - (progress - .2) * .5;
      draw3dsStar(touchCtx, cx, cy, 19.008 * pop, '#ffe229', Math.max(0, life), 0);
    }
    // Judgement belongs to the touch display, not over the GBA playfield.
    if (fx.label) {
      touchCtx.save();
      touchCtx.globalAlpha = Math.max(0, life);
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
  touchFx = touchFx.filter((item) => audioClock() - item.startedAt < TOUCH_FX_SECONDS);
}

function finish() {
  running = false;
  stopTweezersAudioScheduler();
  stopKarateAudioScheduler();
  auditStatePublisher();
  setTimeout(quit, 120);
}

// Additional GBA games are driven directly from the expanded local
// BeatScripts.  Their clocks, image manifests and original PCM music all load
// before the lead-in begins; no render-frame clock is used for judgement.
const portedModes = {
  spaceball: { label: '太空棒球', bg: 'spaceball_bg_map.png', backdrop: '#000070', idle: 1, action: [1,2,3,4,5], actor: [190,105], object: 6, duration: { CUE_LOW_FAST:12, CUE_LOW:24, CUE_HIGH:48, CUE_HIGH_FAST:36 }, music: [['spaceball_bgm_events',75]], sfx: { spawn:'spaceball_throw_events', high:'spaceball_high_events', hit:'spaceball_hit_events', barely:'spaceball_barely_events', land:'spaceball_land_events' } },
  samurai_slice: { label: '拔刀术', bg: 'samurai_slice_bg_map.png', backdrop: '#f8f8f8', overlays: ['samurai_slice_bg_map_fog_bottom.png','samurai_slice_bg_map_fog_top.png'], idle: 20, action: [21,22,23,24,25,26,27], actor: [105,108], object: 58, duration: { CUE_FIRST:24, CUE_SECOND:24 }, music: [['samurai_bgm1_events',100],['samurai_bgm2_events',100],['samurai_bgm3_events',100],['samurai_result_events',100]], sfx: { spawn:'samurai_appear_events', phrase1a:'samurai_phrase1a_events', phrase2a:'samurai_phrase2a_events', phrase3a:'samurai_phrase3a_events', phrase1b:'samurai_phrase1b_events', phrase2b:'samurai_phrase2b_events', phrase3b:'samurai_phrase3b_events', hit:'samurai_cut1_events', hit2:'samurai_cut2_events', barely:'samurai_miss_events' } },
  night_walk: { label: '夜空漫步', bg: 'night_walk_bg_map.png', backdrop: '#000000', idle: 7, action: [3,4,5,4,3,7,8,9,10], actor: [64,120], object: 29, duration: { CUE_KICK:192, CUE_SNARE:192, CUE_ROLL:192, CUE_CYMBAL:192, CUE_STAR_WAND:192 }, music: [['night_walk_bgm_events',80]], sfx: { count:'night_walk_count_events', kick:'night_walk_kick_events', snare:'night_walk_snare_events', cymbal:'night_walk_cymbal_events', roll:'night_walk_roll_events', default:'night_walk_default_events', open:'night_walk_open_events', barely:'night_walk_barely_events', barelySnare:'night_walk_barely_snare_events', miss:'night_walk_miss_events', fall:'night_walk_fall_events', damage:'night_walk_damage_events' } },
  power_calligraphy: { label: '节奏写书', bg: 'power_calligraphy_bg_map.png', backdrop: '#f8f8f8', idle: 128, action: [128,129], actor: [120,84], object: 0, duration: {}, music: [['calligraphy_bgm1_events',80],['calligraphy_bgm2_events',80],['calligraphy_bgm3_events',80],['calligraphy_end_events',80]], sfx: { hit:'calligraphy_hit_events', hit2:'calligraphy_hit2_events', barely:'calligraphy_barely_events', barelyUnuu:'calligraphy_unuu_events', barelyOuch:'calligraphy_ouch_events', miss:'calligraphy_miss_events', ho:'calligraphy_ho_events', start:'calligraphy_start_events', swing1:'calligraphy_swing1_events', chargeVoice:'calligraphy_charge_voice_events', ha1:'calligraphy_ha1_events', ha2:'calligraphy_ha2_events', ha3:'calligraphy_ha3_events', break:'calligraphy_break_events', swing2:'calligraphy_swing2_events', furi:'calligraphy_furi_events' } }
};
const ported = { data: {}, mode: null, timeline: null, frames: {}, manifest: {}, bg: null, overlays: [], peopleFrames: {}, peopleManifest: {}, sfx: {}, cueIndex: 0, cues: [], balloons: [], nightStars: [], actionAt: -99, actionHit: false, actionCue: null, peopleStumbleAt: -99, failedAt: -1, failedCue: null, cueSpawningDisabled: false, actionGood: false, starWandAt: -1, scheduled: new Set(), tempo: [], audioQueue: [], audioQueueIndex: 0, audioQueueReady: false, reverb: [], reverbIndex: 0, textBoxes: [] };
// Match the GBA engine's 16-bit LCG used by PLATFORM_TYPE_RANDOM.
let gbaRandomState = 0;
function gbaRandom(max) {
  gbaRandomState = (gbaRandomState * 109 + 1021) & 0xffff;
  return Math.floor((gbaRandomState * max) / 0x10000);
}
let tweezersRandomState = 0;
function tweezersRandom(max) {
  tweezersRandomState = (tweezersRandomState * 109 + 1021) & 0xffff;
  return Math.floor((tweezersRandomState * max) / 0x10000);
}
let spaceballRandomState = 0, spaceballStars = [];
function spaceballRandom(max) {
  spaceballRandomState = (spaceballRandomState * 109 + 1021) & 0xffff;
  return Math.floor((spaceballRandomState * max) / 0x10000);
}
function resetSpaceballStar(index, zoom) {
  const scale = spaceballRandom(3) + 1;
  spaceballStars[index] = {
    x: (spaceballRandom(240) - 120) * scale,
    y: (spaceballRandom(160) - 80) * scale,
    z: zoom + scale
  };
}
function updateSpaceballStars(zoom) {
  const zMin = zoom + 1, zMax = zoom + 4;
  for (let i = 0; i < spaceballStars.length; i++) {
    const star = spaceballStars[i]; star.z -= 8 / 256;
    if (star.z < zMin || star.z > zMax) resetSpaceballStar(i, zoom);
  }
}
const PORTED_ASSET_REV = 'gba-ports-13';
const PORTED_AUDIO_LOOKAHEAD = 5;
function portedAssetUrl(path) { return `${path}?v=${PORTED_ASSET_REV}`; }

function gameAssetPrefix(id) { return `assets/gba/${id}`; }
function latestPortedEvent(op, tick, before = Infinity) {
  const events = ported.timeline?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.tick <= tick && event.tick < before && event.op === op) return event;
  }
  return null;
}
function signedHex16(value) {
  const parsed = Number.parseInt(String(value), 0) & 0xffff;
  return parsed & 0x8000 ? parsed - 0x10000 : parsed;
}
function portedEnum(value, table, fallback = 0) {
  if (Object.prototype.hasOwnProperty.call(table, value)) return table[value];
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function animationCell(sequence, elapsedFrames, loop = false) {
  if (!sequence.length) return 0;
  const total = sequence.reduce((sum, frame) => sum + frame[1], 0);
  let cursor = loop && total ? ((elapsedFrames % total) + total) % total : Math.max(0, elapsedFrames);
  for (const [cell, duration] of sequence) {
    if (cursor < duration) return cell;
    cursor -= duration;
  }
  return sequence.at(-1)[0];
}
function framesBetweenTicks(from, to) { return Math.max(0, (secondsAtTick(to) - secondsAtTick(from)) * 60); }
function signedFramesBetweenTicks(from, to) { return (secondsAtTick(to) - secondsAtTick(from)) * 60; }
async function loadPortedMode(id) {
  if (ported.data[id]) return ported.data[id];
  const prefix = gameAssetPrefix(id);
  const [timeline, manifest] = await Promise.all([
    fetch(portedAssetUrl(`assets/gba/${id}_timeline.json`)).then(r => { if (!r.ok) throw new Error(`Missing ${id} BeatScript timeline`); return r.json(); }),
    fetch(portedAssetUrl(`${prefix}/frames.json`)).then(r => { if (!r.ok) throw new Error(`Missing ${id} animation manifest`); return r.json(); })
  ]);
  const frames = {}, imageLoads = [];
  if (Object.values(manifest).some(meta => Number.isFinite(meta.atlasX))) {
    const atlas = new Image(); atlas.src = portedAssetUrl(`${prefix}/atlas.png`); imageLoads.push(waitForImage(atlas));
    for (const number of Object.keys(manifest)) frames[Number(number)] = atlas;
  } else {
    for (const [number, meta] of Object.entries(manifest)) {
      const image = new Image(); image.src = portedAssetUrl(`${prefix}/${meta.file}`); frames[Number(number)] = image; imageLoads.push(waitForImage(image));
    }
  }
  const bg = new Image(); bg.src = portedAssetUrl(`${prefix}/${portedModes[id].bg}`); imageLoads.push(waitForImage(bg));
  const overlays = (portedModes[id].overlays ?? []).map(file => {
    const image = new Image(); image.src = portedAssetUrl(`${prefix}/${file}`); imageLoads.push(waitForImage(image)); return image;
  });
  let peopleManifest = {}, peopleFrames = {};
  if (id === 'power_calligraphy') {
    peopleManifest = await fetch(portedAssetUrl('assets/gba/power_calligraphy_people/frames.json')).then(r => r.json());
    const peopleAtlas = new Image(); peopleAtlas.src = portedAssetUrl('assets/gba/power_calligraphy_people/atlas.png'); imageLoads.push(waitForImage(peopleAtlas));
    for (const number of Object.keys(peopleManifest)) peopleFrames[Number(number)] = peopleAtlas;
  }
  const music = await Promise.all(portedModes[id].music.map(async ([name, volume]) => {
    const result = await fetch(portedAssetUrl(`assets/gba/${name}.json`)).then(r => { if (!r.ok) throw new Error(`Missing ${name}`); return r.json(); });
    return { name, volume: result.volume ?? volume, loopStartBeats: Number(result.loopStartBeats) || 0, loopBeats: Number(result.loopBeats) || 0, events: result.events ?? result };
  }));
  const sfx = {};
  await Promise.all(Object.entries(portedModes[id].sfx ?? {}).map(async ([kind,name]) => { const result = await fetch(portedAssetUrl(`assets/gba/${name}.json`)).then(r => { if (!r.ok) throw new Error(`Missing ${name}`); return r.json(); }); sfx[kind] = { volume: result.volume ?? 256, events: result.events ?? result }; }));
  const needed = [...new Set([...music.flatMap(track => track.events), ...Object.values(sfx).flatMap(entry => entry.events)].map(event => event.sample).filter(Number.isFinite))];
  const result = { timeline, manifest: Object.fromEntries(Object.entries(manifest).map(([k,v]) => [Number(k),v])), frames, bg, overlays, peopleManifest: Object.fromEntries(Object.entries(peopleManifest).map(([k,v]) => [Number(k),v])), peopleFrames, music, sfx, needed, imageLoads };
  ported.data[id] = result; return result;
}
function setPortedTempo(timeline) {
  const all = timeline.events.filter(e => e.op === 'set_tempo').map(e => ({ tick: e.tick, bpm: Number(e.args[0]) }));
  if (!all.length || all[0].tick !== 0) all.unshift({ tick: 0, bpm: 120 });
  ported.tempo = all;
}
function secondsAtTick(tick) {
  let seconds = 0;
  for (let i = 0; i < ported.tempo.length; i++) {
    const segment = ported.tempo[i], next = ported.tempo[i + 1]?.tick ?? tick;
    if (tick <= segment.tick) break;
    const span = Math.min(tick, next) - segment.tick;
    if (span > 0) seconds += span * 60 / (24 * segment.bpm);
    if (tick <= next) break;
  }
  return seconds;
}
function tempoAtTick(tick) {
  let bpm=120;
  for (const segment of ported.tempo) { if (segment.tick > tick) break; bpm=segment.bpm; }
  return bpm;
}
// gameplay_update_cue() advances the cue's counter once per 60 Hz frame and
// gameplay_calculate_input_timing() compares that *frame* counter against
// `duration + <CueDefinition window>`, so every hit/barely/miss window is a
// real-time window: ±3 frames = ±50.0 ms for a hit, ±5 frames = ±83.3 ms for a
// barely, independent of BPM.  The values in the CueDefinitions are frame counts
// even though the surrounding engine talks about ticks/beats, and
// gameplay_get_last_hit_offset() hands the hit/barely callbacks that same frame
// offset.  Judging in ticks instead makes the window BPM-dependent and up to 56%
// wider than the ROM (Rhythm Tweezers runs at 96 BPM), so the judgment paths use
// signedFramesBetweenTicks()/framesBetweenBeats() rather than raw tick deltas.
function framesBetweenBeats(fromBeat, toBeat, beatMs) {
  return (toBeat - fromBeat) * beatMs / 1000 * 60;
}
function portedTick() {
  return portedTickAtAudioTime(audio().currentTime);
}
function portedTickAtAudioTime(audioTime) {
  // audioTime is an AudioContext timestamp; the player hears it outputLatency()
  // later, so song time is measured from the heard moment.
  const elapsed = Math.max(0, audioTime - outputLatency() - audioSongStart);
  let passed = 0;
  for (let i = 0; i < ported.tempo.length; i++) {
    const s = ported.tempo[i], next = ported.tempo[i + 1];
    const duration = next ? (next.tick - s.tick) * 60 / (24 * s.bpm) : Infinity;
    if (elapsed <= passed + duration) return s.tick + (elapsed - passed) * 24 * s.bpm / 60;
    passed += duration;
  }
  return 0;
}
function portedMusicVolumeAt(tick) {
  let value = 256;
  for (const event of ported.timeline.events) {
    if (event.op === 'set_music_volume' && event.tick <= tick) value = Number(event.args[0]);
    if ((event.op === 'mod_music_volume' || event.op === 'fade_music_out') && event.tick <= tick) {
      // fade_music_out <ticks> ramps the current music-bus volume to silence;
      // every level's scene entry ends with one before the screen fade.
      const target = event.op === 'mod_music_volume' ? Number(event.args[0]) : 0;
      const span = Math.max(1, Number(event.args[1] ?? event.args[0]));
      const before = value;
      if (tick < event.tick + span) return before + (target - before) * (tick - event.tick) / span;
      value = target;
    }
  }
  return value;
}

// fade_screen_out <ticks>[, <colour>]: the fade command does not consume script
// time (the BeatScript handler returns immediately), so the playfield ramps over
// N ticks from the command's tick and the following `rest` commands hold it.
function portedScreenFade(tick) {
  let fade = null;
  for (const event of ported.timeline.events) {
    if (event.op !== 'fade_screen_out' || event.tick > tick) continue;
    fade = { tick: event.tick, span: Math.max(1, Number(event.args[0])), colour: String(event.args[1] ?? 'BLACK').toUpperCase().includes('WHITE') ? '#fff' : '#000' };
  }
  if (!fade) return null;
  return { alpha: Math.max(0, Math.min(1, (tick - fade.tick) / fade.span)), colour: fade.colour };
}
function configurePortedSample(source, event, pitchSemitones = 0, rateScale = 1) {
  const note = event.playNote ?? event.note;
  const baseNote = event.baseNote ?? 60;
  const bend = ((event.pitchWheel ?? 0x2000) - 0x2000) / 0x2000 * (event.pitchRange ?? 2);
  source.playbackRate.value = (event.fixed ? 1 : Math.pow(2,(note-baseNote+bend)/12)) * Math.pow(2,pitchSemitones/12) * rateScale;
  if (event.sampleLoop?.length === 2 && source.buffer) {
    const [start,end] = event.sampleLoop;
    if (end > start && end <= source.buffer.length) {
      source.loop = true;
      const sampleRate = event.sampleRate || source.buffer.sampleRate;
      source.loopStart = start / sampleRate;
      source.loopEnd = end / sampleRate;
    }
  }
}
function connectPortedVoice(source, event, level, when, duration, pitchSemitones = 0, rateScale = 1, automationSecondsPerBeat = .5) {
  const ac = audio(), envelope = ac.createGain(), channel = ac.createGain();
  let volume = event.volume ?? 127, expression = event.expression ?? 127, panning = event.panning ?? 64;
  const voiceDuration = schedulePortedEnvelope(envelope,level,when,duration,event);
  channel.gain.setValueAtTime(volume / 127 * expression / 127,when);
  const panner = ac.createStereoPanner ? ac.createStereoPanner() : null;
  if (panner) panner.pan.setValueAtTime(Math.max(-1,Math.min(1,(panning-64)/63)),when);
  let pitchWheel = event.pitchWheel ?? 0x2000, pitchRange = event.pitchRange ?? 2;
  const note = event.playNote ?? event.note, baseNote = event.baseNote ?? 60;
  for (const point of event.automation ?? []) {
    const at = when + point.beat * automationSecondsPerBeat;
    if (at >= when + duration) break;
    if (point.volume != null) volume = point.volume;
    if (point.expression != null) expression = point.expression;
    if (point.panning != null) panning = point.panning;
    if (point.pitchWheel != null) pitchWheel = point.pitchWheel;
    if (point.pitchRange != null) pitchRange = point.pitchRange;
    channel.gain.setValueAtTime(volume / 127 * expression / 127,at);
    if (panner) panner.pan.setValueAtTime(Math.max(-1,Math.min(1,(panning-64)/63)),at);
    if (!event.fixed && (point.pitchWheel != null || point.pitchRange != null)) {
      const bend = (pitchWheel - 0x2000) / 0x2000 * pitchRange;
      const rate = Math.pow(2,(note-baseNote+bend+pitchSemitones)/12) * rateScale;
      if (source.playbackRate) source.playbackRate.setValueAtTime(rate,at);
      else if (source.frequency) source.frequency.setValueAtTime(440*Math.pow(2,(note-69+bend+pitchSemitones)/12)*rateScale,at);
    }
  }
  source.connect(envelope).connect(channel);
  if (panner) channel.connect(panner).connect(master()); else channel.connect(master());
  source.start(when); source.stop(when + voiceDuration + .01); scheduledMusicNodes.push(source);
  source.onended = () => {
    source.disconnect(); envelope.disconnect(); channel.disconnect(); if (panner) panner.disconnect();
    const index = scheduledMusicNodes.indexOf(source); if (index >= 0) scheduledMusicNodes.splice(index,1);
  };
}
function schedulePortedEnvelope(gain, level, when, noteDuration, event) {
  if (event.adsrInit == null) { schedulePortedGain(gain,level,when,noteDuration); return noteDuration; }
  const full=127*65536, frame=1/60;
  const initial=Math.max(0,Math.min(1,event.adsrInit/full));
  const sustain=Math.max(0,Math.min(1,event.adsrSustain/full));
  const attackFrames=event.adsrAttack ? Math.max(0,(full-event.adsrInit)/event.adsrAttack) : 0;
  const decayFrames=event.adsrDecay ? Math.max(0,(full-event.adsrSustain)/event.adsrDecay) : 0;
  const attackEnd=attackFrames*frame, decayEnd=attackEnd+decayFrames*frame;
  function envelopeAt(seconds) {
    if (seconds < attackEnd && attackEnd) return initial+(1-initial)*seconds/attackEnd;
    if (seconds < decayEnd && decayEnd>attackEnd) return 1-(1-sustain)*(seconds-attackEnd)/(decayEnd-attackEnd);
    if (!event.adsrFade) return sustain;
    return Math.max(0,sustain-event.adsrFade*(seconds-decayEnd)*60/full);
  }
  gain.gain.setValueAtTime(level*initial,when);
  if (attackEnd>0) gain.gain.linearRampToValueAtTime(level*envelopeAt(Math.min(noteDuration,attackEnd)),when+Math.min(noteDuration,attackEnd));
  if (noteDuration>attackEnd && decayEnd>attackEnd) gain.gain.linearRampToValueAtTime(level*envelopeAt(Math.min(noteDuration,decayEnd)),when+Math.min(noteDuration,decayEnd));
  const fadeSeconds=event.adsrFade ? event.adsrSustain/event.adsrFade*frame : Infinity;
  const naturalEnd=decayEnd+fadeSeconds;
  if (noteDuration>decayEnd && event.adsrFade) gain.gain.linearRampToValueAtTime(level*envelopeAt(Math.min(noteDuration,naturalEnd)),when+Math.min(noteDuration,naturalEnd));
  const atRelease=envelopeAt(noteDuration);
  gain.gain.setValueAtTime(level*atRelease,when+noteDuration);
  const releaseSeconds=event.adsrRelease ? atRelease*full/event.adsrRelease*frame : 0;
  if (releaseSeconds>0) gain.gain.linearRampToValueAtTime(0,when+noteDuration+releaseSeconds);
  else gain.gain.setValueAtTime(0,when+noteDuration);
  return Math.min(noteDuration+releaseSeconds,Number.isFinite(naturalEnd)?naturalEnd:Infinity);
}
function schedulePortedGain(gain, level, when, duration) {
  // WebAudio otherwise cuts an arbitrary non-zero PCM sample at note-off,
  // producing clicks that the GBA instrument release envelope does not.
  const attack = Math.min(.002,duration*.15), release = Math.min(.006,duration*.25);
  gain.gain.setValueAtTime(0,when);
  gain.gain.linearRampToValueAtTime(level,when+attack);
  gain.gain.setValueAtTime(level,Math.max(when+attack,when+duration-release));
  gain.gain.linearRampToValueAtTime(0,when+duration);
}
function schedulePortedMusic() {
  const starts = ported.timeline.events.filter(e => e.op === 'play_music');
  const names = { s_shibafu1_bgm_seqData: 'spaceball_bgm_events', s_iai_bgm1_seqData: 'samurai_bgm1_events', s_iai_bgm2_seqData: 'samurai_bgm2_events', s_iai_bgm3_seqData: 'samurai_bgm3_events', s_iai_result_seqData: 'samurai_result_events', s_4beat_bgm_seqData: 'night_walk_bgm_events', s_shuji_bgm1_seqData: 'calligraphy_bgm1_events', s_shuji_bgm2_seqData: 'calligraphy_bgm2_events', s_shuji_bgm3_seqData: 'calligraphy_bgm3_events', s_shuji_bgm_end_seqData: 'calligraphy_end_events' };
  for (const [startIndex, start] of starts.entries()) {
    const name = names[start.args[0]], track = ported.music.find(item => item.name === name); if (!track) continue;
    // `play_music` owns the one GBA music player: the next command replaces
    // the current sequence rather than layering a second copy over it.
    const replaceTick = Math.min(starts[startIndex + 1]?.tick ?? Infinity, ported.timeline.endTick);
    const loopTicks = track.loopBeats * 24, loopStartTick = track.loopStartBeats * 24, loopEndTick = loopStartTick + loopTicks;
    for (let repeat = 0; start.tick + (repeat ? loopEndTick + (repeat-1)*loopTicks : 0) < replaceTick; repeat++) {
      const loopOffset = repeat * loopTicks;
      for (const note of track.events) {
        const noteTick = note.beat * 24;
        if (repeat && (!loopTicks || noteTick < loopStartTick || noteTick >= loopEndTick)) continue;
        if (!Number.isFinite(note.sample) && !note.wave) continue;
        const atTick = start.tick + loopOffset + noteTick; if (atTick >= replaceTick) continue;
        const endTick = Math.min(replaceTick, atTick + note.length * 24), when = audioSongStart + secondsAtTick(atTick), duration = Math.max(.02, secondsAtTick(endTick) - secondsAtTick(atTick));
        // SongHeader volume and BeatScript music-bus volume are distinct GBA
        // mixer stages.  Preserve both instead of applying a browser-only boost.
        const level = GBA_MIX_SCALE * (note.wave ? .32 : 1) * (note.velocity / 127) * (track.volume / 256) * (portedMusicVolumeAt(atTick) / 256);
        queuePortedAudio({ type:'music', note, when, duration, level, automationSecondsPerBeat: secondsAtTick(atTick+24)-secondsAtTick(atTick) });
      }
      if (!loopTicks) break;
    }
  }
}
function queuePortedAudio(item) {
  if (!ported.audioQueueReady) { ported.audioQueue.push(item); return; }
  let low = ported.audioQueueIndex, high = ported.audioQueue.length;
  while (low < high) { const mid = (low + high) >> 1; if (ported.audioQueue[mid].when <= item.when) low = mid + 1; else high = mid; }
  ported.audioQueue.splice(low,0,item); pumpPortedAudio();
}
// GBA noise channel (midi_psg_update_id case PSG_NOISE_CHANNEL): the note
// number indexes midi_psg_noise_freq_table, whose value is a SOUND4CNT_L
// register - bits 0-2 select the divider, bit 3 the short 7-bit LFSR, bits 4-7
// the shift clock.  The channel is a 1-bit LFSR clocked at
// 524288 / divider / 2^(shift+1) Hz, so synthesise that sequence directly
// instead of rendering the ROM's own noise voice as a square wave.
const GBA_NOISE_DIVIDERS = [.5, 1, 2, 3, 4, 5, 6, 7];
const gbaNoiseBuffers = new Map();

function gbaNoiseBuffer(ac, register, short, seconds) {
  const divider = GBA_NOISE_DIVIDERS[register & 7] ?? 1;
  const shift = (register >> 4) & 0xF;
  const clock = 524288 / divider / Math.pow(2, shift + 1);
  const length = Math.max(.25, Math.ceil(seconds / .25) * .25);
  const key = `${register}:${short}:${length}:${ac.sampleRate}`;
  const cached = gbaNoiseBuffers.get(key);
  if (cached) return cached;
  const buffer = ac.createBuffer(1, Math.max(1, Math.ceil(length * ac.sampleRate)), ac.sampleRate);
  const data = buffer.getChannelData(0);
  let lfsr = 0x7fff, level = 1, phase = 0;
  for (let i = 0; i < data.length; i++) {
    phase += clock / ac.sampleRate;
    while (phase >= 1) {
      phase -= 1;
      const bit = (lfsr ^ (lfsr >> 1)) & 1;
      lfsr = (lfsr >> 1) | (bit << 14);
      if (short) lfsr = (lfsr & ~0x40) | (bit << 6);
      level = (lfsr & 1) ? 1 : -1;
    }
    data[i] = level;
  }
  gbaNoiseBuffers.set(key, buffer);
  return buffer;
}

function startPortedAudioItem(item) {
  const ac = audio(), event = item.note ?? item.event;
  const when = Math.max(ac.currentTime + .005,item.when);
  const duration = Math.max(.02,item.duration - Math.max(0,when-item.when));
  const source = event.wave === 'noise' ? ac.createBufferSource() : event.wave ? ac.createOscillator() : ac.createBufferSource();
  if (event.wave === 'noise') {
    // The LFSR rate comes from the register, so the buffer is played at pitch.
    source.buffer = gbaNoiseBuffer(ac, event.noiseRegister ?? 0x44, Boolean(event.noiseShort), duration + .05);
  }
  else if (event.wave) {
    const bend=((event.pitchWheel??0x2000)-0x2000)/0x2000*(event.pitchRange??2);
    source.type=event.wave; source.frequency.value=440*Math.pow(2,(event.note-69+bend+(item.pitchSemitones??0))/12)*(item.rateScale??1);
  }
  else {
    const sample=originalSamples[event.sample]; if (!sample) throw new Error(`Unloaded original PCM ${event.sample}`);
    source.buffer=sample; configurePortedSample(source,event,item.pitchSemitones,item.rateScale);
  }
  connectPortedVoice(source,event,item.level,when,duration,item.pitchSemitones,item.rateScale,item.automationSecondsPerBeat);
}
function pumpPortedAudio() {
  if (!ported.audioQueueReady) return;
  const horizon = audio().currentTime + PORTED_AUDIO_LOOKAHEAD;
  while (ported.audioQueueIndex < ported.audioQueue.length && ported.audioQueue[ported.audioQueueIndex].when <= horizon) {
    startPortedAudioItem(ported.audioQueue[ported.audioQueueIndex++]);
  }
  if (ported.audioQueueIndex > 512) {
    ported.audioQueue.splice(0,ported.audioQueueIndex); ported.audioQueueIndex=0;
  }
}
function playPortedSfx(kind, atTick = null, eventVolume = 256, eventPitch = 0, rateScale = 1) {
  const entry = ported.sfx[kind], events = entry?.events; if (!events?.length) return;
  // GBA sequence offsets are authored at the local song tempo. Derive the
  // scale from the trigger tick unless a caller explicitly supplies one.
  // Night Walk's main script sets 128 BPM at tick 0. Its drumtech sequences
  // (kick/snare/cymbal/count/offbeat) use local quarter-beat offsets, so they
  // must use that same tempo instead of the generic 120-BPM helper default.
  const effectiveRateScale = atTick == null || rateScale !== 1 ? rateScale : tempoAtTick(atTick) / 120; // trigger-tempo sequence timing
  const ac = audio(), base = atTick == null ? ac.currentTime : audioSongStart + secondsAtTick(atTick);
  for (const event of events) {
    if (!originalSamples[event.sample]) continue;
    const level = GBA_MIX_SCALE * (event.velocity / 127) * (entry.volume / 256) * (eventVolume / 256);
    const when = Math.max(ac.currentTime + .005, base + event.beat * 60 / (120*effectiveRateScale));
    const duration=Math.max(.15,event.length*60/(120*effectiveRateScale));
    const item={ type:'sfx', event, when, duration, level, pitchSemitones:eventPitch/256, rateScale:effectiveRateScale, automationSecondsPerBeat:60/(120*effectiveRateScale) };
    if (atTick == null) startPortedAudioItem(item); else queuePortedAudio(item);
  }
}
function playNightWalkDrum(cue, perfect, tick) {
  if (!perfect) {
    if (cue.kind === 'CUE_KICK') playPortedSfx('barely',tick,256,0xc00);
    else {
      playPortedSfx('barelySnare',tick,256,0x400);
      playPortedSfx('barely',tick,256,0xc00);
    }
    return;
  }
  if (cue.kind === 'CUE_KICK') return playPortedSfx('kick',tick);
  if (cue.kind === 'CUE_SNARE') {
    // drum_seq_night_walk_snare1: drum 4 at t=0, drum 17 at +0x04 ticks.
    playPortedSfx('kick',tick); playPortedSfx('snare',tick + 4); return;
  }
  if (cue.kind === 'CUE_CYMBAL' || cue.kind === 'CUE_STAR_WAND') {
    // drum_seq_night_walk_cymbal1: kick/snare at t=0, cymbal at +0x0C.
    playPortedSfx('kick',tick); playPortedSfx('snare',tick);
    playPortedSfx('cymbal',tick + 12,128); return;
  }
  if (cue.kind === 'CUE_ROLL') {
    // The GBA selects one of four roll phrases with agb_random(4). The
    // exported web audio uses the corresponding extracted phrase, but the
    // RNG side effect must remain in order for later random platforms.
    const rollVariant = gbaRandom(4);
    playPortedSfx('kick',tick);
    const rolls = [
      [[8,32],[12,48],[16,64],[20,96]],
      [[8,48],[12,64],[20,80]],
      [[8,64]],
      []
    ][rollVariant];
    for (const [delay,volume] of rolls) playPortedSfx('roll',tick+delay,volume);
    if (rollVariant === 2) playPortedSfx('barelySnare',tick+12,64);
  }
}
function playNightWalkOffbeat(cue) {
  const tick = cue.hit + 12;
  if (cue.kind === 'CUE_SNARE') {
    playPortedSfx('open',tick); playPortedSfx('open',tick+6); playPortedSfx('kick',tick+12); return;
  }
  if (cue.kind === 'CUE_CYMBAL') {
    playPortedSfx('open',tick); playPortedSfx('open',tick+4,192); playPortedSfx('open',tick+8,160); playPortedSfx('kick',tick+12); return;
  }
  playPortedSfx('open',tick); playPortedSfx('kick',tick+12);
}
function schedulePortedTimelineSfx() {
  const calligraphy = {
    s_shuji_ho_seqData:'ho', s_f_shuji_start_seqData:'start', s_f_shuji_swing1_seqData:'swing1',
    s_f_shuji_v_funuue_seqData:'chargeVoice', s_f_shuji_v_ha1_seqData:'ha1', s_f_shuji_v_ha2_seqData:'ha2',
    s_f_shuji_v_ha3_seqData:'ha3', s_rabbit_break2_seqData:'break', s_f_shuji_swing2_seqData:'swing2', s_furi_seqData:'furi'
  };
  for (const event of ported.timeline.events) {
    if (event.op === 'night_walk_play_drumtech_note' && Number(event.args[0]) === 38) playPortedSfx('count',event.tick,Number(event.args[1]),Number(event.args[2]));
    if (!/^play_sfx(?:_vol(?:_pitch)?)?$/.test(event.op) || event.args[0] === 'NULL') continue;
    const kind = calligraphy[event.args[0]]; if (!kind) continue;
    // Calligraphy changes tempo mid-song (127/161/98 BPM). The original
    // sequence player scales note offsets with the active tempo; using the
    // fixed 120-BPM WebAudio default shifts voice/swing sounds in those bars.
    playPortedSfx(kind,event.tick,Number(event.args[1] ?? 256),Number(event.args[2] ?? 0),tempoAtTick(event.tick) / 120);
  }
}
function startPortedMode(id) {
  mode = id; running = false; const run = ++songRun; audio();
  stopKarateAudioScheduler();
  activeTextBox = null;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} } scheduledMusicNodes = [];
  menu.classList.add('hidden'); game.classList.remove('hidden'); game.classList.remove('tweezers-mode'); touchFx = [];
  loadPortedMode(id).then(async data => {
    await Promise.all(data.imageLoads);
    if (run !== songRun || mode !== id) return;
    // Render the fully decoded original art right away.  PCM still preloads
    // before the lead-in, but a first visit never shows an empty game panel.
    ported.mode = id; ported.timeline = data.timeline; ported.frames = data.frames; ported.manifest = data.manifest; ported.bg = data.bg; ported.overlays = data.overlays; ported.peopleFrames = data.peopleFrames; ported.peopleManifest = data.peopleManifest; ported.music = data.music; ported.sfx = data.sfx;
    const samuraiSpawns = id === 'samurai_slice' ? data.timeline.events.filter(event => event.op === 'samurai_slice_event02') : [];
    if (id === 'night_walk') {
      // night_walk_init_balloons(7) consumes the GBA RNG before any random
      // platform decisions. Cache these values once, rather than regenerating
      // positions during every render frame.
      gbaRandomState = 0; ported.balloons = []; ported.nightStars = [];
      // night_walk_init_stars runs during engine start, before the scripted
      // balloon event. Consume the same RNG calls for all 32 star sprites.
      for (let i = 0; i < 32; i++) {
        const variant = gbaRandom(8), x = gbaRandom(256) - 8 + gbaRandom(256), y = gbaRandom(176) - 8;
        ported.nightStars.push({ x, y, variant, size: 0 });
      }
      const count = Number(data.timeline.events.find(e => e.op === 'night_walk_init_balloons')?.args[0] ?? 0);
      for (let i = 0; i < count; i++) {
        const x = gbaRandom(i * 3) + 64 - Math.floor(i * 3 / 2) - i;
        const variant = gbaRandom(6);
        ported.balloons.push({ x, y: 120 - i * 2, variant, palette: i % 5 });
      }
    }
    if (id === 'spaceball') {
      spaceballRandomState = 0; spaceballStars = [];
      const initialZoom = spaceballZoomAt(0);
      for (let i = 0; i < 24; i++) resetSpaceballStar(i, initialZoom);
    }
    ported.cues = data.timeline.events.filter(event => event.op === 'spawn_cue').map((event, index) => {
      const cue = { index, spawn: event.tick, hit: event.tick + (portedModes[id].duration[event.args[0]] ?? 24), kind: event.args[0], state: 'fresh' };
      if (id === 'spaceball') cue.objectType = portedEnum(latestPortedEvent('spaceball_set_ball_sprite', event.tick)?.args[0], { BASEBALL:0, RICE_BALL:1, STAR_BALL:2 });
      if (id === 'samurai_slice') {
        // event02 is the engine's demon-create command.  It is normally 120
        // ticks before the cue, but the script contains paired cues and
        // tempo changes, so array-index pairing is not reliable.  Resolve the
        // command immediately preceding this cue, exactly as the engine does.
        const expectedSpawnTick = event.tick - 120;
        const visualSpawn = samuraiSpawns.find(item => item.tick === expectedSpawnTick);
        // The decomp guarantees this exact 120-tick pairing. Do not fall back
        // to an older create event, which makes a demon appear too early when
        // a timeline export is incomplete.
        cue.visualSpawn = visualSpawn?.tick ?? event.tick;
        cue.objectType = Number(visualSpawn?.args[0] ?? 0);
      }
      if (id === 'night_walk') {
        cue.platformType = Number(latestPortedEvent('night_walk_set_platform', event.tick)?.args[0] ?? 0);
        // PLATFORM_TYPE_RANDOM consumes agb_random(4) in cue_spawn, not at
        // engine initialisation. Resolve it when this cue reaches the running
        // timeline so input-time RNG calls retain their original order.
        cue.endOfBridge = cue.platformType === 1;
        cue.platformResolved = cue.platformType !== 2;
        // Every cue still executes night_walk_cue_spawn even when its type is
        // explicit; that captures the bridge baseline and advances it after a
        // gap. Keep lifecycle state separate from type resolution.
        cue.platformSpawned = false;
        cue.hasFish = cue.platformType === 3;
      }
      if (id === 'power_calligraphy') cue.inputType = latestPortedEvent('power_calligraphy_set_next_input', event.tick)?.args[0] ?? null;
      return cue;
    });
    ported.cueIndex = 0; ported.actionAt = -99; ported.actionHit = false; ported.actionCue = null; ported.peopleStumbleAt = -99; ported.failedAt = -1; ported.failedCue = null; ported.cueSpawningDisabled = false; ported.starWandAt = -1; ported.nightWalkBaseY = 120; ported.audioQueue=[]; ported.audioQueueIndex=0; ported.audioQueueReady=false; setPortedTempo(data.timeline); drawPorted(-1, portedModes[id]);
    // `run gameplay_set_reverb, N` (currently only Karate Man uses it).
    ported.reverb = data.timeline.events.filter(event => event.op === 'run' && event.args[0] === 'gameplay_set_reverb')
      .map(event => ({ tick: event.tick, level: Number(event.args[1] ?? 0) }));
    ported.reverbIndex = 0;
    // Script text boxes: `print_text_s` / `print_text_f` open a window that the
    // matching clear op closes (the numeric `print_text_f` arguments are the
    // Karate Man warning cels, not text, so they are skipped here).
    ported.textBoxes = [];
    let openTextBox = null;
    for (const event of data.timeline.events) {
      if (/^print_text_[sf]$/.test(event.op) && TEXT_BOX_STRINGS[event.args[0]]) openTextBox = { label: event.args[0], from: event.tick, mode: id };
      if (/^clear_text_[sf]$/.test(event.op) && openTextBox) { ported.textBoxes.push({ ...openTextBox, until: event.tick }); openTextBox = null; }
    }
    resetReverb();
    activeTextBox = null;
    await loadOriginalSamples(data.needed);
    if (run !== songRun || mode !== id) return;
    // BeatScript rests provide the original lead-in; there is no extra web countdown.
    audioSongStart = audio().currentTime + 0.05; running = true; schedulePortedMusic(); schedulePortedTimelineSfx();
    if (id === 'samurai_slice') {
      for (const event of data.timeline.events.filter(item => item.op === 'samurai_slice_event02')) {
        const variant = Number(event.args[0]) <= 1 ? 1 : Number(event.args[0]) <= 3 ? 2 : 3;
        const alternate = Boolean(latestPortedEvent('samurai_slice_event04',event.tick));
        // Phrase sequences are authored in quarter-beat units.  Convert them
        // with the active song tempo (the audio helper's base is 120 BPM),
        // rather than the old /140 guess which slowed 120-BPM phrases.
        playPortedSfx(`phrase${variant}${alternate?'b':'a'}`,event.tick,256,0,tempoAtTick(event.tick)/120);
      }
    }
    for (const cue of ported.cues) {
      let sound = 'spawn';
      if (mode === 'spaceball' && ['CUE_HIGH','CUE_HIGH_FAST'].includes(cue.kind)) sound = 'high';
      if (mode === 'spaceball' && cue.kind === 'CUE_LOW_FAST') continue;
      if (ported.sfx[sound]) playPortedSfx(sound, cue.spawn);
    }
    ported.audioQueue.sort((a,b) => a.when-b.when); ported.audioQueueReady=true; pumpPortedAudio();
    cancelAnimationFrame(frame); frame = requestAnimationFrame(loop);
  }).catch(error => { console.error(`Unable to start ${id}:`, error); quit(); });
}
function drawPortedCell(cell, x, y, scale = 4, rotation = 0, flipX = false) {
  const image = ported.frames[cell], meta = ported.manifest[cell]; if (!image || !meta) return;
  // x/y are always native 240x160 screen coordinates. `scale` changes only
  // the sprite size (affine sprites must not drag their anchor with zoom).
  ctx.save(); ctx.translate(x * 4, y * 4); ctx.rotate(rotation); if (flipX) ctx.scale(-1,1); ctx.imageSmoothingEnabled = false;
  if (Number.isFinite(meta.atlasX)) ctx.drawImage(image,meta.atlasX,meta.atlasY,meta.width,meta.height,-meta.originX*scale,-meta.originY*scale,meta.width*scale,meta.height*scale);
  else ctx.drawImage(image, -meta.originX * scale, -meta.originY * scale, image.naturalWidth * scale, image.naturalHeight * scale);
  ctx.restore();
}
function drawPortedPerson(cell, x, y) {
  const image = ported.peopleFrames[cell], meta = ported.peopleManifest[cell]; if (!image || !meta) return;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  if (Number.isFinite(meta.atlasX)) ctx.drawImage(image,meta.atlasX,meta.atlasY,meta.width,meta.height,(x-meta.originX)*4,(y-meta.originY)*4,meta.width*4,meta.height*4);
  else ctx.drawImage(image, (x-meta.originX)*4, (y-meta.originY)*4, image.naturalWidth*4, image.naturalHeight*4);
  ctx.restore();
}
function spaceballZoomAt(tick) {
  let value = -.5;
  for (const event of ported.timeline.events) {
    if (event.op !== 'spaceball_zoom_camera' || event.tick > tick) continue;
    const target = signedHex16(event.args[0]) / 256, duration = Number(event.args[1]);
    const nextTick = event.tick + duration;
    if (tick < nextTick) return value + (target - value) * (tick - event.tick) / Math.max(1, duration);
    value = target;
  }
  return value;
}
function drawSpaceballBackground(zoom) {
  // func_08008910() samples the original 256x256 affine tilemap around
  // (128,176).  The BG matrix advances -zoom source pixels for every screen
  // pixel, exactly matching the entity perspective calculation below.
  const step = Math.max(.001, -zoom);
  const sourceX = 128 - 120 * step, sourceY = 176 - 80 * step;
  // Affine overflow is disabled in the original BGCNT; pixels outside the
  // 256x256 map reveal BG palette entry 0 instead of the page canvas.
  ctx.fillStyle = portedModes.spaceball.backdrop; ctx.fillRect(0,0,stage.width,stage.height);
  ctx.drawImage(ported.bg, sourceX, sourceY, 240 * step, 160 * step, 0, 0, stage.width, stage.height);
}
function drawGbaTilemap(image, offsetX = 0, offsetY = 0) {
  // Regular 256x256 GBA backgrounds wrap.  Keep native pixels at 4x instead
  // of stretching the complete map to the 240x160 viewport.
  const x = ((offsetX % 256) + 256) % 256, y = ((offsetY % 256) + 256) % 256;
  for (let py = -y; py < 160; py += 256) for (let px = -x; px < 240; px += 256) {
    ctx.drawImage(image, px * 4, py * 4, 1024, 1024);
  }
}
function drawSpaceballEntity(cell, worldX, worldY, z, zoom, rotation = 0, farCell = null) {
  const positionScale = 1 / Math.max(.05, z - zoom);
  let spriteScale = positionScale, selected = cell;
  // spaceball_update_batter calculates screen x/y with the perspective scale,
  // then doubles only the far cel's affine size.  Reusing the doubled scale
  // for x/y makes the batter jump toward the right wall at the cel switch.
  if (farCell != null && positionScale <= .5) { spriteScale *= 2; selected = farCell; }
  drawPortedCell(selected, 120 + worldX * positionScale, 80 + worldY * positionScale, 4 * spriteScale, rotation);
}
function spaceballFlight(cue, tick) {
  // spaceball_cue_spawn converts the cue arc from ticks to rendered frames
  // before calculating endTime. Keep the same frame-domain math; advancing by
  // raw ticks makes the ball visibly too fast at the normal 120 BPM tempo.
  const arcTicks = cue.hit - cue.spawn;
  const arc = arcTicks >= 24 ? 90 * arcTicks / 24 : 90;
  const arcFrames = framesBetweenTicks(cue.spawn, cue.hit);
  const temp = Math.max(0, arc - 48);
  const div = Math.sqrt(temp / Math.max(1, arc));
  const landingFrames = 2 * arcFrames / (div + 1);
  const elapsedFrames = framesBetweenTicks(cue.spawn, tick);
  const q = Math.max(0, Math.min(1, elapsedFrames / Math.max(1, landingFrames)));
  return { arc, landingFrames, landingTicks: landingFrames, x: 70 + 68*q, y: 120 - (arc - arc * Math.pow(2*q-1,2)) };
}
function drawSpaceballScene(tick) {
  const zoom = spaceballZoomAt(tick);
  updateSpaceballStars(zoom);
  for (const star of spaceballStars) {
    const scale = 1 / Math.max(.05, star.z - zoom);
    // GBA affine sprites use scale = 256 / (z - zoom). `drawPortedCell`
    // already maps native pixels at 4x, so preserve that factor here.
    drawPortedCell(27, 120 + star.x * scale, 80 + star.y * scale, 4 * scale);
  }
  const batterType = portedEnum(latestPortedEvent('spaceball_set_batter_sprite', tick)?.args[0], { BATTER_GREEN:0, BATTER_RED:1, BATTER_PINK:2 });
  const close = [[1,2,3,4,5],[9,10,11,12,13],[30,31,32,33,34]][batterType] ?? [1,2,3,4,5];
  const far = [[44,44,45,45,46],[47,47,48,48,49],[50,50,51,51,52]][batterType] ?? [44,44,45,45,46];
  const swingFrames = framesBetweenTicks(ported.actionAt,tick);
  const closeSeq = [[close[1],3],[close[2],3],[close[3],3],[close[4],20]];
  const farSeq = [[far[1],3],[far[2],3],[far[3],3],[far[4],20]];
  const ufoEvent = latestPortedEvent('spaceball_set_ufo_anim',tick);
  const ufoOpen = ufoEvent && portedEnum(ufoEvent.args[0], { UFO_OPEN:1, UFO_SWAY:0 });
  const ufoCell = ufoOpen ? animationCell([[55,4],[60,20],[59,10],[58,10],[55,10]],framesBetweenTicks(ufoEvent.tick,tick)) : animationCell([[55,4],[54,4],[53,4],[54,4],[55,4],[56,4],[57,4],[56,4]],frame,true);
  drawSpaceballEntity(ufoCell,0,9,0,zoom);
  const pitcherThrow = ported.cues.find(c => tick >= c.spawn && tick < c.spawn + 6);
  drawSpaceballEntity(pitcherThrow ? animationCell([[16,4],[14,2]],framesBetweenTicks(pitcherThrow.spawn,tick)) : 15,-50,48,0,zoom);
  const swingDuration = ported.actionAt >= 0 ? framesBetweenTicks(ported.actionAt, ported.actionAt + 10) : 0;
  const swinging = ported.actionAt >= 0 && swingFrames < swingDuration;
  drawSpaceballEntity(swinging ? animationCell(closeSeq,swingFrames) : close[0],50,0,0,zoom,0,
    swinging ? animationCell(farSeq,swingFrames) : far[0]);
}
function samuraiPowerAt(tick) {
  let hits = 0;
  for (const cue of ported.cues) {
    if (cue.hit > tick) break;
    if (cue.state === 'hit' && cue.perfect) hits++;
    else if (cue.state === 'hit') hits = 0;
  }
  return Math.min(2, hits);
}
function drawSamuraiScene(tick) {
  const power = samuraiPowerAt(tick), beatSeqs = [
    [[20,4],[19,3],[18,3],[17,30]], [[31,4],[30,3],[28,3],[29,30]], [[43,4],[42,3],[41,3],[40,30]]
  ], sliceSeqs = [
    [[20,64],[21,2],[22,1],[23,1],[22,6],[24,1],[25,1],[26,1],[27,1]],
    [[30,64],[33,2],[34,1],[35,1],[34,1],[35,1],[34,4],[36,1],[37,1],[38,1],[39,1]],
    [[42,64],[44,2],[45,1],[46,1],[45,1],[46,1],[45,1],[46,1],[45,1],[46,1],[47,1],[48,1],[49,1],[50,1]]
  ];
  const beat = latestPortedEvent('beat_anim',tick), actionFrames = framesBetweenTicks(ported.actionAt,tick);
  let cell = animationCell(beatSeqs[power], beat ? framesBetweenTicks(beat.tick,tick) : 999);
  if (ported.actionAt >= 0 && actionFrames < 24) cell = animationCell(sliceSeqs[power], 64 + actionFrames);
  // The flame sprite is created hidden during engine_start. It is only
  // revealed by the later Event 03 transition (the opening at tick 0 must
  // remain the clean street scene shown in the original cartridge).
  const flameEvent = latestPortedEvent('samurai_slice_event03', tick);
  if (flameEvent) {
    const flameCell = animationCell([[0,6],[2,6],[1,6]],framesBetweenTicks(flameEvent.tick,tick),true);
    drawPortedCell(flameCell,20,120,4);
  }
  drawPortedCell(cell,14,123,4);
}
function samuraiHopAt(cue, tick) {
  // func_08031c94 advances the demon for ticks_to_frames(0xC0) and calls
  // func_08031c68(localFrames, spanTicks) for every hop:
  //   hop = 4 * local * (span - local) * spanTicks / span^2,  span = ticks_to_frames(spanTicks)
  // Its peak (local = span / 2) is exactly spanTicks pixels, so the amplitude is
  // tempo independent - the previous version divided by span once, which made
  // every hop frameAt(spanTicks) pixels tall.
  const framePerTick = 150 / Math.max(1, tempoAtTick(cue.visualSpawn));
  const frameAt = value => value * framePerTick;
  const parabola = (local, spanTicks) => {
    const span = Math.max(1, frameAt(spanTicks));
    const clamped = Math.max(0, Math.min(span, local));
    return 4 * clamped * (span - clamped) * spanTicks / (span * span);
  };
  const e = Math.max(0, framesBetweenTicks(cue.visualSpawn, tick));
  if (cue.objectType === 0) {
    // Small demon: 0x18-tick hops until 0xA0, then it stays on the lane.
    return e < frameAt(0xA0) ? parabola(e % frameAt(0x18), 0x18) : 0;
  }
  if (cue.objectType === 1) {
    // Medium demon: four 0x18 hops, then one 0x30 parabola over [0x60, 0xA0).
    if (e < frameAt(0x60)) return parabola(e % frameAt(0x18), 0x18);
    if (e < frameAt(0xA0)) return parabola(e - frameAt(0x60), 0x30);
    return 0;
  }
  if (cue.objectType === 2 || cue.objectType === 3) {
    // Winged and propeller demons hover: 8 * sin + 8 + 64 * progress above the
    // lane, with the 0x30 parabola dive during [0x78, 0xA0).  Returning 0 here
    // (the previous behaviour) dropped them onto the lane base.
    if (e >= frameAt(0x78) && e < frameAt(0xA0)) return parabola(e - frameAt(0x60), 0x30);
    const period = Math.max(1, frameAt(0x30));
    const lifetime = Math.max(1, frameAt(0xC0));
    const wave = Math.sin(((e % period) / period) * Math.PI * 2);
    return 8 * wave + 8 + 64 * Math.min(1, e / lifetime);
  }
  // Large demon: one 0x30 parabola over [0x60, 0xA0).
  return e >= frameAt(0x60) && e < frameAt(0xA0) ? parabola(e - frameAt(0x60), 0x30) : 0;
}
function samuraiFogAt(tick) {
  const effect = latestPortedEvent('samurai_slice_event03',tick);
  if (!effect) return { offsets:[0,0], alpha:0 };
  // Event 03 arms the effect; the original cue-hit routine changes state 1
  // to state 2, after which BG1/BG2 move by +8/-8 px per rendered frame and
  // clamp at +/-240.  A later Event 03 resets both offsets to zero.
  const target = Math.max(0,Math.min(16,Number(effect.args[0]) || 0));
  const effectIndex = ported.timeline.events.filter(event => event.op === 'samurai_slice_event03' && event.tick <= effect.tick).length - 1;
  const rampPerFrame = ((ported.tempo.findLast?.(segment => segment.tick <= effect.tick)?.bpm ?? 120) * (effectIndex ? 64 : 24)) / (140 * 256);
  const armedAlpha = Math.min(target,framesBetweenTicks(effect.tick,tick)*rampPerFrame);
  const resolved = ported.cues.find(cue => cue.hit >= effect.tick && (cue.state !== 'fresh' || tick > cue.hit + 5));
  if (!resolved) return { offsets:[0,0], alpha:armedAlpha/16 };
  if (resolved.state !== 'hit' || !resolved.perfect) return { offsets:[0,0], alpha:0 };
  const hitAlpha = Math.min(target,framesBetweenTicks(effect.tick,resolved.actionTick)*rampPerFrame);
  const afterFrames = framesBetweenTicks(resolved.actionTick,tick);
  const fadePerFrame = (ported.tempo.findLast?.(segment => segment.tick <= resolved.actionTick)?.bpm ?? 120) / 140;
  const distance = Math.min(240,Math.max(0,afterFrames)*8);
  return { offsets:[distance,-distance], alpha:Math.max(0,hitAlpha-afterFrames*fadePerFrame)/16 };
}
function nightWalkWorldShift(tick) {
  let completed = 0, active = null;
  for (const cue of ported.cues) {
    // Only a jump over a gap moves the shared world origin.  Ordinary
    // stepping-stone/bridge jumps move Yan's sprite in place; applying their
    // parabola to the stars and bridge makes the whole background appear to
    // bounce, which is not what the GBA engine does.
    if (!cue.endOfBridge || cue.state !== 'hit' || cue.actionTick > tick) continue;
    const elapsed = framesBetweenTicks(cue.actionTick,tick);
    // gameplay_get_last_hit_offset() reports the cue's *frame* offset
    // (gameplay_update_cue's counter minus the cue duration), and the base jump
    // duration is ticks_to_frames(0x14), so the subtraction happens in frames.
    const timingOffset = signedFramesBetweenTicks(cue.hit, cue.actionTick);
    // night_walk_play_yan_jump uses ticks_to_frames(0x14) - timingOffset.
    // An early hit (negative offset) therefore lengthens the jump, while a
    // late hit shortens it, exactly as in the GBA engine.
    const duration = Math.max(1, framesBetweenTicks(cue.hit, cue.hit + 20) - timingOffset);
    if (elapsed < duration && (!active || cue.actionTick > active.actionTick)) active = { cue, elapsed, duration };
    else completed++;
  }
  // The engine stores the shared origin as a negative vertical offset
  // (unk3B8.unk6). Sprite positions are composed with that origin, so a
  // negative value moves the shared scene upward while Yan clears a gap.
  // The source keeps unk4 (the future platform baseline) separate from unk8
  // / unk6 (the active jump origin). Gap spawning changes only unk4; this
  // function therefore models the dynamic jump origin alone.
  const baseShift = -completed * 16;
  if (!active) return baseShift;
  const step = 27 * active.elapsed / active.duration - 16;
  const jumpHeight = 32 - (32 * step * step / 256);
  return baseShift - Math.max(0,jumpHeight);
}
function portedLoop() {
  pumpPortedAudio();
  const tick = portedTick(), cfg = portedModes[mode];
  if (tick > ported.timeline.endTick) return finish();
  while (ported.reverbIndex < ported.reverb.length && ported.reverb[ported.reverbIndex].tick <= tick) {
    setReverbLevel(ported.reverb[ported.reverbIndex++].level);
  }
  setActiveTextBox(ported.textBoxes.find(entry => tick >= entry.from && tick < entry.until));
  if (mode === 'night_walk') {
    // Match the engine's cue-spawn order. Pre-resolving every random platform
    // at startup lets later input RNG calls change the wrong cue.
    for (const cue of ported.cues) {
      // `platformResolved` only says that the type is known. It is not the
      // same as `night_walk_cue_spawn` having run: explicit bridge/gap types
      // are known when the chart is loaded, but the source still captures
      // unk4 and advances it for every actual gap at its spawn tick.
      if (cue.platformSpawned || cue.spawn > tick) continue;
      if (!cue.platformResolved) {
        cue.endOfBridge = cue.platformType === 1 || (cue.platformType === 2 && gbaRandom(4) === 0);
        cue.platformResolved = true;
      }
      cue.baseY = ported.nightWalkBaseY ?? 120;
      // night_walk_cue_spawn decrements unk4 after capturing this cue's y.
      if (cue.endOfBridge) ported.nightWalkBaseY = cue.baseY - 16;
      cue.platformSpawned = true;
    }
  }
  if (localAuditPerfect) {
    const cue = ported.cues.find(item => item.state === 'fresh' && item.hit <= tick + 1);
    if (cue) {
      // Keep the replay exactly on the source judgment tick so a backgrounded
      // browser frame cannot turn an automated perfect replay into a barely.
      audioSongStart = audio().currentTime - outputLatency() - secondsAtTick(cue.hit);
      portedPunch();
    }
  }
  // gameplay_update_cue(): a cue expires once its frame counter passes
  // duration + missWindowLate, i.e. 5 frames (12 for the calligraphy cues)
  // after the judgment tick.
  const lateWindow = mode === 'power_calligraphy' ? 12 : 5;
  for (const cue of ported.cues) if (cue.state === 'fresh' && signedFramesBetweenTicks(cue.hit, tick) > lateWindow) {
    cue.state = 'miss';
    if (mode === 'power_calligraphy') playPortedSfx('miss');
    if (mode === 'night_walk' && cue.endOfBridge && ported.failedAt < 0) {
      ported.failedAt = tick; ported.failedCue = cue; ported.cueSpawningDisabled = true;
      for (const future of ported.cues) if (future.spawn > tick && future.state === 'fresh') future.state = 'disabled';
      playPortedSfx('fall', tick);
    }
  }
  if (mode === 'night_walk') for (const cue of ported.cues) {
    if (cue.state === 'miss' && !cue.endOfBridge && !cue.offbeatPlayed && tick >= cue.hit + 12) {
      cue.offbeatPlayed = true; playNightWalkOffbeat(cue);
    }
  }
  if (mode === 'spaceball') for (const cue of ported.cues) {
    const flight = spaceballFlight(cue,tick);
    if (cue.state === 'miss' && !cue.landed && tick >= cue.spawn + flight.landingTicks) {
      cue.landed = true; cue.landedAt = tick; playPortedSfx('land');
    }
  }
  // script_night_walk_end: fade_music_out 96, ten rest 24 commands, then
  // fade_screen_out and two final rests. Keep the falling scene alive for the
  // complete end script instead of ending after the old 96-tick shortcut.
  if (mode === 'night_walk' && ported.failedAt >= 0) {
    const fadeTicks = 12 * tempoAtTick(ported.failedAt) / 150;
    if (tick - ported.failedAt > 192 + fadeTicks + 48) return finish();
  }
  drawPorted(tick, cfg); auditStatePublisher(); frame = requestAnimationFrame(loop);
}
function drawPorted(tick, cfg) {
  ctx.clearRect(0,0,stage.width,stage.height); ctx.imageSmoothingEnabled = false;
  ctx.fillStyle=cfg.backdrop; ctx.fillRect(0,0,stage.width,stage.height);
  if (mode === 'spaceball') drawSpaceballBackground(spaceballZoomAt(tick));
  else if (mode !== 'night_walk') ctx.drawImage(ported.bg, 0, 0, stage.width, stage.height);
  const samuraiFog = mode === 'samurai_slice' ? samuraiFogAt(tick) : { offsets:[0,0], alpha:0 };
  if (mode === 'samurai_slice' && ported.overlays[1] && samuraiFog.alpha > 0) {
    ctx.save(); ctx.globalAlpha=samuraiFog.alpha; drawGbaTilemap(ported.overlays[1],0,samuraiFog.offsets[1]); ctx.restore();
  }
  const actionFrame = framesBetweenTicks(ported.actionAt, tick);
  let actorCell = animationCell(cfg.action.map(cell => [cell, 2]), actionFrame);
  if (tick < ported.actionAt || actionFrame >= cfg.action.length * 2) actorCell = cfg.idle;
  let actorX = cfg.actor[0], actorY = cfg.actor[1];
  if (mode === 'night_walk' && ported.actionAt >= 0) {
    const elapsed = framesBetweenTicks(ported.actionAt,tick);
    const actionOffset = ported.actionCue ? signedFramesBetweenTicks(ported.actionCue.hit, ported.actionAt) : 0;
    const actionBase = ported.actionCue?.hit ?? ported.actionAt;
    const duration = Math.max(1, framesBetweenTicks(actionBase, actionBase + 20) - actionOffset);
    const age = Math.max(0,elapsed/duration);
    if (ported.actionHit && age < 1) {
      if (!ported.actionCue?.endOfBridge) actorY -= 32 - 32 * Math.pow(age * 32 - 16, 2) / 256;
      actorCell = 2;
    }
    // For a gap jump the GBA keeps Yan at sprite Y=120 while ascending, then
    // the shared origin affects the bridge sprites; Yan has no origin pointer.
    else if (!ported.actionHit && elapsed < 19) actorCell = animationCell([[3,1],[4,1],[5,3],[4,1],[3,1],[7,4],[8,4],[9,4],[10,4]],elapsed);
    else actorCell = animationCell([[7,4],[8,4],[9,4],[10,4]],secondsAtTick(Math.max(0,tick))*60,true);
  }
  if (mode === 'night_walk' && ported.actionAt < 0) {
    // night_walk_init_balloons sets anim_play_yan_jump immediately; the
    // sprite then settles into its walking animation after the 20-frame
    // one-shot, even though the logical state remains WALKING.
    const openingFrames = secondsAtTick(Math.max(0, tick)) * 60;
    actorCell = openingFrames < 20
      ? animationCell([[3,4],[4,4],[5,4],[4,4],[3,4]], openingFrames)
      : animationCell([[7,4],[8,4],[9,4],[10,4]], openingFrames, true);
  }
  if (mode === 'night_walk' && ported.starWandAt >= 0) {
    const riseFrames = framesBetweenTicks(ported.starWandAt,tick);
    actorCell = animationCell([[111,30],[112,2],[111,10],[112,2]],riseFrames,true);
    actorY -= Math.min(110, riseFrames * 0.5);
  }
  if (mode === 'night_walk' && ported.failedAt >= 0) {
    const fallFrames = framesBetweenTicks(ported.failedAt, tick);
    actorCell = animationCell([[12,4],[13,4],[14,4],[15,4],[14,4]], fallFrames);
    // night_walk_play_yan_update_fall: yVelocity += 28; yDistance +=
    // yVelocity (8.8 fixed point), capped after 100 native pixels.
    actorY += Math.min(110, (28 * fallFrames * (fallFrames + 1) / 2) / 256);
  }
  if (mode === 'night_walk') {
    const worldShift = nightWalkWorldShift(tick);
    const starFrames = secondsAtTick(Math.max(0,tick))*60;
    const expandedStars = ported.cues.filter(c => c.state === 'hit' && c.perfect && c.hit <= tick).length
      + ported.timeline.events.filter(e => e.op === 'night_walk_expand_stars' && e.tick <= tick).reduce((sum,e) => sum + Number(e.args[0] ?? 0),0);
    const starLevel = Math.min(4, Math.floor(expandedStars / 32)), nextStar = expandedStars % 32;
    const starCells = [[95,96],[97,98],[99,100],[101,102],[103,104]];
    for (let i=0;i<ported.nightStars.length;i++) {
      const star = ported.nightStars[i];
      // night_walk_scroll_stars advances each persistent star by -0.5 px per
      // rendered frame and wraps its 256x176 native field.
      const sx=((star.x-.5*starFrames+8)%256+256)%256-8;
      const sy=((star.y-worldShift/2+8)%176+176)%176-8;
      const starLevelForCell=Math.min(4,starLevel + (i < nextStar ? 1 : 0));
      const starAnim=starCells[starLevelForCell];
      const initialCel = ported.nightStars[i].variant;
      drawPortedCell(animationCell([[starAnim[0],28],[starAnim[1],2]],starFrames+i*9+initialCel,true),sx,sy,4);
    }
  }
  if (mode !== 'power_calligraphy' && mode !== 'spaceball' && mode !== 'samurai_slice') drawPortedCell(actorCell, actorX, actorY);
  if (mode === 'night_walk') {
    const popEvents = ported.timeline.events.filter(e => e.op === 'night_walk_pop_balloon' && e.tick <= tick);
    const popped = popEvents.length;
    const balloonFrame = Math.floor(secondsAtTick(Math.max(0,tick))*10);
    // The engine changes the last remaining balloon to cel092 for two
    // rendered frames before it disappears; removing it immediately loses
    // the characteristic pop animation.
    for (let i=0; i<Math.max(0,ported.balloons.length-popped); i++) {
      const balloon = ported.balloons[i];
      // export_game_frames.py bakes the runtime OBJ palette offsets into
      // numeric namespaces (1000, 2000, ...). Select the same palette bank
      // that night_walk_init_balloons assigns to each sprite.
      const baseCell = [89,90,91,92][(balloon.variant + balloonFrame + i * 2) % 4];
      const cell = baseCell + balloon.palette * 1000;
      drawPortedCell(cell, balloon.x, balloon.y, 4);
    }
    for (let j = 0; j < popped; j++) {
      const pop = popEvents[j], balloon = ported.balloons[ported.balloons.length - 1 - j];
      if (!balloon || framesBetweenTicks(pop.tick, tick) >= 2) continue;
      drawPortedCell(92 + balloon.palette * 1000, balloon.x, balloon.y, 4);
    }
  }
  if (mode === 'spaceball') drawSpaceballScene(tick);
  if (mode === 'samurai_slice') drawSamuraiScene(tick);
  if (mode === 'power_calligraphy') {
    const kana = { KANA_ONORE:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17], KANA_CHIKARA:[21,22,23,24,25,26,27,28,29,30,31,32], KANA_SUN:[39,40,41,42,43,44,45,46,47,48,49], KANA_KOKORO:[56,57,58,59,60,61,62,63,64,65,66,67,68,69], KANA_RE:[80,81,82,83,84,85], KANA_COMMA:[88,89], KANA_FACE:[92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123], KANA_END_KANJI:[127] };
    const inputCells = {
      KANA_INPUT_ONORE1:[18,19,20], KANA_INPUT_CHIKARA1:[33,34,35], KANA_INPUT_CHIKARA2:[36,37,38],
      KANA_INPUT_SUN1:[50,51,52], KANA_INPUT_SUN2:[53,54,55], KANA_INPUT_KOKORO1:[70,71,72],
      KANA_INPUT_KOKORO2:[73,75,76], KANA_INPUT_KOKORO3:[77,78,79], KANA_INPUT_RE1:[85,86,87],
      KANA_INPUT_COMMA1:[89,90,91], KANA_INPUT_FACE1:[124,125,126]
    };
    const removals = ported.timeline.events.filter(e => (e.op === 'power_calligraphy_remove_paper' || e.op === 'power_calligraphy_remove_paper_slowly') && e.tick <= tick);
    const removeEvent = removals.at(-1), lastPaper = removeEvent?.tick ?? -1;
    const paperMotions = {
      KANA_INPUT_ONORE1:[0,-8], KANA_INPUT_CHIKARA1:[-6,-6], KANA_INPUT_CHIKARA2:[-4,8],
      KANA_INPUT_SUN1:[-4,-6], KANA_INPUT_SUN2:[4,4], KANA_INPUT_KOKORO1:[-4,-6],
      KANA_INPUT_KOKORO2:[4,4], KANA_INPUT_KOKORO3:[6,6], KANA_INPUT_RE1:[6,-6],
      KANA_INPUT_COMMA1:[5,6], KANA_INPUT_FACE1:[6,-1]
    };
    let paperX = 0, paperY = 0;
    for (const event of ported.timeline.events) if (event.op === 'power_calligraphy_offset_paper' && event.tick >= lastPaper && event.tick <= tick) {
      paperX += Number(event.args[0] ?? 0); paperY += Number(event.args[1] ?? 0);
    }
    for (const cue of ported.cues) if (cue.result === 0 && cue.hit >= lastPaper && cue.hit <= tick) {
      const motion = paperMotions[cue.inputType];
      if (motion) { paperX -= motion[0]; paperY -= motion[1]; }
    }
    // BG_OFS is a source offset: positive values move the visible paper left
    // and up.  The kana, input strokes and brush use the same origin pointer.
    const paperScreenX = -paperX, paperScreenY = -paperY;
    ctx.clearRect(0,0,stage.width,stage.height);
    ctx.drawImage(ported.bg,71,7,114,153,(71+paperScreenX)*4,(7+paperScreenY)*4,456,612);
    if (removeEvent) {
      const slow = removeEvent.op.endsWith('_slowly'), age = framesBetweenTicks(removeEvent.tick,tick);
      if (age < (slow ? 160 : 20)) {
        const previousRemove = removals.at(-2)?.tick ?? -1;
        let oldX = 0, oldY = 0;
        for (const event of ported.timeline.events) if (event.op === 'power_calligraphy_offset_paper' && event.tick >= previousRemove && event.tick < removeEvent.tick) {
          oldX += Number(event.args[0] ?? 0); oldY += Number(event.args[1] ?? 0);
        }
        oldX += (slow ? 0 : -4) * age; oldY += (slow ? -1 : -8) * age;
        const oldScreenX = -oldX, oldScreenY = -oldY;
        ctx.drawImage(ported.bg,71,7,114,153,(71+oldScreenX)*4,(7+oldScreenY)*4,456,612);
        const oldKana = ported.timeline.events.filter(e => e.op === 'power_calligraphy_set_kana' && e.tick < removeEvent.tick).at(-1);
        const oldCel = ported.timeline.events.filter(e => e.op === 'power_calligraphy_set_kana_cel' && e.tick < removeEvent.tick).at(-1);
        if (oldKana && oldCel && Number(oldCel.args[0]) >= 0) drawPortedCell(kana[oldKana.args[0]]?.[Number(oldCel.args[0])] ?? 0,120+oldScreenX,84+oldScreenY,4);
        for (const cue of ported.cues) if (cue.result != null && cue.hit >= previousRemove && cue.hit < removeEvent.tick) {
          drawPortedCell(inputCells[cue.inputType]?.[cue.result] ?? 0,120+oldScreenX,84+oldScreenY,4);
        }
      }
    }
    const kanaEvent = ported.timeline.events.filter(e => e.op === 'power_calligraphy_set_kana' && e.tick <= tick).at(-1);
    const celEvent = ported.timeline.events.filter(e => e.op === 'power_calligraphy_set_kana_cel' && e.tick <= tick).at(-1);
    if (kanaEvent && celEvent && Number(celEvent.args[0]) >= 0) drawPortedCell(kana[kanaEvent.args[0]]?.[Number(celEvent.args[0])] ?? 0, 120 + paperScreenX, 84 + paperScreenY, 4);
    for (const cue of ported.cues) if (cue.result != null && cue.hit >= lastPaper && cue.hit <= tick) {
      drawPortedCell(inputCells[cue.inputType]?.[cue.result] ?? 0, 120 + paperScreenX, 84 + paperScreenY, 4);
    }
    const brush = ported.timeline.events.filter(e => /^power_calligraphy_set_brush(?:_(raised|down))?$/.test(e.op) && e.tick <= tick).at(-1);
    let brushDrawX = 180 + paperScreenX, brushDrawY = 100 + paperScreenY;
    if (brush) {
      const hitCue = ported.cues.filter(c => c.result != null && c.hit <= tick && c.hit >= lastPaper).at(-1);
      const brushMotions = {
        KANA_INPUT_ONORE1:[[31,-30,0],[65,-14,0],[36,-7,0]], KANA_INPUT_CHIKARA1:[[1,-22,0],[-11,28,0],[19,-4,0]], KANA_INPUT_CHIKARA2:[[-61,43,0],[-46,40,0],[3,-54,0]],
        KANA_INPUT_SUN1:[[-14,-15,0],[-19,-8,0],[9,6,0]], KANA_INPUT_SUN2:[[1,-7,1],[2,-8,1],[6,-18,1]], KANA_INPUT_KOKORO1:[[29,-40,0],[76,-30,0],[51,-22,0]],
        KANA_INPUT_KOKORO2:[[17,-34,1],[15,-41,1],[21,-54,1]], KANA_INPUT_KOKORO3:[[44,-36,1],[60,-32,0],[38,-51,1]], KANA_INPUT_RE1:[[39,-29,0],[30,-14,0],[17,-8,0]],
        KANA_INPUT_COMMA1:[[12,-4,1],[35,-6,0],[20,-10,0]], KANA_INPUT_FACE1:[[32,-11,0],[10,81,0],[0,14,0]]
      };
      const motion = hitCue ? brushMotions[hitCue.inputType]?.[hitCue.result] : null;
      const normalCharge = latestPortedEvent('power_calligraphy_charge_brush',tick), commaCharge = latestPortedEvent('power_calligraphy_charge_brush_comma',tick);
      const charge = !normalCharge ? commaCharge : !commaCharge ? normalCharge : normalCharge.tick > commaCharge.tick ? normalCharge : commaCharge;
      const nextChargeEnd = charge && ported.timeline.events.find(e => e.op === 'power_calligraphy_end_charge_effect' && e.tick >= charge.tick);
      const charging = charge && charge.tick >= brush.tick && tick < (nextChargeEnd?.tick ?? Infinity) && (!hitCue || hitCue.hit < charge.tick);
      let brushCell = motion ? 128 + motion[2] : (brush.op.endsWith('_down') ? 129 : 128);
      if (charging) brushCell = charge.op.endsWith('_comma') ? animationCell([[138,3],[139,3],[140,3],[141,3],[142,3],[143,3]],framesBetweenTicks(charge.tick,tick)) : animationCell([[130,1],[131,1],[132,1],[133,2],[134,2],[135,2],[136,2]],framesBetweenTicks(charge.tick,tick));
      brushDrawX = 120 + (motion?.[0] ?? Number(brush.args[0])) + paperScreenX;
      brushDrawY = 84 + (motion?.[1] ?? Number(brush.args[1])) + paperScreenY;
      const raise = latestPortedEvent('power_calligraphy_raise_brush',tick);
      if (raise && raise.tick >= brush.tick) { brushDrawY -= 24; brushCell = 128; }
      drawPortedCell(brushCell,brushDrawX,brushDrawY,4);
    } else drawPortedCell(128,brushDrawX,brushDrawY,4);
    const chargeEffect = latestPortedEvent('power_calligraphy_start_charge_effect',tick);
    const chargeEffectEnd = chargeEffect && ported.timeline.events.find(e => e.op === 'power_calligraphy_end_charge_effect' && e.tick >= chargeEffect.tick);
    if (chargeEffect && tick < (chargeEffectEnd?.tick ?? chargeEffect.tick)) {
      drawPortedCell(animationCell([[152,2],[153,2],[154,2],[155,2],[156,2]],framesBetweenTicks(chargeEffect.tick,tick),true),brushDrawX,brushDrawY,4);
    }
    const peopleEvent = ported.timeline.events.filter(e => e.op === 'power_calligraphy_set_people_state' && e.tick <= tick).at(-1);
    const stumble = tick - ported.peopleStumbleAt >= 0 && tick - ported.peopleStumbleAt < 48;
    const peopleState = stumble ? 'LITTLE_PEOPLE_STUMBLE' : (peopleEvent?.args[0] ?? 'LITTLE_PEOPLE_NULL');
    if (peopleState !== 'LITTLE_PEOPLE_NULL') {
      const dance = peopleState === 'LITTLE_PEOPLE_DANCE', side = Math.floor(tick/24)&1;
      const bow = peopleState === 'LITTLE_PEOPLE_BOW' || peopleState === 'LITTLE_PEOPLE_END_BOW';
      const peopleFrames = secondsAtTick(Math.max(0,tick))*60;
      const manDance = side ? [[5,4],[6,4],[7,4],[8,10],[7,4],[6,4],[5,4],[0,10]] : [[1,4],[2,4],[3,4],[4,10],[3,4],[2,4],[1,4],[0,10]];
      const womanDance = side ? [[18,4],[19,4],[20,4],[21,10],[20,4],[19,4],[18,4],[17,10]] : [[22,4],[23,4],[24,4],[25,10],[24,4],[23,4],[22,4],[17,10]];
      for (let i=0;i<6;i++) {
        const travel = ((Math.min(tick,4974)-3438)/6.75) % 192;
        const my = ((-160+i*32+travel+384)%192);
        const wy = ((192+i*32-travel+384)%192);
        let man = dance ? animationCell(manDance,peopleFrames,true) : stumble ? 15 : animationCell([[12,6],[13,8],[12,6],[14,20]],peopleFrames,peopleState!=='LITTLE_PEOPLE_END_BOW');
        let woman = dance ? animationCell(womanDance,peopleFrames,true) : stumble ? 33 : animationCell([[29,6],[30,8],[29,6],[31,20]],peopleFrames,peopleState!=='LITTLE_PEOPLE_END_BOW');
        if (bow && i < 3) { man = animationCell([[9,6],[10,8],[9,6],[11,20]],peopleFrames,peopleState!=='LITTLE_PEOPLE_END_BOW'); woman = animationCell([[26,6],[27,8],[26,6],[28,20]],peopleFrames,peopleState!=='LITTLE_PEOPLE_END_BOW'); }
        drawPortedPerson(man,32,my); drawPortedPerson(woman,216,wy);
      }
    }
  }
  for (const cue of ported.cues) {
    const tail = mode === 'night_walk' ? 96 : mode === 'spaceball' ? 180 : mode === 'samurai_slice' ? 60 : 30;
    const visibleFrom = mode === 'samurai_slice' ? cue.visualSpawn : cue.spawn;
    if (cue.state === 'done' || cue.state === 'disabled' || tick < visibleFrom || tick > cue.hit + tail) continue;
    const p = Math.max(0, Math.min(1, (tick - cue.spawn) / Math.max(1, cue.hit - cue.spawn)));
    if (mode === 'spaceball') {
      const flight = spaceballFlight(cue,tick), { landingTicks, x, y } = flight;
      const ballCells = [6,8,7], ball = ballCells[cue.objectType] ?? 6, zoom = spaceballZoomAt(tick);
      if (cue.state === 'hit') {
        const actionTick = cue.actionTick ?? cue.hit, base = spaceballFlight(cue,actionTick), hitFrames = framesBetweenTicks(actionTick,tick);
        if (cue.perfect) {
          const z = -.25 * hitFrames;
          if (z >= zoom + .25) drawSpaceballEntity(ball,base.x-120,base.y-80,z,zoom,tick*.012);
        } else {
          const z = -(4/256)*hitFrames, dx = cue.actionTick < cue.hit ? -3 : 3;
          const bx = base.x + dx*hitFrames, by = base.y - 4*hitFrames + .125*hitFrames*hitFrames;
          if (z >= zoom + .25 && by < 1000) drawSpaceballEntity(ball,bx-120,by-80,z,zoom,-tick*.012);
        }
      } else if (tick <= cue.spawn + landingTicks) drawSpaceballEntity(ball,x-120,y-80,0,zoom,tick*.012);
      if (cue.landedAt != null) {
        const poofFrames = framesBetweenTicks(cue.landedAt,tick);
        if (poofFrames < 9) {
          const poof = animationCell([[24,4],[25,3],[26,2]],poofFrames);
          drawSpaceballEntity(poof,34,52,0,zoom);
          drawSpaceballEntity(poof,2,52,0,zoom);
        }
      }
    } else if (mode === 'samurai_slice') {
      // Movement table follows D_089e4928: type 2 is winged-fly and type 3
      // is propeller-hover (the previous implementation had these reversed).
      const demonSeqs = [ [[70,8],[67,2],[68,4],[69,4]], [[58,8],[53,2],[54,4],[55,4]], [[71,3],[72,3],[73,3],[74,3],[75,3]], [[59,6],[60,4],[61,4],[62,3],[63,2]], [[84,12],[85,12]], [[84,12],[85,12]] ];
      const seq = demonSeqs[cue.objectType] ?? demonSeqs[1];
      // func_08031c94 advances the demon for ticks_to_frames(0xC0), i.e. a
      // 192-tick engine lifetime, independent of the cue's 24-tick judging
      // window.  Using cue.hit as the endpoint made demons rush 25% too fast.
      // ticks_to_frames() is evaluated when the demon is created and keeps
      // that tempo for the whole sprite lifetime. Re-integrating across later
      // tempo changes incorrectly compresses demons in the fast sections.
      const spawnTempo = tempoAtTick(cue.visualSpawn);
      const moveDuration = Math.max(1, 192 * 150 / Math.max(1, spawnTempo));
      const travel = Math.max(0, Math.min(1, framesBetweenTicks(cue.visualSpawn, tick) / moveDuration));
      // func_08031c94 begins from fixed-point Y 0xA000 (160 px) and adds
      // its 54 px lane drift before subtracting the per-type hop.  The old
      // 40 px literal put every demon one lane too high, which also made
      // their entry look prematurely fast.
      // func_08031c94 builds the lane from fixed-point constants: X =
      // 0xF0 << 8 - 216 * travel (240 px) and Y = 0xA0 << 6 + 54 * travel,
      // i.e. 0xA0 * 64 / 256 = **40 px**, not 160 px.  A previous pass read that
      // shift as << 8 and moved every demon 120 px down, which is why they fell
      // through the pavement and off the bottom of the screen.
      const x = 240 - 216 * travel, baseY = 40 + 54 * travel;
      // Demon hop/hover cels loop independently of horizontal travel in the
      // original sprite engine; tying this phase to travel made paired cues
      // stretch the hop and visibly drift away from the beat.
      const hop = samuraiHopAt(cue, tick);
      const y = baseY - hop;
      if (cue.state === 'hit') {
        const drift = Math.max(0,tick-(cue.actionTick ?? cue.hit));
        if (!cue.perfect) {
          const barelyCells = [76,56,77,57,86,86];
          drawPortedCell(barelyCells[cue.objectType] ?? 56,x+drift*1.2,y+drift*.45,4,drift*.025);
        } else {
          const hitCells = [78,64,79,65,82,83];
          drawPortedCell(hitCells[cue.objectType] ?? 64,x+drift*1.8,y-drift*1.2,4,drift*.06);
          drawPortedCell(cue.objectType >= 4 ? (cue.objectType === 4 ? 83 : 82) : 66,x-drift*1.2,y+drift*.9,4,-drift*.04);
          if (drift < 7) drawPortedCell(animationCell([[88,1],[89,4],[90,2]],framesBetweenTicks(cue.actionTick ?? cue.hit,tick)),74,96,4);
        }
      } else {
        // Every demon owns a ground shadow sprite (sprite index 2): the original
        // parks it at baseY - 4 and drops it another 64 px once the cue passes
        // ticks_to_frames(0x78).  Flying demons keep it on the lane below them.
        const shadowY = baseY - 4 + (framesBetweenTicks(cue.visualSpawn, tick) > 150 / Math.max(1, tempoAtTick(cue.visualSpawn)) * 0x78 ? 64 : 0);
        drawPortedCell(cue.objectType >= 4 ? 87 : 80, x, shadowY, 4);
        drawPortedCell(animationCell(seq,framesBetweenTicks(cue.visualSpawn,tick),true),x,y,4);
      }
    }
    else if (mode === 'night_walk') {
      const p = Math.max(0, Math.min(1.5, (tick - cue.spawn) / Math.max(1, cue.hit - cue.spawn)));
      const bridgeAnimations = {
        CUE_KICK:[[29,40],[37,1],[38,1],[39,2],[40,3],[41,40]], CUE_SNARE:[[29,40],[43,1],[44,1],[45,2],[46,3],[47,40]],
        CUE_CYMBAL:[[29,40],[50,1],[51,1],[52,1],[53,2],[54,3],[55,40]], CUE_ROLL:[[29,40],[37,1],[38,1],[39,2],[40,3],[41,40]],
        CUE_STAR_WAND:[[57,1],[58,1],[59,1],[60,1],[61,1],[62,1],[63,1],[64,40]]
      };
      const boxAnimations = {
        CUE_KICK:[[56,40],[67,1],[68,1],[69,2],[70,3],[71,40]], CUE_SNARE:[[56,40],[73,1],[74,1],[75,2],[76,3],[77,40]],
        CUE_CYMBAL:[[56,40],[80,1],[81,1],[82,1],[83,2],[84,3],[85,40]], CUE_ROLL:[[56,40],[67,1],[68,1],[69,2],[70,3],[71,40]],
        CUE_STAR_WAND:[[57,1],[58,1],[59,1],[60,1],[61,1],[62,1],[63,1],[64,40]]
      };
      const animation = (cue.endOfBridge ? boxAnimations : bridgeAnimations)[cue.kind] ?? bridgeAnimations.CUE_KICK;
      const noteAnimation = [[30,40],[31,1],[32,2],[33,2],[34,3],[35,6],[34,3],[33,6]];
      // night_walk_cue_hit seeks directly to animation cel 1, leaving cel 0
      // as the unopened box.  The opened cels carry their own origins, so
      // treating the cel index as elapsed-frame 40 shifts the platform after
      // a gap instead of preserving the original standing height.
      const cell = cue.state === 'hit' ? animationCell(animation.slice(1),framesBetweenTicks(cue.actionTick ?? cue.hit,tick))
        : cue.state === 'miss' && !cue.endOfBridge && tick >= cue.hit + 12 ? animationCell(noteAnimation,framesBetweenTicks(cue.hit+12,tick))
        : animation[0][0];
      const x = 320 - 256*p;
      // All bridge/fish sprites share the engine's vertical origin (unk3B8),
      // the same offset that drives the star field during a gap jump.
      // sprite_set_origin_x_y composes visibleY = captured unk4 - current unk6.
      const y = (cue.baseY ?? 120) - nightWalkWorldShift(tick);
      drawPortedCell(cell,x,y,4);
      if (cue.hasFish) drawPortedCell(animationCell([[21,4],[22,4],[23,4],[24,4],[25,4],[26,4]],framesBetweenTicks(cue.spawn,tick),true),x,y,4);
    }
  }
  if (mode === 'samurai_slice' && ported.overlays[0] && samuraiFog.alpha > 0) {
    ctx.save(); ctx.globalAlpha=samuraiFog.alpha; drawGbaTilemap(ported.overlays[0],0,samuraiFog.offsets[0]); ctx.restore();
  }
  if (mode === 'night_walk' && ported.failedAt >= 0) {
    // The original end script fades the gameplay screen after eight rests
    // (192 ticks), over a 12-tick fade interval, before its final waits.
    const fade = Math.max(0, Math.min(1, framesBetweenTicks(ported.failedAt + 192, tick) / 12));
    if (fade > 0) { ctx.save(); ctx.globalAlpha = fade; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, stage.width, stage.height); ctx.restore(); }
  }
  // Every scene entry ends with fade_screen_out + two rests, so the finished
  // run fades out and holds the faded screen instead of cutting to the menu.
  const screenFade = portedScreenFade(tick);
  if (screenFade && screenFade.alpha > 0) {
    ctx.save(); ctx.globalAlpha = screenFade.alpha; ctx.fillStyle = screenFade.colour;
    ctx.fillRect(0, 0, stage.width, stage.height);
    ctx.restore();
  }
  drawTextBox();
  drawTouchScreen();
}
function eventAudioTime(event) {
  const ac = audio();
  if (!event || !Number.isFinite(event.timeStamp)) return ac.currentTime;
  // DOMHighResTimeStamp is normally relative to performance.timeOrigin; old
  // Safari versions exposed epoch milliseconds instead. Convert both forms
  // and subtract delivery latency from the shared AudioContext clock.
  const eventPerf = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
  const age = performance.now() - eventPerf;
  if (!Number.isFinite(age) || age < -50 || age > 1000) return ac.currentTime;
  return ac.currentTime - age / 1000;
}
function portedPunch(inputEvent = null) {
  if (!running) return;
  const inputAudioTime = eventAudioTime(inputEvent);
  const tick = inputEvent ? portedTickAtAudioTime(inputAudioTime) : portedTick();
  const cue = ported.cues.find(item => {
    if (item.state !== 'fresh') return false;
    const offsetFrames = signedFramesBetweenTicks(item.hit, tick);
    if (mode === 'power_calligraphy') return offsetFrames >= -24 && offsetFrames <= 12;
    const barelyFrames = mode === 'night_walk' && item.kind === 'CUE_STAR_WAND' ? 4 : 5;
    return Math.abs(offsetFrames) <= barelyFrames;
  });
  ported.actionAt = tick; ported.actionHit = Boolean(cue); ported.actionCue = cue ?? null;
  if (!cue) {
    if (mode === 'night_walk') playPortedSfx('count',tick,128,-0xc00);
    createImpact('empty'); return;
  }
  cue.state = 'hit'; const offset = signedFramesBetweenTicks(cue.hit, tick);
  cue.actionTick = tick;
  const perfectFrames = mode === 'power_calligraphy' || (mode === 'night_walk' && cue.kind === 'CUE_STAR_WAND') ? 4 : 3;
  const perfect = Math.abs(offset) <= perfectFrames;
  cue.perfect = perfect;
  if (mode === 'night_walk' && cue.kind === 'CUE_STAR_WAND' && perfect) {
    const priorHits = ported.cues.filter(item => item !== cue && item.state === 'hit' && item.perfect && item.hit <= cue.hit).length;
    const expanded = priorHits + ported.timeline.events.filter(event => event.op === 'night_walk_expand_stars' && event.tick <= cue.hit).reduce((sum,event) => sum + Number(event.args[0] ?? 0), 0);
    if (Math.floor(expanded / 32) >= 4) ported.starWandAt = tick;
  }
  if (mode === 'power_calligraphy') cue.result = perfect ? 0 : offset < 0 ? 1 : 2;
  if (mode === 'power_calligraphy' && !perfect) ported.peopleStumbleAt = tick;
  let sound = perfect ? (mode === 'samurai_slice' && cue.kind === 'CUE_SECOND' ? 'hit2' : 'hit') : 'barely';
  if (mode === 'spaceball' && perfect && cue.kind === 'CUE_LOW_FAST') sound = null;
  if (mode === 'night_walk') sound = null;
  if (mode === 'power_calligraphy' && perfect && ['KANA_INPUT_SUN2','KANA_INPUT_KOKORO2','KANA_INPUT_KOKORO3','KANA_INPUT_COMMA1'].includes(cue.inputType)) sound = 'hit2';
  if (mode === 'power_calligraphy' && !perfect && ['KANA_INPUT_CHIKARA2','KANA_INPUT_FACE1'].includes(cue.inputType)) sound = 'barelyUnuu';
  if (mode === 'power_calligraphy' && !perfect && ['KANA_INPUT_SUN2','KANA_INPUT_KOKORO2','KANA_INPUT_KOKORO3','KANA_INPUT_COMMA1'].includes(cue.inputType)) sound = 'barelyOuch';
  if (sound) playPortedSfx(sound);
  if (mode === 'night_walk') playNightWalkDrum(cue,perfect,tick);
  createImpact(perfect ? 'perfect' : 'normal');
}

// Local-only inspection hook used by the automated browser audit. It is not
// exposed by GitHub Pages and cannot change normal gameplay.
if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && new URLSearchParams(location.search).has('audit')) {
  const audit = {
    state: () => {
      if (mode === 'tweezers') return {
        mode, running, beat: songBeat(), lastEvent: tweezers.lastEvent,
        auditPerfect: localAuditPerfect,
        perfectHits: tweezers.perfectHits,
        decodedSamples: Object.keys(originalSamples).length,
        active: tweezers.active.map(hair => ({ beat: hair.beat, hitBeat: hair.hitBeat, type: hair.type, state: hair.state, pullComplete: Boolean(hair.pullComplete) })),
        scrolling: tweezers.scrollStart >= 0
      };
      if (portedModes[mode]) return {
        mode, running, tick: ported.timeline ? portedTick() : null,
        cueCount: ported.cues.length, loadedFrames: Object.keys(ported.frames).length,
        failedAt: ported.failedAt, actionAt: ported.actionAt, actionHit: ported.actionHit,
        musicLevel: ported.timeline ? portedMusicVolumeAt(portedTick()) : null,
        screenFade: ported.timeline ? (portedScreenFade(portedTick())?.alpha ?? 0) : 0,
        reverbWet, reverbReady,
        outputLatency: outputLatency(),
        baseLatency: audioCtx ? audioCtx.baseLatency : null,
        textBoxes: ported.textBoxes.map(entry => ({ label: entry.label, from: entry.from, until: entry.until })),
        textBox: activeTextBox?.lines?.[0] ?? null,
        ...(mode === 'night_walk' ? {
          worldShift: nightWalkWorldShift(portedTick()),
          nextBridgeBaseY: ported.nightWalkBaseY,
          firstBridges: ported.cues.slice(0, 10).map(cue => ({ spawn: cue.spawn, endOfBridge: cue.endOfBridge, baseY: cue.baseY, spawned: cue.platformSpawned }))
        } : {})
      };
      if (mode === 'karate') return {
        mode, running, beat: songBeat(),
        cueCount: karateChart.length, warnings: karateWarnings.map(warning => ({ beat: warning.beat, id: warning.id })),
        tempoSegments: karateTempo, songEnd: karateSongEnd,
        bgmNotes: originalBgmEvents.length, bgmSamples: originalBgmEvents.filter(event => Number.isFinite(event.sample)).length,
        fanNotes: originalFanEvents.length, fanSamples: originalFanEvents.filter(event => Number.isFinite(event.sample)).length,
        sfxLoaded: Object.keys(karateSfx).length,
        sfxSamplesReady: Object.values(karateSfx).every(entry => entry.events.every(event => event.wave || originalSamples[event.sample])),
        decodedSamples: Object.keys(originalSamples).length,
        flowLevel, beatAnim: karateBeatAnimKind, fighterCell: karateFighterCell(),
        judgement, activeObjects: active.length,
        ouchPunch: lastPunchOuch,
        stagePalette: karateStagePalette,
        musicCursor: { ...karateMusicCursor },
        scheduledMusicNodes: scheduledMusicNodes.length,
        updatedBeat: lastBeat,
        noiseBuffers: gbaNoiseBuffers.size,
        timelineReady: karateTimelineReady,
        musicLevel: karateMusicVolumeAt(songBeat()),
        beatAnimTicks: karateBeatAnimTicks.length,
        screenFade: karateScreenFadeAlpha(songBeat()),
        reverbWet, reverbReady, reverbIndex: karateReverbIndex, reverbEvents: karateReverbEvents.length,
        outputLatency: outputLatency(),
        baseLatency: audioCtx ? audioCtx.baseLatency : null,
        textBoxes: karateTextBoxEvents.map(entry => ({ label: entry.label, from: entry.from, until: entry.until })),
        textBox: activeTextBox?.lines?.[0] ?? null
      };
      return { mode, running, beat: songBeat(), outputLatency: outputLatency() };
    },
    // Karate Man and Rhythm Tweezers run on their own beat clock, so the local
    // audit needs a way to park them on a source beat before injecting input.
    jumpToBeat: (beat) => {
      if (!running || portedModes[mode]) return;
      audioSongStart = audio().currentTime - outputLatency() - (mode === 'tweezers' ? beat * tweezersBeatMs : elapsedForBeat(beat)) / 1000;
    },
    // Local check that the GBA noise channel really is an LFSR at the register's
    // clock rate: it reports the measured level changes per second.
    noiseProbe: (register = 0x55, short = false, seconds = 0.5) => {
      const ac = audio();
      const buffer = gbaNoiseBuffer(ac, register, short, seconds);
      const data = buffer.getChannelData(0);
      let changes = 0, min = 1, max = -1;
      for (let i = 0; i < data.length; i++) {
        min = Math.min(min, data[i]); max = Math.max(max, data[i]);
        if (i && data[i] !== data[i - 1]) changes++;
      }
      const divider = GBA_NOISE_DIVIDERS[register & 7] ?? 1;
      const clock = 524288 / divider / Math.pow(2, ((register >> 4) & 0xF) + 1);
      return { frames: data.length, sampleRate: ac.sampleRate, min, max, changesPerSecond: changes / (data.length / ac.sampleRate), clock };
    },
    // Real output-level measurement on the master bus (the same signal the
    // player hears, post-gain, pre-destination).  The window is measured on the
    // AudioContext clock, not performance.now(), so it stays meaningful under a
    // virtual/headless clock.  Used to decide GBA_MIX_SCALE from data rather
    // than by ear.
    levelProbe: async (seconds = 1) => {
      const ac = audio();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      const bus = master();
      bus.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const start = ac.currentTime;
      let peak = 0, sumSquares = 0, samples = 0, fullScale = 0;
      while (ac.currentTime - start < seconds) {
        analyser.getFloatTimeDomainData(buffer);
        for (let i = 0; i < buffer.length; i++) {
          const value = buffer[i];
          const magnitude = Math.abs(value);
          if (magnitude > peak) peak = magnitude;
          if (magnitude >= .999) fullScale++;
          sumSquares += value * value;
          samples++;
        }
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      bus.disconnect(analyser);
      const rms = Math.sqrt(sumSquares / Math.max(1, samples));
      return {
        seconds, sampleRate: ac.sampleRate, mixScale: GBA_MIX_SCALE,
        peak, peakDb: 20 * Math.log10(Math.max(peak, 1e-6)),
        rms, rmsDb: 20 * Math.log10(Math.max(rms, 1e-6)),
        fullScaleSamples: fullScale, measuredSamples: samples,
        start, end: ac.currentTime
      };
    },
    // Tap point for local level measurement: the master bus is the exact signal
    // the player hears, so an analyser hung off it reads the real output level.
    masterNode: () => master(),
    // Parking the clock must use the same heard-time origin as portedTick(),
    // otherwise a parked cue would sit outputLatency() away from its own tick.
    jumpToTick: (tick) => { if (running && ported.timeline) audioSongStart = audio().currentTime - outputLatency() - secondsAtTick(Number(tick)); },
    nextCue: () => ported.cues.find(cue => cue.state === 'fresh' && cue.hit >= portedTick())?.hit ?? null,
    hitNext: () => { const hit = ported.cues.find(cue => cue.state === 'fresh' && cue.hit >= portedTick())?.hit; if (hit != null) { audioSongStart = audio().currentTime - outputLatency() - secondsAtTick(hit); portedPunch(); } }
  };
  // Deterministic source-tick replay used by the local audit. It advances to
  // each cue's spawn tick, then injects the input exactly at its hit tick.
  // This verifies the actual browser judgement path rather than merely
  // comparing JSON charts.
  audit.perfectSweep = () => {
    if (!running || !ported.timeline) return { ok: false, reason: 'not-running' };
    if (!portedModes[mode]) return { ok: false, reason: 'wrong-mode' };
    cancelAnimationFrame(frame);
    const results = [];
    for (const cue of ported.cues) {
      if (cue.state !== 'fresh') continue;
      audioSongStart = audio().currentTime - outputLatency() - secondsAtTick(cue.spawn);
      portedLoop();
      audioSongStart = audio().currentTime - outputLatency() - secondsAtTick(cue.hit);
      portedPunch();
      results.push({ tick: cue.hit, state: cue.state, perfect: cue.perfect === true, actionTick: cue.actionTick });
    }
    cancelAnimationFrame(frame);
    const failed = results.filter(item => !item.perfect || item.state !== 'hit');
    return { ok: failed.length === 0 && results.length === ported.cues.length, count: results.length, failed, results };
  };
  window.__rhythmAudit = audit;
  auditStatePublisher = () => {
    const value = audit.state();
    value.nextCue = audit.nextCue();
    value.cueSpawningDisabled = ported.cueSpawningDisabled;
    if (portedModes[mode]) value.perfectHits = ported.cues.filter(cue => cue.state === 'hit' && cue.perfect).length;
    value.cueStates = ported.cues.map(cue => ({ spawn: cue.spawn, hit: cue.hit, state: cue.state, perfect: cue.perfect ?? null, endOfBridge: cue.endOfBridge ?? null, platformType: cue.platformType ?? null, actionTick: cue.actionTick ?? null }));
    document.body.dataset.auditState = JSON.stringify(value);
  };
  document.addEventListener('rhythm-audit', () => {
    const [command, value] = (document.body.dataset.auditCommand ?? 'state').split(':');
    if (command === 'jump') audit.jumpToTick(Number(value));
    if (command === 'hit') audit.hitNext();
    document.body.dataset.auditState = JSON.stringify(audit.state());
  });
  if (new URLSearchParams(location.search).has('auditSweep')) {
    const sweepStart = () => {
      const requested = new URLSearchParams(location.search).get('auditSweep');
      const targets = ['karate', 'tweezers', 'spaceball', 'samurai_slice', 'night_walk', 'power_calligraphy'];
      const target = targets.includes(requested) ? requested : 'night_walk';
      const label = portedModes[target]?.label ?? (target === 'karate' ? '空手道家' : '节奏脱毛');
      if (!(mode === target && running)) {
        if (target === 'karate') start();
        else if (target === 'tweezers') tweezersStart();
        else startPortedMode(target);
      }
      const wait = () => {
        // Karate Man and Rhythm Tweezers have no synthetic perfect sweep; the
        // route just reports their loaded runtime state for a smoke test.
        if (!running || mode !== target) return setTimeout(wait, 50);
        if (portedModes[target] && !ported.cues.length) return setTimeout(wait, 50);
        if (portedModes[target]) {
          const result = audit.perfectSweep();
          document.body.dataset.auditSweep = JSON.stringify(result);
          document.title = `${label} sweep ${result.ok ? 'PASS' : 'FAIL'} (${result.count ?? 0}/${ported.cues.length})`;
          return;
        }
        const result = audit.state();
        document.body.dataset.auditSweep = JSON.stringify(result);
        document.title = `${label} state samples ${result.decodedSamples ?? 0} sfx ${result.sfxLoaded ?? 0}`;
      };
      wait();
    };
    setTimeout(sweepStart, 0);
  }
}

$('#startBtn').onclick = () => { mode = 'karate'; start(); };
$('#tweezersBtn').onclick = tweezersStart;
$('#spaceballBtn').onclick = () => startPortedMode('spaceball');
$('#samuraiBtn').onclick = () => startPortedMode('samurai_slice');
$('#nightWalkBtn').onclick = () => startPortedMode('night_walk');
$('#calligraphyBtn').onclick = () => startPortedMode('power_calligraphy');
stage.addEventListener('pointerdown', (event) => portedModes[mode] ? portedPunch(event) : mode === 'tweezers' ? tweezersPunch() : punch());
touch.addEventListener('pointerdown', (event) => portedModes[mode] ? portedPunch(event) : mode === 'tweezers' ? tweezersPunch() : punch());
// iOS Safari still recognises a double-tap zoom gesture on some canvas builds
// even with viewport constraints.  The game owns touch-end on both screens.
for (const canvas of [stage, touch]) canvas.addEventListener('touchend', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
// Prevent iOS/Android long-press selection, callout menus and image dragging
// while interacting with either game screen.
for (const eventName of ['contextmenu', 'selectstart', 'dragstart']) {
  document.addEventListener(eventName, (event) => {
    if (event.target instanceof HTMLCanvasElement || event.target.closest?.('#game')) event.preventDefault();
  }, { passive: false });
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (game.classList.contains('hidden')) start(); else portedModes[mode] ? portedPunch() : mode === 'tweezers' ? tweezersPunch() : punch(); }
  if (event.code === 'F1' && !game.classList.contains('hidden')) { event.preventDefault(); mode === 'tweezers' ? tweezersStart() : start(); }
  if (event.code === 'F2') cheat = !cheat;
});
