# 🏎️ APEX GP 3D

A 3D WebGL Formula-1 racing game with online multiplayer.

```
web/      the game (static site)  -> Netlify
server/   multiplayer relay        -> Render
tests/    test suite (see below)
render.yaml / netlify.toml         platform configs (at the repo root)
```

## Play locally
Open `web/index.html` in a browser (works offline; multiplayer needs the server).

## Tests

```bash
cd tests
node validate_maps.js       # the 20 procedural circuits don't self-intersect at 26m
node test_headless.js       # real Three.js parses the car, races 3 circuits, checks the menus
node test_lobby_server.js   # boots server/server.js on a free port, drives it with real sockets
node test_browser.js        # headless Chrome clicks the whole flow; --shots writes PNGs
```

- `test_headless.js` runs the real simulation with only the GPU renderer stubbed: physics,
  AI, lap counting, a full 23-car grid, and the lobby UI including hostile player names.
- `test_lobby_server.js` starts the actual server and talks to it over real WebSockets —
  create/browse/join/leave, capacity, host migration, and the original `hello` protocol.
- `test_browser.js` needs Chrome or Edge (`CHROME_PATH` if it's somewhere unusual) and
  skips cleanly without one. It covers what a stubbed renderer cannot: the DOM, menu
  routing, split-screen viewports, gamepad mapping, touch controls and WebGL start-up.
  It never contacts the live server — a test that waits on sleeping free hosting is slow
  and flaky, so it points at a dead port on purpose.

These scripts find the game either beside them or in `../web`, so the same file runs from
here or from a working copy that keeps the game and the single-file builds together.

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
<script>window.APEX_SERVER = "wss://apexgpracing-server.onrender.com";</script>
```
That is the **live** service. (`apexgp-server.onrender.com` is an older one that has
been suspended — don't point at it.) Check a server is up before blaming the game:

```
curl https://apexgpracing-server.onrender.com/health
→ APEX GP multiplayer up · 0 online · 0 lobbies
```

**Render's free tier sleeps** after ~15 minutes idle and takes 15–60s to wake, so the
first person to go online after a quiet spell waits. The client retries automatically
and the status pill reads `waking server… n/6` while it does — that is normal, not a
fault. `?server=wss://…` in the URL overrides the built-in address for a quick test.

### The published site is missing recent changes

First, find out **which build is actually live** — one command, no guessing:

```bash
curl -s https://apexgpracing.netlify.app/ | grep -o "const BUILD='[^']*'"
```

Compare it with the `BUILD` constant in `web/index.html`. If the live one is older (or
missing entirely), the site is **not deploying** — the code is fine and no amount of
editing it will help. Check, in this order:

1. **Netlify → Deploys.** Is the newest deploy your newest commit? If the list stops at
   an older commit, either auto-publishing is stopped / the site is *locked to a deploy*
   (Netlify has a "Stop auto publishing" toggle and a per-deploy lock), or the site
   isn't linked to this repo at all — a site first created by drag-and-drop **never**
   auto-deploys from git, no matter how many times you push.
2. **Site settings → Build & deploy.** Publish directory must be `web`, base directory
   empty, build command empty. A site publishing the repo root serves no `index.html`.
3. **Branch.** Netlify must watch the branch you push (`main`).

**To publish right now without touching any of that**, drag the sibling `apexgp3d-web`
folder onto <https://app.netlify.com/drop>. It carries the whole game — the same
`index.html` plus `three.min.js`, `GLTFLoader.js`, `carmodel.js` and `pp/` — with a
`netlify.toml` that publishes `.`, so it stands alone. `node sync_deploy.js` keeps it
current.

### If the site loads but the game doesn't start
Open the browser console. Every script the page loads is relative and lives in `web/`,
so a 404 there stops the game dead — and Netlify is case-sensitive where Windows isn't.

## Keeping the copies in step

The game is authored once and copied to everywhere that deploys. Doing that by hand is
exactly how a site ends up serving an old build, so:

```bash
node sync_deploy.js          # copy everywhere, rebuild the single-file builds, verify
node sync_deploy.js --check   # verify only; non-zero exit if anything is stale
```

It re-reads every target afterwards and prints the build id, so "did that actually land"
is never a guess. Targets absent on your machine are skipped, so it is safe to run from
a fresh clone of just this repo.

## Controls
`W/↑` throttle · `S/↓` brake · `A/D` steer · `Shift` DRS · `Space` handbrake · `C` camera · `P` pause · `M` mute
