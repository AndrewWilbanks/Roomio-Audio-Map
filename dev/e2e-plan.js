// dev/e2e-plan.js — Electron end-to-end for floor-plan import: drops each plan on setup step 1,
// drags a box around one seat like a user, and checks the seats Roomio finds against the truth.
//   node dev/make-plans.js && node dev/e2e-plan.js [dir] [real-plan.svg its-seats.json]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const DIR = process.argv[2] || path.join(os.tmpdir(), 'roomio-plans'), FH_SVG = process.argv[3], FH_SEATS = process.argv[4];
const PORT = 9336;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-e2e-plan-'));
const bin = process.env.RA_APP_BIN;
const app = spawn(bin || require('electron'), [...(bin ? [] : ['.']), `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: { ...process.env, RA_USER_DATA: userData }, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

async function main() {
  let ws;
  for (let i = 0; i < 40 && !ws; i++) { try { const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(t => t.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r)); } } catch (e) {} await sleep(250); }
  let id = 0; const pend = new Map();
  ws.on('message', m => { const j = JSON.parse(m); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async (e) => { const r = await cdp('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception.description); return r.result.result.value; };
  await sleep(2500);
  const results = [];
  const cases = ['png', 'svg', 'pdf'].map(ext => ({ name: `fan-hall.${ext}`, file: path.join(DIR, `fan-hall.${ext}`), truth: JSON.parse(fs.readFileSync(path.join(DIR, 'fan-hall.truth.json'), 'utf8')) }))
    .map(c => ({ ...c, srcW: c.truth.W, sample: c.truth.sample, size: c.truth.sz * 1.2, count: c.truth.seats, units: 'px' }));
  // the same PNG with a seating area around the centre section only (dragged like a user)
  { const t = JSON.parse(fs.readFileSync(path.join(DIR, 'fan-hall.truth.json'), 'utf8'));
    cases.push({ name: 'fan-hall.png + seating area', file: path.join(DIR, 'fan-hall.png'), srcW: t.W, sample: t.sample, size: t.sz * 1.2, count: t.centre, area: t.centreArea }); }
  if (FH_SVG) {
    const fh = JSON.parse(fs.readFileSync(FH_SEATS, 'utf8')).seats;
    const s = fh.find(q => q.id === 'C-10-8') || fh[Math.floor(fh.length / 2)];
    cases.push({ name: 'Fairhope (real CAD export)', file: FH_SVG, srcW: 1529.1, sample: s, size: 17, count: fh.length, points: fh.map(q => ({ x: q.x, y: q.y })), tol: 7 });
  }
  for (const c of cases) {
    const buf = fs.readFileSync(c.file);
    const mime = c.file.endsWith('.pdf') ? 'application/pdf' : c.file.endsWith('.png') ? 'image/png' : 'image/svg+xml';
    const t0 = Date.now();
    // drop the file on the drop zone, like dragging it from Finder
    await js(`const b = Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([b], ${JSON.stringify(path.basename(c.file))}, { type: ${JSON.stringify(mime)} }));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));`);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { ready = await js(`const s = PlanImport._state(); return !!(s && s.canvas && s.view && s.file.name === ${JSON.stringify(path.basename(c.file))}) && document.getElementById('plan-busy').hidden`); if (!ready) await sleep(200); }
    if (!ready) throw new Error(`${c.name} did not open: ${await js(`return document.getElementById('toast').textContent`)}`);
    // drag a box around the sample seat (screen coordinates from the plan view)
    const k = await js(`return PlanImport._state().canvas.width / ${c.srcW}`);
    const box = { x: (c.sample.x - c.size / 2) * k, y: (c.sample.y - c.size / 2) * k, w: c.size * k, h: c.size * k };
    await js(`const S = PlanImport._state(), cv = document.getElementById('plan-canvas'), r = cv.getBoundingClientRect();
      // zoom so the seat is at least 30 px on screen, centred
      S.view.k = Math.max(S.view.k, 30 / ${box.w}); S.view.x = r.width / 2 - ${box.x + box.w / 2} * S.view.k; S.view.y = r.height / 2 - ${box.y + box.h / 2} * S.view.k;
      const P = (x, y) => ({ clientX: r.left + S.view.x + x * S.view.k, clientY: r.top + S.view.y + y * S.view.k, pointerId: 1, bubbles: true, button: 0, isPrimary: true });
      cv.dispatchEvent(new PointerEvent('pointerdown', P(${box.x}, ${box.y})));
      cv.dispatchEvent(new PointerEvent('pointermove', P(${box.x + box.w / 2}, ${box.y + box.h / 2})));
      cv.dispatchEvent(new PointerEvent('pointermove', P(${box.x + box.w}, ${box.y + box.h})));
      cv.dispatchEvent(new PointerEvent('pointerup', P(${box.x + box.w}, ${box.y + box.h})));`);
    await sleep(300);
    for (let i = 0; i < 300; i++) { if (await js(`return document.getElementById('plan-busy').hidden`)) break; await sleep(200); }
    if (c.area) {                        // then drag the seating area; the boxed sample is searched again
      const a = { x: c.area.x * k, y: c.area.y * k, w: c.area.w * k, h: c.area.h * k };
      await js(`document.querySelector('[data-mode="area"]').click(); document.getElementById('plan-zfit').click();
        const S = PlanImport._state(), cv = document.getElementById('plan-canvas'), r = cv.getBoundingClientRect();
        const P = (x, y) => ({ clientX: r.left + S.view.x + x * S.view.k, clientY: r.top + S.view.y + y * S.view.k, pointerId: 1, bubbles: true, button: 0, isPrimary: true });
        cv.dispatchEvent(new PointerEvent('pointerdown', P(${a.x}, ${a.y})));
        cv.dispatchEvent(new PointerEvent('pointermove', P(${a.x + a.w}, ${a.y + a.h})));
        cv.dispatchEvent(new PointerEvent('pointerup', P(${a.x + a.w}, ${a.y + a.h})));`);
      await sleep(300);
      for (let i = 0; i < 300; i++) { if (await js(`return document.getElementById('plan-busy').hidden`)) break; await sleep(200); }
    }
    const found = await js(`const S = PlanImport._state(); return { seats: S.seats.map(s => ({ x: s.x, y: s.y })), labels: (S.labels || []).map(l => l.section + '|' + l.row) }`);
    const pts = found.seats.map(s => ({ x: s.x / k, y: s.y / k }));
    if (process.env.PLAN_DEBUG && c.points) {        // score distributions of true vs false hits
      const d = await js(`const S = PlanImport._state(); const img = S.canvas.getContext('2d').getImageData(0, 0, S.canvas.width, S.canvas.height);
        const r = await PlanDetect.detectSeats(img, S.box, { sensitivity: +document.getElementById('plan-sens').value, debug: true }); return r.seats.map(s => [s.x, s.y, s.score]);`);
      const q = (a) => { a.sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75, 0.95].map(p => a.length ? a[Math.floor(p * (a.length - 1))].toFixed(3) : '-').join(' / '); };
      const tp = [], fp = [];
      for (const [x, y, sc] of d) (c.points.some(t => Math.hypot(x / k - t.x, y / k - t.y) < c.tol) ? tp : fp).push(sc);
      console.log(c.name, 'TP scores p5/25/50/75/95', q(tp), ' FP', fp.length, q(fp));
      const fpd = d.filter(([x, y]) => !c.points.some(t => Math.hypot(x / k - t.x, y / k - t.y) < c.tol)).map(([x, y]) => Math.min(...c.points.map(t => Math.hypot(x / k - t.x, y / k - t.y))));
      console.log('  FP distance to nearest real seat (drawing units, pitch≈15):', q(fpd));
      const fpxy = d.filter(([x, y]) => !c.points.some(t => Math.hypot(x / k - t.x, y / k - t.y) < c.tol)).map(([x, y]) => [Math.round(x / k), Math.round(y / k)]);
      console.log('  FP sample positions:', JSON.stringify(fpxy.slice(0, 20)));
    }
    let matched = null, falseHits = null;
    const truthPts = c.points;
    if (truthPts) {
      const tol = c.tol;
      matched = truthPts.filter(q => pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) < tol)).length;
      falseHits = pts.filter(p => !truthPts.some(q => Math.hypot(p.x - q.x, p.y - q.y) < tol)).length;
    }
    const secs = new Set(found.labels.map(l => l.split('|')[0])).size, rows = new Set(found.labels).size;
    // use them
    await js(`document.getElementById('plan-use').click(); await new Promise(r => setTimeout(r, 400));`);
    const result = await js(`return document.getElementById('result').innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
    const next = await js(`return !document.getElementById('btn-next').disabled`);
    results.push({ plan: c.name, seconds: ((Date.now() - t0) / 1000).toFixed(1), found: pts.length, expected: c.count, ...(matched != null ? { matched, falseHits } : {}), sections: secs, rows, nextEnabled: next, result });
    if (c === cases[cases.length - 1] || c.name.endsWith('.pdf')) {
      await js(`document.getElementById('plan-zfit').click(); document.getElementById('plan').scrollIntoView(); await new Promise(r => setTimeout(r, 300));`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(DIR, `shot-${c.name.replace(/[^a-z0-9.]+/gi, '_')}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }
  console.log(JSON.stringify(results, null, 1));
  // continue the wizard with the last plan: the map shows the plan behind the seats
  await js(`document.getElementById('btn-next').click(); await new Promise(r => setTimeout(r, 1200));`);
  const map = await js(`return { bg: !!document.querySelector('#setup-map image'), seats: document.querySelectorAll('#setup-map .seat, #setup-map [data-seat]').length }`);
  console.log('step 2 map', JSON.stringify(map));
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(DIR, 'shot-step2.png'), Buffer.from(shot.result.data, 'base64'));
  ws.close();
}
main().catch(e => console.error('E2E FAILED:', e.message)).finally(() => { app.kill(); setTimeout(() => fs.rmSync(userData, { recursive: true, force: true }), 500); });
