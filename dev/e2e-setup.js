// dev/e2e-setup.js — drives the real Electron app through the setup wizard over DevTools.
// Uses a throwaway user-data folder. Needs dev/mock_smaart.py running with MOCK_PASSWORD=testpw.
//   node dev/e2e-setup.js
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');

const PORT = 9333;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-e2e-'));
// RA_APP_BIN=path/to/packaged/binary tests an installed build instead of the source
const bin = process.env.RA_APP_BIN;
const app = spawn(bin || require('electron'), [...(bin ? [] : ['.']), `--remote-debugging-port=${PORT}`], { cwd: path.join(__dirname, '..'), env: { ...process.env, RA_USER_DATA: userData }, stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function page() {
  for (let i = 0; i < 40; i++) {
    try { const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(t => t.type === 'page'); if (t) return t; } catch (e) {}
    await sleep(250);
  }
  throw new Error('Electron window never appeared');
}

async function main() {
  let t = await page();
  let ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const onMsg = (m) => { const j = JSON.parse(m); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  ws.on('message', onMsg);
  const evalJs = (expr) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (j) => j.result && j.result.exceptionDetails ? rej(new Error(j.result.exceptionDetails.exception.description)) : res(j.result && j.result.result.value));
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } }));
  });
  const log = (k, v) => console.log(k.padEnd(22), typeof v === 'string' ? v : JSON.stringify(v));

  await sleep(800);
  log('first page', await evalJs(`return location.pathname.split('/').pop()`));
  log('node in renderer?', await evalJs(`return typeof require + '/' + typeof process`));
  await evalJs(`document.getElementById('btn-example').click(); await new Promise(r => setTimeout(r, 400));`);
  log('import result', await evalJs(`return document.getElementById('result').innerText.split('\\n')[1]`));
  await evalJs(`document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 400));
    const x = document.getElementById('foh-x'); x.value = '0.5'; x.dispatchEvent(new Event('input'));
    const y = document.getElementById('foh-y'); y.value = '2'; y.dispatchEvent(new Event('input'));
    document.getElementById('btn-next').click();`);
  const test = async (pw) => evalJs(`document.getElementById('sm-pw').value = ${JSON.stringify(pw)};
    document.getElementById('btn-test').click();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 150)); const t = document.getElementById('test-result').textContent; if (t && t !== 'Testing…') return t; }
    return 'timeout';`);
  log('test: no password', await test(''));
  log('test: wrong password', await test('nope'));
  log('test: right password', await test('testpw'));
  log('test: wrong port', await evalJs(`const p = document.getElementById('sm-port'); p.value = '26999'; p.dispatchEvent(new Event('input'));
    document.getElementById('btn-test').click();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 150)); const t = document.getElementById('test-result').textContent; if (t && t !== 'Testing…') { p.value = '26000'; return t; } }
    return 'timeout';`));
  await evalJs(`document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 300));`);
  log('review', await evalJs(`return document.getElementById('review').innerText.replace(/\\n+/g, ' | ')`));
  await evalJs(`document.getElementById('btn-next').click();`);
  await sleep(1500);

  // the window navigated to index.html: reconnect to the new page target
  ws.close();
  t = await page();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.on('message', onMsg);
  await sleep(1000);
  log('after save', await evalJs(`return location.pathname.split('/').pop() + ' · ' + document.getElementById('page-eyebrow').textContent + ' · ' + document.querySelectorAll('.seat').length + ' seats'`));

  const files = fs.readdirSync(userData).filter(f => /venue|measurements|credentials/.test(f));
  log('userData files', files);
  const venue = JSON.parse(fs.readFileSync(path.join(userData, 'venue.json'), 'utf8'));
  log('venue.json', { schemaVersion: venue.schemaVersion, name: venue.auditorium.name, foh: venue.foh, smaart: venue.smaart });
  const venueText = fs.readFileSync(path.join(userData, 'venue.json'), 'utf8');
  const creds = fs.readFileSync(path.join(userData, 'credentials.json'), 'utf8');
  log('password in venue?', venueText.includes('testpw'));
  log('password plaintext?', creds.includes('testpw'));
  app.kill();
  fs.rmSync(userData, { recursive: true, force: true });
}
main().catch(e => { console.error('E2E FAILED:', e.message); app.kill(); process.exit(1); });
