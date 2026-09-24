// smaart-service.js — the live Smaart API connection, owned by the main process.
// Handles: connect, handshake, password login (password never leaves this process),
// keepalive, poll messages, reconnect with backoff. The window only gets status + messages.
const EventEmitter = require('events');
const WebSocket = require('ws');
const { smaartUrl, checkConfig, describeError } = require('./smaart-test');

const BACKOFF = [1000, 2000, 4000, 8000, 15000];   // ms between reconnect attempts, then stays at 15 s

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
    this.timers = {};
    this.state = { status: 'off', message: 'Not connected', url: '', attempt: 0, nextRetryAt: null, since: null };
  }

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

    ws.on('open', () => {
      this.attempt = 0;
      this.seq = 1;
      this.keepSeqs.clear();
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
    if (resp && resp.error !== undefined) {
      if (/password/i.test(String(resp.error))) {
        this.authFailed = true;
        this.stop(true);                               // don't retry with a bad password…
        this.setStatus('error', 'Smaart rejected the API password. Update it in the Smaart settings.');   // …but keep the error visible
        return;
      }
      this.emit('log', { dir: 'err', text: 'Smaart: ' + resp.error });
      return;
    }
    if (resp && resp.authenticationRequired) {
      const pw = this.getPassword();
      if (pw) {
        this.send({ sequenceNumber: this.seq++, action: 'set', properties: [{ password: pw }] }, true);
        this.emit('log', { dir: 'out', text: '(sent API password)' });
      } else if (this.state.status !== 'auth') {
        this.setStatus('auth', 'Smaart needs its API password. Enter it in the Smaart settings.');
      }
      return;
    }
    if (msg && this.keepSeqs.has(msg.sequenceNumber)) return;   // keepalive replies aren't data
    this.emit('message', raw);
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
    const lines = String(this.cfg.pollMessages || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) {
      const tick = () => lines.forEach(l => this.send(l, true));
      tick();
      this.timers.poll = setInterval(tick, Math.max(100, +this.cfg.pollMs || 500));
    }
  }
  stopTimers() { clearInterval(this.timers.keep); clearInterval(this.timers.poll); }

  // user pressed Disconnect (or a hard failure): stop and don't retry
  stop(silent) {
    this.wanted = false;
    clearTimeout(this.timers.retry);
    this.stopTimers();
    if (this.ws) { this.ws.removeAllListeners('close'); try { this.ws.terminate(); } catch (e) {} this.ws = null; }
    if (silent) this.state = { ...this.state, status: 'off', message: 'Not connected', nextRetryAt: null };
    else this.setStatus('off', 'Disconnected', { nextRetryAt: null });
  }
  retryNow() { if (this.cfg) { this.wanted = true; this.attempt = 0; this.open(); } }
}

module.exports = { SmaartService };
