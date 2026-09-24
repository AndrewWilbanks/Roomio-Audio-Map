/* setup.js — first-run / new-venue wizard.
   1 import auditorium (JSON or CSV, validated)  2 place FOH (click or type), optional stage
   3 Smaart connection + Test connection          4 review, save -> venue.json */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const native = RA.native;

  const state = {
    step: 1,
    auditorium: null,     // validated auditorium object (file coordinates)
    room: null,           // normalised for the map
    source: null,         // { name, kind: 'json'|'csv', text }
    foh: null,            // { x, y, z? } file coordinates
    placing: 'foh',
    tested: null,         // last Test connection result
  };

  // ------------------------------------------------------------ navigation
  function go(step) {
    state.step = step;
    document.querySelectorAll('.step').forEach(s => { s.hidden = +s.dataset.step !== step; });
    document.querySelectorAll('#stepper li').forEach(li => {
      const n = +li.dataset.step;
      li.classList.toggle('on', n === step);
      li.classList.toggle('done', n < step);
    });
    $('#btn-back').hidden = step === 1;
    $('#btn-next').textContent = step === 4 ? 'Save venue & open' : 'Next';
    $('#nav-err').textContent = '';
    if (step === 2) enterPlacement();
    if (step === 4) renderReview();
    updateNext();
    window.scrollTo(0, 0);
  }

  function canContinue() {
    if (state.step === 1) return !!state.auditorium;
    if (state.step === 2) return !!state.foh;
    return true;
  }
  function updateNext() { $('#btn-next').disabled = !canContinue(); }

  // ------------------------------------------------------------ step 1: import
  // file = { name, text } from the native Open dialog, or a dropped File (drag-and-drop is allowed)
  async function loadFile(file) {
    const text = typeof file.text === 'string' ? file.text : await file.text();
    const kind = /\.csv$|\.txt$/i.test(file.name) || (!/^\s*[{[]/.test(text) && /,/.test(text)) ? 'csv' : 'json';
    state.source = { name: file.name, kind, text };
    if (kind === 'csv') {
      $('#csv-opts').hidden = false;
      if (!$('#csv-name').value) $('#csv-name').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    } else $('#csv-opts').hidden = true;
    parseSource();
  }

  function parseSource() {
    const src = state.source;
    if (!src) return;
    const r = src.kind === 'csv'
      ? Auditorium.parseAuditoriumCsv(src.text, { name: $('#csv-name').value.trim() || 'Imported room', units: $('#csv-units').value, yAxis: $('#csv-yaxis').value })
      : Auditorium.parseAuditoriumJson(src.text);
    state.auditorium = r.ok ? r.auditorium : null;
    state.room = r.ok ? Auditorium.normalise(r.auditorium) : null;
    state.foh = null;
    renderResult(r);
    updateNext();
  }

  function renderResult(r) {
    const box = $('#result');
    box.hidden = false;
    const src = state.source;
    let html = `<div class="result-file">${esc(src.name)} <span class="muted">· ${src.kind.toUpperCase()}</span></div>`;
    if (r.ok) {
      const R = state.room, a = r.auditorium;
      const xs = a.seats.map(s => s.x), ys = a.seats.map(s => s.y);
      const span = (v) => (Math.max(...v) - Math.min(...v)).toFixed(1);
      html += `<div class="result-ok">✓ <b>${esc(a.name)}</b> — ${a.seats.length} seats in ${R.sections.length} section${R.sections.length === 1 ? '' : 's'}
        · ${span(xs)} × ${span(ys)} ${esc(a.units)}${a.background ? ' · with floor-plan image' : ''}${a.stage ? ' · stage set' : ''}</div>
        <div class="result-secs">${R.sections.slice(0, 16).map(s => `<span class="badge none">${esc(s.name)} · ${s.seats}</span>`).join(' ')}${R.sections.length > 16 ? ` <span class="muted small">+${R.sections.length - 16} more</span>` : ''}</div>`;
    } else {
      html += `<div class="result-bad">This file can't be used yet — fix ${r.errors.length === 1 ? 'this' : 'these'} and choose it again:</div>
        <ul class="errs">${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
    }
    if (r.warnings.length) html += `<ul class="warns">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
    box.innerHTML = html;
  }

  // ------------------------------------------------------------ step 2: FOH / stage
  let mapReady = null;                 // room object the map was built for
  function enterPlacement() {
    const R = state.room, a = state.auditorium;
    if (!state.foh) {
      const f = a.foh || { x: R.suggestedFoh.x, y: R.suggestedFoh.y * R.flip };
      state.foh = { x: round(f.x), y: round(f.y) };
    }
    document.querySelectorAll('.unit').forEach(u => { u.textContent = a.units ? `(${a.units})` : ''; });
    $('#chip-stage').textContent = a.stage ? 'Move stage' : 'Place stage (optional)';
    if (mapReady !== R) {
      const wrap = $('#setup-map');
      [...wrap.children].forEach(c => { if (!c.classList.contains('map-tools')) c.remove(); });
      SeatMap.init(wrap, R);
      SeatMap.setSeats(R.seats);
      SeatMap.setMode('booth');
      mapReady = R;
    }
    showFoh();
  }

  const round = (v) => Math.round(v * 1000) / 1000;
  const toMap = (p) => ({ x: p.x, y: p.y * state.room.flip });

  function showFoh() {
    SeatMap.setBooth(toMap(state.foh));
    $('#foh-x').value = state.foh.x;
    $('#foh-y').value = state.foh.y;
    $('#foh-z').value = state.foh.z ?? '';
    updateNext();
  }

  function onMapClick(p) {                       // p in map coordinates
    const file = { x: round(p.x), y: round(p.y * state.room.flip) };
    if (state.placing === 'stage') {
      state.auditorium.stage = { x: file.x, y: file.y, label: (state.auditorium.stage && state.auditorium.stage.label) || 'Stage' };
      // stage changes seat facing + labels: rebuild the map
      state.room = Auditorium.normalise(state.auditorium);
      mapReady = null;
      setPlacing('foh');
      enterPlacement();
      toast('Stage placed — now click FOH if it moved');
      return;
    }
    state.foh = { ...file, z: state.foh && state.foh.z };
    if (state.foh.z == null) delete state.foh.z;
    showFoh();
  }

  function setPlacing(what) {
    state.placing = what;
    document.querySelectorAll('[data-place]').forEach(b => b.classList.toggle('on', b.dataset.place === what));
    $('#place-hint').textContent = what === 'stage'
      ? 'Click the centre front of the stage. Seats will face it, and row numbering reads from it.'
      : 'Click the map where the FOH mix position (the Smaart measurement mic at the booth) is. Or type the position:';
  }

  function onCoordInput() {
    const x = parseFloat($('#foh-x').value), y = parseFloat($('#foh-y').value), z = $('#foh-z').value.trim();
    if (!isFinite(x) || !isFinite(y)) { $('#nav-err').textContent = 'FOH x and y must be numbers.'; state.foh = null; updateNext(); return; }
    if (z !== '' && !isFinite(parseFloat(z))) { $('#nav-err').textContent = 'FOH height must be a number or empty.'; return; }
    $('#nav-err').textContent = '';
    state.foh = { x, y };
    if (z !== '') state.foh.z = parseFloat(z);
    SeatMap.setBooth(toMap(state.foh));
    updateNext();
  }

  // ------------------------------------------------------------ step 3: Smaart
  function smaartCfg() {
    return { host: $('#sm-host').value.trim(), port: parseInt($('#sm-port').value, 10) || null, path: $('#sm-path').value, autoConnect: $('#sm-auto').checked };
  }

  async function testConnection() {
    const out = $('#test-result'), btn = $('#btn-test');
    const cfg = smaartCfg();
    if (!cfg.host) { out.className = 'test-result bad'; out.textContent = 'Enter the Smaart computer\'s host or IP.'; return; }
    if (!(cfg.port >= 1 && cfg.port <= 65535)) { out.className = 'test-result bad'; out.textContent = 'Port must be 1–65535.'; return; }
    if (!native) { out.className = 'test-result'; out.textContent = 'Test connection works in the desktop app.'; return; }
    btn.disabled = true; out.className = 'test-result'; out.textContent = 'Testing…';
    try {
      const r = await native.smaartTest(cfg, $('#sm-pw').value);
      state.tested = r;
      out.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
      out.textContent = (r.ok ? '✓ ' : '✕ ') + r.message;
    } catch (e) { out.className = 'test-result bad'; out.textContent = '✕ ' + e.message; }
    btn.disabled = false;
  }

  // ------------------------------------------------------------ step 4: review + save
  function renderReview() {
    const a = state.auditorium, c = smaartCfg(), R = state.room;
    const f = state.foh;
    $('#review').innerHTML = `
      <dt>Venue</dt><dd><b>${esc(a.name)}</b> · ${a.seats.length} seats · ${R.sections.length} section${R.sections.length === 1 ? '' : 's'}</dd>
      <dt>FOH</dt><dd>x ${f.x}, y ${f.y}${f.z != null ? `, z ${f.z}` : ''} ${esc(a.units)}</dd>
      <dt>Stage</dt><dd>${a.stage ? `x ${a.stage.x}, y ${a.stage.y}` : '<span class="muted">not set</span>'}</dd>
      <dt>Smaart</dt><dd>ws://${esc(c.host)}:${c.port}${esc(c.path)} ${$('#sm-pw').value ? '· password saved (encrypted)' : ''}
        ${state.tested ? (state.tested.ok ? '<span class="badge live">tested OK</span>' : '<span class="badge stale">last test failed</span>') : '<span class="badge none">not tested</span>'}</dd>`;
    if (native) native.info().then(i => { $('#save-where').textContent = `Saved as venue.json in ${i.userData}`; });
  }

  async function save() {
    const venue = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      auditorium: state.auditorium,
      foh: state.foh,
      smaart: smaartCfg(),
      seatEdits: { deleted: [], added: [], labels: {} },
      preferences: {},
    };
    const btn = $('#btn-next');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (native) await native.setupComplete(venue, $('#sm-pw').value);
      else { await RA.venue.save(venue); await RA.data.save({ readings: [], spectra: [] }); location.href = 'index.html'; }
    } catch (e) {
      $('#nav-err').textContent = 'Could not save: ' + e.message;
      btn.disabled = false; btn.textContent = 'Save venue & open';
    }
  }

  // ------------------------------------------------------------ misc
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function loadExample() {
    let text;
    try {
      text = native && native.example ? await native.example() : await (await fetch('examples/example-hall.auditorium.json')).text();
    } catch (e) { toast('Could not load the example: ' + e.message); return; }
    state.source = { name: 'example-hall.auditorium.json', kind: 'json', text };
    $('#csv-opts').hidden = true;
    parseSource();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    // pre-fill Smaart's factory settings (saved into venue.json, which is what's used from then on)
    $('#sm-host').value = SMAART_DEFAULTS.host;
    $('#sm-port').value = SMAART_DEFAULTS.port;
    $('#sm-path').value = SMAART_DEFAULTS.path;
    const drop = $('#drop');
    const choose = async () => {
      try { const f = await RA.openTextFile('auditorium'); if (f) loadFile(f); }
      catch (e) { toast('Could not open the file: ' + e.message); }
    };
    drop.addEventListener('click', choose);
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
    ['#csv-name', '#csv-units', '#csv-yaxis'].forEach(id => $(id).addEventListener('change', parseSource));
    $('#btn-example').onclick = loadExample;
    $('#btn-demo').onclick = async () => {
      if (!native) { toast('Demo mode works in the desktop app'); return; }
      try { await native.demoStart(); } catch (e) { toast('Could not start the demo: ' + e.message); }
    };
    const importProfile = async () => {
      if (!native) { toast('Venue profiles work in the desktop app'); return; }
      try { await native.profileImport(); } catch (e) { toast(e.message); }
    };
    $('#btn-profile').onclick = importProfile;
    if (native) native.onMenu((a) => { if (a === 'import-profile') importProfile(); });

    SeatMap.on('boothPlaced', onMapClick);
    document.querySelectorAll('[data-place]').forEach(b => b.onclick = () => setPlacing(b.dataset.place));
    ['#foh-x', '#foh-y', '#foh-z'].forEach(id => $(id).addEventListener('input', onCoordInput));
    $('#zoom-in').onclick = () => SeatMap.zoomBy(1.4);
    $('#zoom-out').onclick = () => SeatMap.zoomBy(1 / 1.4);
    $('#zoom-fit').onclick = () => SeatMap.fit();

    $('#btn-test').onclick = testConnection;
    ['#sm-host', '#sm-port', '#sm-path', '#sm-pw'].forEach(id => $(id).addEventListener('input', () => { state.tested = null; $('#test-result').textContent = ''; }));

    $('#btn-back').onclick = () => go(state.step - 1);
    $('#btn-next').onclick = () => { if (!canContinue()) return; if (state.step === 4) save(); else go(state.step + 1); };

    // opened from Settings → New venue: allow going back to the current venue
    if (native && await native.hasVenue()) {
      $('#btn-cancel').hidden = false;
      $('#btn-cancel').onclick = () => native.setupCancel();
    }
    go(1);
  });
})();
