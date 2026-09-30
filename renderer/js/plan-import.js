/* plan-import.js — setup step 1 for floor-plan pictures (PDF, PNG, JPEG, SVG).
   Renders the plan, then the user outlines each AREA of the room by clicking its corners (the
   map's draw tool, map.js), names it, places the stage and optionally sets the scale. The result
   is a normal auditorium: the areas + the plan (cropped to them) as the map background.
   Everything runs in this window — PDFs are rendered by the bundled pdf.js
   (renderer/vendor/pdfjs); nothing leaves the computer (SANDBOX.md).

   PlanImport.open({name, mime?, base64? | text}, { onReady(auditorium), toast })  */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_PLAN_PX = 5000;        // longest side of the rendered plan
  const MAX_BG_PX = 3200;          // longest side of the background image saved with the venue
  const UNIT_NAMES = { ft: 'feet', m: 'metres', px: 'drawing units' };

  const visible = () => !!$('#plan') && $('#plan').offsetParent !== null;   // step 1 is showing
  let S = null;        // current import: { file, canvas, planUrl, pdf, pageNo, areas[], stage, tool, measure, upp, units, selected, redraw }
  let hooks = {};
  const toast = (m) => hooks.toast && hooks.toast(m);

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
    const k = MAX_PLAN_PX / Math.max(w, h);          // render large: plans are fine linework
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
    S = { file, canvas: null, pdf: null, pageNo: 1, areas: [], stage: null, tool: 'draw', measure: null, upp: null, units: 'px', selected: null, redraw: null };
    busy('Opening the plan…');
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
      panel.hidden = true; S = null;
      throw new Error(`Couldn't open ${file.name}: ${e.message || e}`);
    }
    busy(null);
    attach();
    panel.scrollIntoView({ block: 'nearest' });
  }
  function close() { $('#plan').hidden = true; S = null; }

  async function changePage(n) {
    if (S.areas.length && !confirm('Switching pages clears the areas drawn on this one. Continue?')) { $('#plan-page').value = S.pageNo; return; }
    busy(`Rendering page ${n}…`);
    try { S.canvas = await renderPdfPage(S.pdf, n); S.pageNo = n; S.areas = []; S.stage = null; S.measure = null; S.upp = null; S.units = 'px'; S.selected = null; }
    finally { busy(null); }
    attach();
  }

  // the map (map.js) shows the plan as its background; areas are drawn on it in plan pixels
  function planRoom() {
    const W = S.canvas.width, H = S.canvas.height;
    if (!S.planUrl || S.planUrl.w !== W || S.planUrl.page !== S.pageNo) S.planUrl = { url: S.canvas.toDataURL('image/png'), w: W, page: S.pageNo };
    return { name: 'plan', units: 'px', flip: 1, viewBox: [0, 0, W, H], areas: [], pitch: Math.max(W, H) / 45,
      background: { href: S.planUrl.url, x: 0, y: 0, width: W, height: H, opacity: 1 }, stage: S.stage ? { ...S.stage, label: 'Stage' } : null };
  }
  function attach() {
    if (!S) return;
    SeatMap.init($('#plan-view'), planRoom());
    SeatMap.setBooth(null);
    showAreas();
    setTool(S.tool);
  }
  const mapAreas = () => S.areas.map(a => {
    const lp = Auditorium.labelPoint(a.poly);
    return { id: a.id, name: a.name, poly: a.poly, x: lp.x, y: lp.y, size: Math.sqrt(Math.abs(Auditorium.polygonArea(a.poly))) };
  });
  function showAreas() {
    SeatMap.setAreas(mapAreas());
    SeatMap.select(S.selected);
    SeatMap.setStage(S.stage ? { ...S.stage, label: 'Stage' } : null);
    SeatMap.setGuide(S.measure ? S.measure.pts : null);
    renderList(); updateUi();
  }

  // ---------------------------------------------------------------- tools
  function setTool(t) {
    S.tool = t;
    if (t !== 'measure') { S.measure = null; $('#plan-measure').hidden = true; SeatMap.setGuide(null); }
    SeatMap.setMode(t === 'draw' ? 'draw' : t === 'stage' || t === 'measure' ? 'pick' : 'view');
    document.querySelectorAll('#plan-modes [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === t));
    updateUi();
  }
  function onAreaDrawn(pts) {
    const used = new Set(S.areas.map(a => a.id));
    const name = `Area ${S.areas.length + 1}`;
    const a = { id: Auditorium.slug(name, used), name, poly: pts };
    S.areas.push(a); S.selected = a.id;
    showAreas();
    // name it right away: type, then Enter (or just keep clicking corners for the next one)
    const inp = document.querySelector(`#plan-areas [data-name="${a.id}"]`);
    if (inp) { inp.focus(); inp.select(); }
  }
  function onPick(p) {
    if (!S || !visible()) return;
    if (S.tool === 'stage') {
      S.stage = { x: p.x, y: p.y };
      SeatMap.setStage({ ...S.stage, label: 'Stage' });
      setTool('draw'); toast('Stage placed'); return;
    }
    if (S.tool === 'measure') {
      if (!S.measure || S.measure.pts.length >= 2) S.measure = { pts: [] };
      S.measure.pts.push([p.x, p.y]);
      SeatMap.setGuide(S.measure.pts);
      if (S.measure.pts.length === 2) {
        $('#plan-measure').hidden = false;
        $('#plan-dist').value = ''; $('#plan-dist').focus();
      }
    }
  }
  function onAreaClick({ id }) {
    if (!S || !visible() || S.tool === 'draw') return;
    S.selected = id; SeatMap.select(id); renderList();
    const inp = document.querySelector(`#plan-areas [data-name="${id}"]`); if (inp) inp.focus();
  }

  function renderList() {
    const box = $('#plan-areas');
    if (!S.areas.length) { box.innerHTML = '<div class="small muted">No areas yet — click the corners of the first one on the plan.</div>'; return; }
    box.innerHTML = S.areas.map((a, i) => `<div class="plan-area ${a.id === S.selected ? 'sel' : ''}" data-id="${esc(a.id)}">
        <span class="plan-area-n">${i + 1}</span>
        <input data-name="${esc(a.id)}" value="${esc(a.name)}" aria-label="Name of area ${i + 1}">
        <button class="icon-btn" data-up="${esc(a.id)}" title="Earlier in the walk-through" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-redraw="${esc(a.id)}" title="Redraw this area">✎</button>
        <button class="icon-btn" data-del="${esc(a.id)}" title="Remove this area">✕</button></div>`).join('');
    box.querySelectorAll('[data-name]').forEach(inp => {
      inp.oninput = () => { const a = S.areas.find(x => x.id === inp.dataset.name); if (a) { a.name = inp.value; SeatMap.setAreas(mapAreas()); SeatMap.select(S.selected); } };
      inp.onfocus = () => { S.selected = inp.dataset.name; SeatMap.select(S.selected); box.querySelectorAll('.plan-area').forEach(r => r.classList.toggle('sel', r.dataset.id === S.selected)); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      inp.onblur = () => { const a = S.areas.find(x => x.id === inp.dataset.name); if (a && !a.name.trim()) { a.name = `Area ${S.areas.indexOf(a) + 1}`; inp.value = a.name; SeatMap.setAreas(mapAreas()); } };
    });
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.areas = S.areas.filter(a => a.id !== b.dataset.del); if (S.selected === b.dataset.del) S.selected = null; showAreas(); });
    box.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = S.areas.findIndex(a => a.id === b.dataset.up); if (i > 0) { [S.areas[i - 1], S.areas[i]] = [S.areas[i], S.areas[i - 1]]; showAreas(); } });
    box.querySelectorAll('[data-redraw]').forEach(b => b.onclick = () => {
      S.redraw = b.dataset.redraw; setTool('draw'); toast(`Click the new corners of ${S.areas.find(a => a.id === S.redraw).name}`);
    });
  }

  // ---------------------------------------------------------------- build the auditorium
  // the part of the plan that becomes the map background: the areas + stage, with a margin
  function cropRegion() {
    const pts = S.areas.flatMap(a => a.poly).concat(S.stage ? [[S.stage.x, S.stage.y]] : []);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    const pad = 0.08 * Math.max(x1 - x0, y1 - y0) + 10;
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(S.canvas.width, Math.ceil(x1 + pad)); y1 = Math.min(S.canvas.height, Math.ceil(y1 + pad));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function backgroundImage(r) {
    const k = fitScale(r.w, r.h, MAX_BG_PX);
    const c = toCanvas(r.w * k, r.h * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(S.canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    let url = c.toDataURL('image/png');
    if (isImage(S.file) && /jpe?g/i.test(S.file.mime || S.file.name) || url.length > 10e6) url = c.toDataURL('image/jpeg', 0.85);   // photos/scans: JPEG
    return url;
  }
  function build() {
    const upp = S.upp || 1, units = S.upp ? S.units : 'px';
    const crop = cropRegion();
    const r = (v) => Math.round(v * upp * 1000) / 1000;
    const X = (x) => r(x - crop.x), Y = (y) => r(y - crop.y);       // coordinates start at the crop's corner
    return {
      format: Auditorium.FORMAT, schemaVersion: Auditorium.SCHEMA_VERSION,
      name: $('#plan-name').value.trim() || 'Imported room', units, yAxis: 'down',
      stage: S.stage ? { x: X(S.stage.x), y: Y(S.stage.y), label: 'Stage' } : undefined,
      areas: S.areas.map(a => ({ id: a.id, name: a.name.trim() || a.id, points: a.poly.map(([x, y]) => [X(x), Y(y)]) })),
      background: { image: backgroundImage(crop), x: 0, y: 0, width: r(crop.w), height: r(crop.h), opacity: 0.8 },
    };
  }

  // ---------------------------------------------------------------- UI state
  let busyOn = false;
  function busy(text) {
    busyOn = !!text;
    $('#plan-busy').hidden = !text;
    if (text) $('#plan-busy-t').textContent = text;
    if (!text && S) updateUi();
  }
  function updateUi() {
    if (!S || !S.canvas) return;
    const n = S.areas.length;
    $('#plan-count').textContent = n ? `${n} area${n === 1 ? '' : 's'}` : '';
    if (!busyOn) $('#plan-use').disabled = !n;
    const W = S.canvas.width * (S.upp || 1), H = S.canvas.height * (S.upp || 1);
    $('#plan-scale-note').textContent = S.upp ? `Scale set: the plan is ${W.toFixed(0)} × ${H.toFixed(0)} ${UNIT_NAMES[S.units]}.` : 'No scale yet — sizes are in drawing units. Measure a known distance to work in feet or metres (optional).';
    $('#plan-hint').textContent = {
      draw: S.redraw ? 'Click the new corners of the area. Click the first corner, double-click or press Enter to finish.' : 'Click the corners of an area. Click the first corner, double-click or press Enter to finish it, then type its name. Backspace undoes a corner; drag to pan, scroll to zoom.',
      stage: 'Click the centre front of the stage.',
      measure: 'Click two points a known distance apart (a wall, the stage edge), then type the distance.',
    }[S.tool] || '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('#plan')) return;
    SeatMap.on('areaDrawn', (pts) => {
      if (!S || !visible()) return;
      if (S.redraw) {
        const a = S.areas.find(x => x.id === S.redraw); S.redraw = null;
        if (a) { a.poly = pts; S.selected = a.id; showAreas(); toast(`New outline for ${a.name}`); }
        return;
      }
      onAreaDrawn(pts);
    });
    SeatMap.on('pick', onPick);
    SeatMap.on('seatClick', onAreaClick);
    SeatMap.on('drawHint', (m) => { if (S && visible()) toast(m); });
    document.querySelectorAll('#plan-modes [data-mode]').forEach(b => b.onclick = () => { if (S) { S.redraw = null; setTool(b.dataset.mode); } });
    $('#plan-zin').onclick = () => S && SeatMap.zoomBy(1.4);
    $('#plan-zout').onclick = () => S && SeatMap.zoomBy(1 / 1.4);
    $('#plan-zfit').onclick = () => S && SeatMap.fit();
    $('#plan-page').onchange = (e) => S && changePage(+e.target.value);
    $('#plan-name').oninput = () => { $('#plan-name').dataset.typed = '1'; };
    $('#plan-measure').onsubmit = (e) => {
      e.preventDefault();
      const d = parseFloat($('#plan-dist').value), m = S && S.measure;
      if (!(d > 0) || !m || m.pts.length < 2) return;
      const px = Math.hypot(m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1]);
      if (px < 2) { toast('Pick two points further apart'); return; }
      S.upp = d / px; S.units = $('#plan-dist-unit').value;
      setTool('draw');
      toast(`Scale set: ${d} ${UNIT_NAMES[S.units]}`);
    };
    $('#plan-measure-x').onclick = () => S && setTool('draw');
    $('#plan-use').onclick = () => {
      if (!S || !S.areas.length) return;
      let a;
      try { a = build(); } catch (e) { toast(e.message); return; }
      hooks.onReady && hooks.onReady(a);
    };
  });

  window.PlanImport = { isPlanFile, open, close, attach, get active() { return !!S; }, _state: () => S };
})();
