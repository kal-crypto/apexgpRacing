/* ============================================================================
   APEX GP — multiplayer relay server (for Render "Web Service").
   Pure state-relay: each client simulates its own car and broadcasts position;
   the server forwards it to everyone racing the same circuit (a "room").
   No database, no auth — just real-time presence.
   ==========================================================================*/
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// simple HTTP layer (Render health check + a friendly landing page)
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`APEX GP multiplayer up · ${clients.size} online`);
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server });
let nextId = 1;
const clients = new Map();                 // ws -> { id, name, livery, room }

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
function peers(room, exceptWs) {
  const out = [];
  for (const [w, c] of clients) if (c.room === room && w !== exceptWs) out.push(w);
  return out;
}

wss.on('connection', (ws) => {
  const id = nextId++;
  clients.set(ws, { id, name: 'P' + id, livery: 0, room: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'id', id });

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    const c = clients.get(ws); if (!c) return;

    if (m.t === 'hello') {
      c.name = ('' + (m.name || 'P' + id)).slice(0, 16);
      c.livery = m.livery | 0;
      // private room code -> its own room; otherwise a public room per circuit
      const room = m.room ? ('r:' + String(m.room).toUpperCase().slice(0, 8)) : ('t' + (m.track | 0));
      if (c.room !== room) {
        if (c.room) for (const w of peers(c.room, ws)) send(w, { t: 'bye', id });
        c.room = room;
        // introduce me to the room and the room to me
        for (const w of peers(c.room, ws)) {
          send(w, { t: 'join', id, name: c.name, livery: c.livery });
          const oc = clients.get(w);
          send(ws, { t: 'join', id: oc.id, name: oc.name, livery: oc.livery });
        }
      }
    } else if (m.t === 's') {                 // position/state update
      if (!c.room) return;
      m.id = id;                              // stamp sender
      for (const w of peers(c.room, ws)) send(w, m);
    }
  });

  ws.on('close', () => {
    const c = clients.get(ws);
    if (c && c.room) for (const w of peers(c.room, ws)) send(w, { t: 'bye', id: c.id });
    clients.delete(ws);
  });
});

// drop dead connections every 30s
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, () => console.log('APEX GP multiplayer listening on ' + PORT));
