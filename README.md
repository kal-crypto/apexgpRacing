# 🏎️ APEX GP 3D

A 3D WebGL Formula-1 racing game with online multiplayer.

```
web/      the game (static site)  -> Netlify
server/   multiplayer relay        -> Render
render.yaml / netlify.toml         platform configs (at the repo root)
```

## Play locally
Open `web/index.html` in a browser (works offline; multiplayer needs the server).

## Deploy

### Website → Netlify
- Import this repo. Netlify reads `netlify.toml` and publishes the **`web`** folder.
- Build command: *(empty)* · Publish directory: `web`.

### Multiplayer server → Render
- New **Blueprint** from this repo (reads `render.yaml`) → deploys **`server/`** as a Node web service.
- Or a manual **Web Service** with **Root Directory = `server`**, build `npm install`, start `node server.js`.

### Wire them together
In `web/index.html`, this line points the site at the server:
```html
<script>window.APEX_SERVER = "wss://apexgp-server.onrender.com";</script>
```
Set it to your server's `wss://…onrender.com` URL.

## Controls
`W/↑` throttle · `S/↓` brake · `A/D` steer · `Shift` DRS · `Space` handbrake · `C` camera · `P` pause · `M` mute
