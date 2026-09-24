import {minMaxCurveValue as cv, minMaxGradientValue as gv, acePaletteValue} from './heaven-timing-values.js';

// Source-driven browser implementation. Unity native integration and inherited
// birth-subemitter scheduling remain approximations; see tools/heaven-timing-audit.md.
const DT = 1 / 120;
const lerp = (a,b,t) => a+(b-a)*t;
const mul = (a,b) => a.map((v,i)=>v*b[i]);
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed>>>15, 1|seed); t ^= t+Math.imul(t ^ t>>>7,61|t); return ((t ^ t>>>14)>>>0)/4294967296; }; }
function rotate(v, axis, angle) {
  const a=(axis+1)%3,b=(axis+2)%3,c=Math.cos(angle),s=Math.sin(angle),x=v[a],y=v[b];
  v[a]=x*c-y*s;v[b]=x*s+y*c;
}
function samplePath(p, age) {
  const f=Math.max(0,Math.min(p.path.length-1,age/DT)),i=Math.floor(f),a=p.path[i],b=p.path[Math.min(i+1,p.path.length-1)];
  return a.map((v,k)=>lerp(v,b[k],f-i));
}
function appearance(p,age) {
  const t=Math.max(0,Math.min(1,age/p.life)),s=p.system.particleSystem;
  const size=p.size*(s.SizeModule.enabled?cv(s.SizeModule.curve,t,p.random):1);
  const color=mul(p.color,s.ColorModule.enabled?gv(s.ColorModule.gradient,t,p.random):[1,1,1,1]);
  return {size,color};
}
export function createBurst(source, variant, {seed=Date.now(),scale=1}={}) {
  const random=rng(seed),system=source.systems[source.roots[variant]],s=system.particleSystem;
  const particles=[];
  function particle(sys,birth,position,angle,inherit) {
    const m=sys.particleSystem,i=m.InitialModule,r=random(),life=cv(i.startLifetime,0,r);
    const p={system:sys,birth,life,random:r,size:cv(i.startSize,0,r),color:gv(i.startColor,0,random()),path:[],rotation:cv(i.startRotation,0,random())};
    if(inherit){
      if(inherit.flags&1)p.color=mul(p.color,inherit.color);
      if(inherit.flags&2)p.size*=inherit.size;
      if(inherit.flags&4)p.rotation+=inherit.rotation;
    }
    let pos=[...position],velocity=[Math.cos(angle),Math.sin(angle),0].map(v=>v*cv(i.startSpeed,0,r)),rot=p.rotation;
    p.path.push([...pos,rot]);
    for(let step=0;step<Math.ceil(life/DT);step++){
      const t=Math.min(1,(step+.5)*DT/life),v=m.VelocityModule;
      // Damp the persistent launch velocity; radial/orbital module velocities
      // are evaluated anew each step. Dampen is normalized to a 60 Hz step.
      const clamp=m.ClampVelocityModule;
      if(clamp.enabled){
        const speed=Math.hypot(...velocity),limit=cv(clamp.magnitude,t,r);
        if(speed>limit){const next=limit+(speed-limit)*Math.pow(1-clamp.dampen,DT*60);velocity=velocity.map(x=>x*next/speed);}
      }
      const radial=v.enabled?cv(v.radial,t,r):0,modifier=v.enabled?cv(v.speedModifier,t,r):1;
      const radius=Math.hypot(...pos),direction=radius>1e-9?pos.map(x=>x/radius):[Math.cos(angle),Math.sin(angle),0];
      const extra=v.enabled?['x','y','z'].map(k=>cv(v[k],t,r)):[0,0,0];
      pos=pos.map((x,k)=>x+(velocity[k]+extra[k]+direction[k]*radial)*modifier*DT);
      if(v.enabled){
        // Rotate both position and its launch direction to retain the ring's
        // outward motion, rather than spiralling particles back to the origin.
        for(let axis=0;axis<3;axis++){
          const a=cv(v[['orbitalX','orbitalY','orbitalZ'][axis]],t,r)*DT;
          rotate(pos,axis,a);rotate(velocity,axis,a);
        }
      }
      if(m.RotationModule.enabled)rot+=cv(m.RotationModule.curve,t,r)*DT;
      p.path.push([...pos,rot]);
    }
    particles.push(p);return p;
  }
  const count=cv(s.EmissionModule.m_Bursts[0].countCurve,0,random());
  for(let n=0;n<count;n++){
    const angle=n*Math.PI*2/count,radius=s.ShapeModule.radius.value;
    const p=particle(system,0,[Math.cos(angle)*radius,Math.sin(angle)*radius,0],angle);
    for(const sub of s.SubModule.subEmitters ?? []){
      if(sub.type!==0)throw new Error('Only source Birth emitters supported');
      const child=source.systems[sub.emitter.fileID],m=child.particleSystem,end=Math.min(p.life,m.lengthInSec),times=[];
      const rate=cv(m.EmissionModule.rateOverTime,0,p.random);
      if(rate>0)for(let t=1/rate;t<end-1e-8;t+=1/rate)times.push(t);
      for(const burst of m.EmissionModule.m_Bursts){
        for(let cycle=0;cycle<burst.cycleCount;cycle++){
          const t=burst.time+cycle*burst.repeatInterval;
          if(t<=end+1e-8)for(let k=0;k<cv(burst.countCurve,0,p.random);k++)times.push(t);
        }
      }
      for(const time of times){
        const state=samplePath(p,time),a=appearance(p,time);
        particle(child,time,state.slice(0,3),0,{flags:sub.properties,color:a.color,size:a.size,rotation:state[3]});
      }
    }
  }
  particles.sort((a,b)=>a.system.renderer.m_SortingOrder-b.system.renderer.m_SortingOrder);
  return {variant,scale,particles,life:Math.max(...particles.map(p=>p.birth+p.life))};
}

export function statesAt(burst,age){
  return burst.particles.filter(p=>age>=p.birth&&age<p.birth+p.life).map(p=>{
    const elapsed=age-p.birth,state=samplePath(p,elapsed),a=appearance(p,elapsed);
    return {x:state[0]*burst.scale,y:state[1]*burst.scale,z:state[2]*burst.scale,rotation:state[3],size:a.size*burst.scale,color:a.color,system:p.system,birth:p.birth};
  });
}

export async function loadTimingRenderer(){
  const response=await fetch(new URL('./assets/heaven-timing/source.json',import.meta.url));
  if(!response.ok)throw new Error(`Timing VFX manifest: ${response.status}`);
  const source=await response.json(),image=new Image();
  image.src=new URL('./assets/heaven-timing/main.png',import.meta.url).href;
  await image.decode();
  const tint=document.createElement('canvas');tint.width=image.width;tint.height=image.height;
  const tc=tint.getContext('2d');
  return {
    create:(variant,options)=>createBurst(source,variant,options),
    draw(ctx,burst,age,x,y,ppu,globalSeconds){
      ctx.save();ctx.imageSmoothingEnabled=true;
      for(const state of statesAt(burst,age)){
        const ace=state.system.material.m_Shader.guid==='49c9ed0b23138ae43854107346543307';
        const rgba=state.color;
        const speed=state.system.material.m_SavedProperties.m_Floats.find(x=>x._Speed!==undefined)?._Speed;
        const color=ace?acePaletteValue(source.palette,(rgba[0]+rgba[1]+rgba[2])/3,globalSeconds,speed):rgba;
        tc.globalCompositeOperation='source-over';tc.clearRect(0,0,tint.width,tint.height);tc.drawImage(image,0,0);
        tc.globalCompositeOperation='source-in';tc.fillStyle=`rgb(${color.slice(0,3).map(v=>Math.round(Math.max(0,Math.min(1,v))*255)).join(',')})`;tc.fillRect(0,0,tint.width,tint.height);
        ctx.save();ctx.globalAlpha=Math.max(0,Math.min(1,rgba[3]));ctx.translate(x+state.x*ppu,y-state.y*ppu);ctx.rotate(-state.rotation);
        const size=state.size*ppu;ctx.drawImage(tint,-size/2,-size/2,size,size);ctx.restore();
      }
      ctx.restore();
    }
  };
}
