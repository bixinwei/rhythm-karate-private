// Sample-accurate measurement of the port's dry music bed in the same bus units
// game.js uses (1.0 = full scale).
//
// The ROM's mixer accumulates every voice in its scratch domain and
// gMidiSampleTable clamps `scratch >> 7` to -128..127, so one full-volume voice
// already reaches the clamp: the browser-side calibration factor that
// reproduces the retail mix is 1.0, and loud passages saturate exactly like the
// ROM's DMA stage.  This tool reports what each level's exported music bed does
// at a given scale, so GBA_MIX_SCALE can be checked against data instead of by
// ear.
//
// Usage: node tools/measure_mix_levels.mjs [scale ...]   (default: 0.48 1)
import fs from 'node:fs';
import path from 'node:path';

const OUT_RATE = 48000;
const ROOT = process.cwd();
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/gba', name + '.json'), 'utf8'));
const dB = (value) => (value <= 1e-9 ? -Infinity : 20 * Math.log10(value));

function readWav(file) {
  const bytes = fs.readFileSync(file);
  let offset = 12, format = null, data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: bytes.readUInt16LE(offset + 10), rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
    if (id === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('unsupported wav: ' + file);
  const count = Math.floor(data.length / (format.bits / 8) / format.channels);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * (format.bits / 8) * format.channels;
    // 8-bit PCM WAV is unsigned; Web Audio's decodeAudioData maps it the same way.
    samples[i] = format.bits === 8 ? (data[at] - 128) / 128 : data.readInt16LE(at) / 32768;
  }
  return { rate: format.rate, samples };
}

const sampleCache = new Map();
function sampleData(index) {
  if (!sampleCache.has(index)) sampleCache.set(index, readWav(path.join(ROOT, 'assets/gba/samples', `sample_${String(index).padStart(3, '0')}.wav`)));
  return sampleCache.get(index);
}

function envelopeAt(event, seconds) {
  if (event.adsrInit == null) return 1;
  const full = 127 * 65536, frame = 1 / 60;
  const initial = Math.max(0, Math.min(1, event.adsrInit / full));
  const sustain = Math.max(0, Math.min(1, event.adsrSustain / full));
  const attackEnd = (event.adsrAttack ? Math.max(0, (full - event.adsrInit) / event.adsrAttack) : 0) * frame;
  const decayEnd = attackEnd + (event.adsrDecay ? Math.max(0, (full - event.adsrSustain) / event.adsrDecay) : 0) * frame;
  if (seconds < attackEnd && attackEnd) return initial + (1 - initial) * seconds / attackEnd;
  if (seconds < decayEnd && decayEnd > attackEnd) return 1 - (1 - sustain) * (seconds - attackEnd) / (decayEnd - attackEnd);
  if (!event.adsrFade) return sustain;
  return Math.max(0, sustain - event.adsrFade * (seconds - decayEnd) * 60 / full);
}

function busVolumeAt(events, tick) {
  let value = 256;
  for (const event of events) {
    if (event.tick > tick) break;
    if (event.op === 'set_music_volume') value = Number(event.args[0]);
    if (event.op === 'mod_music_volume' || event.op === 'fade_music_out') {
      const target = event.op === 'mod_music_volume' ? Number(event.args[0]) : 0;
      const span = Math.max(1, Number(event.args[1] ?? event.args[0]));
      if (tick < event.tick + span) return value + (target - value) * (tick - event.tick) / span;
      value = target;
    }
  }
  return value;
}

function bedFor(file, timelineName, scale, overrides = {}) {
  const payload = readJson(file);
  const header = overrides.header ?? payload.volume ?? 256;
  const events = payload.events ?? payload;
  const timeline = timelineName ? readJson(timelineName) : null;
  const timelineEvents = timeline ? [...timeline.events].sort((a, b) => a.tick - b.tick) : [];
  const tempoEvents = timelineEvents.filter((event) => event.op === 'set_tempo');
  const bpm = overrides.bpm ?? (tempoEvents.length ? Number(tempoEvents[0].args[0]) : 120);
  const secondsPerBeat = 60 / bpm;
  const endSeconds = Math.max(...events.map((event) => (event.beat + Math.max(event.length, 0.02)) * secondsPerBeat));
  const length = Math.ceil((endSeconds + 1) * OUT_RATE);
  const bed = new Float32Array(length);
  let voices = 0, skipped = 0, loudest = { gain: 0 };
  for (const event of events) {
    if (!Number.isFinite(event.sample)) { skipped++; continue; }
    const sample = sampleData(event.sample);
    const rate = (event.fixed ? 1 : Math.pow(2, ((event.playNote ?? event.note) - (event.baseNote ?? 60)) / 12)) * sample.rate / OUT_RATE;
    const bus = timeline ? busVolumeAt(timelineEvents, event.beat * 24) : (overrides.bus ?? 256);
    const gain = scale * (event.velocity / 127) * (header / 256) * (bus / 256) * ((event.volume ?? 127) / 127) * ((event.expression ?? 127) / 127);
    if (gain > loudest.gain) loudest = { gain, note: event.note, velocity: event.velocity, volume: event.volume, bus };
    const duration = Math.max(0.02, event.length * secondsPerBeat);
    const start = Math.floor(event.beat * secondsPerBeat * OUT_RATE);
    const frames = Math.min(length - start, Math.ceil(duration * OUT_RATE));
    for (let i = 0; i < frames; i++) {
      const source = (i * rate) | 0;
      if (source >= sample.samples.length) break;
      bed[start + i] += gain * envelopeAt(event, i / OUT_RATE) * sample.samples[source];
    }
    voices++;
  }
  let peak = 0, sumSquares = 0, clipped = 0;
  for (let i = 0; i < length; i++) {
    const value = bed[i], magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if (magnitude > 1) clipped++;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / length);
  return { header, bpm, voices, skipped, peak, peakDb: dB(peak), rms, rmsDb: dB(rms), clippedPercent: 100 * clipped / length, loudest };
}

const LEVELS = [
  { id: 'spaceball', file: 'spaceball_bgm_events', timeline: 'spaceball_timeline' },
  { id: 'samurai_slice', file: 'samurai_bgm1_events', timeline: 'samurai_slice_timeline' },
  { id: 'samurai_result', file: 'samurai_result_events', timeline: null },
  { id: 'night_walk', file: 'night_walk_bgm_events', timeline: 'night_walk_timeline' },
  { id: 'power_calligraphy', file: 'calligraphy_bgm1_events', timeline: 'power_calligraphy_timeline' },
  // karate_bgm_events.json carries no SongHeader volume: the port hardcodes the
  // ROM's 90 and the BeatScript music-bus automation (100 -> 240 -> 150), so the
  // measurement uses that pair explicitly.
  { id: 'karate_man', file: 'karate_bgm_events', timeline: null, overrides: { header: 90, bus: 150, bpm: 120 } }
];

const scales = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
const report = [];
for (const level of LEVELS) {
  for (const scale of (scales.length ? scales : [1])) {
    const result = bedFor(level.file, level.timeline, scale, level.overrides);
    report.push(`${level.id} scale ${scale}: header ${result.header}/256 bpm ${result.bpm} voices ${result.voices} (skipped ${result.skipped}) peak ${result.peakDb.toFixed(1)}dB RMS ${result.rmsDb.toFixed(1)}dB over-full ${result.clippedPercent.toFixed(3)}% loudest voice gain ${result.loudest.gain.toFixed(3)} (vel ${result.loudest.velocity} chvol ${result.loudest.volume} bus ${result.loudest.bus})`);
  }
}
const text = report.join('\n');
const captureDirectory = path.join(ROOT, 'captures');
if (fs.existsSync(captureDirectory)) fs.writeFileSync(path.join(captureDirectory, 'mix-levels.txt'), text);
console.log(text);