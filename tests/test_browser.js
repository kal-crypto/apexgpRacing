/* ============================================================================
   Real-browser smoke test: launches headless Chrome, loads index.html, and
   clicks through the whole menu flow over the DevTools protocol.

     node test_browser.js            # run the checks
     node test_browser.js --shots    # also write PNGs next to this file

   test_headless.js covers the simulation with a stubbed renderer; this covers
   what that cannot — the DOM, the menu routing, the split-screen viewports and
   whether the WebGL/post-processing stack actually initialises. It exists
   because it caught two bugs the unit tests could not see: the lobby browser
   staying hidden on the online page, and SSAOPass (whose shader isn't among the
   pp/ files) taking the entire post-processing composer down with it.

   Note: headless Chrome renders WebGL on SwiftShader, so the 3D world comes out
   near-black in screenshots. That is the software rasteriser, not the game —
   the checks below assert structure and state, never pixel colour.
   ==========================================================================*/
const {spawn}=require('child_process'), http=require('http'), fs=require('fs'), path=require('path');
const dir=__dirname, SHOTS=process.argv.includes('--shots');

// ---- find Chrome ----------------------------------------------------------
const CANDIDATES=[process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const CHROME=CANDIDATES.find(p=>{try{return fs.existsSync(p);}catch(e){return false;}});
if(!CHROME){ console.log('SKIP: no Chrome/Edge found (set CHROME_PATH to run this test)'); process.exit(0); }

// ---- find ws (dependency of the multiplayer server) ----------------------
let WS;
for(const p of [path.join(dir,'..','apexgp-server','node_modules','ws'),
                path.join(dir,'..','..','apexgp-server','node_modules','ws'),
                path.join(dir,'..','server','node_modules','ws'),
                path.join(dir,'..','apexgp','server','node_modules','ws'),
                path.join(dir,'node_modules','ws'),'ws']){ try{ WS=require(p); break; }catch(e){} }
if(!WS){ console.log('SKIP: `ws` is not installed locally — cannot speak CDP'); process.exit(0); }

// unique per run: a recycled profile would carry the remembered device across runs
const RUN=process.pid+'-'+(Date.now()%100000);
const PORT=9400+(process.pid%500), PROFILE=path.join(require('os').tmpdir(),'apexgp-cdp-'+RUN);
// works from the ApexGP3D working folder or the repo's tests/ folder
const GAME_DIR=[dir, path.join(dir,'..','web'), path.join(dir,'web')]
  .find(d=>fs.existsSync(path.join(d,'index.html')));
if(!GAME_DIR){ console.log('SKIP: cannot locate index.html from '+dir); process.exit(0); }
const GAME='file:///'+path.join(GAME_DIR,'index.html').replace(/\\/g,'/');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,
  '--no-first-run','--no-default-browser-check','--enable-unsafe-swiftshader','--use-angle=swiftshader',
  '--window-size=1400,900','--hide-scrollbars','--mute-audio','--allow-file-access-from-files',
  'about:blank'],{stdio:'ignore'});
const cleanup=()=>{ try{chrome.kill();}catch(e){} try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch(e){} };
const getJson=u=>new Promise((res,rej)=>http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej));

let pass=0, fail=0;
const check=(label,got,want)=>{
  const ok = want instanceof RegExp ? want.test(String(got)) : got===want;
  ok?pass++:fail++;
  console.log(`  ${ok?'ok  ':'FAIL'} ${label}${ok?'':'  -> '+JSON.stringify(got)}`);
};

(async()=>{
  let ver=null;
  for(let i=0;i<50&&!ver;i++){ await sleep(300); try{ ver=await getJson(`http://127.0.0.1:${PORT}/json/version`); }catch(e){} }
  if(!ver) throw new Error('Chrome never opened the debug port');
  console.log(ver['Browser']+'\n');
  const page=(await getJson(`http://127.0.0.1:${PORT}/json/list`)).find(t=>t.type==='page');
  const ws=new WS(page.webSocketDebuggerUrl,{perMessageDeflate:false});
  await new Promise(r=>ws.on('open',r));
  let id=0; const pend=new Map(); const errors=[];
  ws.on('message',d=>{ const m=JSON.parse(d);
    if(m.id&&pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id);
      m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result); }
    else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')
      errors.push(m.params.args.map(a=>a.value!==undefined?a.value:a.description).join(' '));
    else if(m.method==='Runtime.exceptionThrown')
      errors.push('EXCEPTION: '+(m.params.exceptionDetails.text||''));
  });
  const cmd=(method,params={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});
  await cmd('Runtime.enable'); await cmd('Page.enable');
  const ev=async expr=>{ const r=await cmd('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails) return 'EVAL-THREW'; return r.result.value; };
  const vis=sel=>ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return 'MISSING';
    const s=getComputedStyle(e),r=e.getBoundingClientRect();
    return (s.display!=='none'&&r.width>0&&r.height>0)?'visible':'hidden';})()`);
  const txt=sel=>ev(`(()=>{const e=document.querySelector('${sel}');return e?(e.textContent||'').trim().slice(0,60):'MISSING';})()`);
  const clickSel=sel=>ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return 'MISSING';e.click();return 'ok';})()`);
  const keyTap=k=>cmd('Input.dispatchKeyEvent',{type:'keyDown',key:k,code:k,windowsVirtualKeyCode:38})
    .then(()=>cmd('Input.dispatchKeyEvent',{type:'keyUp',key:k,code:k,windowsVirtualKeyCode:38}));
  const shot=async name=>{ if(!SHOTS)return; const r=await cmd('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(dir,'shot-'+name+'.png'),Buffer.from(r.data,'base64')); };
  const waitReady=async()=>{ for(let i=0;i<60;i++){ await sleep(400);
    if(await ev(`(()=>{const b=document.getElementById('playBtn');return !!b&&!b.disabled;})()`)===true) return true; } return false; };

  await cmd('Page.navigate',{url:GAME}); await sleep(1200);
  // start from a known slate: the game remembers your device and your circuits
  await ev(`(()=>{try{localStorage.clear();}catch(e){}})()`);
  await cmd('Page.reload',{ignoreCache:true}); await sleep(1200);
  check('the car model loads and the game becomes playable', await waitReady(), true);

  console.log('\nrenderer');
  check('WebGL context is alive', await ev(`(()=>{const c=document.getElementById('c');
    return !!(c.getContext('webgl2')||c.getContext('webgl'));})()`), true);
  // SSAOPass has no shader here; if that escapes, bloom + FXAA + the sRGB pass all die
  check('post-processing composer survives the missing SSAOShader',
    await ev(`(()=>{try{return composer!==null&&typeof composer==='object';}catch(e){return 'not in scope';}})()`), true);
  check('no console errors on load', errors.length, 0);

  console.log('\ndevice page comes first');
  check('device picker shown', await vis('#pgDevice'), 'visible');
  // the footer names the build, so a stale cache can be told apart from a real bug
  check('build stamp is shown', await txt('#buildTag'), /\d{4}-\d{2}-\d{2}/);
  check('phone option', await vis('#devPhone'), 'visible');
  check('laptop option', await vis('#devKeys'), 'visible');
  check('controller option', await vis('#devPad'), 'visible');
  check('mode buttons not shown yet', await vis('#btnMulti'), 'hidden');
  check('the three options are in order: controller, desktop, phone', await ev(`(()=>{
    const ids=[...document.querySelectorAll('#pgDevice .devBtn')].map(b=>b.id);
    return ids.join(',');})()`), 'devPad,devKeys,devPhone');
  check('no CONTINUE step — one tap picks and moves on',
    await ev(`(()=>{return !document.getElementById('devNext');})()`), true);
  // picking DESKTOP must reveal MULTIPLAYER / OFFLINE by itself
  await clickSel('#devKeys'); await sleep(350);
  check('choosing a device shows MULTIPLAYER', await vis('#btnMulti'), 'visible');
  check('choosing a device shows OFFLINE', await vis('#btnOffline'), 'visible');
  check('the device page steps aside', await vis('#pgDevice'), 'hidden');
  check('and you can go back to change it', await vis('#rootBack'), 'visible');
  // PHONE does the same
  await clickSel('#rootBack'); await sleep(250);
  await clickSel('#devPhone'); await sleep(350);
  check('choosing PHONE also reveals the modes', await vis('#btnMulti'), 'visible');
  await clickSel('#rootBack'); await sleep(250);
  // CONTROLLER with nothing plugged in must NOT strand you on a dead page
  await clickSel('#devPad'); await sleep(350);
  const padPage=await ev(`(()=>{return menuPage;})()`);
  check('CONTROLLER with no pad explains itself instead of stranding you',
    padPage==='device' ? await vis('#padLive') : 'visible', 'visible');
  if(padPage==='device') check('it tells you to press a button', await txt('#padHint'), /Press any button/);
  await clickSel('#devKeys'); await sleep(300);   // back to a known device
  await clickSel('#rootBack'); await sleep(250);
  // don't assume what's plugged into the machine — just that the badge tells the truth
  const realPads=await ev(`(()=>{try{return padCount();}catch(e){return -1;}})()`);
  console.log('  (this machine reports '+realPads+' gamepad(s))');
  check('gamepad badge matches reality', await txt('#devPadStat'),
    realPads===0?/none/:realPads>1?/pads/:/connected/);
  await shot('device');
  // a synthetic PS4-style pad: left stick right, R2 down, circle held
  // a real standard-mapped pad declares mapping:'standard' — the code keys off that
  // to know which way round the four face buttons are
  // nothing held by default — a fixture that holds circle forever would keep firing
  // the pad's "back" action and bounce us off whatever page we navigate to
  await ev(`(()=>{window.__fakePad={id:'Wireless Controller (STANDARD GAMEPAD)',index:0,connected:true,
    mapping:'standard', axes:[0.80,0,0,0],
    buttons:Array.from({length:17},()=>({pressed:false,value:0,touched:false}))};
    navigator.getGamepads=()=>[window.__fakePad];return 'ok';})()`);
  await ev(`refreshPadStatus()`); await sleep(120);
  check('controller detected', await txt('#devPadStat'), /connected|pads/);
  check('controller name shown', await txt('#devPadName'), /Wireless Controller/);
  // with a pad awake, picking CONTROLLER goes straight on to the modes
  await clickSel('#devPad'); await sleep(350);
  check('controller selected', await ev(`(()=>{return device;})()`), 'pad');
  check('a woken pad moves you on to the modes', await vis('#btnMulti'), 'visible');
  // the mapping: axis 0 -> steer, R2 -> throttle, circle -> handbrake
  const pad=await ev(`(()=>{try{
    __fakePad.buttons[7]={pressed:true,value:1};      // R2
    __fakePad.buttons[1]={pressed:true,value:1};      // circle (standard mapping)
    const i=readInput({seat:0});
    __fakePad.buttons[7]={pressed:false,value:0}; __fakePad.buttons[1]={pressed:false,value:0};
    return i.steer.toFixed(2)+'|'+i.thr+'|'+i.brk+'|'+i.hand;}catch(e){return 'ERR '+e.message;}})()`);
  check('gamepad maps to steer/throttle/handbrake', pad, /^0\.(7|8)\d\|true\|false\|true$/);
  // deadzone: a stick barely off centre must not steer
  await ev(`(()=>{window.__fakePad.axes[0]=0.05;})()`);
  check('stick deadzone holds the wheel straight',
    await ev(`(()=>{return readInput({seat:0}).steer;})()`), 0);

  // A DualShock 4 over Bluetooth on Windows often reports RAW HID rather than the
  // standard mapping: 6 axes, L2/R2 ARE axes 3/4, and the right stick sits on 2/5
  // where a standard pad has nothing. Reading 4/5 as triggers made an untouched pad
  // read full throttle AND full brake, so the car drove itself. Never again.
  await ev(`(()=>{
    const btn=n=>Array.from({length:n},()=>({pressed:false,value:0}));
    window.__raw={id:'054c-09cc-Wireless Controller',index:0,connected:true,mapping:'',
      axes:[0,0,0,-1,-1,0], buttons:btn(14)};
    navigator.getGamepads=()=>[window.__raw]; return 'ok';})()`);
  await sleep(150);
  const rawIdle=await ev(`(()=>{const i=readInput({seat:0});return i.thr+'|'+i.brk+'|'+i.steer;})()`);
  check('a raw-mapping pad sitting idle does NOT drive itself', rawIdle, 'false|false|0');
  // moving the right stick must not touch the pedals either
  await ev(`(()=>{window.__raw.axes[2]=0.7;window.__raw.axes[5]=-0.6;})()`);
  check('right stick on a raw pad is not mistaken for the pedals',
    await ev(`(()=>{const i=readInput({seat:0});return i.thr+'|'+i.brk;})()`), 'false|false');
  // and R2 on its axis really does accelerate
  await ev(`(()=>{window.__raw.axes[4]=0.9;})()`);
  check('R2 on a raw pad accelerates', await ev(`(()=>{return readInput({seat:0}).thr;})()`), true);
  await ev(`(()=>{window.__raw.axes[3]=0.9;})()`);
  check('L2 on a raw pad brakes', await ev(`(()=>{return readInput({seat:0}).brk;})()`), true);
  // face buttons are reordered in raw mode; cross must still be the throttle
  await ev(`(()=>{window.__raw.axes[3]=-1;window.__raw.axes[4]=-1;
    window.__raw.buttons[1]={pressed:true,value:1};})()`);   // raw: 1 = cross
  check('cross accelerates on a raw pad too', await ev(`(()=>{return readInput({seat:0}).thr;})()`), true);
  // steering still comes off the left stick
  await ev(`(()=>{window.__raw.buttons[1]={pressed:false,value:0};window.__raw.axes[0]=-0.9;})()`);
  check('raw pad steers from the left stick',
    await ev(`(()=>{return readInput({seat:0}).steer<-0.5;})()`), true);
  await ev(`(()=>{window.__raw.axes[0]=0;})()`);

  console.log('\ncontroller drives the menus');
  // park on the device page so the read-out and the page transitions are checkable
  await ev(`(()=>{padWaiting=false;showPage('device');})()`); await sleep(250);
  check('a menu button takes pad focus', await ev(`(()=>{
    padMenuTick(0.2); return document.querySelectorAll('.padfocus').length;})()`), 1);
  await ev(`padLiveTick()`);      // don't wait on the render loop, which is slow in software
  check('live read-out appears with a pad attached', await vis('#padLive'), 'visible');
  check('the read-out shows the stick moving', await ev(`(()=>{
    window.__raw.axes[0]=0.9; padLiveTick();
    const t=document.getElementById('padSteer').textContent;
    window.__raw.axes[0]=0; return /▮/.test(t);})()`), true);
  // cross activates whatever is focused — aim it at DESKTOP and check we move on
  await ev(`(()=>{const btns=menuButtons();padFocus=btns.indexOf(document.getElementById('devKeys'));})()`);
  await ev(`(()=>{window.__raw.buttons[1]={pressed:true,value:1};padMenuTick(0.2);
    window.__raw.buttons[1]={pressed:false,value:0};})()`);
  await sleep(300);
  check('cross activates the focused button', await ev(`(()=>{return menuPage;})()`), 'root');
  check('the modes are now on screen', await vis('#btnMulti'), 'visible');
  // circle goes back
  await ev(`(()=>{window.__raw.buttons[2]={pressed:true,value:1};padMenuTick(0.2);
    window.__raw.buttons[2]={pressed:false,value:0};})()`);
  await sleep(300);
  check('circle goes back a page', await ev(`(()=>{return menuPage;})()`), 'device');
  // that navigation may have changed the device, so put the controller back first
  await ev(`(()=>{navigator.getGamepads=()=>[window.__fakePad];})()`);
  await clickSel('#devPad'); await sleep(200);
  check('controller selected again', await ev(`(()=>{return device;})()`), 'pad');
  // and unplugging falls back to the keyboard rather than leaving you with no input
  await ev(`(()=>{navigator.getGamepads=()=>[];window.dispatchEvent(new Event('gamepaddisconnected'));})()`);
  await sleep(250);
  check('unplugging falls back to keyboard', await ev(`(()=>{try{return device;}catch(e){return '?';}})()`), 'keys');

  console.log('\nphone: on-screen controls');
  await clickSel('#devPhone'); await sleep(200);
  check('phone selected', await ev(`document.getElementById('devPhone').classList.contains('sel')`), true);
  check('on-screen controls hidden in the menu', await vis('#touch'), 'hidden');
  await sleep(200);
  await clickSel('#btnOffline'); await sleep(300);
  await clickSel('#playBtn'); await sleep(1800);
  check('on-screen controls appear in the race', await vis('#touch'), 'visible');
  check('steering strip shown', await vis('#tSteer'), 'visible');
  check('throttle button shown', await vis('#tGas'), 'visible');
  // drag the wheel right, then let go
  const box=await ev(`(()=>{const r=document.getElementById('tSteer').getBoundingClientRect();
    return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height});})()`);
  const b=JSON.parse(box);
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:Math.round(b.x+b.w*0.85),y:Math.round(b.y+b.h/2),button:'left',clickCount:1,pointerType:'touch'});
  await sleep(200);
  check('sliding right steers right', await ev(`(()=>{return touchIn.steer>0.5;})()`), true);
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:Math.round(b.x+b.w*0.85),y:Math.round(b.y+b.h/2),button:'left',clickCount:1,pointerType:'touch'});
  await sleep(200);
  check('letting go re-centres the wheel', await ev(`(()=>{return touchIn.steer;})()`), 0);
  await shot('touch-race');

  console.log('\nphone-sized screen: does any of it overlap?');
  // a real phone in landscape, which is how you'd hold it to drive
  await cmd('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:2,mobile:true});
  await sleep(700);
  const overlap=async(a,b)=>ev(`(()=>{const A=document.querySelector('${a}'),B=document.querySelector('${b}');
    if(!A||!B)return 'MISSING';const r=A.getBoundingClientRect(),s=B.getBoundingClientRect();
    const hidden=e=>getComputedStyle(e).display==='none';
    if(hidden(A)||hidden(B))return false;
    return !(r.right<=s.left||s.right<=r.left||r.bottom<=s.top||s.bottom<=r.top);})()`);
  check('steering strip clear of the speed card', await overlap('#tSteer','#speed'), false);
  check('steering strip clear of the pedals', await overlap('#tSteer','#tGas'), false);
  check('brake clear of throttle', await overlap('#tBrake','#tGas'), false);
  check('handbrake clear of the brake', await overlap('#tHand','#tBrake'), false);
  check('minimap clear of the lap-time card', await overlap('#mini','#hudTR'), false);
  check('controls stay on screen', await ev(`(()=>{const w=innerWidth,h=innerHeight;
    return ['#tSteer','#tGas','#tBrake','#tHand','#tDrs'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();
      return r.left>=-1&&r.top>=-1&&r.right<=w+1&&r.bottom<=h+1;});})()`), true);
  await shot('phone-landscape');
  // and the menu has to fit a portrait phone without the start button escaping
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await ev(`location.reload()`); await sleep(2600); await waitReady();
  check('device page fits a portrait phone', await ev(`(()=>{const p=document.querySelector('.panel');
    return p.getBoundingClientRect().height<=innerHeight;})()`), true);
  await clickSel('#devPhone'); await sleep(300);
  await clickSel('#btnOffline'); await sleep(400);
  check('circuit store drops to 2 columns on a phone', await ev(`(()=>{
    return getComputedStyle(document.getElementById('mapGrid')).gridTemplateColumns.split(' ').length;})()`), 2);
  check('START RACE is reachable without scrolling', await ev(`(()=>{const b=document.getElementById('playBtn'),
    r=b.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0;})()`), true);
  await shot('phone-portrait-menu');
  await cmd('Emulation.clearDeviceMetricsOverride');

  // back to the keyboard for the rest of the run
  await ev(`location.reload()`); await sleep(2500); await waitReady();
  await clickSel('#devKeys'); await sleep(350);

  console.log('\nroot page: two buttons only');
  check('MULTIPLAYER shown', await vis('#btnMulti'), 'visible');
  check('OFFLINE shown', await vis('#btnOffline'), 'visible');
  check('no start-race button yet', await vis('#playBtn'), 'hidden');
  check('online/local not shown yet', await vis('#btnOnline'), 'hidden');
  check('no bots slider yet', await vis('#botSlider'), 'hidden');
  await shot('root');

  console.log('\nOFFLINE: bots slider, then start');
  await clickSel('#btnOffline'); await sleep(350);
  check('bots slider appears', await vis('#botSlider'), 'visible');
  check('slider runs 0..22', await ev(`(()=>{const s=document.getElementById('botSlider');return s.min+'..'+s.max;})()`), '0..22');
  check('start race appears', await vis('#playBtn'), 'visible');
  check('start race is enabled', await ev(`!document.getElementById('playBtn').disabled`), true);
  check('no seats offline', await vis('#seatBox'), 'hidden');
  await ev(`(()=>{const s=document.getElementById('botSlider');s.value='22';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(250);
  check('22 bots selected', await txt('#botNum'), '22');
  check('field reads 23 cars', await txt('#botMax'), /23 cars/);
  await shot('offline');
  await clickSel('#playBtn'); await sleep(2500);
  check('a 23-car race starts', await ev(`(()=>{try{return cars.length;}catch(e){return -1;}})()`), 23);
  check('screen is not split for one player', await ev(`document.body.classList.contains('split')`), false);
  await shot('offline-race');

  console.log('\nMULTIPLAYER: online + local play');
  await ev(`location.reload()`); await sleep(2500); await waitReady();
  await clickSel('#devKeys'); await sleep(300);
  await clickSel('#btnMulti'); await sleep(350);
  check('ONLINE shown', await vis('#btnOnline'), 'visible');
  check('LOCAL PLAY shown', await vis('#btnLocal'), 'visible');
  check('root buttons hidden', await vis('#btnOffline'), 'hidden');
  check('no start-race on this page', await vis('#playBtn'), 'hidden');
  await shot('multiplayer');

  console.log('\nLOCAL PLAY: one seat, then two, then split');
  await clickSel('#btnLocal'); await sleep(400);
  check('seats shown', await vis('#seatBox'), 'visible');
  check('bots slider shown', await vis('#botSlider'), 'visible');
  check('player 2 has not joined', await txt('#seat2name'), /Press/);
  check('one seat does not split', await ev(`document.body.classList.contains('split')`), false);
  await shot('local-1p');
  await keyTap('ArrowUp'); await sleep(350);
  // seat 2 is ready either way; it says "gamepad" when a spare pad is plugged in
  check('player 2 joins', await txt('#seat2name'), /^Ready/);
  await ev(`(()=>{const s=document.getElementById('botSlider');s.value='4';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);
  check('two seats + 4 bots = 6 cars', await txt('#botMax'), /6 cars/);
  await shot('local-2p');
  await clickSel('#playBtn'); await sleep(2000);
  check('two seats split the screen', await ev(`document.body.classList.contains('split')`), true);
  check('divider drawn', await vis('#splitLine'), 'visible');
  check('P1 strip shown', await vis('#strip1'), 'visible');
  check('P2 strip shown', await vis('#strip2'), 'visible');
  check('the single-view speed card is hidden', await vis('#speed'), 'hidden');
  check('a second camera exists', await ev(`(()=>{try{return cam2!==null;}catch(e){return 'n/a';}})()`), true);
  check('the two cameras sit in different places', await ev(`(()=>{try{
    return cam2.position.distanceTo(camera.position)>0.5;}catch(e){return 'n/a';}})()`), true);
  check('both seats got a car', await ev(`(()=>{try{return cars.filter(c=>c.isPlayer).length;}catch(e){return -1;}})()`), 2);
  await shot('split');

  console.log('\nONLINE: lobby browser and the start gate');
  // Never talk to the real Render server from a test: it sleeps, so a cold start
  // would make this slow and flaky. None of these checks need a live connection.
  await ev(`(()=>{document.getElementById('mpUrl').value='ws://127.0.0.1:9999';})()`);
  await ev(`location.reload()`); await sleep(2500); await waitReady();
  await clickSel('#devKeys'); await sleep(300);
  await clickSel('#btnMulti'); await sleep(250);
  await clickSel('#btnOnline'); await sleep(900);
  check('lobby browser is shown at once', await vis('#lobbyWrap'), 'visible');
  check('create-lobby button shown', await vis('#mpCreate'), 'visible');
  check('no bots online', await vis('#botSlider'), 'hidden');
  check('start is gated until players arrive', await txt('#playBtn'), /LOBBY|WAITING|START/);
  check('start is disabled with nobody there', await ev(`document.getElementById('playBtn').disabled`), true);
  await shot('online');

  // The server is on free hosting that sleeps and takes up to a minute to wake. A
  // single attempt with no retry left the game stuck "offline", which is
  // indistinguishable from being broken. Point it at a dead port and check it keeps
  // trying and says so, rather than giving up silently.
  console.log('\nsleeping/unreachable server');
  await ev(`(()=>{ if(myLobby)leaveLobby();
    mpGiveUp(); if(ws){try{ws.close();}catch(e){}} ws=null; mpConnected=false;
    document.getElementById('mpUrl').value='ws://127.0.0.1:9999';  // nothing listens here
    // (port 9 is on Chrome's blocked list and fails differently)
    mpConnect(); })()`);
  await sleep(1500);
  const tries1=await ev(`(()=>{return mpTries;})()`);
  check('a failed connection schedules another try', tries1>=1, true);
  check('the status says it is waking the server, not "offline"',
    await txt('#mpStatus'), /waking|connecting|asleep/i);
  check('the lobby panel explains the wait', await txt('#lobbyList'), /[Ww]aking|Connecting|sleep/);
  await sleep(4000);
  check('it tried again on its own', await ev(`(()=>{return mpTries;})()`)>tries1, true);
  // and leaving the page must stop it retrying forever in the background
  await clickSel('#setupBack'); await sleep(600);
  check('leaving online cancels the retry', await ev(`(()=>{return mpRetryT===null;})()`), true);
  await ev(`(()=>{document.getElementById('mpUrl').value='';mpGiveUp();})()`);

  if(errors.length){ console.log('\nconsole errors seen:'); errors.slice(0,10).forEach(e=>console.log('  '+e)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail?'BROWSER TESTS FAILED ⚠️':'BROWSER TESTS PASSED ✅');
  ws.close(); cleanup(); process.exit(fail?1:0);
})().catch(e=>{ console.error('DRIVER ERROR:',e.message); cleanup(); process.exit(1); });
