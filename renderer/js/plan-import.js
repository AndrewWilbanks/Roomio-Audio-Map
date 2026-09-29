/* plan-import.js — setup step 1 for floor-plan pictures (PDF, PNG, JPEG, SVG).
   Renders the plan, lets the user box one seat, finds the rest (plan-detect.js), shows them for
   checking (add / remove, stage, scale), and turns them into a normal auditorium: seats in feet or
   metres + the plan as its background image. Everything runs in this window — PDFs are rendered by
   the bundled pdf.js (renderer/vendor/pdfjs), nothing leaves the computer (SANDBOX.md).

   PlanImport.open({name, mime?, base64? | text}, { onReady(auditorium, info), toast })  */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_PLAN_PX = 5000;        // longest side of the working picture
  const MAX_BG_PX = 3200;          // longest side of the background image saved with the venue
  const DEFAULT_PITCH = { ft: 1.75, m: 0.53 };   // typical seat spacing, 21 in centre to centre
  const SECTION_COLORS = ['#2f6fb0', '#c8324a', '#2e8b57', '#b9770e', '#7b4bb7', '#0f8a8a', '#b04f86', '#5a6f2a'];

  let S = null;        // current import: { file, canvas, pdf, page, seats, stage, box, mode, view, ... }
  let hooks = {};

  // ---------------------------------------------------------------- loading
  const isPdf = (f) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isSvg = (f) => /\.svg$/i.test(f.name) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(f.text || '');
  const isImage = (f) => /^image\//.test(f.mime || '') || /\.(png|jpe?g)$/i.test(f.name);
  function isPlanFile(f) { return !!f && (isPdf(f) || isImage(f) || isSvg(f)); }

  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('The picture could not be read.')); im.src = src; });
  }
  function toCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function fitScale(w, h, max) { return Math.min(1, max / Math.max(w, h)); }
  function paperCanvas(w, h) { const c = toCanvas(w, h), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); return c; }

  async function renderRaster(f) {
    const im = await loadImage(`data:${f.mime || 'image/png'};base64,${f.base64}`);
    const k = fitScale(im.naturalWidth, im.naturalHeight, MAX_PLAN_PX);
    const c = paperCanvas(im.naturalWidth * k, im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  }

  async function renderSvg(f) {
    const text = f.text != null ? f.text : atob(f.base64);
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('That SVG file could not be read.');
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    let w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
    if (!(w > 0 && h > 0) && vb.length === 4) { w = vb[2]; h = vb[3]; }
    if (!(w > 0 && h > 0)) { w = 1600; h = 1200; }
    // render large: plans are fine linework
    const k = MAX_PLAN_PX / Math.max(w, h);
    if (vb.length !== 4) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(Math.round(w * k)));
    svg.setAttribute('height', String(Math.round(h * k)));
    const data = new XMLSerializer().serializeToString(svg);
    const im = await loadImage('data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data))));
    const c = paperCanvas(w * k, h * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  }

  let pdfjs = null;
  async function pdfLib() {
    if (!pdfjs) {
      pdfjs = await import(new URL('vendor/pdfjs/pdf.min.mjs', location.href).href);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    }
    return pdfjs;
  }
  async function openPdf(f) {
    const lib = await pdfLib();
    const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
    return lib.getDocument({
      data: bytes, isEvalSupported: false, enableScripting: false, useSystemFonts: false,
      standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', location.href).href,
      wasmUrl: new URL('vendor/pdfjs/wasm/', location.href).href,
    }).promise;
  }
  async function renderPdfPage(pdf, n) {
    const page = await pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: MAX_PLAN_PX / Math.max(v1.width, v1.height) });
    const c = paperCanvas(vp.width, vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
    page.cleanup();
    return c;
  }

  // ---------------------------------------------------------------- open
  async function open(file, opts = {}) {
    hooks = opts;
    const panel = $('#plan');
    panel.hidden = false;
    $('#plan-file').textContent = `${file.name} · ${isPdf(file) ? 'PDF' : isSvg(file) ? 'SVG' : 'picture'} floor plan`;
    if (!$('#plan-name').dataset.typed) $('#plan-name').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');   // until the user types one
    S = { file, canvas: null, pdf: null, pageNo: 1, seats: [], stage: null, box: null, mode: 'box', view: null, measure: null, measuredUpp: null, drag: null };
    busy('Opening the plan…', 0.1);
    try {
      if (isPdf(file)) {
        S.pdf = await openPdf(file);
        const sel = $('#plan-page');
        sel.hidden = S.pdf.numPages < 2;
        sel.innerHTML = Array.from({ length: S.pdf.numPages }, (_, i) => `<option value="${i + 1}">Page ${i + 1} of ${S.pdf.numPages}</option>`).join('');
        S.canvas = await renderPdfPage(S.pdf, 1);
      } else {
        $('#plan-page').hidden = true;
        S.canvas = isSvg(file) ? await renderSvg(file) : await renderRaster(file);
      }
    } catch (e) {
      busy(null);
      panel.hidden = true;
      throw new Error(`Couldn't open ${file.name}: ${e.message || e}`);
    }
    S.pixels = null;
    busy(null);
    setMode('box');
    fitView();
    updateUi();
    panel.scrollIntoView({ block: 'nearest' });
  }
  function close() { $('#plan').hidden = true; S = null; }

  async function changePage(n) {
    busy(`Rendering page ${n}…`, 0.2);
    try { S.canvas = await renderPdfPage(S.pdf, n); S.pageNo = n; S.pixels = null; S.seats = []; S.box = null; S.stage = null; }
    finally { busy(null); }
    fitView(); updateUi();
  }

  // ---------------------------------------------------------------- detect + label
  function pixels() {
    if (!S.pixels) S.pixels = S.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S.canvas.width, S.canvas.height);
    return S.pixels;
  }
  async function find() {
    if (!S.box) return;
    busy('Finding seats…', 0);
    try {
      const r = await PlanDetect.detectSeats(pixels(), S.box, { sensitivity: +$('#plan-sens').value, onProgress: (p) => busy('Finding seats…', p) });
      if (r.error) { hooks.toast && hooks.toast(r.error); S.seats = []; }
      else S.seats = r.seats.map(s => ({ x: s.x, y: s.y }));
      S.stage = null;                         // re-guess for the new set
      relabel();
    } finally { busy(null); }
    if (S.seats.length) setMode('edit');
    updateUi();
    if (S.seats.length === 1) hooks.toast && hooks.toast('Only the sample matched — try a higher sensitivity, or box the seat more tightly.');
  }
  function relabel() {
    if (!S.seats.length) { S.labels = null; return; }
    const L = PlanDetect.labelSeats(S.seats, S.stage);
    S.labels = L.seats; S.pitchPx = L.pitch;
    if (!S.stage) S.stage = L.stage;
  }

  // units per picture pixel: measured, else from the seat spacing field
  function unitsPerPx() {
    if (S.measuredUpp) return S.measuredUpp;
    const pitch = parseFloat($('#plan-pitch').value);
    return S.pitchPx && pitch > 0 ? pitch / S.pitchPx : null;
  }

  // ---------------------------------------------------------------- build the auditorium
  function backgroundImage() {
    const k = fitScale(S.canvas.width, S.canvas.height, MAX_BG_PX);
    const c = toCanvas(S.canvas.width * k, S.canvas.height * k);
    c.getContext('2d').drawImage(S.canvas, 0, 0, c.width, c.height);
    let url = c.toDataURL('image/png');
    if (isImage(S.file) && /jpe?g/i.test(S.file.mime || S.file.name) || url.length > 10e6) url = c.toDataURL('image/jpeg', 0.85);   // photos/scans: JPEG
    return url;
  }
  function build() {
    const upp = unitsPerPx();
    if (!upp) throw new Error('Set the seat spacing (or Measure a distance) first.');
    const units = $('#plan-units').value;
    const r = (v) => Math.round(v * upp * 1000) / 1000;
    const seats = S.labels.map(l => ({ id: l.id, section: l.section, row: l.row, seat: l.seat, x: r(l.x), y: r(l.y) }));
    return {
      format: Auditorium.FORMAT, schemaVersion: Auditorium.SCHEMA_VERSION,
      name: $('#plan-name').value.trim() || 'Imported room', units, yAxis: 'down',
      stage: S.stage ? { x: r(S.stage.x), y: r(S.stage.y), label: 'Stage' } : undefined,
      seats,
      background: { image: backgroundImage(), x: 0, y: 0, width: r(S.canvas.width), height: r(S.canvas.height), opacity: 0.9 },
    };
  }

  // ---------------------------------------------------------------- view (pan / zoom)
  const cv = () => $('#plan-canvas');
  function fitView() {
    const el = cv(), w = el.clientWidth || 800, h = el.clientHeight || 500;
    const k = Math.min(w / S.canvas.width, h / S.canvas.height) * 0.96;
    S.view = { k, x: (w - S.canvas.width * k) / 2, y: (h - S.canvas.height * k) / 2 };
    draw();
  }
  function zoomAt(f, px, py) {
    const v = S.view; const el = cv();
    if (px == null) { px = el.clientWidth / 2; py = el.clientHeight / 2; }
    const k = Math.max(0.02, Math.min(40, v.k * f));
    v.x = px - (px - v.x) * (k / v.k); v.y = py - (py - v.y) * (k / v.k); v.k = k;
    draw();
  }
  const toPlan = (e) => { const b = cv().getBoundingClientRect(); return { x: (e.clientX - b.left - S.view.x) / S.view.k, y: (e.clientY - b.top - S.view.y) / S.view.k, sx: e.clientX - b.left, sy: e.clientY - b.top }; };

  function draw() {
    if (!S || !S.view) return;
    const el = cv(), dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
    const g = el.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f3f1ea'; g.fillRect(0, 0, w, h);
    const v = S.view;
    g.save(); g.translate(v.x, v.y); g.scale(v.k, v.k);
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.canvas, 0, 0);
    g.restore();
    const P = (p) => [v.x + p.x * v.k, v.y + p.y * v.k];
    // seats
    const rDot = Math.max(2.5, Math.min(9, (S.pitchPx || 20) * v.k * 0.28));
    const secIdx = new Map();
    (S.labels || S.seats).forEach((s) => {
      const sec = s.section || '';
      if (!secIdx.has(sec)) secIdx.set(sec, secIdx.size);
      const [x, y] = P(s);
      g.beginPath(); g.arc(x, y, rDot, 0, Math.PI * 2);
      g.fillStyle = SECTION_COLORS[secIdx.get(sec) % SECTION_COLORS.length];
      g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
      g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    });
    // section letters at their centres (when zoomed out enough to need them)
    if (S.labels && S.labels.length) {
      const acc = new Map();
      S.labels.forEach(l => { const a = acc.get(l.section) || { x: 0, y: 0, n: 0 }; a.x += l.x; a.y += l.y; a.n++; acc.set(l.section, a); });
      g.font = '800 13px Montserrat, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const [sec, a] of acc) {
        const [x, y] = P({ x: a.x / a.n, y: a.y / a.n });
        g.lineWidth = 4; g.strokeStyle = '#fff'; g.strokeText(sec, x, y); g.fillStyle = '#10151c'; g.fillText(sec, x, y);
      }
    }
    // stage
    if (S.stage) {
      const [x, y] = P(S.stage);
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fillStyle = '#10151c'; g.fill();
      g.font = '800 11px Montserrat, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
      g.lineWidth = 4; g.strokeStyle = '#fff'; g.strokeText('STAGE', x, y + 12); g.fillStyle = '#10151c'; g.fillText('STAGE', x, y + 12);
    }
    // sample box / box being drawn
    const box = S.drag && S.drag.kind === 'box' ? S.drag.rect : S.box;
    if (box) {
      const [x, y] = P(box);
      g.setLineDash([5, 4]); g.lineWidth = 2; g.strokeStyle = '#c8324a';
      g.strokeRect(x, y, box.w * v.k, box.h * v.k); g.setLineDash([]);
    }
    // measuring line
    if (S.measure && S.measure.a) {
      const [ax, ay] = P(S.measure.a), [bx, by] = P(S.measure.b || S.measure.hover || S.measure.a);
      g.lineWidth = 2.5; g.strokeStyle = '#b9770e';
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      for (const [x, y] of [[ax, ay], [bx, by]]) { g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fillStyle = '#b9770e'; g.fill(); }
    }
  }

  // ---------------------------------------------------------------- interaction
  function setMode(m) {
    S.mode = m;
    if (m !== 'measure') { S.measure = null; $('#plan-measure').hidden = true; }
    document.querySelectorAll('#plan-modes [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#plan-view').className = 'plan-view mode-' + m;
    draw();
  }
  function nearestSeat(p, maxPx) {
    let best = -1, bd = maxPx / S.view.k;
    S.seats.forEach((s, i) => { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function onDown(e) {
    if (!S || e.button > 0) return;
    const p = toPlan(e);
    try { cv().setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers */ }
    const pan = e.button === 1 || e.altKey || e.metaKey || e.shiftKey && S.mode !== 'box';
    S.drag = { start: p, moved: false, kind: pan ? 'pan' : S.mode === 'box' ? 'box' : 'click', view: { ...S.view } };
  }
  function onMove(e) {
    if (!S) return;
    const p = toPlan(e);
    if (S.measure && S.measure.a && !S.measure.b) { S.measure.hover = p; draw(); }
    const d = S.drag; if (!d) return;
    if (Math.hypot(p.sx - d.start.sx, p.sy - d.start.sy) > 4) d.moved = true;
    if (d.kind === 'box') {
      d.rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
      draw();
    } else if (d.moved && (d.kind === 'pan' || d.kind === 'click')) {        // dragging the plan pans in every mode
      d.kind = 'pan';
      $('#plan-view').classList.add('panning');
      S.view.x = d.view.x + (p.sx - d.start.sx); S.view.y = d.view.y + (p.sy - d.start.sy);
      draw();
    }
  }
  function onUp(e) {
    if (!S || !S.drag) return;
    const d = S.drag, p = toPlan(e);
    S.drag = null;
    $('#plan-view').classList.remove('panning');
    if (d.kind === 'box') {
      const r = d.rect;
      if (r && r.w * S.view.k >= 6 && r.h * S.view.k >= 6) { S.box = r; updateUi(); find(); }
      else { draw(); hooks.toast && hooks.toast('Drag a box around one seat'); }
      return;
    }
    if (d.kind !== 'click' || d.moved) return;
    if (S.mode === 'edit') {
      const i = nearestSeat(p, 10);
      if (i >= 0) S.seats.splice(i, 1);
      else S.seats.push({ x: p.x, y: p.y });
      relabel(); updateUi();
    } else if (S.mode === 'stage') {
      S.stage = { x: p.x, y: p.y }; relabel(); setMode('edit'); updateUi();
      hooks.toast && hooks.toast('Stage placed — rows now count out from it');
    } else if (S.mode === 'measure') {
      if (!S.measure || S.measure.b) S.measure = { a: p };
      else {
        S.measure.b = p;
        const f = $('#plan-measure'); f.hidden = false;
        f.querySelector('.plan-unit').textContent = $('#plan-units').value === 'm' ? 'metres' : 'feet';
        $('#plan-dist').value = ''; $('#plan-dist').focus();
      }
      draw();
    }
  }

  // ---------------------------------------------------------------- UI state
  let busyOn = false;
  function busy(text, p) {
    const el = $('#plan-busy');
    busyOn = !!text;
    el.hidden = !text;
    if (text) { $('#plan-busy-t').textContent = text; $('#plan-bar').style.width = `${Math.round((p || 0) * 100)}%`; }
    ['#plan-find', '#plan-use', '#plan-clear'].forEach(id => { if (text) $(id).disabled = true; });
    if (!text && S) updateUi();
  }
  function updateUi() {
    if (!S) return;
    const n = S.seats.length, upp = unitsPerPx(), units = $('#plan-units').value;
    $('#plan-count').textContent = n ? `${n} seat${n === 1 ? '' : 's'}` : '';
    if (!busyOn) {
      $('#plan-find').disabled = !S.box;
      $('#plan-clear').disabled = !n && !S.box;
      $('#plan-use').disabled = !n || !upp;
    }
    const secs = S.labels ? new Set(S.labels.map(l => l.section)).size : 0;
    const rows = S.labels ? new Set(S.labels.map(l => l.section + '|' + l.row)).size : 0;
    if (upp && S.canvas) {
      const W = S.canvas.width * upp, H = S.canvas.height * upp;
      $('#plan-scale-note').textContent = `${S.measuredUpp ? 'Measured' : 'From seat spacing'}: plan is ${W.toFixed(0)} × ${H.toFixed(0)} ${units}`;
    } else $('#plan-scale-note').textContent = '';
    $('#plan-summary').textContent = n ? `${secs} section${secs === 1 ? '' : 's'} · ${rows} rows. Sections run A, B, C… from the audience's left; row 1 is nearest the stage.` : '';
    const g = { box: !!S.box, fix: n > 0, scale: n > 0 && (!!S.measuredUpp || !!$('#plan-pitch').dataset.typed) };
    const now = !g.box ? 'box' : !g.fix ? 'box' : 'fix';
    document.querySelectorAll('.plan-guide li').forEach(li => { li.classList.toggle('done', !!g[li.dataset.g] && li.dataset.g !== 'fix'); li.classList.toggle('now', li.dataset.g === now); });
    draw();
  }

  function onUnits() {
    const u = $('#plan-units').value, prev = $('#plan-units').dataset.prev || 'ft';
    if (u !== prev) {
      const k = u === 'm' ? 0.3048 : 1 / 0.3048;
      const p = parseFloat($('#plan-pitch').value);
      if (p > 0) $('#plan-pitch').value = +(p * k).toFixed(3);
      if (S && S.measuredUpp) S.measuredUpp *= k;
    }
    $('#plan-units').dataset.prev = u;
    updateUi();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('#plan')) return;
    $('#plan-pitch').value = DEFAULT_PITCH.ft;
    $('#plan-units').dataset.prev = 'ft';
    const el = cv();
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', () => { if (S) { S.drag = null; draw(); } });
    el.addEventListener('wheel', (e) => { if (!S) return; e.preventDefault(); const p = toPlan(e); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), p.sx, p.sy); }, { passive: false });
    new ResizeObserver(() => draw()).observe($('#plan-view'));
    document.querySelectorAll('#plan-modes [data-mode]').forEach(b => b.onclick = () => S && setMode(b.dataset.mode));
    $('#plan-zin').onclick = () => S && zoomAt(1.4);
    $('#plan-zout').onclick = () => S && zoomAt(1 / 1.4);
    $('#plan-zfit').onclick = () => S && fitView();
    $('#plan-find').onclick = () => S && find();
    $('#plan-sens').onchange = () => { if (S && S.box) find(); };
    $('#plan-clear').onclick = () => { if (!S) return; S.seats = []; S.labels = null; S.box = null; S.stage = null; setMode('box'); updateUi(); };
    $('#plan-page').onchange = (e) => S && changePage(+e.target.value);
    $('#plan-units').onchange = onUnits;
    $('#plan-pitch').oninput = () => { $('#plan-pitch').dataset.typed = '1'; if (S) { S.measuredUpp = null; updateUi(); } };
    $('#plan-name').oninput = () => { $('#plan-name').dataset.typed = '1'; };
    $('#plan-measure').onsubmit = (e) => {
      e.preventDefault();
      const d = parseFloat($('#plan-dist').value), m = S && S.measure;
      if (!(d > 0) || !m || !m.b) return;
      const px = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
      if (px < 2) { hooks.toast && hooks.toast('Pick two points further apart'); return; }
      S.measuredUpp = d / px;
      if (S.pitchPx) $('#plan-pitch').value = +(S.pitchPx * S.measuredUpp).toFixed(3);
      setMode(S.seats.length ? 'edit' : 'box'); updateUi();
      hooks.toast && hooks.toast('Scale set');
    };
    $('#plan-measure-x').onclick = () => S && setMode(S.seats.length ? 'edit' : 'box');
    $('#plan-use').onclick = () => {
      if (!S || !S.labels) return;
      let a;
      try { a = build(); } catch (e) { hooks.toast && hooks.toast(e.message); return; }
      hooks.onReady && hooks.onReady(a, { seats: a.seats.length });
    };
    document.addEventListener('keydown', (e) => {
      if (!S || $('#plan').hidden || /input|select|textarea/i.test(document.activeElement && document.activeElement.tagName)) return;
      if (e.key === 'Escape' && S.mode === 'measure') setMode(S.seats.length ? 'edit' : 'box');
    });
  });

  window.PlanImport = { isPlanFile, open, close, get active() { return !!S; }, _state: () => S };
})();
