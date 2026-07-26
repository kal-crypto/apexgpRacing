/* ============================================================================
   Build the two single-file distributions from index.html.

     node build_bundles.js            # build, report, verify
     node build_bundles.js --check    # verify only, non-zero exit if stale (CI)

   index.html is the ONLY source of truth. Every <script src="..."> is inlined
   from disk, so the outputs need no other files at runtime:

     apexgp3d_standalone.html  full HTML document — double-click to play, or
                               upload to itch.io / Netlify as-is
     apexgp3d_artifact.html    the same page as a fragment (no doctype/html/
                               head/body) for publishing as a Claude Artifact,
                               which supplies its own document skeleton

   Written as UTF-8. The previously hand-maintained bundles had double-encoded
   text (the coin and trophy glyphs and every em-dash rendered as mojibake);
   generating them fixes that at the source.
   ==========================================================================*/
const fs = require('fs'), path = require('path');
const dir = __dirname;
const SRC = 'index.html';
const OUT_STANDALONE = 'apexgp3d_standalone.html';
const OUT_ARTIFACT = 'apexgp3d_artifact.html';
const check = process.argv.includes('--check');
// The two single-file builds only exist in the distribution folder. Run from the
// repo (which ships the multi-file site only) there is nothing to build.
if(!fs.existsSync(path.join(dir,SRC))){
  console.log('no bundles in this layout — '+SRC+' is not beside this script'); process.exit(0);
}

const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const kb = n => (n / 1024).toFixed(0) + 'kB';

// ---- inline every external script -----------------------------------------
const src = read(SRC);
const missing = [], payloads = [];
let inlined = 0, bytes = 0;
const standalone = src.replace(/<script\s+src="([^"]+)"\s*>\s*<\/script>/g, (m, file) => {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) { missing.push(file); return m; }
  const js = fs.readFileSync(p, 'utf8');
  inlined++; bytes += js.length; payloads.push([file, js]);
  // a stray </script> inside the payload would end the tag early
  if (/<\/script/i.test(js)) throw new Error(file + ' contains a literal </script> — cannot inline safely');
  return '<script>\n/* ---- inlined: ' + file + ' ---- */\n' + js + '\n</script>';
});
if (missing.length) { console.error('MISSING source files: ' + missing.join(', ')); process.exit(1); }
if (/<script\s+src=/.test(standalone)) { console.error('some <script src> tags were not inlined'); process.exit(1); }

// ---- the artifact variant is the same page without the document wrapper ----
const from = standalone.indexOf('<style>');
const to = standalone.lastIndexOf('</script>');
if (from < 0 || to < 0) { console.error('cannot locate <style>..</script> span for the artifact build'); process.exit(1); }
const artifact = standalone.slice(from, to + '</script>'.length)
  .replace(/^[ \t]*<\/head>[ \t]*\r?\n/m, '')          // the host page supplies these
  .replace(/^[ \t]*<body[^>]*>[ \t]*\r?\n/m, '') + '\n';

// ---- verify before writing -------------------------------------------------
const gameScript = s => { const m = /<script>\s*"use strict"([\s\S]*?)<\/script>/.exec(s); return m && m[1]; };
const problems = [];
const srcGame = gameScript(src);
for (const [name, out] of [[OUT_STANDALONE, standalone], [OUT_ARTIFACT, artifact]]) {
  if (gameScript(out) !== srcGame) problems.push(name + ': game script does not match index.html');
  if (/<script\s+src=/.test(out)) problems.push(name + ': still references an external script');
  if (/â€|ðŸ|Ã©/.test(out)) problems.push(name + ': contains double-encoded text');
  if (!out.includes('CAR_GLB_B64')) problems.push(name + ': car model missing');
  try { new Function(gameScript(out)); } catch (e) { problems.push(name + ': game script syntax error — ' + e.message); }
  // every inlined payload must survive verbatim — catches truncation or mangling
  for (const [file, js] of payloads) if (!out.includes(js)) problems.push(name + ': ' + file + ' was not inlined intact');
}
if (artifact.includes('<!doctype') || artifact.includes('<body')) problems.push(OUT_ARTIFACT + ': should not carry a document wrapper');
if (!standalone.startsWith('<!doctype')) problems.push(OUT_STANDALONE + ': should be a full document');
if (problems.length) { console.error('BUILD REJECTED:\n  ' + problems.join('\n  ')); process.exit(1); }

// ---- write (or just report staleness) -------------------------------------
let stale = false;
for (const [name, out] of [[OUT_STANDALONE, standalone], [OUT_ARTIFACT, artifact]]) {
  const p = path.join(dir, name);
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  const same = old === out;
  if (!same) stale = true;
  if (!check && !same) fs.writeFileSync(p, out);
  console.log(`${name.padEnd(26)} ${kb(out.length).padStart(7)}  ` +
    (same ? 'up to date' : check ? 'STALE' : `written (was ${old === null ? 'absent' : kb(old.length)})`));
}
console.log(`inlined ${inlined} scripts (${kb(bytes)}) from ${SRC}`);
if (check && stale) { console.error('\nbundles are stale — run: node build_bundles.js'); process.exit(1); }
console.log(check ? '\nbundles are up to date' : '\nbundles built');
