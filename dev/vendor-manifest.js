// dev/vendor-manifest.js — writes renderer/vendor/**/MANIFEST.json (SHA-256 of every vendored file).
// The sandbox guard test fails if a vendored file changes without the manifest being regenerated.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const VENDOR = path.join(__dirname, '..', 'renderer', 'vendor');
for (const lib of fs.readdirSync(VENDOR)) {
  const dir = path.join(VENDOR, lib), out = {};
  (function walk(d) {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f !== 'MANIFEST.json') out[path.relative(dir, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  })(dir);
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote', path.relative(process.cwd(), path.join(dir, 'MANIFEST.json')), Object.keys(out).length, 'files');
}
