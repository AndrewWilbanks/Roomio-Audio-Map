/* map.js — seat map: background drawing, seats, booth marker, pan/zoom.
   Coordinates are the drawing's own units (viewBox of the source SVG). */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  // Everything is sized from the venue's seat pitch (typical distance between neighbouring
  // seats), so any drawing units work: seat = 76% of pitch, tap radius = 66%, etc.
  let U = 1;                              // one "unit" = pitch / 15 (the proportions were tuned at pitch 15)
  let SEAT = 11.5;
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  let wrap, svg, vp, seatLayer, labelLayer, boothG, tooltip, room;
  let full, view;                         // [x,y,w,h]
  let seatEls = new Map();
  let seatList = [];
  let mode = 'view';                      // 'view' | 'booth' | 'edit'
  let selected = null;
  const handlers = {};

  function init(container, roomData) {
    room = roomData;
    wrap = container;
    U = (room.pitch || 15) / 15;
    SEAT = 11.5 * U;
    full = room.viewBox.slice();
    svg = el('svg', { preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Seat map' });
    svg.style.setProperty('--u', U);          // CSS sizes below scale with the venue (see styles.css)
    vp = el('g', {});
    if (room.background) {
      const b = room.background;
      const bg = el('image', { href: b.href, x: b.x, y: b.y, width: b.width, height: b.height, class: 'map-bg', preserveAspectRatio: 'none' });
      if (b.opacity != null) bg.style.opacity = b.opacity;
      vp.appendChild(bg);
    }
    if (room.stage) {
      const stage = el('text', { x: room.stage.x, y: room.stage.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'stage-label', 'font-size': 16 * U });
      stage.textContent = (room.stage.label || 'Stage').toUpperCase();
      vp.appendChild(stage);
    }
    labelLayer = el('g', {});
    seatLayer = el('g', {});
    boothG = el('g', { class: 'booth-marker' });
    boothG.appendChild(el('circle', { r: 28 * U, class: 'booth-ring', 'stroke-width': 1.2 * U }));
    boothG.appendChild(el('rect', { x: -17 * U, y: -10 * U, width: 34 * U, height: 20 * U, rx: 5 * U, 'stroke-width': 1.6 * U }));
    const t = el('text', { x: 0, y: 3.4 * U, 'text-anchor': 'middle', 'font-size': 9 * U }); t.textContent = 'FOH';
    boothG.appendChild(t);
    vp.append(labelLayer, seatLayer, boothG);
    svg.appendChild(vp);
    wrap.appendChild(svg);
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    wrap.appendChild(tooltip);
    view = full.slice();
    applyView();
    bindPanZoom();
  }

  function setSeats(seats) {
    seatLayer.innerHTML = '';
    seatEls = new Map();
    seatList = seats;
    for (const s of seats) {
      const r = el('rect', {
        x: -SEAT / 2, y: -SEAT / 2, width: SEAT, height: SEAT, rx: 2.6 * U, 'stroke-width': 0.6 * U,
        transform: `translate(${s.x} ${s.y}) rotate(${s.rot || 0})`, class: 'seat empty', 'data-id': s.id,
      });
      seatLayer.appendChild(r);
      seatEls.set(s.id, r);
    }
    drawSectionLabels(seats);
    if (selected && seatEls.get(selected)) seatEls.get(selected).classList.add('sel');
  }

  function drawSectionLabels(seats) {
    labelLayer.innerHTML = '';
    const by = {};
    for (const s of seats) (by[s.section] = by[s.section] || []).push(s);
    for (const [name, list] of Object.entries(by)) {
      if (list.length < 40 && Object.keys(by).length > 1) continue;   // tiny sections are too small to label
      // label just behind the section's last row, on the side away from the stage
      const cx = list.reduce((a, s) => a + s.x, 0) / list.length;
      const cy = list.reduce((a, s) => a + s.y, 0) / list.length;
      // no stage: label below the section
      const st = room.stage || { x: cx, y: cy - 1 };
      const far = list.reduce((a, s) => Math.max(a, Math.hypot(s.x - st.x, s.y - st.y)), 0);
      const dx = cx - st.x, dy = cy - st.y, d = Math.hypot(dx, dy) || 1;
      const [vx, vy, vw, vh] = room.viewBox;
      const lx = Math.min(vx + vw - 60 * U, Math.max(vx + 60 * U, st.x + dx / d * (far + 26 * U)));
      const ly = Math.min(vy + vh - 20 * U, Math.max(vy + 20 * U, st.y + dy / d * (far + 26 * U)));
      const t = el('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'sec-label', 'font-size': 11 * U, 'stroke-width': 3 * U });
      t.textContent = name;
      labelLayer.appendChild(t);
    }
  }

  // colors: Map id -> {fill, est}
  function paint(colors) {
    for (const [id, r] of seatEls) {
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

  function setBooth(b) {
    boothG.setAttribute('transform', `translate(${b.x} ${b.y})`);
  }

  function select(id, pulse) {
    if (selected && seatEls.get(selected)) seatEls.get(selected).classList.remove('sel', 'sel-pulse');
    selected = id;
    const r = id && seatEls.get(id);
    if (r) {
      r.classList.add('sel');
      seatLayer.appendChild(r);            // draw on top
      if (pulse) { r.classList.remove('sel-pulse'); void r.getBBox(); r.classList.add('sel-pulse'); }
    }
  }

  function setMode(m) {
    mode = m;
    wrap.classList.toggle('mode-booth', m === 'booth');
    wrap.classList.toggle('mode-edit', m === 'edit');
  }

  // ---- view / pan / zoom ----
  function applyView() { svg.setAttribute('viewBox', view.map(v => v.toFixed(2)).join(' ')); }

  function toDrawing(clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  }

  function zoomAt(factor, cx, cy) {
    const minW = full[2] / 12, maxW = full[2] * 1.3;
    const w = Math.max(minW, Math.min(maxW, view[2] / factor));
    const f = w / view[2];
    view = [cx - (cx - view[0]) * f, cy - (cy - view[1]) * f, w, view[3] * f];
    applyView();
  }
  function zoomBy(factor) { zoomAt(factor, view[0] + view[2] / 2, view[1] + view[3] / 2); }
  function fit() { view = full.slice(); applyView(); }
  function centerOn(x, y) {
    if (view[2] > full[2] / 2.2) { const w = full[2] / 2.6, h = full[3] / 2.6; view = [x - w / 2, y - h / 2, w, h]; }
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
    let drag = null, pinch = null, moved = false;
    svg.addEventListener('pointerdown', (e) => {
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic/ended pointer */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
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
      hover(e);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      wrap.classList.remove('dragging');
      if (pointers.size < 2) pinch = null;
      if (drag && !moved && e.type === 'pointerup') click(e);
      if (pointers.size === 0) drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', hideTip);
  }

  // Seats are small when zoomed out, so a tap snaps to the nearest seat within `reach` units.
  function seatFromEvent(e, reach = 10) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (t && t.classList && t.classList.contains('seat')) return t.getAttribute('data-id');
    const p = toDrawing(e.clientX, e.clientY);
    const unitsPerPx = Math.max(view[2] / svg.clientWidth, view[3] / svg.clientHeight);
    let best = null, bd = Math.max(reach * U, (mode === 'edit' ? 6 : 14) * unitsPerPx);   // min tap radius in screen px
    for (const s of seatList) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }
  function click(e) {
    const p = toDrawing(e.clientX, e.clientY);
    const onBooth = e.target.closest && e.target.closest('.booth-marker');
    const id = onBooth ? null : seatFromEvent(e, mode === 'edit' ? 6 : 10);
    if (mode === 'booth') { emit('boothPlaced', p); return; }
    if (onBooth && !id) { emit('boothClick'); return; }
    if (id) emit('seatClick', { id, point: p });
    else emit('emptyClick', p);
  }
  function hover(e) {
    const id = seatFromEvent(e);
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

  window.SeatMap = { init, setSeats, paint, setBooth, select, setMode, zoomBy, fit, centerOn, on, hideTip };
})();
