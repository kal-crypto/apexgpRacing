// Full headless test of the 3D game: real Three.js + real GLTFLoader parse the
// exported car, real scene/geometry build, sim + camera + rig transforms run.
// Only the GPU renderer is stubbed (no WebGL context in Node).
const fs = require('fs'), path = require('path');
const dir = __dirname;
// Run from the ApexGP3D working folder (game files alongside) or from the repo's
// tests/ folder (game in ../web) — whichever this file was copied into.
const GAME_DIR = [dir, path.join(dir,'..','web'), path.join(dir,'web')]
  .find(d => fs.existsSync(path.join(d,'index.html')));
if(!GAME_DIR){ console.log('SKIP: cannot locate index.html from '+dir); process.exit(0); }

// ---- globals the browser code expects -------------------------------------
global.self = global; global.window = global;
global.devicePixelRatio = 1; global.innerWidth = 1280; global.innerHeight = 720;
global.addEventListener = ()=>{};
global.requestAnimationFrame = ()=>0;
global.performance = { now:()=>0 };
global.localStorage = { _d:{}, getItem(k){return this._d[k]??null;}, setItem(k,v){this._d[k]=v;} };
global.localStorage._d['apexgp_owned']=JSON.stringify([...Array(23).keys()]); // own all maps for testing
global.localStorage._d['apexgp_money']='999999';
global.AudioContext = function(){ throw new Error('no audio in node'); };

function ctx2d(){ return new Proxy({}, { get(t,p){
  if(p==='createLinearGradient'||p==='createRadialGradient') return ()=>({addColorStop(){}});
  if(p in t) return t[p]; return ()=>{}; }, set(t,p,v){t[p]=v;return true;} }); }
function canvasStub(){ return { width:64, height:64, getContext:()=>ctx2d(), style:{} }; }
function elStub(id){ return { id, style:{}, dataset:{v:'3'}, classList:{add(){},remove(){},toggle(){},contains(){return false;}},
  _t:'', set textContent(v){this._t=v;}, get textContent(){return this._t;}, innerHTML:'', onclick:null, oninput:null, onkeydown:null,
  value:(id==='botSlider'?'5':''), max:'22', checked:false,
  disabled:false, width:150, height:150, addEventListener(){}, appendChild(){}, getContext:()=>ctx2d() }; }
const lights = Array.from({length:5},()=>elStub('lt'));
const seatStubs = [elStub('seat1'), elStub('seat2')];
global.document = {
  body: elStub('body'),
  getElementById:id => (id==='c') ? canvasStub() : (id==='mini') ? {width:150,height:150,getContext:()=>ctx2d()} : elStub(id),
  querySelectorAll:sel => sel==='.lt' ? lights
    : sel.includes('.seat') ? seatStubs
    : (sel.includes('button') ? [elStub(),elStub(),elStub()] : []),
  createElement:()=>canvasStub(),
};

// ---- real three.js + GLTFLoader -------------------------------------------
global.THREE = require(path.join(GAME_DIR,'three.min.js'));
require(path.join(GAME_DIR,'GLTFLoader.js'));            // attaches THREE.GLTFLoader
// stub only the GPU renderer
THREE.WebGLRenderer = class { constructor(o){ this.domElement=o&&o.canvas||canvasStub();
    this.shadowMap={enabled:false,type:0}; this.capabilities={isWebGL2:true}; this.toneMapping=0; this.toneMappingExposure=1; }
  setPixelRatio(){} setSize(){} render(){} set outputEncoding(v){} get outputEncoding(){return 0;} };

// car model base64
global.CAR_GLB_B64 = require(path.join(GAME_DIR,'carmodel.js')) || global.CAR_GLB_B64;
{ // carmodel.js sets window.CAR_GLB_B64 = "..."
  const src = fs.readFileSync(path.join(GAME_DIR,'carmodel.js'),'utf8');
  (0,eval)(src);
}
console.log('CAR_GLB_B64 length:', (global.CAR_GLB_B64||'').length);

// ---- load the game script -------------------------------------------------
const html = fs.readFileSync(path.join(GAME_DIR,'index.html'),'utf8');
const game = /<script>\s*"use strict"([\s\S]*?)<\/script>/.exec(html)[1];
const wrapped = '"use strict";' + game +
  '\n;globalThis.__API={startRace,update,frame,keys,rigsReady:()=>modelReady,'
  + 'get selTrack(){return selTrack}, set selTrack(v){selTrack=v}, mpHandle, remotes:()=>remotes,'
  + 'get state(){return state}, set state(v){state=v}, get player(){return player}, get cars(){return cars}, T:()=>T,'
  + 'lobbies:()=>lobbies, myLobby:()=>myLobby, lobbyListHTML, lobbyBlocked,'
  + 'setLobbySupported:v=>{lobbySupported=v}, setMpConnected:v=>{mpConnected=v}, lobbyErr:()=>lobbyErr,'
  + 'totalLaps:()=>totalLaps, owned:()=>owned, TRACKS:()=>TRACKS, money:()=>money,'
  + 'joinFromList, validTrack, botCount:v=>{if(v!=null)botCount=v;return botCount},'
  + 'seats:v=>{if(v!=null)seats=v;return seats}, setMode:v=>{mode=v}, mode:()=>mode,'
  + 'fieldSize, splitOn, showPage, gridSlot, LIVERIES:()=>LIVERIES, MAX_GRID:()=>MAX_GRID};';
try{ (0,eval)(wrapped); }catch(e){ console.error('LOAD ERROR:', e); process.exit(1); }
console.log('script loaded OK · track nodes=', globalThis.__API.T().N);

// ---- wait for async GLB parse, then run a race ----------------------------
const A = globalThis.__API;
setTimeout(()=>{
  try{
    console.log('modelReady=', A.rigsReady());
    if(!A.rigsReady()){ console.log('\n⚠️ model did not parse — check GLTFLoader/GLB'); process.exit(1); }
    const wrap=a=>((a+Math.PI*3)%(Math.PI*2))-Math.PI;
    let allOk=true;
    // Robustness test: run until EVERY car completes 3 laps (or time out).
    // A car that can never finish = a genuine stuck bug.
    for(const trk of [0,2,5]){   // a hand map, Highlands, and a procedural map
      A.selTrack=trk; A.startRace();
      let maxSpd=0, gotRacing=false, playerFin=false, ticks=0;
      const T=A.T(), N=T.N;
      while(ticks++<40000){
        if(A.state==='racing' && !playerFin){
          gotRacing=true;
          const p=A.player;
          const la=Math.min(10,Math.max(2,Math.round(2+p.spd*0.08))), tgt=(p.node+la)%N;
          const diff=wrap(Math.atan2(T.c[tgt].y-p.y,T.c[tgt].x-p.x)-p.a);
          let ts=99,ds=0,k=p.node; while(ds<10+p.spd*1.2){ts=Math.min(ts,T.cspd[k]);ds+=T.seg[k];k=(k+1)%N;}
          const brake=p.spd>ts+2; A.keys['w']=!brake; A.keys['s']=brake;
          A.keys['a']=diff<-0.02; A.keys['d']=diff>0.02;
        }
        A.update(1/60);
        if(A.state==='finished'){ playerFin=true; A.state='racing';      // keep simulating AI
          A.keys['w']=A.keys['s']=A.keys['a']=A.keys['d']=false; }        // player coasts, out of the way
        if(ticks%300===0) A.frame(0);
        maxSpd=Math.max(maxSpd,A.player.spd);
        if(A.cars.every(c=>c.lapsCrossed>=3)) break;
      }
      const ai=A.cars.filter(c=>!c.isPlayer).map(c=>c.lapsCrossed);
      const allDone=A.cars.every(c=>c.lapsCrossed>=3);
      const ok = gotRacing && maxSpd>20 && playerFin && allDone;
      console.log(`track ${trk} (len ${Math.round(A.T().len)}m): maxSpd=${maxSpd.toFixed(1)} ticks=${ticks} `
        +`playerFin=${playerFin} AIlaps=[${ai}] allFinished=${allDone} `+(ok?'OK':'FAIL'));
      allOk = allOk && ok;
      A.keys['w']=A.keys['s']=A.keys['a']=A.keys['d']=false;
    }
    // multiplayer client: mock incoming messages -> a remote car rig is created + tracked
    try{
      A.mpHandle({t:'id',id:5});
      A.mpHandle({t:'join',id:7,name:'Bob',livery:2});
      A.mpHandle({t:'s',id:7,x:100,y:50,a:0.5,sp:30,lap:1,nd:10});
      const rem=A.remotes(), r=rem.get(7);
      const mpOk = rem.size===1 && !!r && !!r.rig && r.tx===100 && r.ty===50;
      console.log('multiplayer client: remote car created & state routed =', mpOk);
      allOk = allOk && mpOk;
    }catch(e){ console.log('multiplayer client ERROR:', e.message); allOk=false; }
    // ---- lobby browser: directory renders, details bind, hostile names are escaped ----
    try{
      let lob=true;
      const say=(k,v)=>{ console.log('  lobby · '+k+' =', v); lob = lob && v; };
      A.mpHandle({t:'lobbies',list:[
        {key:'r:AB12',code:'AB12',host:'Bob',track:0,laps:5,players:2,max:8,racing:false,pub:false,names:['Bob','Ann'],age:9},
        {key:'t2',code:'',host:'Zed',track:2,laps:3,players:1,max:8,racing:true,pub:true,names:['Zed'],age:40},
        {key:'r:XSS1',code:'XSS1',host:'<img src=x onerror=alert(1)>',track:0,laps:3,players:1,max:8,racing:false,pub:false,
         names:['<script>bad()</script>'],age:2}]});
      say('list stored', A.lobbies().length===3);
      const html=A.lobbyListHTML();
      say('rows rendered', (html.match(/class="lrow/g)||[]).length===3);
      say('circuit name shown', html.includes('Silverlake'));
      say('laps shown', html.includes('5 laps'));
      say('player count shown', html.includes('2/8'));
      say('host shown', html.includes('Bob'));
      say('open badge', html.includes('lbadge open'));
      say('racing badge', html.includes('lbadge racing'));
      say('public lobby marked', html.includes('PUB'));
      say('hostile host name escaped', !html.includes('<img src=x') && html.includes('&lt;img'));
      say('hostile player name escaped', !html.includes('<script>bad'));
      // joining a lobby adopts its circuit and lap count — in the menu
      A.state='menu';
      A.selTrack=1; A.mpHandle({t:'lobby',lobby:{key:'r:AB12',code:'AB12',host:'Bob',track:2,laps:5,
        players:2,max:22,racing:false,pub:false,names:['Bob','Ann']}});
      say('adopted lobby circuit', A.selTrack===2);
      say('adopted lobby laps', A.totalLaps()===5);
      say('my lobby detail bound', A.myLobby() && A.myLobby().code==='AB12');
      // ...but never mid-race: totalLaps drives the finish test, so a lobby update
      // arriving after lights-out must not end the race at a different lap count
      A.state='racing';
      A.mpHandle({t:'lobby',lobby:{key:'r:AB12',code:'AB12',host:'Bob',track:0,laps:10,
        players:3,max:22,racing:true,pub:false,names:['Bob','Ann','Cid']}});
      say('mid-race lobby update leaves laps alone', A.totalLaps()===5);
      say('mid-race lobby update leaves the circuit alone', A.selTrack===2);
      say('but the lobby detail still updates', A.myLobby().players===3);
      A.state='menu';
      // an unowned circuit must block the race rather than silently racing a different track
      A.mpHandle({t:'lobby',lobby:{key:'r:AB12',code:'AB12',host:'Bob',track:2,laps:5,
        players:2,max:22,racing:false,pub:false,names:['Bob','Ann']}});
      const owned=A.owned(); const had=owned.has(2); owned.delete(2);
      say('unowned lobby circuit blocks race', A.lobbyBlocked()===true);
      if(had)owned.add(2);
      say('owned lobby circuit allows race', A.lobbyBlocked()===false);
      // a hostile lobby advertising a circuit index we do not have must be refused
      // outright — never priced at $0, never added to the saved economy
      const cash=A.money(), ownedBefore=owned.size;
      A.mpHandle({t:'lobby',lobby:{key:'r:BAD1',code:'BAD1',host:'Evil',track:999,laps:3,
        players:1,max:22,racing:false,pub:false,names:['Evil']}});
      say('out-of-range circuit blocks the race', A.lobbyBlocked()===true);
      say('out-of-range circuit is not adopted', A.selTrack!==999);
      say('out-of-range circuit costs nothing', A.money()===cash);
      say('out-of-range circuit is not granted', owned.size===ownedBefore && !owned.has(999));
      A.mpHandle({t:'lobby',lobby:null});
      say('leaving clears lobby', A.myLobby()===null);
      A.mpHandle({t:'err',why:'full'});
      say('server error surfaced', A.lobbyListHTML().includes('full'));
      // an older server that never answers `list` must degrade to the room-code flow,
      // not sit on "connecting" forever (this happens during every staged deploy)
      A.setMpConnected(true);                       // as if a real socket were open
      A.mpHandle({t:'lobbies',list:[]});
      say('empty directory invites you to create', A.lobbyListHTML().includes('CREATE LOBBY'));
      A.setLobbySupported(null);
      say('unknown support shows a waiting message', A.lobbyListHTML().includes('who'));
      A.setLobbySupported(false);
      const legacy=A.lobbyListHTML();
      say('legacy server explains the code fallback', legacy.includes('older build') && legacy.includes('Join'));
      A.setLobbySupported(true);
      A.setMpConnected(false);
      say('disconnected list explains itself', /Tick the box|Connecting/.test(A.lobbyListHTML()));
      console.log('lobby browser =', lob);
      allOk = allOk && lob;
    }catch(e){ console.log('lobby browser ERROR:', e); allOk=false; }
    // ---- race modes: bots slider, field sizing, split screen ----------------
    try{
      let md=true; const say=(k,v)=>{console.log('  mode · '+k+' =', v); md = md && v;};
      const L=A.LIVERIES(), GRID=A.MAX_GRID();
      say('23 grid slots', GRID===23);
      say('a livery per grid slot', L.length>=GRID);
      say('every livery colour is distinct', new Set(L.map(x=>x.tint)).size===L.length);
      // grid slots must stay inside the barriers and never overlap
      const slots=[...Array(GRID)].map((_,k)=>A.gridSlot(k));
      say('grid stays inside the barriers', slots.every(s=>Math.abs(s.col)+0.85 < 13+2));
      let minGap=1e9;
      for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){
        const d=Math.hypot(slots[i].back-slots[j].back, slots[i].col-slots[j].col);
        if(d<minGap)minGap=d;}
      say('no two grid slots overlap (gap '+minGap.toFixed(1)+'m)', minGap>3.2);
      // OFFLINE: bots slider drives the field size
      A.setMode('offline'); A.seats(1);
      A.botCount(22); say('offline 22 bots = 23 cars', A.fieldSize()===23);
      A.botCount(0);  say('offline 0 bots = 1 car', A.fieldSize()===1);
      A.botCount(99); say('bots clamp to the grid', A.fieldSize()<=23);
      say('offline never splits the screen', A.splitOn()===false);
      // ONLINE: bots would desync between clients, so there are none
      A.setMode('online'); A.botCount(10);
      say('online runs no bots', A.fieldSize()===1);
      say('online never splits the screen', A.splitOn()===false);
      // LOCAL: two seats split the screen and still leave room for 21 bots
      A.setMode('local'); A.seats(2); A.botCount(21);
      say('two seats + 21 bots = 23 cars', A.fieldSize()===23);
      say('two seats split the screen', A.splitOn()===true);
      A.seats(1); say('one seat does not split', A.splitOn()===false);
      // a full 23-car field actually races
      A.setMode('offline'); A.seats(1); A.botCount(22); A.selTrack=2; A.startRace();
      say('full grid built', A.cars.length===23);
      say('every car got a rig', A.cars.every(c=>!!c.rig));
      say('every car has its own livery', new Set(A.cars.map(c=>c.livery.tint)).size===23);
      let g2=0; while(A.state==='countdown'&&g2++<400)A.update(1/60);
      for(let i=0;i<1800;i++){A.keys['w']=true;A.update(1/60);if(A.state!=='racing')A.state='racing';}
      A.keys['w']=false;
      const spread=A.cars.map(c=>c.progress);
      say('23 cars all moved', spread.every(p=>p>40));
      say('nobody fell through the world', A.cars.every(c=>isFinite(c.x)&&isFinite(c.y)));
      say('no two cars occupy the same spot', A.cars.every((c,i)=>
        A.cars.every((d,j)=>i===j||Math.hypot(c.x-d.x,c.y-d.y)>0.5)));
      console.log('race modes =', md); allOk = allOk && md;
    }catch(e){ console.log('race modes ERROR:', e); allOk=false; }
    // flat-out capability probe (floor it, no braking) — how fast can the car actually go?
    A.selTrack=2; A.startRace(); let guard=0; while(A.state==='countdown'&&guard++<2000)A.update(1/60);
    let flatMax=0; const T2=A.T(),N2=T2.N;
    for(let i=0;i<9000;i++){ const p=A.player,tgt=(p.node+6)%N2;
      const dif=wrap(Math.atan2(T2.c[tgt].y-p.y,T2.c[tgt].x-p.x)-p.a);
      A.keys['w']=true;A.keys['s']=false;A.keys['a']=dif<-0.02;A.keys['d']=dif>0.02;
      A.update(1/60); if(A.state!=='racing')A.state='racing'; flatMax=Math.max(flatMax,p.spd); }
    console.log('flat-out top speed reached:', (flatMax*2.237).toFixed(0)+' mph ('+flatMax.toFixed(0)+' m/s)');
    console.log(allOk ? '\n3D + MULTIPLAYER TESTS PASSED ✅' : '\nTESTS FAILED ⚠️');
    process.exit(allOk?0:1);
  }catch(e){ console.error('RUNTIME ERROR:', e); process.exit(1); }
}, 800);
