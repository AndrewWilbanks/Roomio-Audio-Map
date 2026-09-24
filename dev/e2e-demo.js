// dev/e2e-demo.js — demo mode end-to-end: wizard → Try the demo → simulated live data → Exit demo.
// Throwaway user-data folder; no Smaart, no mock server, no network needed.   node dev/e2e-demo.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 9335;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-e2e-demo-'));
// RA_APP_BIN=path/to/packaged/binary tests an installed build instead of the source
const bin = process.env.RA_APP_BIN;
const app = spawn(bin || require('electron'), [...(bin ? [] : ['.']), `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, RA_USER_DATA: userData }, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(t => t.type === 'page'); if (t) { const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r)); return ws; } } catch (e) {}
    await sleep(250);
  }
  throw new Error('no window');
}
function driver(ws) {
  let id = 0; const pending = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
  return (expr) => new Promise((res, rej) => { const n = ++id; pending.set(n, (j) => j.result && j.result.exceptionDetails ? rej(new Error(j.result.exceptionDetails.exception.description)) : res(j.result && j.result.result.value));
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } })); });
}
const log = (k, v) => console.log(k.padEnd(26), typeof v === 'string' ? v : JSON.stringify(v));

async function main() {
  let ws = await connect(); let js = driver(ws);
  await sleep(800);
  log('first page', await js(`return location.pathname.split('/').pop() + ' · demo button: ' + !!document.getElementById('btn-demo')`));
  await js(`document.getElementById('btn-demo').click();`);
  await sleep(1500); ws.close(); ws = await connect(); js = driver(ws); await sleep(2500);
  log('page', await js(`return location.pathname.split('/').pop() + ' · ' + document.getElementById('page-eyebrow').textContent`));
  log('banner', await js(`return document.querySelector('.demo-banner') ? document.querySelector('.demo-banner').innerText.split('\\n')[0] : 'none'`));
  log('pill', await js(`return document.querySelector('#smaart-pill .txt').textContent`));
  log('live booth SPL', await js(`const b = Smaart.booth('spl'); return b.source + ' ' + (b.value && b.value.toFixed(1))`));
  log('live FOH spectrum bands', await js(`const s = Smaart.liveSpectrum('booth'); return s ? s.length : 0`));
  log('seats colored / total', await js(`return document.querySelectorAll('.seat:not(.empty)').length + ' / ' + document.querySelectorAll('.seat').length`));
  log('readings / responses', await js(`return Store.readings.length + ' / ' + Store.spectra.length`));
  const v1 = await js(`return [...document.querySelectorAll('.seat:not(.empty):not(.est)')].slice(0, 3).map(r => r.getAttribute('fill')).join(' ')`);
  await sleep(4000);
  const v2 = await js(`return [...document.querySelectorAll('.seat:not(.empty):not(.est)')].slice(0, 3).map(r => r.getAttribute('fill')).join(' ')`);
  log('seat colours follow FOH', v1 !== v2 ? 'yes (changed over 4 s)' : 'NO CHANGE');
  await js(`document.getElementById('btn-settings').click(); await new Promise(r => setTimeout(r, 300));`);
  log('Settings in demo', await js(`return [...document.querySelectorAll('.modal button')].map(b => b.textContent.trim()).filter(Boolean).join(' | ')`));
  await js(`document.getElementById('st-exit-demo').click();`);
  await sleep(1500); ws.close(); ws = await connect(); js = driver(ws); await sleep(800);
  log('after Exit demo', await js(`return location.pathname.split('/').pop()`));
  const top = fs.readdirSync(userData).filter(f => /\.json$/.test(f));
  log('real venue files', top.length ? top : 'none (untouched)');
  log('demo files', fs.readdirSync(path.join(userData, 'demo')));
  ws.close();
}
main().catch(e => console.error('E2E FAILED:', e.message)).finally(() => { app.kill(); setTimeout(() => fs.rmSync(userData, { recursive: true, force: true }), 500); });
