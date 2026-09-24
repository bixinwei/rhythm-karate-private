// Source-value evaluators. Native ParticleSystem motion/emission is NOT
// implemented here, and passing these tests does not certify visual parity.
const mix = (a, b, t) => a + (b - a) * t;

export function curveValue(curve, time) {
  const keys = curve.m_Curve;
  if (!keys.length) throw new Error('Empty Unity curve');
  if (keys.some(k => k.weightedMode)) throw new Error('Weighted curve needs a separate evaluator');
  if (time <= keys[0].time) return keys[0].value;
  if (time >= keys.at(-1).time) return keys.at(-1).value;
  const i = keys.findIndex(k => k.time >= time);
  const a = keys[i - 1], b = keys[i];
  if (time === b.time) return b.value;
  // Infinite tangents describe a held/stepped segment, not linear easing.
  if (!Number.isFinite(Number(a.outSlope)) || !Number.isFinite(Number(b.inSlope))) return a.value;
  const span = b.time - a.time, u = (time - a.time) / span;
  return (2*u**3 - 3*u**2 + 1)*a.value + (u**3 - 2*u**2 + u)*span*a.outSlope
    + (-2*u**3 + 3*u**2)*b.value + (u**3 - u**2)*span*b.inSlope;
}

export function minMaxCurveValue(value, time, random) {
  switch (value.minMaxState) {
    case 0: return value.scalar;
    case 1: return value.scalar * curveValue(value.maxCurve, time);
    case 2: return mix(value.scalar * curveValue(value.minCurve, time), value.scalar * curveValue(value.maxCurve, time), random);
    case 3: return mix(value.minScalar, value.scalar, random);
    default: throw new Error(`Unsupported curve mode ${value.minMaxState}`);
  }
}

export function gradientValue(gradient, time) {
  if (![0, 1].includes(gradient.m_Mode)) throw new Error('Unsupported gradient mode');
  const sample = (channel, count, prefix) => {
    const keys = Array.from({length: count}, (_, i) => ({t: gradient[`${prefix}${i}`] / 65535, v: gradient[`key${i}`][channel]}));
    if (time <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; ++i) {
      if (time <= keys[i].t) {
        if (gradient.m_Mode === 1) return keys[i].v;
        return mix(keys[i-1].v, keys[i].v, (time-keys[i-1].t)/(keys[i].t-keys[i-1].t));
      }
    }
    return keys.at(-1).v;
  };
  return [...'rgb'].map(c => sample(c, gradient.m_NumColorKeys, 'ctime'))
    .concat(sample('a', gradient.m_NumAlphaKeys, 'atime'));
}

export function minMaxGradientValue(value, time, random) {
  const rgba = c => [c.r, c.g, c.b, c.a];
  switch (value.minMaxState) {
    case 0: return rgba(value.maxColor);
    case 1: return gradientValue(value.maxGradient, time);
    case 2: return rgba(value.minColor).map((a,i) => mix(a, rgba(value.maxColor)[i], random));
    case 3: return gradientValue(value.minGradient,time).map((a,i) => mix(a,gradientValue(value.maxGradient,time)[i],random));
    case 4: return gradientValue(value.maxGradient, random);
    default: throw new Error(`Unsupported gradient mode ${value.minMaxState}`);
  }
}

// AceColorCycle.shader: grayscale + (_Speed / 4) * _Time.y. _Time is
// global shader time, NOT the particle's age. Bilinear clamp texture sampling.
export function acePaletteValue(palette, gray, globalSeconds, speed) {
  if (palette.height !== 1) throw new Error('Expected source one-row palette');
  const phase = gray + speed / 4 * globalSeconds;
  const x = (phase - Math.floor(phase)) * palette.width - .5;
  const a = Math.floor(x), t = x - a;
  const pixel = i => palette.pixels[Math.max(0, Math.min(palette.width-1, i))];
  return pixel(a).map((v,i) => mix(v, pixel(a+1)[i], t) / 255);
}
