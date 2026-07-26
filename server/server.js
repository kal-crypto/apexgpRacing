/* ============================================================================
   APEX GP — multiplayer relay + lobby directory (for Render "Web Service").
   Pure state-relay: each client simulates its own car and broadcasts position;
   the server forwards it to everyone in the same lobby. It also keeps a live
   directory of open lobbies so players can browse and join from the menu
   instead of swapping codes by hand. No database, no auth — just presence.

   Client -> server:  hello · list · create · enter · leave · cfg · race · s
   Server -> client:  id · lobbies · lobby · join · bye · err · s

   `hello` is the original protocol and still behaves exactly as it did, so
   older clients (cached pages, published single-file builds) keep working
   against this server unchanged.
   ==========================================================================*/
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 22;                                  // cars per lobby — a full grid
const MAX_LOBBIES = 240;                                 // abuse guard
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I look-alikes
const CREATE_COOLDOWN = 2000;                            // ms between creates per client
const LIST_COOLDOWN = 900;                               // ms between directory rebuilds per client

const clients = new Map();   // ws -> { id, name, livery, room, lastCreate, lastList }
const lobbies = new Map();   // key -> { key, code, host, hostId, track, laps, racing, pub, created }

const send = (ws, obj) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } };
// names and codes come from strangers: strip control chars, cap the length
const clean = (s, n) => ('' + (s == null ? '' : s)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const asInt = (v, lo, hi, dflt) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function members(key, exceptWs) {
  const out = [];
  if (!key) return out;
  for (const [w, c] of clients) if (c.room === key && w !== exceptWs) out.push(w);
  return out;
}
function population(key) { let n = 0; for (const c of clients.values()) if (c.room === key) n++; return n; }

// the payload the menu's lobby browser renders — the server stays circuit-name
// agnostic and just reports the track index; the client knows the names
function info(r) {
  const names = [];
  for (const c of clients.values()) if (c.room === r.key) names.push(c.name);
  return { key: r.key, code: r.code, host: r.host, hostId: r.hostId, track: r.track, laps: r.laps,
           players: names.length, max: MAX_PLAYERS, racing: !!r.racing, pub: !!r.pub,
           names: names.slice(0, MAX_PLAYERS), age: Math.round((Date.now() - r.created) / 1000) };
}
function directory() {
  const out = [];
  for (const r of lobbies.values()) { const i = info(r); if (i.players > 0) out.push(i); }
  // joinable first, then busiest, then newest — the order the browser shows
  out.sort((a, b) => (a.racing - b.racing) || (b.players - a.players) || (a.age - b.age));
  return out;
}
function detail(key) {
  const r = lobbies.get(key); if (!r) return;
  const d = info(r);
  for (const w of members(key)) send(w, { t: 'lobby', lobby: d });
}
let listPending = false;                                  // coalesce bursts of churn
function publish() {
  if (listPending) return;
  listPending = true;
  setTimeout(() => {
    listPending = false;
    const list = directory();
    for (const w of clients.keys()) send(w, { t: 'lobbies', list });
  }, 60);
}

function leave(ws, quiet) {
  const c = clients.get(ws); if (!c || !c.room) return;
  const key = c.room; c.room = null;
  for (const w of members(key)) send(w, { t: 'bye', id: c.id });
  const r = lobbies.get(key);
  if (r) {
    if (population(key) === 0) lobbies.delete(key);
    else {
      if (r.hostId === c.id) {                            // hand the lobby to whoever's left
        const heir = clients.get(members(key)[0]);
        if (heir) { r.host = heir.name; r.hostId = heir.id; }
      }
      detail(key);
    }
  }
  if (!quiet) send(ws, { t: 'lobby', lobby: null });
  publish();
}

// `make` builds the lobby when it doesn't exist yet; pass null to require one
function enter(ws, key, make) {
  const c = clients.get(ws); if (!c) return;
  if (c.room === key) { detail(key); return; }
  let r = lobbies.get(key);
  if (!r) {
    if (!make) { send(ws, { t: 'err', why: 'gone' }); return; }
    if (lobbies.size >= MAX_LOBBIES) { send(ws, { t: 'err', why: 'busy' }); return; }
  } else if (population(key) >= MAX_PLAYERS) { send(ws, { t: 'err', why: 'full', code: r.code }); return; }
  leave(ws, true);
  if (!r) { r = make(); lobbies.set(key, r); }
  c.room = key;
  for (const w of members(key, ws)) {                     // introduce me to them and them to me
    send(w, { t: 'join', id: c.id, name: c.name, livery: c.livery });
    const oc = clients.get(w);
    send(ws, { t: 'join', id: oc.id, name: oc.name, livery: oc.livery });
  }
  detail(key);
  publish();
}

function freshCode() {
  for (let tries = 0; tries < 500; tries++) {
    let s = '';
    for (let k = 0; k < 4; k++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!lobbies.has('r:' + s)) return s;
  }
  return null;
}
const mk = (key, code, c, track, laps, pub) =>
  () => ({ key, code, host: c.name, hostId: c.id, track, laps, racing: false, pub, created: Date.now() });

// simple HTTP layer (Render health check, landing page, lobby directory as JSON)
const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/lobbies') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ online: clients.size, lobbies: directory() }));
  } else if (path === '/health' || path === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`APEX GP multiplayer up · ${clients.size} online · ${lobbies.size} lobbies`);
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on('connection', (ws) => {
  const id = nextId++;
  clients.set(ws, { id, name: 'P' + id, livery: 0, room: null, lastCreate: 0, lastList: 0 });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'id', id });
  send(ws, { t: 'lobbies', list: directory() });          // so the browser fills in at once

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const c = clients.get(ws); if (!c) return;
    const track = () => asInt(m.track, 0, 999, 0);
    const laps = () => asInt(m.laps, 1, 50, 3);

    if (m.t === 'hello') {                                // original protocol, unchanged behaviour
      c.name = clean(m.name, 16) || ('P' + c.id);
      c.livery = asInt(m.livery, 0, 99, 0);
      const code = clean(m.room, 8).toUpperCase();
      // private room code -> its own lobby; otherwise a public lobby per circuit
      const key = code ? 'r:' + code : 't' + track();
      enter(ws, key, mk(key, code, c, track(), laps(), !code));
      // enter() is a no-op when you are already in that lobby, so a repeat hello
      // would otherwise silently drop the circuit/laps it carries
      const r = lobbies.get(key);
      if (r && r.hostId === c.id && (r.track !== track() || r.laps !== laps())) {
        r.track = track(); r.laps = laps(); detail(key); publish();
      }

    } else if (m.t === 'list') {
      const now = Date.now();                             // rebuilding the directory is O(lobbies x clients)
      if (now - c.lastList < LIST_COOLDOWN) return;
      c.lastList = now;
      send(ws, { t: 'lobbies', list: directory() });

    } else if (m.t === 'create') {
      const now = Date.now();
      if (now - c.lastCreate < CREATE_COOLDOWN) { send(ws, { t: 'err', why: 'slow-down' }); return; }
      c.lastCreate = now;
      c.name = clean(m.name, 16) || ('P' + c.id);
      c.livery = asInt(m.livery, 0, 99, 0);
      const code = freshCode();
      if (!code) { send(ws, { t: 'err', why: 'busy' }); return; }
      enter(ws, 'r:' + code, mk('r:' + code, code, c, track(), laps(), false));

    } else if (m.t === 'enter') {
      const code = clean(m.code, 8).toUpperCase();
      if (!code) { send(ws, { t: 'err', why: 'gone' }); return; }
      c.name = clean(m.name, 16) || c.name;
      c.livery = asInt(m.livery, 0, 99, c.livery);
      enter(ws, 'r:' + code, null);                       // must already exist

    } else if (m.t === 'leave') {
      leave(ws);

    } else if (m.t === 'cfg') {                           // host changed circuit / laps
      const r = lobbies.get(c.room);
      if (r && r.hostId === c.id) {
        if (m.track != null) r.track = track();
        if (m.laps != null) r.laps = laps();
        detail(c.room); publish();
      }

    } else if (m.t === 'race') {                          // lights out / back to the menu
      const r = lobbies.get(c.room);
      if (r) { r.racing = !!m.on; detail(c.room); publish(); }

    } else if (m.t === 's') {                              // position/state update
      if (!c.room) return;
      m.id = c.id;                                         // stamp sender
      for (const w of members(c.room, ws)) send(w, m);
    }
  });

  ws.on('close', () => { leave(ws, true); clients.delete(ws); publish(); });
  ws.on('error', () => {});
});

// drop dead connections every 30s
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, () => console.log('APEX GP multiplayer listening on ' + PORT));
