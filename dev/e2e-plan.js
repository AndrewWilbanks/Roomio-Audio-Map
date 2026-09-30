// dev/e2e-plan.js — Electron end-to-end for floor plans and areas, driven like a user:
//   setup: drop each plan (PNG, SVG, PDF), click the corners of three areas, name them, place the
//   stage, measure the scale, Use these areas; finish setup with the last one; then in the app:
//   Edit areas → draw a fourth area, rename one, remove one.
//   node dev/make-plans.js && node dev/e2e-plan.js [dir]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const DIR = process.argv[2] || path.join(os.tmpdir(), 'roomio-plans');
const PORT = 9336;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-e2e-plan-'));
const bin = process.env.RA_APP_BIN;
const app = spawn(bin || require('electron'), [...(bin ? [] : ['.']), `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, RA_USER_DATA: userData }, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function main() {
  let ws;
  const connect = async () => {
    for (let i = 0; i < 60; i++) { try { const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(t => t.type === 'page'); if (t) { const w = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => w.on('open', r)); return w; } } catch (e) {} await sleep(250); }
    throw new Error('no window');
  };
  let id = 0; const pend = new Map();
  const bindWs = () => ws.on('message', m => { const j = JSON.parse(m); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  ws = await connect(); bindWs();
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception.description); return r.result.result.value; };
  const shot = async (name) => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, name), Buffer.from(s.result.data, 'base64')); };
  // click points on the map in its own coordinates (like a user clicking the drawing)
  const clickMap = (container, pts, gap = 380) => js(`const svg = document.querySelector('${container} svg');
    for (const [x, y] of ${JSON.stringify(pts)}) {
      const m = svg.getScreenCTM(), cx = m.a * x + m.c * y + m.e, cy = m.b * x + m.d * y + m.f;
      const o = { clientX: cx, clientY: cy, pointerId: 1, bubbles: true, button: 0, isPrimary: true };
      svg.dispatchEvent(new PointerEvent('pointerdown', o)); svg.dispatchEvent(new PointerEvent('pointerup', o));
      await new Promise(r => setTimeout(r, ${gap}));                // not a double-click
    }`);
  await sleep(2500);

  const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'fan-hall.truth.json'), 'utf8'));
  const results = [];
  for (const ext of ['png', 'svg', 'pdf']) {
    const file = path.join(DIR, `fan-hall.${ext}`), name = path.basename(file);
    const mime = { png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf' }[ext];
    await js(`const b = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(file).toString('base64'))}), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));`);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { ready = await js(`const s = PlanImport._state(); return !!(s && s.canvas && s.file.name === ${JSON.stringify(name)}) && document.getElementById('plan-busy').hidden`); if (!ready) await sleep(200); }
    if (!ready) throw new Error(`${name} did not open: ${await js(`return document.getElementById('toast').textContent`)}`);
    const k = await js(`return PlanImport._state().canvas.width / ${truth.W}`);
    // three areas over the synthetic hall's sections (left, centre, right), clicked corner by corner
    const K = (pts) => pts.map(([x, y]) => [x * k, y * k]);
    const areas = [
      K([[230, 300], [560, 200], [630, 330], [330, 620], [180, 520]]),
      K([[590, 260], [810, 260], [830, 620], [570, 620]]),
      K([[840, 200], [1170, 300], [1220, 520], [1070, 620], [770, 330]]),
    ];
    for (const [i, a] of areas.entries()) {
      await clickMap('#plan-view', a.concat([a[0]]));                    // …then the first corner again closes it
      await js(`const i = document.querySelector('#plan-areas .plan-area:last-child input'); i.value = ${JSON.stringify(['House Left', 'Centre', 'House Right'][i])}; i.dispatchEvent(new Event('input')); i.blur();`);
    }
    await js(`document.querySelector('[data-mode="stage"]').click();`);
    await clickMap('#plan-view', [[700 * k, 60 * k]]);
    await js(`document.querySelector('[data-mode="measure"]').click();`);
    await clickMap('#plan-view', [[20 * k, 500 * k], [1380 * k, 500 * k]]);
    await js(`document.getElementById('plan-dist').value = '80'; document.getElementById('plan-dist-unit').value = 'ft'; document.getElementById('plan-measure').requestSubmit(); await new Promise(r => setTimeout(r, 200));`);
    if (ext === 'pdf') { await js(`document.getElementById('plan').scrollIntoView(); await new Promise(r => setTimeout(r, 300));`); await shot('shot-plan-areas.png'); }
    const st = await js(`const S = PlanImport._state(); return { areas: S.areas.map(a => a.name + ':' + a.poly.length), stage: !!S.stage, scale: S.upp ? S.units : null }`);
    await js(`document.getElementById('plan-use').click(); await new Promise(r => setTimeout(r, 500));`);
    const result = await js(`return document.getElementById('result').innerText.replace(/\\s+/g, ' ').slice(0, 170)`);
    results.push({ plan: name, ...st, next: await js(`return !document.getElementById('btn-next').disabled`), result });
  }
  console.log(JSON.stringify(results, null, 1));

  // finish setup with the last plan
  await js(`document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 1200));`);
  console.log('step 2 map', await js(`return JSON.stringify({ bg: !!document.querySelector('#setup-map image'), areas: document.querySelectorAll('#setup-map .area').length })`));
  await shot('shot-step2.png');
  await js(`document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 300)); document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 300)); document.getElementById('btn-next').click();`);
  await sleep(2500);
  ws.close(); ws = await connect(); bindWs();                            // setup.html → index.html
  await sleep(1500);
  const count = () => js(`return document.querySelectorAll('#map .area').length`);
  console.log('app', await js(`return document.getElementById('page-eyebrow').textContent`), '· areas', await count());
  // Edit areas → Draw area: a fourth area behind the others
  await js(`document.getElementById('btn-edit').click(); await new Promise(r => setTimeout(r, 200)); document.getElementById('ban-draw').click();`);
  const R = await js(`const a = Store.room.areas; const ys = a.flatMap(x => x.poly.map(p => p[1])), xs = a.flatMap(x => x.poly.map(p => p[0])); return { x0: Math.min(...xs), x1: Math.max(...xs), y1: Math.max(...ys) }`);
  const w = R.x1 - R.x0, y = R.y1;
  await clickMap('#map', [[R.x0 + w * 0.2, y + 2], [R.x1 - w * 0.2, y + 2], [R.x1 - w * 0.2, y + 12], [R.x0 + w * 0.2, y + 12]]);
  await js(`document.getElementById('ban-finish').click(); await new Promise(r => setTimeout(r, 300));
    document.getElementById('ae-name').value = 'Rear'; document.getElementById('ae-save').click(); await new Promise(r => setTimeout(r, 300));`);
  console.log('after drawing', await count(), 'areas:', await js(`return Store.room.areas.map(a => a.name).join(', ')`));
  // rename Centre, remove House Right
  await js(`document.getElementById('ban-cancel').click(); await new Promise(r => setTimeout(r, 200));`);
  const centreAt = await js(`const a = Store.room.areas.find(x => x.name === 'Centre'); return [a.x, a.y]`);
  await clickMap('#map', [centreAt]);
  await js(`document.getElementById('ae-name').value = 'Centre Block'; document.getElementById('ae-save').click(); await new Promise(r => setTimeout(r, 300));`);
  const rightAt = await js(`const a = Store.room.areas.find(x => x.name === 'House Right'); return [a.x, a.y]`);
  await clickMap('#map', [rightAt]);
  await js(`window.confirm = () => true; document.getElementById('ae-del').click(); await new Promise(r => setTimeout(r, 300));`);
  console.log('after rename + remove', await count(), 'areas:', await js(`return Store.room.areas.map(a => a.name).join(', ')`));
  await js(`document.getElementById('ban-done').click(); await new Promise(r => setTimeout(r, 1200));`);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'venue.json'), 'utf8'));
  console.log('venue.json areas', saved.auditorium.areas.map(a => `${a.name}(${a.points.length})`).join(', '), '· units', saved.auditorium.units, '· schema', saved.schemaVersion);
  await shot('shot-app-areas.png');
  ws.close();
}
main().catch(e => console.error('E2E FAILED:', e.message)).finally(() => { app.kill(); setTimeout(() => fs.rmSync(userData, { recursive: true, force: true }), 500); });
