/* smaart.js — the page's view of the Smaart connection.
   The socket, handshake, password login, keepalive, polling and reconnects all run in the
   main process (main/smaart-service.js). This module turns the raw messages it forwards
   into booth / roaming-mic values and spectra, using the field mapping from the venue:
     - "paths"          = where each metric's number lives in Smaart's replies
     - "spectrum path"  = an RTA/spectrum array, used for the FOH response and band levels
   The Smaart dialog's live message list lets you set these by clicking. */
(function () {
  const native = RA.native;
  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, data) => {
    listeners[ev] = (listeners[ev] || []).filter(fn => !fn.dead);   // fn.dead = unsubscribed
    listeners[ev].forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  };

  // status from the main process: off | connecting | live | auth | error
  let state = { status: 'off', message: native ? 'Not connected' : 'Live Smaart needs the desktop app', attempt: 0, nextRetryAt: null };
  const live = {};        // booth metric -> {value, t}
  const liveSeat = {};    // roaming-mic metric -> {value, t}
  const liveSpec = {};    // 'booth' | 'seat' -> {thirds[31], t}  (frequency response)
  let lastMessage = null;
  const log = [];         // [{dir:'in'|'out'|'err', text, t}]
  const STALE_MS = 5000;
  const cfg = () => Store.settings.smaart;

  function addLog(dir, text) {
    log.push({ dir, text: String(text).slice(0, 2000), t: Date.now() });
    if (log.length > 60) log.shift();
    emit('log', log);
  }

  if (native) {
    native.onSmaartStatus((s) => {
      const changed = s.status !== state.status || s.message !== state.message;
      state = s;
      if (changed && s.status !== 'live') addLog(s.status === 'error' || s.status === 'auth' ? 'err' : 'out', s.message);
      if (changed && s.status === 'live') addLog('out', `connected ${s.url}`);
      emit('status', { status: s.status, msg: s.message });
    });
    native.onSmaartMessage(handle);
    native.onSmaartLog((l) => addLog(l.dir, l.text));
    native.smaartStatus().then(s => { state = s; emit('status', { status: s.status, msg: s.message }); });
  }

  // settings the main process needs to (re)connect — password stays in the main process
  const connCfg = () => { const c = cfg(); return { host: c.host, port: c.port, path: c.path, pollMs: c.pollMs, pollMessages: c.pollMessages, autoConnect: c.autoConnect }; };
  function connect() { if (native) { addLog('out', 'connecting…'); native.smaartConnect(connCfg()); } }
  function disconnect() { if (native) native.smaartDisconnect(); }
  function retryNow() { if (native) native.smaartRetry(); }
  function send(text) {
    if (!native || state.status !== 'live') return false;
    native.smaartSend(text);
    addLog('out', text);
    return true;
  }

  // ---- parsing ----
  function getPath(obj, path) {
    if (!path) return undefined;
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      // "name=Booth" selects the array element whose name/label/id matches
      const m = p.match(/^(\w+)=(.+)$/);
      if (m && Array.isArray(cur)) cur = cur.find(e => e && String(e[m[1]]) === m[2]);
      else cur = cur[p];
    }
    return cur;
  }

  // Accepts [[f,db],...], [{f|freq|frequency, db|mag|magnitude|value|level}], or {freqs|frequencies:[], mags|magnitudes|values|levels:[]}
  function toBins(v) {
    if (!v) return null;
    if (Array.isArray(v)) {
      if (!v.length) return null;
      if (Array.isArray(v[0])) return v.map(p => [+p[0], +p[1]]);
      if (typeof v[0] === 'object') {
        const fk = ['f', 'freq', 'frequency', 'hz'].find(k => k in v[0]);
        const vk = ['db', 'dB', 'mag', 'magnitude', 'value', 'level', 'spl'].find(k => k in v[0]);
        if (fk && vk) return v.map(p => [+p[fk], +p[vk]]);
      }
      return null;
    }
    if (typeof v === 'object') {
      const fs = v.freqs || v.frequencies || v.f;
      const ms = v.mags || v.magnitudes || v.values || v.levels || v.db;
      if (Array.isArray(fs) && Array.isArray(ms)) return fs.map((f, i) => [+f, +ms[i]]);
    }
    return null;
  }

  function smooth(store, key, value) {
    const a = Math.max(0, Math.min(0.95, +cfg().smoothing || 0));
    const prev = store[key];
    const v = prev && Date.now() - prev.t < 2000 ? prev.value * a + value * (1 - a) : value;
    store[key] = { value: v, t: Date.now() };
  }

  function smoothThirds(key, t) {
    const a = Math.max(0, Math.min(0.95, +cfg().smoothing || 0));
    const prev = liveSpec[key];
    const fresh = prev && Date.now() - prev.t < 2000;
    liveSpec[key] = { thirds: t.map((v, i) => v == null ? null : (fresh && prev.thirds[i] != null ? prev.thirds[i] * a + v * (1 - a) : v)), t: Date.now() };
  }

  function handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { addLog('in', raw); return; }
    addLog('in', raw);
    lastMessage = msg;
    const c = cfg();
    let changed = false;
    for (const m of MEASURED) {
      const bv = Number(getPath(msg, c.paths[m.id]));
      if (c.paths[m.id] && isFinite(bv)) { smooth(live, m.id, bv); changed = true; }
      const sv = Number(getPath(msg, c.seatPaths[m.id]));
      if (c.seatPaths[m.id] && isFinite(sv)) { smooth(liveSeat, m.id, sv); changed = true; }
    }
    if (c.seatSpectrumPath) {
      const t = toThirds(toBins(getPath(msg, c.seatSpectrumPath)));
      if (t) { smoothThirds('seat', t); changed = true; }
    }
    if (c.spectrumPath) {
      const t = toThirds(toBins(getPath(msg, c.spectrumPath)));
      if (t) {
        smoothThirds('booth', t); changed = true;
        for (const m of MEASURED) {
          if (!m.band || c.paths[m.id]) continue;     // a direct path wins
          const lv = bandFromThirds(t, m.band[0], m.band[1]);   // same math as captured curves
          if (lv != null) { smooth(live, m.id, lv); changed = true; }
        }
      }
    }
    emit('message', msg);
    if (changed) emit('values', live);
  }

  // every numeric leaf in a message, for the click-to-map picker
  function leaves(obj, prefix = '', out = []) {
    if (out.length > 400) return out;
    if (typeof obj === 'number') out.push([prefix, obj]);
    else if (Array.isArray(obj)) {
      const named = obj.length && obj.every(e => e && typeof e === 'object' && ('name' in e || 'label' in e));
      obj.slice(0, 64).forEach((e, i) => {
        const key = named ? `${prefix}.${'name' in e ? 'name' : 'label'}=${e.name ?? e.label}` : `${prefix}[${i}]`;
        leaves(e, key, out);
      });
    } else if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) leaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  const fresh = (e) => e && Date.now() - e.t < STALE_MS;
  window.Smaart = {
    on, connect, disconnect, retryNow, send, getPath, leaves, toBins,
    available: !!native,
    // settings changed (poll messages, address): reconnect with the new ones
    restartPolling: () => { if (state.status !== 'off') connect(); },
    setPassword: (pw) => native ? native.smaartSetPassword(pw) : Promise.resolve(false),
    hasPassword: () => native ? native.hasPassword() : Promise.resolve(false),
    get status() { return state.status; }, get statusMsg() { return state.message; },
    get state() { return state; },
    get log() { return log; }, get lastMessage() { return lastMessage; },
    // booth value for a metric: live Smaart if fresh, else manual
    booth(metric) {
      if (fresh(live[metric])) return { value: live[metric].value, source: 'live' };
      const man = Store.settings.manualBooth[metric];
      if (man != null && man !== '' && isFinite(man)) return { value: +man, source: live[metric] ? 'stale-manual' : 'manual' };
      if (live[metric]) return { value: live[metric].value, source: 'stale' };
      return { value: null, source: 'none' };
    },
    seatLive(metric) { return fresh(liveSeat[metric]) ? liveSeat[metric].value : null; },
    // live third-octave response: which = 'booth' | 'seat'
    liveSpectrum(which) { return fresh(liveSpec[which]) ? liveSpec[which].thirds.slice() : null; },
    liveSpectrumTime(which) { return fresh(liveSpec[which]) ? liveSpec[which].t : 0; },
    hasSeatSource() { return Object.values(cfg().seatPaths || {}).some(Boolean) || !!cfg().seatSpectrumPath; },
  };
})();
