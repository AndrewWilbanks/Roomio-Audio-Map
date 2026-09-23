// dev/e2e-live.js — Electron end-to-end: Smaart in the main process, status indicator,
// reconnect, Settings. Seeds a throwaway user-data folder with the example venue.
// Starts/stops dev/mock_smaart.py itself (no password).   node dev/e2e-live.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 9334;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-e2e-live-'));
const hall = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/examples/example-hall.auditorium.json'), 'utf8'));
fs.writeFileSync(path.join(userData, 'venue.json'), JSON.stringify({
  schemaVersion: 1, auditorium: hall, foh: { x: 0, y: 1.5 },
  smaart: { host: '127.0.0.1', port: 26000, path: '/api/v4/', autoConnect: true, paths: { spl: 'meters.name=Booth.dBA' }, seatPaths: {}, spectrumPath: 'spectrum.name=Booth.bins', seatSpectrumPath: '' },
  seatEdits: { deleted: [], added: [], labels: {} }, preferences: {},
}));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let mock = null;
const startMock = () => { mock = spawn('python3', ['-u', path.join(__dirname, 'mock_smaart.py')], { stdio: 'ignore' }); };
const stopMock = () => { if (mock) { mock.kill(); mock = null; } };
startMock();
// RA_APP_BIN=path/to/packaged/binary tests an installed build instead of the source
const bin = process.env.RA_APP_BIN;
const app = spawn(bin || require('electron'), [...(bin ? [] : ['.']), `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, RA_USER_DATA: userData }, stdio: 'ignore' });
const getJson = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function connectPage() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(t => t.type === 'page'); if (t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r)); return ws; } } catch (e) {}
    await sleep(250);
  }
  throw new Error('no window');
}

async function main() {
  const ws = await connectPage();
  let id = 0; const pending = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  const js = (expr) => new Promise((res, rej) => { const n = ++id; pending.set(n, (j) => j.result && j.result.exceptionDetails ? rej(new Error(j.result.exceptionDetails.exception.description)) : res(j.result && j.result.result.value));
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } })); });
  const log = (k, v) => console.log(k.padEnd(26), typeof v === 'string' ? v : JSON.stringify(v));
  const pill = () => js(`return document.querySelector('#smaart-pill .txt').textContent`);

  await sleep(3000);
  log('page', await js(`return location.pathname.split('/').pop() + ' · ' + document.getElementById('page-eyebrow').textContent`));
  log('pill', await pill());
  log('booth SPL (via IPC)', await js(`const b = Smaart.booth('spl'); return b.source + ' ' + (b.value && b.value.toFixed(1))`));
  log('booth Low (spectrum)', await js(`const b = Smaart.booth('low'); return b.source + ' ' + (b.value && b.value.toFixed(1))`));
  log('page opened a socket?', await js(`return performance.getEntriesByType('resource').some(e => e.name.startsWith('ws'))`));
  log('CSP blocks ws in page?', await js(`try { new WebSocket('ws://127.0.0.1:26000/api/v4/'); await new Promise(r => setTimeout(r, 300)); return 'constructed (CSP enforced on connect)'; } catch (e) { return 'blocked: ' + e.name; }`));
  stopMock();
  await sleep(2500);
  log('after Smaart quits', await pill());
  log('  status message', await js(`return Smaart.statusMsg`));
  startMock();
  await sleep(5000);
  log('after Smaart returns', await pill());
  await js(`document.getElementById('btn-settings').click(); await new Promise(r => setTimeout(r, 400));`);
  log('Settings dialog', await js(`return [...document.querySelectorAll('.modal button')].map(b => b.textContent.trim()).filter(Boolean).join(' | ')`));
  log('  about', await js(`return [...document.querySelectorAll('.modal .hint')].pop().textContent`));
  ws.close();
}
main().catch(e => console.error('E2E FAILED:', e.message)).finally(() => { stopMock(); app.kill(); setTimeout(() => fs.rmSync(userData, { recursive: true, force: true }), 500); });
