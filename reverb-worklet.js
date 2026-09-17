// Game Boy Advance software reverb, derived from the retail mixer.
//
// The mixer keeps one DMA buffer of 1568 samples per channel at
// AUDIO_SAMPLE_RATE 13379 Hz (midi.h: DMA_SAMPLE_BUFFER_SIZE / AUDIO_SAMPLE_RATE,
// four 8-bit samples per 32-bit DMA word, see midi_arm_stereo_update_buffer).
// midi_arm_stereo_update_scratch reads that buffer with a tap that lags one full
// buffer length for the right channel and 4 * phase samples less for the left,
// then runs two one-pole sections over it:
//
//   a  = a  - (a  >> lowCut) + x     // x = the 8-bit sample from the DMA buffer
//   hp = x  - (a  >> lowCut)         // DC block
//   b  = b  - (b  >> decay)  + hp    // leaky low boost
//   wet = (wet >> decay) * b         // scratch units, summed with the dry mix
//
// gameplay_set_reverb(level) calls midi_player_set_reverb(clamp(level + 35, 0, 127), 2, 2, 4),
// so lowCut = decay = 2 and the multiplier is (wet >> 2).  The scratch mix is
// converted back to the DMA's 8-bit samples by gMidiSampleTable, which
// midi_directsound_init fills with clamp(scratch >> 7, -128, 127) - so the wet
// lands in the same units as the dry mix after dividing by 128.
//
// Because the DMA buffer holds the post-mix signal, the tap reads the reverb's
// own output: the ring stores dry + wet, exactly like the ROM (the wet is added
// to the scratch before midi_arm_stereo_update_buffer packs it).
//
// The one-pole coefficient is per ROM sample, so it is re-derived for the device
// sample rate while the delay keeps the ROM's timing (116.6 ms for the right
// channel, 0.6 ms less for the left).
const ROM_SAMPLE_RATE = 13379;
const ROM_RING_SAMPLES = 1568;
const ROM_PHASE_SAMPLES = 2;              // gMidiReverb2Phase, in DMA words
const ROM_SAMPLES_PER_WORD = 4;
const ROM_POLE_DECAY = 2;                 // a -= a >> 2
const ROM_WET_SHIFT = 2;                  // wet >> decay
const ROM_SCRATCH_TO_SAMPLE = 128;        // gMidiSampleTable: scratch >> 7

class GbaReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'wet', defaultValue: 0, minValue: 0, maxValue: 127, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    const ratio = sampleRate / ROM_SAMPLE_RATE;
    this.pole = Math.pow(1 - Math.pow(2, -ROM_POLE_DECAY), ratio);
    this.ringLength = Math.max(2, Math.round(ROM_RING_SAMPLES * ratio));
    this.delays = [
      this.ringLength,
      Math.max(1, this.ringLength - Math.round(ROM_PHASE_SAMPLES * ROM_SAMPLES_PER_WORD * ratio))
    ];
    this.rings = [new Float32Array(this.ringLength), new Float32Array(this.ringLength)];
    this.position = 0;
    this.low = [0, 0];
    this.accumulator = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const wet = (parameters.wet[0] | 0) >> ROM_WET_SHIFT;
    const alpha = 1 - this.pole;
    const gain = wet / ROM_SCRATCH_TO_SAMPLE;
    const channels = output.length;
    for (let i = 0; i < frames; i++) {
      for (let channel = 0; channel < channels; channel++) {
        const index = Math.min(channel, 1);
        const ring = this.rings[index];
        const source = input[channel] ?? input[0];
        const dry = source ? source[i] : 0;
        let read = this.position - this.delays[index];
        if (read < 0) read += this.ringLength;
        const delayed = ring[read];
        const low = this.pole * this.low[index] + delayed;
        this.low[index] = low;
        const highPassed = delayed - alpha * low;
        const accumulator = this.pole * this.accumulator[index] + highPassed;
        this.accumulator[index] = accumulator;
        const wetSample = gain * accumulator;
        ring[this.position] = dry + wetSample;
        if (output[channel]) output[channel][i] = wetSample;
      }
      this.position += 1;
      if (this.position >= this.ringLength) this.position = 0;
    }
    return true;
  }
}

registerProcessor('gba-reverb', GbaReverbProcessor);
