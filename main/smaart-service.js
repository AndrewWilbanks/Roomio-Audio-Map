// smaart-service.js — the live Smaart API connection, owned by the main process.
// Handles: connect, handshake, password login (password never leaves this process),
// keepalive, reconnect with backoff. The window only gets status + messages.
//
// Two modes (venue.smaart.mode):
//   'v4' (default) — Smaart v9 built in (renderer/js/smaart-v4.js): finds the calibrated SPL inputs
//                    and spectrum measurements, opens their stream endpoints and forwards each frame
//                    as a normalised envelope. Nothing to set up beyond host/port (and password).
//   'custom'       — sends the user's poll messages and forwards raw replies for field mapping.
const EventEmitter = require('events');
const WebSocket = require('ws');
const { smaartUrl, checkConfig, describeError } = require('./smaart-test');
const V4 = require('../renderer/js/smaart-v4.js');

const BACKOFF = [1000, 2000, 4000, 8000, 15000];   // ms between reconnect attempts, then stays at 15 s
const SOURCE_REFRESH_MS = 5000;                     // re-ask Smaart what's running (measurements start/stop)

class SmaartService extends EventEmitter {
  constructor(getPassword) {
    super();
    this.getPassword = getPassword;
    this.cfg = null;
    this.ws = null;
    this.wanted = false;
    this.attempt = 0;
    this.seq = 1;
    this.keepSeqs = new Set();
    this.pending = new Map();          // sequenceNumber -> 'inputs' | 'measurements'
    this.streams = new Map();          // endpoint -> {ws, kind, label, roles, open}
    this.timers = {};
    this.state = { status: 'off', message: 'Not connected', url: '', attempt: 0, nextRetryAt: null, since: null,
      server: null, sources: null, streams: [] };
  }

  get v4() { return !this.cfg || this.cfg.mode !== 'custom'; }

  setStatus(status, message, extra = {}) {
    this.state = { ...this.state, status, message, attempt: this.attempt, ...extra };
    this.emit('status', this.state);
  }

  connect(cfg) {
    this.stop(true);
    const bad = checkConfig(cfg);                    // values come from venue.json — no silent defaults
    if (bad) { this.setStatus('error', bad, { nextRetryAt: null }); return; }
    this.cfg = { ...cfg };
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  open() {
    clearTimeout(this.timers.retry);
    if (!this.wanted) return;
    const url = smaartUrl(this.cfg);
    this.attempt++;
    this.setStatus('connecting', this.attempt > 1 ? `Reconnecting (attempt ${this.attempt})…` : 'Connecting…', { url, nextRetryAt: null });
    let ws;
    try { ws = new WebSocket(url, { handshakeTimeout: 5000 }); }
    catch (e) { this.setStatus('error', `Invalid Smaart address: ${e.message}`); this.wanted = false; return; }
    this.ws = ws;
    this.authFailed = false;
    this.ready = false;

    ws.on('open', () => {
      this.attempt = 0;
      this.seq = 1;
      this.keepSeqs.clear();
      this.pending.clear();
      this.setStatus('live', 'Connected to Smaart', { since: Date.now() });
      this.send({ sequenceNumber: this.seq++, action: 'get' });          // handshake
      this.startTimers();
    });
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('unexpected-response', (_req, res) => {
      this.lastError = res.statusCode === 404 ? `Smaart answered, but not at "${this.cfg.path}". Check the Smaart version setting.` : `Smaart refused the connection (HTTP ${res.statusCode}).`;
    });
    ws.on('error', (e) => { this.lastError = describeError(e, this.cfg); });
    ws.on('close', () => {
      this.stopTimers();
      this.closeStreams();
      if (this.ws === ws) this.ws = null;
      if (!this.wanted) return;
      if (this.authFailed) return;                     // don't hammer Smaart with a bad password
      // attempt = failed tries since the last good connection: 0 → 1 s, 1 → 2 s, … capped at 15 s
      const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.setStatus('connecting', `${this.lastError || 'Connection lost.'} Retrying in ${Math.round(delay / 1000)} s…`, { nextRetryAt: Date.now() + delay });
      this.timers.retry = setTimeout(() => this.open(), delay);
    });
  }

  onMessage(raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) { /* non-JSON is still shown in the console */ }
    const resp = msg && msg.response;
    const asked = msg && this.pending.get(msg.sequenceNumber);
    if (asked) this.pending.delete(msg.sequenceNumber);
    if (resp && resp.error !== undefined) {
      if (/password/i.test(String(resp.error))) {
        this.authFailed = true;
        this.stop(true);                               // don't retry with a bad password…
        this.setStatus('error', 'Smaart rejected the API password. Update it in the Smaart settings.');   // …but keep the error visible
        return;
      }
      if (/authentication required/i.test(String(resp.error))) { this.login(); return; }
      if (asked) { this.gotSources(asked, null); return; }   // e.g. Smaart RT has no calibrated inputs
      this.emit('log', { dir: 'err', text: 'Smaart: ' + resp.error });
      return;
    }
    if (resp && resp.applicationName) this.state.server = { name: resp.applicationName, version: resp.applicationVersion || '' };
    if (resp && resp.authenticationRequired) { this.login(); return; }
    if (asked) { this.gotSources(asked, resp); return; }
    if (!this.ready && resp) {                          // first non-auth reply: logged in (or no password)
      this.ready = true;
      const sv = this.state.server;
      this.setStatus('live', sv ? `Connected to ${sv.name}${sv.version ? ' ' + sv.version : ''}` : 'Connected to Smaart');
      if (this.v4) this.refreshSources();
    }
    if (msg && this.keepSeqs.has(msg.sequenceNumber)) return;   // keepalive replies aren't data
    if (this.v4 && resp) return;                                 // v4 data arrives on the streams
    this.emit('message', raw);
  }

  login() {
    const pw = this.getPassword();
    if (pw) {
      this.send({ sequenceNumber: this.seq++, ...V4.Q.password(pw) }, true);
      this.emit('log', { dir: 'out', text: '(sent API password)' });
      this.send({ sequenceNumber: this.seq++, action: 'get' }, true);   // its reply confirms the login
    } else if (this.state.status !== 'auth') {
      this.setStatus('auth', 'Smaart needs its API password. Enter it in the Smaart settings.');
    }
  }

  // ---- Smaart v9: discover sources and keep their streams open ----
  refreshSources() {
    if (!this.ready) return;
    this.found = { inputs: null, measurements: null };
    for (const kind of ['inputs', 'measurements']) {
      const n = this.seq++;
      this.pending.set(n, kind);
      this.send({ sequenceNumber: n, ...V4.Q[kind] }, true);
    }
  }

  gotSources(kind, resp) {
    if (!this.found) return;
    this.found[kind] = kind === 'inputs' ? V4.parseInputs(resp) : V4.parseMeasurements(resp);
    if (this.found.inputs === null || this.found.measurements === null) return;
    const sources = { inputs: this.found.inputs, measurements: this.found.measurements };
    const sig = JSON.stringify(sources);
    if (sig !== this.sourcesSig) {
      this.sourcesSig = sig;
      this.state.sources = sources;
      this.emit('log', { dir: 'in', text: `Smaart: ${sources.inputs.length} calibrated SPL input(s), ${sources.measurements.length} running spectrum measurement(s)` });
      this.emit('status', this.state);
    }
    this.syncStreams();
  }

  syncStreams() {
    const want = V4.resolveStreams(this.state.sources, this.cfg.sources);
    const byEndpoint = new Map();
    for (const w of want) {
      const e = byEndpoint.get(w.endpoint) || { kind: w.kind, label: w.label, roles: [] };
      e.roles.push(w.role);
      byEndpoint.set(w.endpoint, e);
    }
    for (const [ep, s] of this.streams) if (!byEndpoint.has(ep)) this.closeStream(ep, s);
    for (const [ep, w] of byEndpoint) {
      const cur = this.streams.get(ep);
      if (cur) cur.roles = w.roles;
      else this.openStream(ep, w);
    }
    this.publishStreams();
  }

  openStream(endpoint, w) {
    let url;
    try { url = V4.streamUrl(smaartUrl(this.cfg), endpoint); } catch (e) { return; }
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    const s = { ws, kind: w.kind, label: w.label, roles: w.roles, open: false };
    this.streams.set(endpoint, s);
    ws.on('open', () => {
      s.open = true;
      const pw = this.getPassword();
      if (pw) ws.send(JSON.stringify(V4.Q.password(pw)));           // harmless if the stream doesn't need it
      ws.send(JSON.stringify(V4.Q.fps(V4.STREAM_FPS[w.kind])));
      if (w.kind === 'spectrum') ws.send(JSON.stringify(V4.Q.banding(V4.SPECTRUM_BANDING)));
      this.emit('log', { dir: 'out', text: `streaming ${w.kind === 'spl' ? 'SPL' : 'spectrum'} "${w.label}" → ${s.roles.join(' + ')}` });
      this.publishStreams();
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      if (msg && msg.response && msg.response.error) { this.emit('log', { dir: 'err', text: `Smaart (${w.label}): ${msg.response.error}` }); return; }
      for (const role of s.roles) {
        const env = V4.envelope(role, s.kind, msg);
        if (env) this.emit('message', JSON.stringify(env));
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {                                            // reopened on the next source refresh
      if (this.streams.get(endpoint) === s) { this.streams.delete(endpoint); this.publishStreams(); }
    });
  }

  closeStream(endpoint, s) {
    this.streams.delete(endpoint);
    s.ws.removeAllListeners('close');
    try { s.ws.terminate(); } catch (e) {}
  }
  closeStreams() { for (const [ep, s] of this.streams) this.closeStream(ep, s); this.publishStreams(true); }

  publishStreams(quiet) {
    const list = [...this.streams.values()].map(s => ({ kind: s.kind, label: s.label, roles: s.roles, open: s.open }));
    const sig = JSON.stringify(list);
    if (sig === this.streamsSig) return;
    this.streamsSig = sig;
    this.state.streams = list;
    if (!quiet) this.emit('status', this.state);
  }

  send(obj, quiet) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.ws.send(text);
    if (!quiet) this.emit('log', { dir: 'out', text: text.slice(0, 2000) });
    return true;
  }

  startTimers() {
    this.stopTimers();
    // keepalive: a bare "get" about once a second, like other Smaart clients
    this.timers.keep = setInterval(() => {
      this.keepSeqs.add(this.seq);
      if (this.keepSeqs.size > 50) this.keepSeqs.delete(this.keepSeqs.values().next().value);
      this.send({ sequenceNumber: this.seq++, action: 'get' }, true);
    }, 1000);
    if (this.v4) {
      this.timers.sources = setInterval(() => this.refreshSources(), SOURCE_REFRESH_MS);
      return;
    }
    const lines = String(this.cfg.pollMessages || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) {
      const tick = () => lines.forEach(l => this.send(l, true));
      tick();
      this.timers.poll = setInterval(tick, Math.max(100, +this.cfg.pollMs || 500));
    }
  }
  stopTimers() { clearInterval(this.timers.keep); clearInterval(this.timers.poll); clearInterval(this.timers.sources); }

  // user pressed Disconnect (or a hard failure): stop and don't retry
  stop(silent) {
    this.wanted = false;
    clearTimeout(this.timers.retry);
    this.stopTimers();
    this.closeStreams();
    this.state.sources = null; this.sourcesSig = null;
    if (this.ws) { this.ws.removeAllListeners('close'); try { this.ws.terminate(); } catch (e) {} this.ws = null; }
    if (silent) this.state = { ...this.state, status: 'off', message: 'Not connected', nextRetryAt: null };
    else this.setStatus('off', 'Disconnected', { nextRetryAt: null });
  }
  retryNow() { if (this.cfg) { this.wanted = true; this.attempt = 0; this.open(); } }
}

module.exports = { SmaartService };
