/* map.js — room map: background drawing, areas (coloured outlines), booth marker, pan/zoom,
   and drawing new areas by clicking their corners. Coordinates are the room's own units. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  // Marker and text sizes follow the venue's typical area size (room.pitch = 15% of it), so any
  // drawing units work. One "unit" = pitch / 15 (the proportions were tuned at pitch 15).
  let U = 1;
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const pathD = (poly, close = true) => poly.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join(' ') + (close ? ' Z' : '');

  let wrap, svg, vp, areaLayer, labelLayer, drawLayer, guideLayer, stageEl, boothG, tooltip, room;
  let full, view;                         // [x,y,w,h]
  let areaEls = new Map();
  let areaList = [];
  let mode = 'view';                      // 'view' | 'booth' | 'edit' | 'draw' | 'pick' | 'boothSize'
  let booth = null;                       // {x, y, w?, d?} as last set
  let selected = null;
  let drawing = [];                       // corners of the area being drawn
  let hoverPt = null;
  const handlers = {};

  function init(container, roomData) {
    room = roomData;
    wrap = container;
    U = (room.pitch || 15) / 15;
    full = room.viewBox.slice();
    [...wrap.querySelectorAll('svg.room-map, .tooltip')].forEach(n => n.remove());
    svg = el('svg', { preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Room map', class: 'room-map' + (room.background ? ' has-bg' : '') });
    svg.style.setProperty('--u', U);          // CSS sizes below scale with the venue (see styles.css)
    vp = el('g', {});
    if (room.background) {
      const b = room.background;
      const bg = el('image', { href: b.href, x: b.x, y: b.y, width: b.width, height: b.height, class: 'map-bg', preserveAspectRatio: 'none' });
      if (b.opacity != null) bg.style.opacity = b.opacity;
      vp.appendChild(bg);
    }
    areaLayer = el('g', {});
    labelLayer = el('g', { class: 'area-labels' });
    stageEl = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'stage-label', 'font-size': 16 * U });
    guideLayer = el('g', { class: 'map-guide' });
    drawLayer = el('g', { class: 'draw-layer' });
    boothG = el('g', { class: 'booth-marker' });
    boothG.appendChild(el('circle', { r: 28 * U, class: 'booth-ring', 'stroke-width': 1.2 * U }));
    boothG.appendChild(el('rect', { 'stroke-width': 1.6 * U }));
    const t = el('text', { x: 0, 'text-anchor': 'middle', 'dominant-baseline': 'central' }); t.textContent = 'FOH';
    boothG.appendChild(t);
    // boothSize mode: drag the corner handle to resize (about the centre), the body to move
    boothG.appendChild(el('circle', { class: 'booth-handle', r: 1 }));
    vp.append(areaLayer, labelLayer, stageEl, guideLayer, drawLayer, boothG);
    svg.appendChild(vp);
    wrap.appendChild(svg);
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    wrap.appendChild(tooltip);
    setStage(room.stage);
    view = full.slice();
    drawing = [];
    applyView();
    bindPanZoom();
  }

  function setStage(st) {
    stageEl.style.display = st ? '' : 'none';
    if (!st) return;
    stageEl.setAttribute('x', st.x); stageEl.setAttribute('y', st.y);
    stageEl.textContent = (st.label || 'Stage').toUpperCase();
  }

  function setAreas(areas) {
    areaLayer.innerHTML = ''; labelLayer.innerHTML = '';
    areaEls = new Map();
    areaList = areas;
    for (const a of areas) {
      const p = el('path', { d: pathD(a.poly), class: 'area empty', 'data-id': a.id, 'stroke-width': 1.2 * U });
      areaLayer.appendChild(p);
      areaEls.set(a.id, p);
      // name, sized to fit inside the area (by its width and the length of the name)
      const xs = a.poly.map(q => q[0]), w = Math.max(...xs) - Math.min(...xs);
      const fs = Math.max(5 * U, Math.min(a.size * 0.16, 0.8 * w / (0.62 * Math.max(4, a.name.length)), 26 * U));
      const t = el('text', { x: a.x, y: a.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'area-label', 'font-size': fs, 'stroke-width': fs * 0.28 });
      t.textContent = a.name;
      labelLayer.appendChild(t);
    }
    if (selected && areaEls.get(selected)) areaEls.get(selected).classList.add('sel');
  }

  // colors: Map id -> {fill, est}
  function paint(colors) {
    for (const [id, r] of areaEls) {
      const c = colors.get(id);
      if (c) {
        r.setAttribute('fill', c.fill);
        r.classList.remove('empty');
        r.classList.toggle('est', !!c.est);
      } else {
        r.removeAttribute('fill');
        r.classList.add('empty');
        r.classList.remove('est');
      }
    }
  }

  // b = {x, y, w?, d?} — with a width and depth the booth is drawn at its real size (room units),
  // otherwise as a standard marker
  function setBooth(b) {
    booth = b ? { ...b } : null;
    boothG.style.display = b ? '' : 'none';
    if (!b) return;
    boothG.setAttribute('transform', `translate(${b.x} ${b.y})`);
    const sized = b.w > 0 && b.d > 0;
    const w = sized ? b.w : 34 * U, d = sized ? b.d : 20 * U;
    const r = boothG.querySelector('rect'), t = boothG.querySelector('text');
    r.setAttribute('x', -w / 2); r.setAttribute('y', -d / 2); r.setAttribute('width', w); r.setAttribute('height', d);
    r.setAttribute('rx', Math.min(5 * U, w * 0.15, d * 0.15));
    boothG.querySelector('.booth-ring').style.display = sized ? 'none' : '';
    t.style.fontSize = `${sized ? Math.max(U * 2, Math.min(9 * U, w * 0.28, d * 0.6)) : 9 * U}px`;
    t.setAttribute('y', 0);
    placeHandle();
  }
  const boothSize = () => booth && booth.w > 0 && booth.d > 0 ? { w: booth.w, d: booth.d } : { w: 34 * U, d: 20 * U };
  function placeHandle() {
    const h = boothG.querySelector('.booth-handle');
    if (!h || !booth) return;
    const { w, d } = boothSize(), upx = unitsPerPx();
    h.setAttribute('cx', w / 2); h.setAttribute('cy', d / 2);
    h.setAttribute('r', 7 * upx); h.setAttribute('stroke-width', 2 * upx);
    h.style.display = mode === 'boothSize' ? '' : 'none';
  }

  function select(id, pulse) {
    if (selected && areaEls.get(selected)) areaEls.get(selected).classList.remove('sel', 'sel-pulse');
    selected = id;
    const r = id && areaEls.get(id);
    if (r) {
      r.classList.add('sel');
      areaLayer.appendChild(r);            // outline on top of its neighbours
      if (pulse) { r.classList.remove('sel-pulse'); void r.getBBox(); r.classList.add('sel-pulse'); }
    }
  }

  function setMode(m) {
    if (mode === 'draw' && m !== 'draw') cancelDraw();
    mode = m;
    wrap.classList.toggle('mode-booth', m === 'booth' || m === 'pick');
    wrap.classList.toggle('mode-edit', m === 'edit');
    wrap.classList.toggle('mode-draw', m === 'draw');
    wrap.classList.toggle('mode-boothsize', m === 'boothSize');
    placeHandle();
  }

  // a line or points drawn over the map (setup's Measure tool). pts = [[x,y], ...] or null
  function setGuide(pts) {
    guideLayer.innerHTML = '';
    if (!pts || !pts.length) return;
    if (pts.length > 1) guideLayer.appendChild(el('path', { d: pathD(pts, false), 'stroke-width': 2.2 * U, fill: 'none' }));
    for (const [x, y] of pts) guideLayer.appendChild(el('circle', { cx: x, cy: y, r: 3.5 * U }));
  }

  // ---- drawing an area: click corners; click the first corner (or double-click / Enter) to close
  function renderDraw() {
    drawLayer.innerHTML = '';
    if (!drawing.length) return;
    const pts = hoverPt ? drawing.concat([hoverPt]) : drawing;
    if (pts.length >= 3) drawLayer.appendChild(el('path', { d: pathD(pts), class: 'draw-fill' }));
    drawLayer.appendChild(el('path', { d: pathD(pts, false), class: 'draw-line', 'stroke-width': 1.8 * U, fill: 'none' }));
    const upx = unitsPerPx();                          // corner markers stay a steady size on screen
    drawing.forEach(([x, y], i) => drawLayer.appendChild(el('circle', { cx: x, cy: y, r: (i === 0 ? 7 : 4.5) * upx, 'stroke-width': 1.5 * upx, class: i === 0 ? 'draw-start' : 'draw-pt' })));
    drawLayer.querySelectorAll('.draw-line').forEach(l => l.setAttribute('stroke-width', 2 * upx));
  }
  function unitsPerPx() { return Math.max(view[2] / (svg.clientWidth || 1), view[3] / (svg.clientHeight || 1)); }
  function finishDraw() {
    if (drawing.length < 3) { emit('drawHint', 'An area needs at least 3 corners'); return; }
    const pts = drawing.slice();
    drawing = []; hoverPt = null; renderDraw();
    emit('areaDrawn', pts);
  }
  function cancelDraw() { drawing = []; hoverPt = null; if (drawLayer) renderDraw(); emit('drawChange', 0); }
  function undoCorner() { drawing.pop(); renderDraw(); emit('drawChange', drawing.length); }
  document.addEventListener('keydown', (e) => {
    if (mode !== 'draw' || !drawing.length || /input|textarea|select/i.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'Enter') { e.preventDefault(); finishDraw(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoCorner(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDraw(); }
  }, true);

  // ---- view / pan / zoom ----
  function applyView() { svg.setAttribute('viewBox', view.map(v => v.toFixed(3)).join(' ')); if (mode === 'draw') renderDraw(); if (mode === 'boothSize') placeHandle(); }

  function toDrawing(clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }

  function zoomAt(factor, cx, cy) {
    const minW = full[2] / 40, maxW = full[2] * 1.3;
    const w = Math.max(minW, Math.min(maxW, view[2] / factor));
    const f = w / view[2];
    view = [cx - (cx - view[0]) * f, cy - (cy - view[1]) * f, w, view[3] * f];
    applyView();
  }
  // the room's extent changed (an area added or redrawn): new zoom limits, same view
  function setBounds(vb) { full = vb.slice(); }
  function zoomBy(factor) { zoomAt(factor, view[0] + view[2] / 2, view[1] + view[3] / 2); }
  function fit() { view = full.slice(); applyView(); }
  function centerOn(x, y) {
    if (view[2] > full[2] / 1.6) { const w = full[2] / 1.8, h = full[3] / 1.8; view = [x - w / 2, y - h / 2, w, h]; }
    else view = [x - view[2] / 2, y - view[3] / 2, view[2], view[3]];
    applyView();
  }

  function bindPanZoom() {
    if (wrap.dataset.wheelBound) return bindPointer();   // re-init on the same container: wheel is already bound
    wrap.dataset.wheelBound = '1';
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = toDrawing(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), p.x, p.y);
    }, { passive: false });
    bindPointer();
  }

  function bindPointer() {
    const pointers = new Map();
    let drag = null, pinch = null, moved = false, lastUp = 0;
    svg.addEventListener('pointerdown', (e) => {
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic/ended pointer */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (mode === 'boothSize' && pointers.size === 1 && booth && e.target.closest && e.target.closest('.booth-marker')) {
        drag = { booth: e.target.classList.contains('booth-handle') ? 'size' : 'move', start: toDrawing(e.clientX, e.clientY), b: { ...booth, ...boothSize() }, x: e.clientX, y: e.clientY };
        return;
      }
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, view: view.slice() };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: view.slice(), mid: toDrawing((a.x + b.x) / 2, (a.y + b.y) / 2) };
        drag = null;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        view = pinch.view.slice(); zoomAt(d / pinch.d, pinch.mid.x, pinch.mid.y);
        moved = true;
        return;
      }
      if (drag && drag.booth) {
        const p = toDrawing(e.clientX, e.clientY), b = drag.b;
        const nb = drag.booth === 'size'
          ? { ...b, w: Math.max(4 * U, 2 * Math.abs(p.x - b.x)), d: Math.max(3 * U, 2 * Math.abs(p.y - b.y)) }   // about the centre (the mic)
          : { ...b, x: b.x + p.x - drag.start.x, y: b.y + p.y - drag.start.y };
        moved = true; setBooth(nb); emit('boothChange', nb);
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; wrap.classList.add('dragging'); hideTip(); }
        if (moved) {
          const k = drag.view[2] / svg.clientWidth, k2 = drag.view[3] / svg.clientHeight, s = Math.max(k, k2);
          view = [drag.view[0] - dx * s, drag.view[1] - dy * s, drag.view[2], drag.view[3]];
          applyView();
        }
        return;
      }
      if (mode === 'draw') { if (drawing.length) { const p = toDrawing(e.clientX, e.clientY); hoverPt = [p.x, p.y]; renderDraw(); } return; }
      hover(e);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      wrap.classList.remove('dragging');
      if (pointers.size < 2) pinch = null;
      if (drag && drag.booth) { if (moved) emit('boothChanged', { ...booth }); drag = null; return; }
      if (drag && !moved && e.type === 'pointerup') {
        const dbl = e.timeStamp - lastUp < 350; lastUp = e.timeStamp;
        click(e, dbl);
      }
      if (pointers.size === 0) drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { hideTip(); if (hoverPt) { hoverPt = null; renderDraw(); } });
  }

  function areaAt(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const hit = t && t.closest && t.closest('.area');
    if (hit && svg.contains(hit)) return hit.getAttribute('data-id');
    const p = toDrawing(e.clientX, e.clientY);
    for (let i = areaList.length - 1; i >= 0; i--) if (Auditorium.pointInPolygon(p.x, p.y, areaList[i].poly)) return areaList[i].id;
    return null;
  }
  function click(e, dbl) {
    const p = toDrawing(e.clientX, e.clientY);
    if (mode === 'draw') {
      if (dbl && drawing.length >= 3) { finishDraw(); return; }
      if (drawing.length >= 3) {                          // clicking the first corner closes the shape
        const [x0, y0] = drawing[0];
        const upx = Math.max(view[2] / svg.clientWidth, view[3] / svg.clientHeight);
        if (Math.hypot(p.x - x0, p.y - y0) < 12 * upx) { finishDraw(); return; }
      }
      drawing.push([p.x, p.y]); renderDraw(); emit('drawChange', drawing.length);
      return;
    }
    if (mode === 'pick') { emit('pick', p); return; }
    if (mode === 'booth') { emit('boothPlaced', p); return; }
    if (mode === 'boothSize') { if (!(e.target.closest && e.target.closest('.booth-marker'))) emit('boothPlaced', p); return; }   // click elsewhere: move it there
    const onBooth = e.target.closest && e.target.closest('.booth-marker');
    const id = onBooth ? null : areaAt(e);
    if (onBooth && !id) { emit('boothClick'); return; }
    if (id) emit('seatClick', { id, point: p });
    else emit('emptyClick', p);
  }
  function hover(e) {
    const id = areaAt(e);
    if (!id || !handlers.tooltip) { hideTip(); return; }
    const html = handlers.tooltip[0](id);
    if (!html) { hideTip(); return; }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const r = wrap.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 14;
    if (y + th > r.height - 8) y = e.clientY - r.top - th - 14;
    tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  }
  function hideTip() { if (tooltip) tooltip.style.display = 'none'; }

  function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }
  function emit(ev, d) { (handlers[ev] || []).forEach(fn => fn(d)); }

  window.SeatMap = { init, setAreas, setSeats: setAreas, setBounds, paint, setBooth, setStage, setGuide, select, setMode, zoomBy, fit, centerOn, on, hideTip,
    finishDraw, cancelDraw, undoCorner, get drawingCorners() { return drawing.length; } };
})();
