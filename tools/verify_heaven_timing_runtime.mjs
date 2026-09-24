import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBurst,statesAt} from '../heaven-timing-runtime.js';
const source=JSON.parse(fs.readFileSync(new URL('../assets/heaven-timing/source.json',import.meta.url)));
for(const variant of ['Just00','Just01']){
  const b=createBurst(source,variant,{seed:1234}),same=createBurst(source,variant,{seed:1234});
  assert.deepEqual(b,same);
  assert.equal(statesAt(b,0).length,10);
  assert.equal(statesAt(b,b.life+.001).length,0);
  assert.ok(b.particles.some(p=>p.birth>0));
  for(let frame=0;frame<100;frame++){
    for(const p of statesAt(b,frame/120)){
      for(const v of [p.x,p.y,p.z,p.rotation,p.size,...p.color])assert.ok(Number.isFinite(v));
      assert.ok(p.size>=0);
    }
  }
  // Child stars stay where they were emitted. They do not orbit or converge.
  const child=b.particles.find(p=>p.birth>0);
  assert.ok(child.path.every(p=>p.every((v,i)=>v===child.path[0][i])));
  const scaled=createBurst(source,variant,{seed:1234,scale:.5});
  const a=statesAt(b,.2),c=statesAt(scaled,.2);
  a.forEach((p,i)=>{assert.equal(c[i].x,p.x*.5);assert.equal(c[i].size,p.size*.5);});
  console.log(`${variant}: deterministic lifetime, ten-star burst, finite trajectories, stationary children, scaling PASS`);
}
