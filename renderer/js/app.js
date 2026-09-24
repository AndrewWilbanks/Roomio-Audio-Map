/* app.js — Roomio: routing, panels, seat entry, Smaart + data dialogs. */
(function () {
  let ROOM = null;              // normalised auditorium from the venue profile (Store.room)
  let seats = [];               // detected seats with edits applied
  let seatById = new Map();
  let latest = new Map();       // "seat|metric" -> latest reading
  let metric = 'spl';
  let selectedId = null;
  let mapMode = 'view';
  let renderQueued = false;
  let dataVersion = 0;          // bumps whenever readings change (estimate cache key)
  let latestSp = new Map();     // seat -> latest frequency response

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = () => Store.settings;

  // ------------------------------------------------------------ boot
  async function boot() {
    syncThemeButton();
    const st = await Store.init();
    if (!st.ready) { showNoVenue(st.error); return; }
    ROOM = Store.room;
    rebuildSeats();
    if (Store.venue.demo) showDemoBanner();
    latest = Store.latest();
    latestSp = Store.latestSpectra();

    SeatMap.init($('#map'), ROOM);
    SeatMap.setSeats(seats);
    SeatMap.setBooth(S().booth);
    SeatMap.on('seatClick', ({ id }) => {
      if (mapMode === 'edit') return openSeatEditor(id);
      selectSeat(id);
      // stacked layout (phone / portrait tablet): bring the entry form into view
      if (window.innerWidth <= 1060) $('#seat-panel').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    SeatMap.on('emptyClick', (p) => { if (mapMode === 'edit') openSeatEditor(null, p); });
    SeatMap.on('boothPlaced', (p) => {
      S().booth = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
      Store.saveSettings(); SeatMap.setBooth(S().booth); setMapMode('view'); toast('Booth location saved');
    });
    SeatMap.on('boothClick', () => toast('FOH booth · use “Place booth” to move it'));
    SeatMap.on('tooltip', tooltipHtml);

    buildMetricPicker();
    Smaart.on('status', renderStatus);
    Smaart.on('values', queueRender);
    setInterval(queueRender, 2000);          // refresh live/stale badges
    if (RA.native) RA.native.onMenu(onMenuAction);           // Settings / Venue menu
    setInterval(() => { if (Smaart.status === 'connecting') renderStatus(true); }, 1000);   // retry countdown

    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if ($('.modal-overlay')) closeModal(); else if (mapMode !== 'view') setMapMode('view'); else selectSeat(null); }
    });
    route();
    renderStatus();
  }

  function showDemoBanner() {
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.innerHTML = `<b>Demo mode</b><span>Sample hall with simulated Smaart data — seats follow the live FOH level. Nothing here touches your own venue.</span>
      <button class="btn btn-sm" id="demo-exit">Exit demo</button>`;
    document.querySelector('.main').prepend(b);
    $('#demo-exit').onclick = () => onMenuAction('exit-demo');
  }

  function showNoVenue(error) {
    document.querySelector('.layout').innerHTML = `<section class="card" style="grid-column:1/-1"><div class="card-body"><div class="empty">
      <div class="t">No venue set up</div><div class="s">${error ? esc(error) + '<br>' : ''}Set up a venue to get started.</div>
      <button class="btn btn-primary" id="btn-setup" style="margin-top:14px">Set up a venue</button></div></div></section>`;
    $('#page-title').textContent = 'Welcome';
    $('#btn-setup').onclick = () => RA.native ? RA.native.openSetup() : (location.href = 'setup.html');
    window.dispatchEvent(new CustomEvent('ra:needs-setup', { detail: { error } }));
  }

  function route() {
    const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
    metric = metricById(id) ? id : 'spl';
    if (!metricById(id)) history.replaceState(null, '', '#/' + metric);
    $('#metric-select').value = metric;
    document.title = `${metricById(metric).label} · Roomio`;
    render();
  }

  function buildMetricPicker() {
    const sel = $('#metric-select');
    sel.innerHTML = METRICS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
    sel.addEventListener('change', () => { location.hash = '#/' + sel.value; });
  }

  // ------------------------------------------------------------ seats
  function rebuildSeats() {
    const ed = S().seatEdits;
    const del = new Set(ed.deleted);
    seats = ROOM.seats.filter(s => !del.has(s.id)).concat(ed.added || [])
      .map(s => ({ ...s, ...(ed.labels[s.id] || {}) }));
    seatById = new Map(seats.map(s => [s.id, s]));
    estCacheByMetric.clear();
  }
  const seatName = (s) => `${s.section} · Row ${s.row} · Seat ${s.seat}`;

  function nextSeat(s) {
    const same = seats.filter(o => o.section === s.section);
    const inRow = same.filter(o => o.row === s.row && o.seat > s.seat).sort((a, b) => a.seat - b.seat);
    if (inRow.length) return inRow[0];
    const later = same.filter(o => o.row > s.row).sort((a, b) => a.row - b.row || a.seat - b.seat);
    return later[0] || null;
  }

  // A seat is complete when every metric has real data (a reading or a frequency response)
  function seatComplete(id) { return MEASURED.every(x => latest.has(id + '|' + x.id) || latestSp.has(id)); }
  const seatOrder = () => {
    const secOrder = ROOM.sections.map(x => x.name);
    const ix = (n) => { const i = secOrder.indexOf(n); return i < 0 ? 99 : i; };
    return seats.slice().sort((a, b) => ix(a.section) - ix(b.section) || a.row - b.row || a.seat - b.seat);
  };
  function nextIncomplete(fromId) {
    const order = seatOrder();
    const start = fromId ? order.findIndex(x => x.id === fromId) + 1 : 0;
    for (let k = 0; k < order.length; k++) {
      const s = order[(start + k) % order.length];
      if (!seatComplete(s.id)) return s;
    }
    return null;
  }
  function goToSeat(s) { selectSeat(s.id, true); SeatMap.centerOn(s.x, s.y); focusEntry(); }

  // ------------------------------------------------------------ values
  // Seat-minus-FOH offset for a metric, kept current against the live FOH.
  //  - reading only:        the measured offset (moves 1:1 with the FOH level)
  //  - response only:       apply the seat's curve difference to the live FOH spectrum
  //  - reading + response:  measured offset, corrected by how the program's spectrum has
  //                         changed since capture (identical to the reading when it hasn't)
  function seatDelta(id, m, liveFOH) {
    const r = latest.get(id + '|' + m), sp = latestSp.get(id);
    if (!sp) return r ? { delta: r.delta, reading: r, src: 'reading' } : null;
    const d = subT(sp.seat_bins, sp.booth_bins);
    const mask = d.map(v => v != null);
    const viaCurve = (foh) => {
      if (!foh) return null;
      const on = mask.map((ok, i) => ok && foh[i] != null);
      const a = metricFromCurve(m, addT(foh, d), on), b = metricFromCurve(m, foh, on);
      return a == null || b == null ? null : a - b;
    };
    const now = viaCurve(liveFOH), cap = viaCurve(sp.booth_bins);
    if (r) return { delta: now != null && cap != null ? r.delta + now - cap : r.delta, reading: r, spectrum: sp, src: now != null ? 'live' : 'reading' };
    const v = now != null ? now : cap;
    return v == null ? null : { delta: v, spectrum: sp, src: now != null ? 'live' : 'response' };
  }

  // IDW neighbours depend only on which seats are measured, so cache them per data version
  const idwCache = new Map();
  function idwNeighbours(m, measuredIds) {
    const key = m + '|' + dataVersion + '|' + Store.spectra.length + '|' + seats.length;
    const hit = idwCache.get(m);
    if (hit && hit.key === key) return hit.map;
    const pts = seats.filter(s => measuredIds.has(s.id));
    const map = new Map();
    for (const s of seats) {
      if (measuredIds.has(s.id)) continue;
      const near = pts.map(p => [Math.hypot(p.x - s.x, p.y - s.y), p.id]).sort((a, b) => a[0] - b[0]).slice(0, 6);
      map.set(s.id, near.map(([dd, id]) => [id, 1 / Math.pow(Math.max(dd, 1), 2)]));
    }
    idwCache.set(m, { key, map });
    return map;
  }

  // Offsets for every seat for one metric (real, or IDW-estimated when "Fill gaps" is on)
  const estCacheByMetric = new Map();
  function estimates(m) {
    const liveFOH = Smaart.liveSpectrum('booth');
    const key = [dataVersion, Store.spectra.length, seats.length, S().ui.interpolate, Smaart.liveSpectrumTime('booth')].join('|');
    const c = estCacheByMetric.get(m);
    if (c && c.key === key) return c.map;
    const out = new Map();
    for (const s of seats) {
      const e = seatDelta(s.id, m, liveFOH);
      if (e) out.set(s.id, e);
    }
    if (S().ui.interpolate && out.size >= 3) {
      const nb = idwNeighbours(m, new Set(out.keys()));
      for (const [id, list] of nb) {
        let wsum = 0, v = 0;
        for (const [nid, w] of list) { const e = out.get(nid); if (e) { wsum += w; v += w * e.delta; } }
        if (wsum) out.set(id, { delta: v / wsum, est: true });
      }
    }
    estCacheByMetric.set(m, { key, map: out });
    return out;
  }

  // What the current page colors each seat by.
  function pageValues() {
    const m = metricById(metric);
    const basis = m.derived ? S().ui.devBasis : metric;
    const est = estimates(basis);
    const booth = Smaart.booth(basis);
    const vals = new Map();
    for (const [id, e] of est) {
      const v = m.derived ? e.delta : (booth.value != null ? booth.value + e.delta : e.delta);
      vals.set(id, { v, delta: e.delta, est: !!e.est, reading: e.reading });
    }
    return { vals, booth, basis, relative: !m.derived && booth.value == null };
  }

  // Fixed scale (default) keeps colors tied to real dB, so the map heats up / cools down
  // with the live FOH level. Auto fits the scale to whatever is on screen.
  const scaleMode = () => S().ui.scaleMode || 'fixed';
  const fixedRange = (id) => (S().ui.scaleRange || {})[id] || FIXED_RANGE[id];

  function range(pv) {
    if (scaleMode() === 'fixed' && !pv.relative) return fixedRange(metric).slice();
    const arr = [...pv.vals.values()].map(x => x.v);
    if (metricById(metric).derived) {
      const a = Math.max(3, Math.ceil(Math.max(0, ...arr.map(Math.abs))));
      return [-a, a];
    }
    if (!arr.length) return [0, 1];
    let lo = Math.floor(Math.min(...arr)), hi = Math.ceil(Math.max(...arr));
    if (hi - lo < 6) { const c = (hi + lo) / 2; lo = Math.floor(c - 3); hi = Math.ceil(c + 3); }
    return [lo, hi];
  }

  // ------------------------------------------------------------ render
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    // rAF when visible; the timer covers hidden/occluded windows (e.g. behind Smaart) so values stay live
    let done = false;
    const run = () => { if (done) return; done = true; renderQueued = false; render(); };
    requestAnimationFrame(run);
    setTimeout(run, 150);
  }

  function render() {
    if (!ROOM) return;
    const m = metricById(metric);
    const pv = pageValues();
    const [lo, hi] = range(pv);
    const stops = m.derived ? scaleDiverging() : SCALE_LEVEL;
    const colors = new Map();
    for (const [id, x] of pv.vals) colors.set(id, { fill: colorAt(stops, (x.v - lo) / (hi - lo || 1)), est: x.est });
    SeatMap.paint(colors);
    renderHead(m, pv);
    renderLegend(m, pv, lo, hi, stops);
    renderBooth();
    renderSeatPanel();
    renderSummary(m, pv);
    renderFR(m);
    renderStatus(true);
  }

  function renderHead(m, pv) {
    const unit = m.derived ? 'dB vs booth' : (pv.relative ? 'dB relative to booth' : m.unit);
    $('#page-eyebrow').textContent = `${ROOM.name} · Seat Map`;
    $('#page-title').textContent = m.label;
    let sub = esc(m.desc);
    if (m.derived) sub += ` · based on <b>${esc(metricById(pv.basis).label)}</b>`;
    else if (pv.relative) sub += ' · <b>no booth value yet</b> — showing each seat relative to FOH';
    else sub += ` · booth ${fmt(pv.booth.value)} ${esc(m.unit)}`;
    $('#page-subtitle').innerHTML = sub;
    const ui = S().ui;
    let chips = '';
    if (m.derived) {
      chips += '<span class="chip-label">Based on</span>' + MEASURED.map(x =>
        `<button class="chip ${ui.devBasis === x.id ? 'on' : ''}" data-basis="${x.id}">${esc(x.short)}</button>`).join('');
    }
    chips += `<button class="chip ${ui.interpolate ? 'on' : ''}" id="chip-interp" title="Estimate unmeasured seats from nearby measured ones">${ui.interpolate ? '✓ ' : ''}Fill gaps</button>`;
    if (!pv.relative) {
      const fr = fixedRange(metric), fixed = scaleMode() === 'fixed';
      chips += `<span class="chip-label" style="margin-left:6px">Scale</span>
        <button class="chip ${!fixed ? 'on' : ''}" data-scale="auto" title="Fit colors to the current values">Auto</button>
        <button class="chip ${fixed ? 'on' : ''}" data-scale="fixed" title="Colors tied to real dB — the map follows the live FOH level">Fixed</button>
        ${fixed ? `<span class="scale-edit"><input type="number" step="1" id="sc-lo" value="${fr[0]}" aria-label="Scale minimum">–<input type="number" step="1" id="sc-hi" value="${fr[1]}" aria-label="Scale maximum"><span class="muted small">${esc(m.derived ? 'dB' : m.unit)}</span></span>` : ''}`;
    }
    const box = $('#page-chips');
    $('#map-unit').textContent = unit;
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // typing a scale value
    box.innerHTML = chips;
    box.querySelectorAll('[data-basis]').forEach(b => b.onclick = () => { ui.devBasis = b.dataset.basis; Store.saveSettings(); render(); });
    $('#chip-interp').onclick = () => { ui.interpolate = !ui.interpolate; Store.saveSettings(); estCacheByMetric.clear(); render(); };
    box.querySelectorAll('[data-scale]').forEach(b => b.onclick = () => { ui.scaleMode = b.dataset.scale; Store.saveSettings(); render(); });
    const setRange = () => {
      const lo = +$('#sc-lo').value, hi = +$('#sc-hi').value;
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { toast('Scale max must be above min'); return; }
      ui.scaleRange = { ...(ui.scaleRange || {}), [metric]: [lo, hi] };
      Store.saveSettings(); render();
    };
    ['#sc-lo', '#sc-hi'].forEach(id => { const i = $(id); if (i) { i.onchange = setRange; i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); }; } });
  }

  function renderLegend(m, pv, lo, hi, stops) {
    const n = 5, ticks = [];
    for (let i = 0; i < n; i++) {
      const v = lo + (hi - lo) * i / (n - 1);
      ticks.push(`<span>${!pv.vals.size && !m.derived ? '' : m.derived || pv.relative ? fmtSigned(v, 0) : fmt(v, 0)}</span>`);
    }
    $('#legend').innerHTML = `
      <div class="legend-bar"><div class="legend-grad" style="background:${gradientCss(stops)}"></div><div class="legend-ticks">${ticks.join('')}</div></div>
      <div class="legend-key"><span class="legend-sw" style="background:var(--seat-empty)"></span>Not measured</div>
      ${S().ui.interpolate ? '<div class="legend-key"><span class="legend-sw" style="background:#b5d86a;opacity:.6;border-style:dashed"></span>Estimated</div>' : ''}
      <div class="legend-key" style="margin-left:auto">${pv.vals.size ? `${[...pv.vals.values()].filter(x => !x.est).length} of ${seats.length} seats measured` : 'No readings yet'}</div>`;
  }

  function sourceBadge(src) {
    return {
      live: '<span class="badge live">Live</span>',
      manual: '<span class="badge manual">Manual</span>',
      'stale-manual': '<span class="badge manual">Manual</span>',
      stale: '<span class="badge stale">Stale</span>',
      none: '<span class="badge none">—</span>',
    }[src] || '';
  }

  function renderBooth() {
    const m = metricById(metric);
    const cur = m.derived ? S().ui.devBasis : metric;
    const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#booth-tiles');
    if (editing) return;                       // don't clobber a manual value being typed
    $('#booth-tiles').innerHTML = MEASURED.map(x => {
      const b = Smaart.booth(x.id);
      return `<div class="tile ${x.id === cur ? 'cur' : ''}" data-m="${x.id}" title="Click to type a manual booth value">
        <div class="src">${sourceBadge(b.source)}</div>
        <div class="l">${esc(x.short)}</div>
        <div class="v">${fmt(b.value)}<small>${esc(x.unit)}</small></div>
      </div>`;
    }).join('');
    $('#booth-tiles').querySelectorAll('.tile').forEach(t => t.onclick = () => editManualBooth(t));
    const live = Smaart.status === 'live';
    $('#booth-note').innerHTML = live
      ? 'Live from Smaart. Manual values are used if the live feed drops.'
      : 'Smaart not connected — click a tile to type the booth reading, or connect Smaart.';
  }

  function editManualBooth(tile) {
    if (tile.querySelector('input')) return;
    const id = tile.dataset.m;
    const cur = S().manualBooth[id];
    tile.querySelector('.v').innerHTML = `<input type="number" step="0.1" inputmode="decimal" value="${cur ?? ''}" placeholder="dB">`;
    const inp = tile.querySelector('input');
    inp.focus(); inp.select();
    const done = (save) => {
      if (save) {
        const v = inp.value.trim();
        if (v === '') delete S().manualBooth[id]; else S().manualBooth[id] = +v;
        Store.saveSettings();
      }
      inp.blur(); render();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    inp.onblur = () => setTimeout(() => done(true), 0);
  }

  // ------------------------------------------------------------ seat panel
  function selectSeat(id, pulse) {
    selectedId = id && seatById.has(id) ? id : null;
    SeatMap.select(selectedId, pulse);
    renderSeatPanel(true);
  }

  let seatPanelSig = '';
  const SRC_NOTE = {
    live: 'tracking live FOH (level + spectrum)', reading: 'tracking FOH level', response: 'from frequency response',
  };
  function bigReadHtml(s) {
    const m = metricById(metric);
    const basis = m.derived ? S().ui.devBasis : metric;
    const e = estimates(basis).get(s.id);
    const b = Smaart.booth(basis);
    const bm = metricById(basis);
    let main;
    if (!e) main = `<div class="big-read"><span class="v muted">—</span><span class="u">not measured for ${esc(bm.label)}</span></div>`;
    else {
      const cls = e.delta > 0.5 ? 'up' : e.delta < -0.5 ? 'down' : 'flat';
      const rel = m.derived || b.value == null;
      main = `<div class="big-read"><span class="v">${rel ? fmtSigned(e.delta) : fmt(b.value + e.delta)}</span><span class="u">${rel ? 'dB vs booth' : bm.unit}${e.est ? ' · estimated' : ''}</span></div>
        ${rel ? '' : `<div class="delta ${cls}">${fmtSigned(e.delta)} dB vs booth${e.src ? ` <span class="muted small">· ${SRC_NOTE[e.src]}</span>` : ''}</div>`}`;
    }
    // every metric for this seat, right now
    const cells = MEASURED.map(x => {
      const ex = estimates(x.id).get(s.id), bx = Smaart.booth(x.id).value;
      const v = !ex ? '—' : bx == null ? fmtSigned(ex.delta) : fmt(bx + ex.delta);
      return `<div class="now-cell ${x.id === basis ? 'cur' : ''}"><div class="l">${esc(x.short)}</div><div class="v">${v}</div>
        <div class="d" title="Difference from FOH">${ex ? 'Δ ' + fmtSigned(ex.delta) : 'no data'}${ex && ex.est ? ' est' : ''}</div></div>`;
    }).join('');
    return `${main}<div class="section-h" style="margin:12px 0 0">Right now</div><div class="now-grid">${cells}</div>`;
  }

  // Rebuilds only when the seat, page or data changes; live numbers update in place
  // so a half-typed form (or an input you're about to tap) is never swapped out.
  function renderSeatPanel(force) {
    const box = $('#seat-panel');
    const sp0 = selectedId && latestSp.get(selectedId);
    const sig = [selectedId, metric, S().ui.devBasis, S().ui.interpolate, dataVersion, Smaart.hasSeatSource(), sp0 ? sp0.id : '', Store.spectra.length].join('|');
    if (!force && sig === seatPanelSig) {
      updateEntryPlaceholders();
      const s = seatById.get(selectedId), big = $('#seat-big');
      if (s && big) big.innerHTML = bigReadHtml(s);
      return;
    }
    seatPanelSig = sig;
    if (!selectedId) {
      box.innerHTML = `<div class="empty"><img src="assets/mascot.png" alt=""><div class="t">Pick a seat</div>
        <div class="s">Tap any seat on the map to see its readings or enter new ones.</div></div>`;
      return;
    }
    const s = seatById.get(selectedId);
    const basis = metricById(metric).derived ? S().ui.devBasis : metric;
    const big = `<div id="seat-big">${bigReadHtml(s)}</div>`;
    const seatSrc = Smaart.hasSeatSource();
    const rows = MEASURED.map(x => {
      const ph = Smaart.booth(x.id).value;
      return `<div class="m ${x.id === basis ? 'cur' : ''}">${esc(x.label)} <span class="muted small">${esc(x.unit)}</span></div>
        <input type="number" step="0.1" inputmode="decimal" data-seat="${x.id}" aria-label="${esc(x.label)} at seat">
        <input type="number" step="0.1" inputmode="decimal" data-booth="${x.id}" aria-label="${esc(x.label)} at booth" placeholder="${ph == null ? '' : fmt(ph)}">`;
    }).join('');

    const hist = MEASURED.map(x => {
      const r = latest.get(s.id + '|' + x.id);
      if (!r) return '';
      const n = Store.readings.filter(q => q.seat_id === s.id && q.metric === x.id).length;
      return `<tr><td>${esc(x.short)}${n > 1 ? ` <span class="muted small">×${n}</span>` : ''}</td><td class="num">${fmt(r.seat_value)}</td><td class="num">${fmt(r.booth_value)}</td>
        <td class="num"><b>${fmtSigned(r.delta)}</b></td><td class="muted small nowrap">${new Date(r.measured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
        <td><button class="icon-btn" data-del="${r.id}" title="Delete this reading">✕</button></td></tr>`;
    }).join('');

    box.innerHTML = `
      <div class="seat-head"><div><div class="seat-name">${esc(seatName(s))}</div><div class="seat-id">${esc(s.id)}</div></div>
        <button class="icon-btn" id="seat-close" title="Close" style="font-size:18px">✕</button></div>
      ${big}
      <div class="divider"></div>
      <div class="section-h" style="margin-top:0">Enter readings</div>
      <p class="hint" style="margin:4px 0 10px">Seat = what the measurement mic reads here. Booth = Smaart at FOH at the same moment (leave blank to use the live/manual booth value shown).</p>
      <div class="entry-grid"><div class="h">Metric</div><div class="h" style="text-align:right">Seat</div><div class="h" style="text-align:right">Booth</div>${rows}</div>
      <input id="entry-notes" placeholder="Notes (optional)" style="margin-top:10px;font-size:13px">
      <label class="check"><input type="checkbox" id="entry-advance" ${localStorage.getItem('ra_advance') !== '0' ? 'checked' : ''}> Jump to next seat after saving</label>
      <div class="entry-actions">
        <button class="btn btn-primary btn-sm" id="entry-save">Save readings</button>
        ${seatSrc ? '<button class="btn btn-sky btn-sm" id="entry-capture">Capture from Smaart</button>' : ''}
        <button class="btn btn-secondary btn-sm" id="entry-next">Skip ›</button>
        <button class="btn btn-secondary btn-sm" id="entry-next-missing" title="Next seat that's missing any reading or response">Next unmeasured ›</button>
      </div>
      ${frSectionHtml(s)}
      ${hist ? `<div class="section-h">Latest readings</div><table class="rtable"><thead><tr><th></th><th class="num">Seat</th><th class="num">Booth</th><th class="num">Δ</th><th></th><th></th></tr></thead><tbody>${hist}</tbody></table>` : ''}`;

    $('#seat-close').onclick = () => selectSeat(null);
    $('#entry-save').onclick = saveEntry;
    $('#entry-next').onclick = () => { const n = nextSeat(s); if (n) { selectSeat(n.id, true); focusEntry(); } else toast('End of section'); };
    $('#entry-next-missing').onclick = () => { const n = nextIncomplete(s.id); if (n) goToSeat(n); else toast('Every seat has a full set of data 🎉'); };
    $('#entry-advance').onchange = (ev) => { try { localStorage.setItem('ra_advance', ev.target.checked ? '1' : '0'); } catch (x) {} };
    if (seatSrc) $('#entry-capture').onclick = captureFromSmaart;
    $('#fr-capture').onclick = captureResponse;
    $('#fr-import').onclick = openImportResponse;
    $('#fr-bands').onchange = (ev) => { try { localStorage.setItem('ra_fr_bands', ev.target.checked ? '1' : '0'); } catch (x) {} };
    if ($('#fr-del')) $('#fr-del').onclick = async () => {
      if (!confirm('Delete this seat\'s latest frequency response? (Band readings saved from it are kept.)')) return;
      try { await Store.deleteSpectrum($('#fr-del').dataset.id); } catch (err) { toast('Delete failed: ' + err.message); }
      afterSpectraChanged();
    };
    box.querySelectorAll('.entry-grid input').forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') saveEntry(); }));
    box.querySelectorAll('[data-del]').forEach(bt => bt.onclick = async () => {
      if (!confirm('Delete this reading? The previous reading for this metric (if any) will be used instead.')) return;
      try { await Store.deleteReading(bt.dataset.del); } catch (err) { toast('Delete failed: ' + err.message); }
      afterReadingsChanged();
    });
  }

  function frSectionHtml(s) {
    const sp = latestSp.get(s.id);
    const n = Store.spectra.filter(x => x.seat_id === s.id).length;
    let info;
    if (sp) {
      const d = subT(sp.seat_bins, sp.booth_bins);
      const bands = MEASURED.filter(x => x.band).map(x => {
        const sv = bandFromThirds(sp.seat_bins, x.band[0], x.band[1]), bv = bandFromThirds(sp.booth_bins, x.band[0], x.band[1]);
        return `<tr><td>${esc(x.short)}</td><td class="num">${fmt(sv)}</td><td class="num">${fmt(bv)}</td><td class="num"><b>${sv == null || bv == null ? '—' : fmtSigned(sv - bv)}</b></td></tr>`;
      }).join('');
      const worst = d.reduce((a, v, i) => v != null && (a == null || Math.abs(v) > Math.abs(d[a])) ? i : a, null);
      info = `<p class="hint" style="margin:4px 0 6px">Captured ${new Date(sp.measured_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          · ${sp.source === 'import' ? 'imported' : 'Smaart'}${n > 1 ? ` · ${n} captures` : ''}${worst != null ? ` · biggest difference ${fmtSigned(d[worst])} dB at ${fmtHz(THIRDS[worst])} Hz` : ''}. The chart below the map shows the curves.</p>
        <table class="rtable"><thead><tr><th>Band</th><th class="num">Seat</th><th class="num">FOH</th><th class="num">Δ</th></tr></thead><tbody>${bands}</tbody></table>`;
    } else info = '<p class="hint" style="margin:4px 0 6px">No response captured for this seat yet.</p>';
    return `<div class="section-h">Frequency response</div>${info}
      <label class="check"><input type="checkbox" id="fr-bands" ${localStorage.getItem('ra_fr_bands') !== '0' ? 'checked' : ''}> Also save Low / Lo-Mid / HF readings from captures</label>
      <div class="entry-actions">
        <button class="btn btn-sky btn-sm" id="fr-capture">Capture response</button>
        <button class="btn btn-secondary btn-sm" id="fr-import">Import…</button>
        ${sp ? `<button class="btn btn-danger btn-sm" id="fr-del" data-id="${sp.id}">Delete</button>` : ''}
      </div>`;
  }

  function updateEntryPlaceholders() {
    document.querySelectorAll('#seat-panel [data-booth]').forEach(i => {
      const v = Smaart.booth(i.dataset.booth).value;
      i.placeholder = v == null ? '' : fmt(v);
    });
  }

  function focusEntry() {
    const m = metricById(metric);
    const basis = m.derived ? S().ui.devBasis : metric;
    const i = document.querySelector(`#seat-panel [data-seat="${basis}"]`);
    if (i && window.matchMedia('(pointer:fine)').matches) i.focus();
  }

  function captureFromSmaart() {
    let n = 0;
    const seatT = Smaart.liveSpectrum('seat'), boothT = Smaart.liveSpectrum('booth');
    for (const x of MEASURED) {
      let sv = Smaart.seatLive(x.id), bv = Smaart.booth(x.id).source === 'live' ? Smaart.booth(x.id).value : null;
      // band metrics can come from the roaming-mic spectrum when there's no direct meter path
      if (sv == null && x.band && seatT && boothT) {
        sv = bandFromThirds(seatT, x.band[0], x.band[1]);
        bv = bandFromThirds(boothT, x.band[0], x.band[1]);
      }
      if (sv != null) { document.querySelector(`#seat-panel [data-seat="${x.id}"]`).value = sv.toFixed(1); n++; }
      if (sv != null && bv != null) document.querySelector(`#seat-panel [data-booth="${x.id}"]`).value = bv.toFixed(1);
    }
    toast(n ? `Captured ${n} value${n > 1 ? 's' : ''} from Smaart` : 'No live roaming-mic values from Smaart');
  }

  async function saveEntry() {
    const s = seatById.get(selectedId);
    if (!s) return;
    const list = [];
    for (const x of MEASURED) {
      const sv = document.querySelector(`#seat-panel [data-seat="${x.id}"]`).value.trim();
      if (sv === '') continue;
      let bv = document.querySelector(`#seat-panel [data-booth="${x.id}"]`).value.trim();
      if (bv === '') {
        const b = Smaart.booth(x.id).value;
        if (b == null) { toast(`Enter the booth reading for ${x.label} — Smaart isn't providing one`); return; }
        bv = b.toFixed(1);
      }
      list.push({ seat_id: s.id, metric: x.id, seat_value: +sv, booth_value: +bv, notes: $('#entry-notes').value.trim() });
    }
    if (!list.length) { toast('Type at least one seat value'); return; }
    try { await Store.addReadings(list); }
    catch (err) { toast('Could not save: ' + err.message); return; }
    toast(`Saved ${list.length} reading${list.length > 1 ? 's' : ''} · ${s.id}`);
    afterReadingsChanged();
    if ($('#entry-advance') && $('#entry-advance').checked) {
      const n = nextSeat(s);
      if (n) { selectSeat(n.id, true); focusEntry(); }
    } else renderSeatPanel(true);
  }

  function afterReadingsChanged() {
    dataVersion++;
    latest = Store.latest();
    estCacheByMetric.clear();
    render();
    renderSeatPanel(true);
  }

  // ------------------------------------------------------------ frequency response
  const addT = (a, b) => a && b ? a.map((v, i) => v == null || b[i] == null ? null : Math.round((v + b[i]) * 10) / 10) : null;
  const subT = (a, b) => a && b ? a.map((v, i) => v == null || b[i] == null ? null : Math.round((v - b[i]) * 10) / 10) : null;

  // mean seat-minus-FOH curve over every seat's latest response
  function roomDelta() {
    const sum = THIRDS.map(() => 0), n = THIRDS.map(() => 0);
    for (const [id, sp] of latestSp) {
      if (!seatById.has(id)) continue;
      subT(sp.seat_bins, sp.booth_bins).forEach((v, i) => { if (v != null) { sum[i] += v; n[i]++; } });
    }
    return { curve: sum.map((v, i) => n[i] ? Math.round(v / n[i] * 10) / 10 : null), seats: Math.max(0, ...n) };
  }

  function renderFR(m) {
    const body = $('#fr-body');
    if (!body) return;
    const ui = S().ui;
    const view = ui.frMode || 'levels';
    const basis = m.derived ? ui.devBasis : m.id;
    const bm = metricById(basis);
    const liveFOH = Smaart.liveSpectrum('booth');
    const sp = selectedId ? latestSp.get(selectedId) : null;
    const room = roomDelta();
    const newest = [...latestSp.values()].sort((a, b) => b.measured_at < a.measured_at ? -1 : 1)[0];

    // FOH reference: live Smaart, else the selected seat's capture, else the newest capture
    const foh = liveFOH || (sp ? sp.booth_bins : newest ? newest.booth_bins : null);
    const fohLabel = liveFOH ? 'FOH (live)' : sp ? 'FOH at capture' : 'FOH (last capture)';
    const seatName = sp ? seatById.get(selectedId).id : '';
    const seatDelta = sp ? subT(sp.seat_bins, sp.booth_bins) : null;
    const series = [];
    if (view === 'relative') {
      if (foh || room.seats || sp) series.push({ key: 'foh', label: 'FOH', cls: 'fr-foh', values: THIRDS.map(() => 0) });
      if (sp) series.push({ key: 'seat', label: `Seat ${seatName}`, cls: 'fr-seat', values: seatDelta });
      if (room.seats) series.push({ key: 'avg', label: `Room average (${room.seats} seat${room.seats === 1 ? "" : "s"})`, cls: 'fr-avg', values: room.curve, dash: true });
    } else {
      if (foh) series.push({ key: 'foh', label: fohLabel, cls: 'fr-foh', values: foh });
      if (sp) series.push({ key: 'seat', label: liveFOH ? `Seat ${seatName} (est. now)` : `Seat ${seatName}`, cls: 'fr-seat', values: liveFOH ? addT(liveFOH, seatDelta) : sp.seat_bins });
      if (room.seats && foh) series.push({ key: 'avg', label: `Room average (${room.seats} seat${room.seats === 1 ? "" : "s"})`, cls: 'fr-avg', values: addT(foh, room.curve), dash: true });
    }

    const sub = [];
    sub.push(liveFOH ? 'Live from Smaart' : newest ? 'From captured responses' : 'No responses captured yet');
    if (selectedId && !sp) sub.push(`seat ${esc(selectedId)} has no response yet`);
    if (bm.band) sub.push(`${esc(bm.label)} band shaded`);
    $('#fr-sub').innerHTML = sub.join(' · ');
    const chips = [['levels', 'dB levels'], ['relative', 'Relative to FOH'], ['table', 'Table']];
    $('#fr-chips').innerHTML = chips.map(([k, l]) => `<button class="chip ${view === k ? 'on' : ''}" data-frv="${k}">${l}</button>`).join('');
    $('#fr-chips').querySelectorAll('[data-frv]').forEach(b => b.onclick = () => { ui.frMode = b.dataset.frv; Store.saveSettings(); renderFR(metricById(metric)); });

    if (!series.length) {
      body.innerHTML = `<div class="fr-empty">No frequency responses yet. Pick a seat and use <b>Capture response</b> (Smaart roaming mic + FOH) or <b>Import</b> a Smaart ASCII export.</div>`;
      delete body.dataset.mode;
      return;
    }
    if (view === 'table') {
      const typing = body.contains(document.activeElement);
      if (!typing) body.innerHTML = FRChart.table(series, false);
      return;
    }
    if (body.dataset.mode !== 'chart') { body.innerHTML = ''; body.dataset.mode = 'chart'; }
    FRChart.render(body, { series, relative: view === 'relative', band: bm.band, bandLabel: bm.band ? bm.short : '' });
  }

  function afterSpectraChanged() {
    latestSp = Store.latestSpectra();
    render();
    renderSeatPanel(true);
  }

  // band readings (Low / Lo-Mid / HF) derived from a pair of curves
  function bandReadingsFrom(seatId, seatT, boothT, when) {
    return MEASURED.filter(x => x.band).map(x => {
      const sv = bandFromThirds(seatT, x.band[0], x.band[1]), bv = bandFromThirds(boothT, x.band[0], x.band[1]);
      return sv == null || bv == null ? null : { seat_id: seatId, metric: x.id, seat_value: Math.round(sv * 10) / 10, booth_value: Math.round(bv * 10) / 10, notes: 'from frequency response', measured_at: when };
    }).filter(Boolean);
  }

  async function saveSpectrum(seatId, seatT, boothT, source, withBands) {
    const when = new Date().toISOString();
    let msg;
    try {
      await Store.addSpectrum({ seat_id: seatId, seat_bins: seatT, booth_bins: boothT, source, measured_at: when });
      msg = `Frequency response saved · ${seatId}`;
    } catch (err) { msg = 'Could not save: ' + err.message; }
    if (withBands) {
      const list = bandReadingsFrom(seatId, seatT, boothT, when);
      if (list.length) {
        try { await Store.addReadings(list); } catch (err) { msg = 'Band readings could not be saved: ' + err.message; }
        msg += ` + ${list.length} band reading${list.length > 1 ? 's' : ''}`;
        dataVersion++; latest = Store.latest(); estCacheByMetric.clear();
      }
    }
    toast(msg);
    afterSpectraChanged();
  }

  function captureResponse() {
    const seatT = Smaart.liveSpectrum('seat'), boothT = Smaart.liveSpectrum('booth');
    if (!seatT || !boothT) {
      toast(!S().smaart.seatSpectrumPath ? 'Set the roaming-mic spectrum path in the Smaart dialog first' : 'No live spectra from Smaart right now');
      return;
    }
    saveSpectrum(selectedId, seatT, boothT, 'smaart', $('#fr-bands') ? $('#fr-bands').checked : true);
  }

  function openImportResponse() {
    const s = seatById.get(selectedId);
    if (!s) return;
    const liveFOH = Smaart.liveSpectrum('booth');
    openModal(`Import response · ${s.id}`, `
      <p class="hint" style="margin-top:12px">In Smaart, export the trace as ASCII text (right-click the trace → Export, or File → Export), then paste it or pick the file.
        Any <b>frequency, dB</b> columns work — FFT or 1/3-octave; it's converted to 31 third-octave bands. A plain list of 31 values (20 Hz → 20 kHz) also works.</p>
      <label>Seat trace (measurement mic at this seat)</label>
      <textarea id="imp-seat" placeholder="Hz	dB&#10;20	78.1&#10;25	79.4&#10;…" style="min-height:90px"></textarea>
      <button class="btn btn-secondary btn-sm" id="imp-seat-file" style="margin-top:6px">Choose file…</button>
      <label>FOH trace (booth mic at the same moment)</label>
      <textarea id="imp-foh" placeholder="${liveFOH ? 'Leave empty to use the live FOH response from Smaart' : 'Paste the FOH trace…'}" style="min-height:90px"></textarea>
      <button class="btn btn-secondary btn-sm" id="imp-foh-file" style="margin-top:6px">Choose file…</button>
      <label class="check"><input type="checkbox" id="imp-bands" checked> Also save Low / Lo-Mid / HF readings from these curves</label>
      <p class="hint" id="imp-status" style="margin-top:10px"></p>`,
      '<button class="btn btn-secondary btn-sm" data-close>Cancel</button><button class="btn btn-primary btn-sm" id="imp-save">Save response</button>');
    const parse = (id) => toThirds(parseTrace($(id).value));
    const status = () => {
      const a = parse('#imp-seat'), b = parse('#imp-foh') || (!$('#imp-foh').value.trim() ? liveFOH : null);
      const cnt = (t) => t ? t.filter(v => v != null).length : 0;
      $('#imp-status').innerHTML = `Seat: <b>${cnt(a)}</b>/31 bands · FOH: <b>${cnt(b)}</b>/31 bands${!$('#imp-foh').value.trim() && liveFOH ? ' (live)' : ''}`;
      return [a, b];
    };
    ['#imp-seat', '#imp-foh'].forEach(id => $(id).addEventListener('input', status));
    [['#imp-seat-file', '#imp-seat'], ['#imp-foh-file', '#imp-foh']].forEach(([b, t]) => $(b).onclick = async () => {
      try { const f = await RA.openTextFile('trace'); if (f) { $(t).value = f.text; status(); } }
      catch (e) { toast('Could not open the file: ' + e.message); }
    });
    status();
    $('#imp-save').onclick = () => {
      const [a, b] = status();
      if (!a || a.filter(v => v != null).length < 6) { toast('Seat trace: need at least 6 bands of data'); return; }
      if (!b || b.filter(v => v != null).length < 6) { toast('FOH trace: paste it, or connect Smaart for a live FOH response'); return; }
      const withBands = $('#imp-bands').checked;
      closeModal();
      saveSpectrum(s.id, a, b, 'import', withBands);
    };
  }

  // ------------------------------------------------------------ summary
  function progressHtml() {
    const done = seats.filter(x => seatComplete(x.id)).length;
    const pct = seats.length ? Math.round(100 * done / seats.length) : 0;
    return `<div class="small" style="font-weight:700">Walk-through: ${done} of ${seats.length} seats complete (${pct}%)</div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <p class="hint" style="margin:0 0 10px">Complete = SPL, Low, Lo-Mid and HF all measured, or a frequency response captured. Every measured seat keeps tracking the live FOH.</p>
      ${done < seats.length ? `<button class="btn btn-secondary btn-sm" id="walk-next" style="margin-bottom:12px">${done ? 'Continue walk-through ›' : 'Start walk-through ›'}</button>` : ''}`;
  }
  function bindProgress() {
    const b = $('#walk-next');
    if (b) b.onclick = () => { const n = nextIncomplete(selectedId); if (n) goToSeat(n); };
  }

  function renderSummary(m, pv) {
    const real = [...pv.vals.entries()].filter(([, x]) => !x.est);
    const box = $('#summary');
    if (!real.length) {
      box.innerHTML = progressHtml() + `<p class="hint">No ${esc(metricById(pv.basis).label)} readings yet. Pick a seat and enter what the measurement mic reads there next to the booth value.</p>`;
      bindProgress();
      return;
    }
    const vs = real.map(([, x]) => x.v);
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const mn = Math.min(...vs), mx = Math.max(...vs);
    const f = (v) => m.derived || pv.relative ? fmtSigned(v) : fmt(v);
    const by = {};
    for (const [id, x] of real) { const s = seatById.get(id); if (s) (by[s.section] = by[s.section] || []).push(x.v); }
    const tot = {};
    for (const s of seats) tot[s.section] = (tot[s.section] || 0) + 1;
    const order = ROOM.sections.map(x => x.name).concat(Object.keys(tot).filter(n => !ROOM.sections.some(x => x.name === n)));
    const loudest = real.reduce((a, b) => b[1].v > a[1].v ? b : a), quietest = real.reduce((a, b) => b[1].v < a[1].v ? b : a);
    box.innerHTML = progressHtml() + `
      <div class="tiles" style="margin-bottom:12px">
        <div class="tile" style="cursor:default"><div class="l">Average</div><div class="v">${f(avg)}</div></div>
        <div class="tile" style="cursor:default"><div class="l">Spread</div><div class="v">${fmt(mx - mn)}<small>dB</small></div></div>
        <div class="tile" data-go="${loudest[0]}"><div class="l">Loudest seat</div><div class="v">${f(mx)}</div><div class="small muted">${esc(loudest[0])}</div></div>
        <div class="tile" data-go="${quietest[0]}"><div class="l">Quietest seat</div><div class="v">${f(mn)}</div><div class="small muted">${esc(quietest[0])}</div></div>
      </div>
      ${order.filter(n => tot[n]).map(n => {
        const a = by[n] || [];
        const av = a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
        return `<div class="sec-row" data-sec="${esc(n)}"><span class="sec-n">${esc(n)}</span>
          <span class="sec-bar" title="${a.length}/${tot[n]} measured"><span style="width:${Math.round(100 * a.length / tot[n])}%"></span></span>
          <span class="sec-v">${av == null ? '<span class="muted">—</span>' : f(av)}</span></div>`;
      }).join('')}`;
    bindProgress();
    box.querySelectorAll('[data-go]').forEach(t => t.onclick = () => { const s = seatById.get(t.dataset.go); selectSeat(s.id, true); SeatMap.centerOn(s.x, s.y); });
    box.querySelectorAll('[data-sec]').forEach(r => r.onclick = () => {
      const list = seats.filter(s => s.section === r.dataset.sec);
      const first = list.find(s => !latest.get(s.id + '|' + pv.basis)) || list[0];
      if (first) { selectSeat(first.id, true); SeatMap.centerOn(first.x, first.y); }
    });
  }

  function tooltipHtml(id) {
    const s = seatById.get(id);
    if (!s) return '';
    const m = metricById(metric);
    const pv = pageValues();
    const x = pv.vals.get(id);
    let v = '<span class="tm">Not measured</span>';
    if (x) {
      const unit = m.derived || pv.relative ? 'dB vs booth' : m.unit;
      v = `<span class="tv">${m.derived || pv.relative ? fmtSigned(x.v) : fmt(x.v)}</span> <span class="tm">${unit}${x.est ? ' · est.' : ''}</span>`;
      if (!m.derived && !pv.relative) v += `<br><span class="tm">${fmtSigned(x.delta)} dB vs booth</span>`;
    }
    return `<b>${esc(s.section)}</b> · Row ${s.row} · Seat ${s.seat}<br>${v}`;
  }

  // ------------------------------------------------------------ modes
  function setMapMode(mode) {
    mapMode = mode;
    SeatMap.setMode(mode);
    const ban = $('#map-banner');
    $('#btn-booth').classList.toggle('on', mode === 'booth');
    $('#btn-edit').classList.toggle('on', mode === 'edit');
    if (mode === 'view') { ban.classList.remove('show'); return; }
    ban.innerHTML = mode === 'booth'
      ? '<span>📍 Click the map where the FOH mix position is.</span><button class="btn btn-sm" id="ban-done">Cancel</button>'
      : '<span>✏️ Editing seats — click a seat to relabel or remove it, click empty floor to add one.</span><button class="btn btn-sm" id="ban-done">Done</button>';
    ban.classList.add('show');
    $('#ban-done').onclick = () => setMapMode('view');
  }

  function openSeatEditor(id, point) {
    const s = id ? seatById.get(id) : null;
    const sections = [...new Set(seats.map(x => x.section))];
    let guess = { section: sections[0], row: 1, seat: 1 };
    if (!s && point) {
      const near = seats.reduce((a, b) => Math.hypot(b.x - point.x, b.y - point.y) < Math.hypot(a.x - point.x, a.y - point.y) ? b : a);
      guess = { section: near.section, row: near.row, seat: near.seat + 1, rot: near.rot, code: near.code };
    }
    const cur = s || guess;
    openModal(s ? 'Edit seat' : 'Add seat', `
      <label>Section</label>
      <input id="se-section" list="se-sections" value="${esc(cur.section)}">
      <datalist id="se-sections">${sections.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="form-row"><div><label>Row</label><input id="se-row" type="number" min="1" value="${cur.row}"></div>
      <div><label>Seat</label><input id="se-seat" type="number" min="1" value="${cur.seat}"></div></div>
      ${s ? `<p class="hint" style="margin-top:12px">Seat ID <b>${esc(s.id)}</b> stays the same so its readings follow the new label.</p>` : ''}`,
      `${s ? '<button class="btn btn-danger btn-sm" id="se-del" style="margin-right:auto">Remove seat</button>' : ''}
       <button class="btn btn-secondary btn-sm" data-close>Cancel</button><button class="btn btn-primary btn-sm" id="se-save">Save</button>`);
    $('#se-save').onclick = () => {
      const lab = { section: $('#se-section').value.trim() || cur.section, row: +$('#se-row').value || 1, seat: +$('#se-seat').value || 1 };
      const ed = S().seatEdits;
      if (s) {
        const added = ed.added.find(a => a.id === s.id);
        if (added) Object.assign(added, lab); else ed.labels[s.id] = lab;
      } else {
        const code = (seats.find(x => x.section === lab.section) || {}).code || 'X';
        ed.added.push({ id: `${code}-A${Date.now().toString(36)}`, code, ...lab, x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10, rot: guess.rot || 0 });
      }
      Store.saveSettings(); closeModal(); rebuildSeats(); SeatMap.setSeats(seats); render();
    };
    if (s) $('#se-del').onclick = () => {
      const ed = S().seatEdits;
      if (ed.added.some(a => a.id === s.id)) ed.added = ed.added.filter(a => a.id !== s.id);
      else ed.deleted.push(s.id);
      if (selectedId === s.id) selectedId = null;
      Store.saveSettings(); closeModal(); rebuildSeats(); SeatMap.setSeats(seats); render(); toast('Seat removed');
    };
  }

  // ------------------------------------------------------------ Smaart dialog
  function openSmaart() {
    const c = S().smaart;
    const opts = ['<option value="">— assign —</option>']
      .concat(MEASURED.map(x => `<option value="b:${x.id}">Booth · ${esc(x.label)}</option>`))
      .concat(MEASURED.map(x => `<option value="s:${x.id}">Roaming mic · ${esc(x.label)}</option>`)).join('');
    openModal('Smaart connection', `
      <div class="note"><b>In Smaart:</b> Options → Preferences → API → enable the API (default port 26000). Use host <b>localhost</b> when Roomio runs on the Smaart computer, or that computer's IP address otherwise.
        Command formats come from the free Smaart API SDK (support@rationalacoustics.com); paste them below and map the fields using the live message list.</div>
      <div class="form-row three"><div><label>Smaart computer (IP or hostname)</label><input id="sm-host" value="${esc(c.host || '')}" placeholder="e.g. ${esc(SMAART_DEFAULTS.host)}"></div>
        <div><label>Port</label><input id="sm-port" type="number" min="1" max="65535" value="${c.port || ''}" placeholder="${SMAART_DEFAULTS.port}"></div>
        <div><label>API path</label><select id="sm-path">
          ${[['/api/v4/', 'Smaart v9 (/api/v4/)'], ['/api/v3/', 'Smaart 8 / Di 2 (/api/v3/)'], ['', 'None']].map(([v, l]) => `<option value="${v}" ${(c.path == null ? SMAART_DEFAULTS.path : c.path) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div></div>
      <div class="form-row"><div><label>API password <span class="muted">(only if set in Smaart — stored encrypted on this computer)</span></label><input id="sm-pw" type="password" autocomplete="off" placeholder="not set"></div>
        <div><label>Poll every (ms)</label><input id="sm-poll" type="number" min="100" step="50" value="${c.pollMs}"></div></div>
      <label class="check"><input type="checkbox" id="sm-auto" ${c.autoConnect ? 'checked' : ''}> Connect automatically when the app opens</label>
      <label>Poll messages <span class="muted">(JSON sent every poll, one per line — leave empty if Smaart streams on its own)</span></label>
      <textarea id="sm-msgs" placeholder='{"...": "command from the Smaart API SDK"}'>${esc(c.pollMessages)}</textarea>

      <div class="section-h">Field mapping</div>
      <p class="hint">Paths into Smaart's JSON replies, e.g. <code>meters.name=Booth.dBA</code> or <code>data[0].level</code>. Band metrics can also come from a spectrum.</p>
      <div class="entry-grid" style="grid-template-columns:110px 1fr 1fr">
        <div class="h">Metric</div><div class="h">Booth path</div><div class="h">Roaming mic path</div>
        ${MEASURED.map(x => `<div class="m">${esc(x.short)}</div>
          <input data-bp="${x.id}" value="${esc(c.paths[x.id] || '')}" style="text-align:left;font-size:12.5px">
          <input data-sp="${x.id}" value="${esc(c.seatPaths[x.id] || '')}" style="text-align:left;font-size:12.5px">`).join('')}
      </div>
      <div class="form-row"><div><label>Booth spectrum path <span class="muted">(FOH response + band levels)</span></label><input id="sm-spec" value="${esc(c.spectrumPath)}"></div>
        <div><label>Roaming mic spectrum path <span class="muted">(seat response)</span></label><input id="sm-seatspec" value="${esc(c.seatSpectrumPath || '')}"></div></div>
      <label>Smoothing (0 = none, 0.9 = heavy)</label><input id="sm-smooth" type="number" min="0" max="0.95" step="0.05" value="${c.smoothing}" style="max-width:160px">

      <div class="section-h">Live messages</div>
      <div id="sm-leaves" class="leaf-list"></div>
      <div class="form-row" style="grid-template-columns:1fr auto;margin-top:10px"><input id="sm-send" placeholder="Send a test command…" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px"><button class="btn btn-secondary btn-sm" id="sm-send-btn">Send</button></div>
      <div id="sm-console" class="console" style="margin-top:10px"></div>`,
      `<span id="sm-state" class="small muted" style="margin-right:auto"></span>
       <button class="btn btn-secondary btn-sm" id="sm-retry" hidden>Retry now</button>
       <button class="btn btn-secondary btn-sm" id="sm-test">Test</button>
       <button class="btn btn-secondary btn-sm" id="sm-conn"></button>
       <button class="btn btn-primary btn-sm" id="sm-save">Save</button>`, 'wide');

    const collect = () => {
      c.host = $('#sm-host').value.trim();                 // blank stays blank -> clear error, no silent default
      c.port = parseInt($('#sm-port').value, 10) || null;
      c.path = $('#sm-path').value;
      const pw = $('#sm-pw');
      if (pw.dataset.changed) { Smaart.setPassword(pw.value); delete pw.dataset.changed; }
      c.pollMs = Math.max(100, +$('#sm-poll').value || 500);
      c.autoConnect = $('#sm-auto').checked;
      c.pollMessages = $('#sm-msgs').value;
      c.spectrumPath = $('#sm-spec').value.trim();
      c.seatSpectrumPath = $('#sm-seatspec').value.trim();
      c.smoothing = Math.max(0, Math.min(0.95, +$('#sm-smooth').value || 0));
      document.querySelectorAll('[data-bp]').forEach(i => { c.paths[i.dataset.bp] = i.value.trim(); });
      document.querySelectorAll('[data-sp]').forEach(i => { c.seatPaths[i.dataset.sp] = i.value.trim(); });
      Store.saveSettings();
    };
    const renderConn = () => {
      const st = Smaart.status;
      if (!$('#sm-conn')) return;
      $('#sm-conn').textContent = st === 'off' || st === 'error' || st === 'auth' ? 'Connect' : 'Disconnect';
      $('#sm-retry').hidden = st !== 'connecting';
      $('#sm-state').textContent = st === 'live' ? 'Connected · ' + (Smaart.state.url || '') : statusText();
    };
    Smaart.hasPassword().then(has => { if ($('#sm-pw') && has) $('#sm-pw').placeholder = '•••••• saved — type to change'; });
    $('#sm-pw').addEventListener('input', () => { $('#sm-pw').dataset.changed = '1'; });
    const renderLog = () => {
      const el = $('#sm-console'); if (!el) return;
      el.innerHTML = Smaart.log.slice(-40).map(l => `<div class="${l.dir}">${l.dir === 'in' ? '←' : l.dir === 'out' ? '→' : '!'} ${esc(l.text)}</div>`).join('') || '<div class="muted">No messages yet.</div>';
      el.scrollTop = el.scrollHeight;
    };
    let lastLeafRender = 0;
    const renderLeaves = () => {
      const el = $('#sm-leaves'); if (!el) return;
      if (el.contains(document.activeElement)) return;
      if (Date.now() - lastLeafRender < 700) return;
      lastLeafRender = Date.now();
      const msg = Smaart.lastMessage;
      if (!msg) { el.innerHTML = '<div class="leaf"><span class="muted">Connect to Smaart to see the numbers it sends — then assign them to metrics here.</span></div>'; return; }
      const spec = [];
      (function walk(o, p) {
        if (spec.length > 10 || !o || typeof o !== 'object') return;
        const bins = Smaart.toBins(o);
        if (bins && bins.length >= 8) { spec.push([p, bins.length]); return; }
        if (Array.isArray(o)) o.slice(0, 16).forEach((e, i) => walk(e, `${p}[${i}]`));
        else Object.keys(o).forEach(k => walk(o[k], p ? `${p}.${k}` : k));
      })(msg, '');
      el.innerHTML = spec.map(([p, n]) => `<div class="leaf"><code title="${esc(p)}">${esc(p || '(root)')}</code><span class="muted">${n} bins</span>
          <span class="chips"><button class="btn btn-secondary btn-sm" data-spec="${esc(p)}">Booth</button><button class="btn btn-secondary btn-sm" data-seatspec="${esc(p)}">Roaming</button></span></div>`).join('') +
        Smaart.leaves(msg).slice(0, 150).map(([p, v]) => `<div class="leaf"><code title="${esc(p)}">${esc(p)}</code><b>${fmt(v, 2)}</b>
          <select data-leaf="${esc(p)}">${opts}</select></div>`).join('');
      el.querySelectorAll('[data-spec]').forEach(b => b.onclick = () => { $('#sm-spec').value = b.dataset.spec; toast('Booth spectrum path set — Save to apply'); });
      el.querySelectorAll('[data-seatspec]').forEach(b => b.onclick = () => { $('#sm-seatspec').value = b.dataset.seatspec; toast('Roaming spectrum path set — Save to apply'); });
      el.querySelectorAll('[data-leaf]').forEach(sel => sel.onchange = () => {
        const [kind, id] = sel.value.split(':');
        if (!id) return;
        const inp = document.querySelector(kind === 'b' ? `[data-bp="${id}"]` : `[data-sp="${id}"]`);
        inp.value = sel.dataset.leaf;
        sel.value = '';
        toast('Mapped — Save to apply');
      });
    };
    renderConn(); renderLog(); renderLeaves();
    const unsub = [];
    const sub = (ev, fn) => { Smaart.on(ev, fn); unsub.push(fn); };
    sub('status', renderConn); sub('log', renderLog); sub('message', renderLeaves);
    modalCleanup = () => { unsub.forEach(fn => fn.dead = true); };

    $('#sm-conn').onclick = () => {
      collect();
      if (['off', 'error', 'auth'].includes(Smaart.status)) Smaart.connect(); else Smaart.disconnect();
    };
    $('#sm-retry').onclick = () => Smaart.retryNow();
    $('#sm-test').onclick = async () => {
      collect();
      const pw = $('#sm-pw').value;
      $('#sm-state').textContent = 'Testing…';
      const r = RA.native ? await RA.native.smaartTest({ host: c.host, port: c.port, path: c.path }, pw ? pw : undefined) : { ok: false, message: 'Test connection works in the desktop app.' };
      $('#sm-state').textContent = (r.ok ? '✓ ' : '✕ ') + r.message;
    };
    $('#sm-save').onclick = () => { collect(); Smaart.restartPolling(); toast('Smaart settings saved'); render(); };
    const sendTest = () => { const t = $('#sm-send').value.trim(); if (!t) return; if (!Smaart.send(t)) toast('Not connected'); };
    $('#sm-send-btn').onclick = sendTest;
    $('#sm-send').onkeydown = (e) => { if (e.key === 'Enter') sendTest(); };
  }

  // ------------------------------------------------------------ Data dialog
  function openData() {
    const ed = S().seatEdits;
    const edits = ed.deleted.length + ed.added.length + Object.keys(ed.labels).length;
    openModal('Data', `
      <div class="section-h">Storage</div>
      <p class="hint">Everything is saved on this computer. To move a venue (with or without its measurements) to another computer, use <b>Settings → Export venue profile</b>.</p>
      <div class="section-h">Readings</div>
      <p class="hint">${Store.readings.length} readings across ${new Set(Store.readings.map(r => r.seat_id)).size} seats · ${Store.spectra.length} frequency responses across ${latestSp.size} seats.</p>
      <div class="chips" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" id="d-export">Export CSV</button>
        <button class="btn btn-secondary btn-sm" id="d-import">Import CSV…</button>
        <button class="btn btn-secondary btn-sm" id="d-export-fr">Export responses CSV</button>
        <button class="btn btn-danger btn-sm" id="d-clear">Clear all measurements</button>
      </div>
      <div class="section-h">Seats</div>
      <p class="hint">${seats.length} seats (${ROOM.seats.length} from the auditorium file${edits ? `, ${edits} manual edit${edits > 1 ? 's' : ''}` : ''}). Use <b>Edit seats</b> in the top bar to fix labels or add/remove seats.</p>
      ${edits ? '<button class="btn btn-secondary btn-sm" id="d-restore" style="margin-top:8px">Restore original seats</button>' : ''}`,
      '<button class="btn btn-primary btn-sm" data-close>Done</button>');
    $('#d-export').onclick = exportCsv;
    $('#d-export-fr').onclick = exportSpectraCsv;
    $('#d-import').onclick = async () => {
      try { const f = await RA.openTextFile('readings'); if (f) importCsv(f); }
      catch (e) { toast('Could not open the file: ' + e.message); }
    };
    $('#d-clear').onclick = async () => {
      if (!confirm(`Delete all ${Store.readings.length} readings and ${Store.spectra.length} frequency responses? This can't be undone. (Export CSVs first if you want a backup.)`)) return;
      try { await Store.clearReadings(); toast('All readings cleared'); } catch (err) { toast('Clear failed: ' + err.message); }
      closeModal(); afterReadingsChanged();
    };
    if ($('#d-restore')) $('#d-restore').onclick = () => {
      if (!confirm('Undo all seat edits and go back to the seats detected from the drawing?')) return;
      S().seatEdits = { deleted: [], added: [], labels: {} };
      Store.saveSettings(); rebuildSeats(); SeatMap.setSeats(seats); closeModal(); render();
    };
  }

  const CSV_COLS = ['seat_id', 'section', 'row', 'seat', 'metric', 'seat_value', 'booth_value', 'delta', 'notes', 'measured_at'];
  function exportCsv() {
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [CSV_COLS.join(',')].concat(Store.readings.map(r => {
      const s = seatById.get(r.seat_id) || {};
      return [r.seat_id, s.section, s.row, s.seat, r.metric, r.seat_value, r.booth_value, r.delta, r.notes, r.measured_at].map(q).join(',');
    }));
    downloadCsv('roomio-readings', lines);
  }

  // native Save dialog (SANDBOX.md) — the user picks where it goes
  async function downloadCsv(name, lines) {
    try {
      const saved = await RA.saveTextFile('csv', `${name}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
      if (saved) toast('Saved ' + saved);
    } catch (e) { toast('Export failed: ' + e.message); }
  }

  // one row per capture per mic: seat_id, ..., trace (seat|foh), then the 31 band levels
  function exportSpectraCsv() {
    const lines = [['seat_id', 'section', 'row', 'seat', 'measured_at', 'source', 'trace', ...THIRDS.map(f => fmtHz(f) + 'Hz')].join(',')];
    for (const r of Store.spectra) {
      const s = seatById.get(r.seat_id) || {};
      for (const [trace, bins] of [['seat', r.seat_bins], ['foh', r.booth_bins]]) {
        lines.push([r.seat_id, `"${(s.section || '').replace(/"/g, '""')}"`, s.row ?? '', s.seat ?? '', r.measured_at, r.source || '', trace, ...bins.map(v => v == null ? '' : v)].join(','));
      }
    }
    downloadCsv('roomio-responses', lines);
  }

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
  }

  async function importCsv(file) {              // file = { name, text } from the native Open dialog
    if (!file) return;
    const rows = parseCsv(file.text);
    const head = rows.shift().map(h => h.trim().toLowerCase());
    const ix = (k) => head.indexOf(k);
    if (ix('seat_id') < 0 || ix('metric') < 0 || ix('seat_value') < 0 || ix('booth_value') < 0) { toast('CSV needs seat_id, metric, seat_value, booth_value columns'); return; }
    const list = [];
    let skipped = 0;
    for (const r of rows) {
      const m = r[ix('metric')].trim(), sv = parseFloat(r[ix('seat_value')]), bv = parseFloat(r[ix('booth_value')]);
      if (!seatById.has(r[ix('seat_id')].trim()) || !MEASURED.some(x => x.id === m) || !isFinite(sv) || !isFinite(bv)) { skipped++; continue; }
      list.push({ seat_id: r[ix('seat_id')].trim(), metric: m, seat_value: sv, booth_value: bv,
        notes: ix('notes') >= 0 ? r[ix('notes')] : '', measured_at: ix('measured_at') >= 0 && r[ix('measured_at')] ? r[ix('measured_at')] : undefined });
    }
    if (!list.length) { toast('No valid rows found'); return; }
    try { await Store.addReadings(list); } catch (err) { toast('Import failed: ' + err.message); return; }
    closeModal(); afterReadingsChanged();
    toast(`Imported ${list.length} readings${skipped ? ` (${skipped} skipped)` : ''}`);
  }

  // ------------------------------------------------------------ chrome
  function renderStatus(fromRender) {
    const pill = $('#smaart-pill');
    const st = Smaart.status;
    const anyManual = Object.keys(S().manualBooth).length > 0;
    const retryIn = Smaart.state.nextRetryAt ? Math.max(0, Math.round((Smaart.state.nextRetryAt - Date.now()) / 1000)) : null;
    pill.className = 'status-pill ' + (st === 'live' ? 'live' : st === 'connecting' ? 'connecting' : st === 'error' || st === 'auth' ? 'error' : '');
    pill.querySelector('.txt').textContent = st === 'live' ? 'Smaart live'
      : st === 'connecting' ? (retryIn != null ? `Retry in ${retryIn}s` : 'Connecting')
      : st === 'auth' ? 'Smaart password' : st === 'error' ? 'Smaart error' : anyManual ? 'Manual booth' : 'Smaart off';
    pill.title = statusText() + ' — click for Smaart settings';
    if (!fromRender) queueRender();
  }

  function statusText() {
    const st = Smaart.state;
    const retryIn = st.nextRetryAt ? Math.max(0, Math.round((st.nextRetryAt - Date.now()) / 1000)) : null;
    return (st.message || '').replace(/Retrying in \d+ s…/, retryIn != null ? `Retrying in ${retryIn} s…` : '');
  }

  // ------------------------------------------------------------ Settings (venue profile, reset)
  async function openSettings() {
    const info = RA.native ? await RA.native.info() : { version: 'dev', userData: '(browser storage)' };
    const f = Store.venue.foh || {};
    const demoNote = info.demo ? `<div class="note" style="margin-top:6px"><b>Demo mode.</b> This is a sample hall with simulated Smaart data — nothing here touches your own venue.
      <button class="btn btn-primary btn-sm" id="st-exit-demo" style="margin-left:8px">Exit demo</button></div>` : '';
    openModal('Settings', `${demoNote}
      <div class="section-h">Venue</div>
      <p class="hint"><b>${esc(ROOM.name)}</b> · ${seats.length} seats · ${ROOM.sections.length} section${ROOM.sections.length === 1 ? '' : 's'}
        · FOH at x ${fmt(f.x, 2)}, y ${fmt(f.y, 2)} ${esc(ROOM.units)}</p>
      ${info.demo ? '' : `<div class="chips" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" id="st-new">New venue…</button>
        <button class="btn btn-danger btn-sm" id="st-reset">Reset venue…</button>
      </div>
      <p class="hint small" style="margin-top:8px">New venue and Reset keep a backup of the current venue and its measurements inside Roomio's data.</p>`}
      <div class="section-h">Venue profile</div>
      <p class="hint">One file with this venue's auditorium, FOH, Smaart settings and field mapping — for another computer or a backup. The Smaart password is never included.</p>
      <label class="check"><input type="checkbox" id="st-incl" checked> Include measurements (${Store.readings.length} readings, ${Store.spectra.length} frequency responses)</label>
      <div class="chips" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm" id="st-export">Export venue profile…</button>
        ${info.demo ? '' : '<button class="btn btn-secondary btn-sm" id="st-import">Import venue profile…</button>'}
        ${info.demo ? '' : '<button class="btn btn-secondary btn-sm" id="st-backup" title="Venue + all measurements in one file, saved where you choose">Back up all data…</button>'}
      </div>
      <div class="section-h">Smaart</div>
      <p class="hint">${esc(statusText())}</p>
      <button class="btn btn-secondary btn-sm" id="st-smaart" style="margin-top:6px">Smaart connection…</button>
      <div class="section-h">About</div>
      <p class="hint">Roomio ${esc(info.version)}${info.buildTarget && info.buildTarget !== 'direct' ? ` (${esc(info.buildTarget)} build)` : ''} · data is stored in <code>${esc(info.userData)}</code></p>`,
      '<button class="btn btn-primary btn-sm" data-close>Done</button>');
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('#st-new', () => onMenuAction('new-venue'));
    on('#st-reset', () => onMenuAction('reset-venue'));
    on('#st-export', () => exportProfile($('#st-incl').checked));
    on('#st-import', () => onMenuAction('import-profile'));
    on('#st-backup', () => onMenuAction('backup'));
    on('#st-exit-demo', () => onMenuAction('exit-demo'));
    $('#st-smaart').onclick = openSmaart;
  }

  async function exportProfile(includeMeasurements) {
    if (!RA.native) { toast('Venue profiles work in the desktop app'); return; }
    await Store.flush();
    try {
      const where = await RA.native.profileExport(includeMeasurements);
      if (where) toast('Venue profile saved: ' + where.split(/[\\/]/).pop());
    } catch (e) { toast('Export failed: ' + e.message); }
  }

  // menu + Settings actions: save anything pending first, then hand over to the main process
  async function onMenuAction(action) {
    if (action === 'settings') return openSettings();
    if (action === 'export-profile') return exportProfile(true);
    if (action === 'backup') return exportProfile(true);        // venue + all measurements, via the Save dialog
    if (!RA.native) { toast('This works in the desktop app'); return; }
    await Store.flush();
    closeModal();
    try {
      if (action === 'new-venue') await RA.native.openSetup();
      else if (action === 'reset-venue') await RA.native.venueReset();
      else if (action === 'import-profile') await RA.native.profileImport();
      else if (action === 'exit-demo') await RA.native.demoExit();
    } catch (e) { toast(e.message); }
  }

  let modalCleanup = null;
  function openModal(title, body, footer, cls) {
    closeModal();
    const o = document.createElement('div');
    o.className = 'modal-overlay';
    o.innerHTML = `<div class="modal ${cls || ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-header"><h2 class="modal-title">${esc(title)}</h2><button class="modal-close" data-close aria-label="Close">×</button></div>
      <div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></div>`;
    o.addEventListener('mousedown', (e) => { if (e.target === o) closeModal(); });
    o.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
    document.body.appendChild(o);
    const f = o.querySelector('input:not([type=checkbox]):not([type=file])');
    if (f && window.matchMedia('(pointer:fine)').matches) f.focus();
  }
  function closeModal() {
    const o = $('.modal-overlay');
    if (o) o.remove();
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ra_theme', next); } catch (e) {}
    syncThemeButton();
    render();                                  // diverging scale midpoint is theme-aware
  }
  function syncThemeButton() {
    const b = $('#theme-toggle');
    if (b) b.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
  }

  // top bar + map buttons
  document.addEventListener('DOMContentLoaded', () => {
    $('#theme-toggle').onclick = toggleTheme;
    $('#btn-booth').onclick = () => setMapMode(mapMode === 'booth' ? 'view' : 'booth');
    $('#btn-edit').onclick = () => setMapMode(mapMode === 'edit' ? 'view' : 'edit');
    $('#btn-smaart').onclick = openSmaart;
    $('#smaart-pill').onclick = openSmaart;
    $('#btn-data').onclick = openData;
    $('#btn-settings').onclick = openSettings;
    $('#zoom-in').onclick = () => SeatMap.zoomBy(1.4);
    $('#zoom-out').onclick = () => SeatMap.zoomBy(1 / 1.4);
    $('#zoom-fit').onclick = () => SeatMap.fit();
    boot().catch(err => {
      console.error(err);
      $('#page-title').textContent = 'Could not load the seat map';
      $('#page-subtitle').textContent = err.message;
    });
  });
})();
