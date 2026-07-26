/* ============================================================================
   Mirror the game into every place that gets deployed, then prove they match.

     node sync_deploy.js            # copy, rebuild the single-file builds, verify
     node sync_deploy.js --check    # verify only; non-zero exit if anything is stale

   The game is authored in ONE place and copied to several. Doing that by hand is
   how a deployed site ends up serving an old build while the local file is fine,
   so this does the whole set at once and then re-reads every target to confirm.

     <authoring>/index.html  ->  apexgp/web/index.html        (git -> Netlify)
                              ->  apexgp3d-web/index.html      (drag-drop folder)
     apexgp/server/server.js  ->  apexgp-server/server.js       (local scratch copy)
     plus the two single-file builds, rebuilt from index.html

   Targets that don't exist on this machine are skipped, so a fresh clone of just
   this repo still runs it without error.
   ==========================================================================*/
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const check = process.argv.includes('--check');
const here = __dirname;                       // the repo
const up = path.join(here, '..');             // the folder holding the repo + siblings

const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const has = f => { try { return fs.existsSync(f); } catch (e) { return false; } };

// Authoring copy: whichever sibling folder holds index.html next to the builds.
// Falls back to the repo's own web/ when there is no working folder here.
const AUTHOR = [path.join(up, 'ApexGP3D', 'index.html'), path.join(here, 'web', 'index.html')].find(has);
if (!AUTHOR) { console.error('cannot find an index.html to sync from'); process.exit(1); }
const AUTHOR_DIR = path.dirname(AUTHOR);
console.log('source: ' + AUTHOR);

const jobs = [
  { src: AUTHOR, dst: path.join(here, 'web', 'index.html'), what: 'web/index.html (git -> Netlify)' },
  { src: AUTHOR, dst: path.join(up, 'apexgp3d-web', 'index.html'), what: 'apexgp3d-web/index.html (drag-drop)' },
  { src: path.join(here, 'server', 'server.js'), dst: path.join(up, 'apexgp-server', 'server.js'), what: 'apexgp-server/server.js' },
];

let stale = 0, copied = 0, skipped = 0;
for (const j of jobs) {
  if (!has(j.src)) { console.log('  skip  ' + j.what + '  (no source)'); skipped++; continue; }
  if (path.resolve(j.src) === path.resolve(j.dst)) { console.log('  same  ' + j.what); continue; }
  if (!has(path.dirname(j.dst))) { console.log('  skip  ' + j.what + '  (target folder absent)'); skipped++; continue; }
  const before = has(j.dst) ? sha(j.dst) : null;
  const want = sha(j.src);
  if (before === want) { console.log('  ok    ' + j.what + '  ' + want); continue; }
  stale++;
  if (check) { console.log('  STALE ' + j.what + '  ' + (before || 'absent') + ' -> ' + want); continue; }
  fs.copyFileSync(j.src, j.dst); copied++;
  console.log('  wrote ' + j.what + '  ' + (before || 'absent') + ' -> ' + sha(j.dst));
}

// the single-file builds live beside the authoring copy
const builder = [path.join(AUTHOR_DIR, 'build_bundles.js'), path.join(here, 'tests', 'build_bundles.js')].find(has);
if (builder && has(path.join(AUTHOR_DIR, 'apexgp3d_standalone.html'))) {
  const r = cp.spawnSync(process.execPath, [builder].concat(check ? ['--check'] : []),
    { cwd: AUTHOR_DIR, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean);
  out.forEach(l => console.log('  bundle: ' + l.trim()));
  if (r.status !== 0) stale++;
} else console.log('  skip  single-file builds (not in this layout)');

// ---- prove it: re-read every target ---------------------------------------
console.log('\nverify:');
const want = sha(AUTHOR);
let bad = 0;
for (const j of jobs) {
  if (!has(j.dst) || !has(j.src)) continue;
  const same = sha(j.dst) === sha(j.src);
  if (!same) bad++;
  console.log('  ' + (same ? 'match ' : 'DIFFER') + ' ' + j.what);
}
console.log('\ngame build id: ' + (/const BUILD='([^']*)'/.exec(fs.readFileSync(AUTHOR, 'utf8')) || [, '(none)'])[1]);
if (bad) { console.error('\n' + bad + ' target(s) still differ'); process.exit(1); }
if (check && stale) { console.error('\n' + stale + ' target(s) stale — run: node sync_deploy.js'); process.exit(1); }
console.log(check ? 'everything in sync' : (copied ? copied + ' file(s) updated — commit and push to deploy' : 'already in sync'));
