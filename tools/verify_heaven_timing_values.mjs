import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {curveValue, minMaxCurveValue, minMaxGradientValue, acePaletteValue} from '../heaven-timing-values.js';

const base = new URL('../assets/heaven-timing/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('source.json', base)));
const ace = data.systems[data.roots.Just00].particleSystem;
const ok = data.systems[data.roots.Just01].particleSystem;
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);

for (const system of Object.values(data.systems)) {
  assert.equal(system.particleSystem.UVModule.sprites.length, 1);
  assert.equal(system.particleSystem.UVModule.sprites[0].sprite.guid, 'f32373bf1e076534c9a5bd0eb82f073f');
  for (const sub of system.particleSystem.SubModule.subEmitters ?? []) {
    assert.equal(typeof sub.emitter.fileID, 'string'); // IDs exceed JS integer precision.
    assert.ok(data.systems[sub.emitter.fileID]);
    assert.equal(sub.type, 0); // Birth, not death.
  }
}
for (const [path, entry] of Object.entries(data.dependencies)) {
  if (!path.startsWith('Assets/') || !entry.sha256) continue;
  const name = path.split('/').at(-1);
  const local = new URL(name === 'TimingAccuracyDisplay.cs' ? name+'.txt' : name, base);
  const digest = createHash('sha256').update(fs.readFileSync(local)).digest('hex');
  assert.equal(digest, entry.sha256, `Source bytes differ: ${name}`);
}
const orbit = ace.VelocityModule.orbitalZ;
near(minMaxCurveValue(orbit,.05,.5), 6 * -.19677734);
near(minMaxCurveValue(orbit,.1,.5), 6 * -.8);
near(minMaxCurveValue(orbit,.25,.5), -6);
near(minMaxCurveValue(ace.SizeModule.curve,.40679932,.5), 1);
near(minMaxCurveValue(ace.SizeModule.curve,.9,.5), .5);
near(minMaxCurveValue(ace.SizeModule.curve,1,.5), .5);
near(minMaxCurveValue(ace.InitialModule.startLifetime,0,.5),.45);
near(minMaxCurveValue(ok.InitialModule.startLifetime,0,.5),.4);
near(minMaxGradientValue(ace.InitialModule.startColor,0,.25)[0],.75);
near(minMaxGradientValue(ace.ColorModule.gradient,55783/65535,.5)[3],0);
assert.equal(ace.ClampVelocityModule.enabled,1);
near(ace.ClampVelocityModule.dampen,.07);
const sub = data.systems[ace.SubModule.subEmitters[0].emitter.fileID].particleSystem;
near(minMaxCurveValue(sub.SizeModule.curve,.5,.5),.75);
assert.equal(sub.RotationModule.enabled,0);
assert.equal(sub.VelocityModule.enabled,0);
assert.equal(data.palette.width,32);
assert.deepEqual(acePaletteValue(data.palette,.5,0,10), data.palette.pixels[15].map((v,i)=>(v+data.palette.pixels[16][i])/510));
assert.notDeepEqual(acePaletteValue(data.palette,.2,0,10),acePaletteValue(data.palette,.2,.1,10));
acePaletteValue(data.palette,.2,0,10).forEach((v,i)=>near(v,acePaletteValue(data.palette,.2,.4,10)[i]));
assert.equal(curveValue({m_Curve:[{time:0,value:2,outSlope:'Infinity'},{time:1,value:9,inSlope:0}]},.5),2);
console.log('PASS: source dependencies, precise IDs, curve steps/tangents, gradients, palette and sub-emitter references.');
console.log('NOT VERIFIED: native Unity motion integration, birth-subemitter simulation, GPU color space/import and visual lifecycle parity.');
console.log('Source-value tests alone do not certify pixel-identical visual parity.');
