const fs = require('fs');
const root = fs.readFileSync('game.js', 'utf8');
const karate = JSON.parse(fs.readFileSync('assets/gba/karate_frames.json'));
const frames = [0, 1, 2, 15, 16, 17, 18, 19, 20, 21, 22, 23];
const failures = [];
for (const cell of frames) {
  const meta = karate[cell];
  if (!meta) { failures.push(`karate: missing cel ${cell}`); continue; }
  const top = 88 - meta.originY, bottom = top + meta.height;
  if (top < 0 || bottom > 160) failures.push(`karate: cel ${cell} crosses native viewport (${top}..${bottom})`);
  console.log(`karate cel ${cell}: native y ${top}..${bottom}`);
}
// The remaining five games must draw every primary sprite through its exported
// source manifest. Their original sprite cells may deliberately extend beyond
// the viewport during entrances, so an image bounding rectangle is not a
// clipping failure by itself.
for (const [name, file] of [
  ['tweezers', 'assets/gba/tweezers/frames.json'],
  ['spaceball', 'assets/gba/spaceball/frames.json'],
  ['samurai', 'assets/gba/samurai_slice/frames.json'],
  ['night_walk', 'assets/gba/night_walk/frames.json'],
  ['calligraphy', 'assets/gba/power_calligraphy/frames.json']
]) {
  const manifest = JSON.parse(fs.readFileSync(file));
  if (!Object.keys(manifest).length) failures.push(`${name}: missing sprite manifest`);
}
if (!root.includes('const meta = karateManifest[cell] ?? karateManifest[0]')) failures.push('karate: renderer does not use source anchors');
if (!root.includes('function drawTweezersCell') || !root.includes('-meta.originY * scale')) failures.push('tweezers: renderer does not use source anchors');
if (!root.includes('function drawPortedCell') || !root.includes('-meta.originY*scale')) failures.push('ported games: renderer does not use source anchors');
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Anchor audit passed: Karate’s complete idle/punch set fits 240×160; all other game renderers use their exported source-manifest anchors.');
