const $ = (selector) => document.querySelector(selector);

const menu = $('#menu');
const game = $('#game');
const stage = $('#stage');
const ctx = stage.getContext('2d');
const touch = $('#lower');
const touchCtx = touch.getContext('2d');

const sprites = {};
// Local exports composed from the GBA decomp's original 4bpp tiles, palette
// banks and animation cells.  These replace the temporary hand-drawn sheet.
const gba = {};
for (const cell of [0, 1, 2, 15, 16, 17, 18, 19, 20, 21, 22, 23, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) {
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
  [128,'pot'], [130,'rock'], [133,'bulb'], [133,'bomb']
];
const chart = spawnChart.map(([spawnBeat, type]) => [spawnBeat + 1, type]);
const SONG_END = 151;
const tempoSegments = [{ from: 0, bpm: 120 }, { from: 134, bpm: 150 }, { from: 143, bpm: 140 }];
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
let originalSamples = {};
let sampleLoadPromise = null;
let audioSongStart = 0;
let scheduledMusicNodes = [];
let songRun = 0;
const bgmLoadPromise = fetch('assets/gba/karate_bgm_events.json').then((response) => response.json()).then((events) => { originalBgmEvents = events; }).catch(() => []);
const originalSfx = {};
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

function loadOriginalSamples() {
  if (sampleLoadPromise) return sampleLoadPromise;
  const ac = audio();
  const numbers = [...new Set([...Array.from({ length: 13 }, (_, index) => index + 1), ...Object.values(karateSfxSamples)])];
  sampleLoadPromise = Promise.allSettled(numbers.map(async (number) => {
    const name = String(number).padStart(3, '0');
    const response = await fetch(`assets/gba/samples/sample_${name}.wav`);
    if (!response.ok) throw new Error(`Missing original sample ${name}`);
    originalSamples[number] = await ac.decodeAudioData(await response.arrayBuffer());
  }));
  return sampleLoadPromise;
}

function playMusic(wholeBeat) {
  if (wholeBeat < 0 || wholeBeat === lastMusicBeat) return;
  lastMusicBeat = wholeBeat;
  // The complete original note timeline is scheduled at start. Keep this only
  // as a safe fallback if its local JSON has not loaded yet.
  if (!originalBgmEvents.length) tone(wholeBeat % 4 === 0 ? 92 : 116, .1, 'triangle', .035);
}

function scheduleOriginalBgm() {
  if (!originalBgmEvents.length) return;
  const ac = audio();
  for (const event of originalBgmEvents) {
    if (event.beat >= SONG_END) continue;
    const freq = 440 * Math.pow(2, (event.note - 69) / 12);
    const endBeat = Math.min(SONG_END, event.beat + event.length);
    const duration = Math.max(.025, (elapsedForBeat(endBeat) - elapsedForBeat(event.beat)) / 1000);
    const percussion = event.program === 127 || event.program === 119 || event.program === 41;
    const type = percussion ? 'square' : event.program === 39 ? 'triangle' : event.channel === 1 ? 'sine' : 'triangle';
    const volume = Math.min(.028, .004 + event.velocity / 127 * (percussion ? .015 : .02));
    const sampleMap = { 0: 1, 1: 2, 2: 3, 3: 4, 5: 5, 7: 6, 8: 7, 10: 8, 11: 9, 12: 10, 39: 12, 41: 11, 119: 13 };
    const sample = originalSamples[sampleMap[event.program]];
    const when = Math.max(ac.currentTime + .01, audioSongStart + elapsedForBeat(event.beat) / 1000);
    if (sample) {
      const source = ac.createBufferSource(); const gain = ac.createGain();
      source.buffer = sample; source.playbackRate.value = Math.pow(2, (event.note - 60) / 12);
      gain.gain.value = volume * 1.8;
      source.connect(gain).connect(ac.destination);
      scheduledMusicNodes.push(source);
      source.start(when); source.stop(when + Math.min(.48, duration));
    } else {
      tone(percussion ? Math.min(880, freq) : freq, Math.min(.48, duration), type, volume, when - ac.currentTime);
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

const chartBeats = new Set(chart.map(([beat]) => beat));

$('#best').textContent = best;

function start() {
  audio();
  const run = ++songRun;
  for (const node of scheduledMusicNodes) { try { node.stop(); } catch {} }
  scheduledMusicNodes = [];
  menu.classList.add('hidden');
  game.classList.remove('hidden');
  startAt = performance.now() + elapsedForBeat(3);
  audioSongStart = audio().currentTime + elapsedForBeat(3) / 1000;
  Promise.all([bgmLoadPromise, loadOriginalSamples()]).then(() => { if (running && run === songRun) scheduleOriginalBgm(); });
  chartIndex = score = combo = 0;
  flowLevel = 0;
  running = true;
  perfectRun = true;
  active = [];
  touchFx = [];
  judgement = '';
  lastBeat = -1;
  lastMusicBeat = -99;
  $('#score').textContent = '0';
  $('#combo').textContent = '0';
  $('#phase').textContent = '3';
  $('#result').className = 'result';
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(loop);
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
  return beatAtElapsed(performance.now() - startAt);
}

function loop() {
  const beat = songBeat();
  if (beat > SONG_END) return finish();
  update(beat);
  render(beat);
  $('#progress').style.width = `${Math.max(0, Math.min(100, beat / SONG_END * 100))}%`;
  frame = requestAnimationFrame(loop);
}

function update(beat) {
  const currentWholeBeat = Math.floor(beat);
  if (currentWholeBeat !== lastBeat) {
    lastBeat = currentWholeBeat;
    $('#phase').textContent = currentWholeBeat < 0 ? String(-currentWholeBeat) : 'GO!';
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
      $('#combo').textContent = '0';
      createImpact('miss');
      missSound();
    }
    if (item.state === 'flying' && cueTime > 2) {
      item.state = 'landed';
      item.landBeat = beat;
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
    $('#combo').textContent = '0';
    createImpact('miss');
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
  judgement = perfect ? 'PERFECT!' : 'OK!';
  if (!perfect) perfectRun = false;
  $('#score').textContent = score;
  $('#combo').textContent = combo;
  $('#best').textContent = best;
  localStorage.karateBest = best;
  if (!playOriginalSfx(candidate?.type === 'football' ? 'ball' : candidate?.type ?? 'normal')) hitSound(perfect);
  createImpact(perfect ? 'perfect' : 'normal');
  const flash = $('#upperFlash');
  flash.className = perfect ? 'good' : 'ok';
  setTimeout(() => { flash.className = ''; }, 180);
}

function createImpact(kind) {
  // The 3DS lower screen has three distinct result animations.
  touchFx.push({ life: 1, kind });
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
  ctx.fillStyle = judgement === 'PERFECT!' ? '#fff0a1' : judgement === 'MISS' ? '#ff9189' : '#ffffff';
  ctx.font = '700 26px DM Mono';
  ctx.textAlign = 'left';
  ctx.fillText(judgement, 48, 58);
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
const PERFECT_COLORS = ['#c9f531', '#f13bca', '#3de9ed', '#78f078', '#aaf03b', '#ffe42b', '#ef42c8', '#ffe42b', '#61f283', '#ffa34e'];

function drawTouchScreen() {
  const w = touch.width, h = touch.height, size = 68, gap = 4, left = 34, top = 28;
  touchCtx.fillStyle = '#070709'; touchCtx.fillRect(0, 0, w, h);
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 8; col++) {
      touchCtx.fillStyle = (row + col) % 2 ? '#24242b' : '#111116';
      touchCtx.fillRect(left + col * (size + gap), top + row * (size + gap), size, size);
      touchCtx.fillStyle = '#34343d'; touchCtx.fillRect(left + col * (size + gap) + 3, top + row * (size + gap) + 3, 2, 2);
    }
  }
  // Permanent markings visible in the reference lower display.
  touchCtx.strokeStyle = '#d8d6dc'; touchCtx.lineWidth = 3; touchCtx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 7 : 14;
    if (i) touchCtx.lineTo(57 + Math.cos(a) * r, 56 + Math.sin(a) * r); else touchCtx.moveTo(57 + Math.cos(a) * r, 56 + Math.sin(a) * r);
  }
  touchCtx.closePath(); touchCtx.stroke();
  touchCtx.fillStyle = '#1b42ed'; touchCtx.beginPath(); touchCtx.arc(570, 126, 15, 0, Math.PI * 2); touchCtx.fill();
  touchCtx.strokeStyle = '#11121c'; touchCtx.lineWidth = 3; touchCtx.stroke();
  touchCtx.fillStyle = '#e4dbff'; touchCtx.beginPath(); touchCtx.arc(564, 110, 5, 0, Math.PI * 2); touchCtx.arc(578, 110, 5, 0, Math.PI * 2); touchCtx.fill();
  touchCtx.fillStyle = '#17121b'; touchCtx.beginPath(); touchCtx.arc(564, 110, 2, 0, Math.PI * 2); touchCtx.arc(578, 110, 2, 0, Math.PI * 2); touchCtx.fill();
  const noteCells = [[1,2],[5,2],[2,3],[6,3],[1,5],[5,5]];
  touchCtx.fillStyle = '#050509'; touchCtx.font = '700 45px sans-serif';
  for (const [col, row] of noteCells) touchCtx.fillText('♪', left + col * (size + gap) + 12, top + row * (size + gap) + 49);
  touchCtx.fillStyle = '#f4f3f4'; touchCtx.font = '600 31px sans-serif'; touchCtx.fillText('⌁  Simple Tap', 45, 447);
  for (const fx of touchFx) {
    fx.life -= .036;
    const progress = 1 - fx.life, cx = w / 2, cy = h / 2;
    if (fx.kind === 'perfect') {
      // Unlike the normal yellow ring, perfect stars keep travelling past
      // the checkerboard and finally leave the lower screen.
      const travel = Math.min(1, progress);
      const ease = travel;
      for (let i = 0; i < PERFECT_COLORS.length; i++) {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / PERFECT_COLORS.length;
        const targetX = cx + Math.cos(angle) * 430, targetY = cy + Math.sin(angle) * 430;
        const startX = cx + Math.cos(angle) * 34, startY = cy + Math.sin(angle) * 34;
        const x = startX + (targetX - startX) * ease, y = startY + (targetY - startY) * ease;
        const spin = i * .19;
        // Stars begin small in the centre cluster, growing continuously as
        // the ring expands to its final diameter.
        const scale = .55 + travel * .68;
        draw3dsStar(touchCtx, x, y, 20.8 * scale, PERFECT_COLORS[i], Math.max(0, fx.life), spin);
      }
    } else if (fx.kind === 'normal') {
      const travel = Math.min(1, progress / .72), ease = 1 - Math.pow(1 - travel, 3);
      for (let i = 0; i < 8; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 4;
        const x = cx + Math.cos(angle) * 150 * ease, y = cy + Math.sin(angle) * 150 * ease;
        draw3dsStar(touchCtx, x, y, 8.8 + travel * 13.6, '#ffe229', Math.max(0, fx.life), 0);
        draw3dsStar(touchCtx, cx + Math.cos(angle) * 78 * ease, cy + Math.sin(angle) * 78 * ease, 2.4 + travel * 4, '#ffe229', Math.max(0, fx.life * .9), 0);
      }
    } else {
      // A miss produces only the single yellow centre star.
      const pop = progress < .2 ? .7 + progress * 2.2 : 1.14 - (progress - .2) * .5;
      draw3dsStar(touchCtx, cx, cy, 19.2 * pop, '#ffe229', Math.max(0, fx.life), 0);
    }
  }
  touchCtx.globalAlpha = 1;
  touchFx = touchFx.filter((fx) => fx.life > 0);
}

function finish() {
  running = false;
  const result = $('#result');
  result.textContent = perfectRun ? 'PERFECT!' : 'STAGE CLEAR';
  result.className = `result show ${perfectRun ? 'good' : 'ok'}`;
  setTimeout(quit, 2800);
}

$('#startBtn').onclick = start;
$('#quitBtn').onclick = quit;
$('#tapBtn').onclick = punch;
stage.addEventListener('pointerdown', punch);
touch.addEventListener('pointerdown', punch);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); game.classList.contains('hidden') ? start() : punch(); }
  if (event.code === 'F1' && !game.classList.contains('hidden')) { event.preventDefault(); start(); }
  if (event.code === 'F2') cheat = !cheat;
});
