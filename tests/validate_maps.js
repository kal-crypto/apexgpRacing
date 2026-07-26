// Validate the 20 procedural maps at the track width (barrier footprint).
// Keep TRACK_W in step with index.html. 26 is the ceiling: at 28 the barriers of
// maps 6, 12, 17 and 20 overlap themselves, so widening further needs new seeds.
const TRACK_W = 26, HALF = TRACK_W/2, BARRIER_OFF = 2.0, TAU = Math.PI*2;
const FOOT = (HALF + BARRIER_OFF) * 2;              // outer-barrier to outer-barrier
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function gen(seed){
  const r=mulberry32(seed);
  const R=340+Math.floor(r()*190), SX=1.0+r()*0.6, SY=0.9+r()*0.5;
  const nc=3+Math.floor(r()*2), coeffs=[];
  for(let k=0;k<nc;k++)coeffs.push([2+k, 0.04+r()*0.055, r()*TAU]);
  return {R,SX,SY,coeffs};
}
function build(g,N){
  const c=[]; const shape=t=>{let s=1;for(const k of g.coeffs)s+=k[1]*Math.sin(k[0]*t+k[2]);return s;};
  for(let i=0;i<N;i++){const t=i/N*TAU,rr=shape(t);c.push([g.R*rr*Math.cos(t)*g.SX, g.R*rr*Math.sin(t)*g.SY]);}
  return c;
}
function stats(c){
  const N=c.length; let minGap=1e9,minR=1e9;
  for(let i=0;i<N;i++)for(let j=i+3;j<N-2;j++){if(Math.abs(i-j)<5||Math.abs(i-j)>N-5)continue;
    const d=Math.hypot(c[i][0]-c[j][0],c[i][1]-c[j][1]);if(d<minGap)minGap=d;}
  for(let i=0;i<N;i++){const a=c[(i-2+N)%N],b=c[i],d=c[(i+2)%N];
    const A=Math.hypot(b[0]-a[0],b[1]-a[1]),B=Math.hypot(d[0]-b[0],d[1]-b[1]),C=Math.hypot(d[0]-a[0],d[1]-a[1]);
    const area=Math.abs((b[0]-a[0])*(d[1]-a[1])-(d[0]-a[0])*(b[1]-a[1]))/2;
    const R=area<1e-3?1e9:(A*B*C)/(4*area); if(R<minR)minR=R;}
  return {minGap:+minGap.toFixed(1),minR:+minR.toFixed(1)};
}
let bad=0;
for(let i=0;i<20;i++){
  const g=gen(1000+i*97), c=build(g,300), s=stats(c);
  const ok = s.minGap > FOOT+4 && s.minR > HALF+5;   // clear of self + inner edge stays sane
  if(!ok)bad++;
  console.log(`map ${i+4}: minGap=${s.minGap} (need >${FOOT+4})  minR=${s.minR} (need >${HALF+5})  ${ok?'ok':'*** BAD ***'}`);
}
console.log(bad===0 ? `\nALL 20 VALID at width ${TRACK_W} ✅` : `\n${bad} BAD ⚠️`);
