// smaart-test.js — one-shot "Test connection" for the setup wizard and Smaart settings,
// plus the shared helpers for building the Smaart URL and wording connection errors.
// Connects, does Smaart's handshake ({"sequenceNumber":1,"action":"get"}), logs in if Smaart
// asks for the API password, lists the SPL inputs / spectrum measurements Smaart v9 offers,
// and reports back in plain language.
const WebSocket = require('ws');
const V4 = require('../renderer/js/smaart-v4.js');

// Connection values come from venue.json only: a missing host or port is an error, not a default.
function checkConfig(cfg) {
  if (!cfg || !String(cfg.host || '').trim()) return 'Smaart host isn\'t set — enter it in the Smaart settings.';
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Smaart port isn\'t set (1–65535) — enter it in the Smaart settings.';
  return null;
}

function smaartUrl(cfg) {
  const err = checkConfig(cfg);
  if (err) throw new Error(err);
  let p = cfg.path == null ? '' : String(cfg.path).trim();
  if (p && !p.startsWith('/')) p = '/' + p;
  const host = String(cfg.host).trim();
  return `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${Number(cfg.port)}${p}`;
}

// Plain-language wording for socket errors (used by the test and the live service)
function describeError(e, cfg) {
  const where = `${cfg && cfg.host}:${cfg && cfg.port}`;
  const code = e && (e.code || (e.cause && e.cause.code));
  const msg = String(e && e.message || e || '');
  if (code === 'ECONNREFUSED') return `Nothing is listening at ${where}. Start Smaart and enable its API (Options → Preferences → API).`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't find a computer called "${cfg && cfg.host}". Check the host name or use its IP address.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') {
    return process.platform === 'darwin'
      ? `Can't reach ${where}. Check the network — and that Roomio is allowed on the local network (System Settings → Privacy & Security → Local Network).`
      : `Can't reach ${where}. Check the network cable/Wi-Fi and the host address.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return process.platform === 'darwin'
      ? 'Roomio isn\'t allowed to use the local network. Turn it on in System Settings → Privacy & Security → Local Network.'
      : 'The connection was blocked (permission denied). Check firewall settings for Roomio.';
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return `No answer from ${where} in time. Check that Smaart is running and the host/port are right, and that a firewall isn't blocking port ${cfg && cfg.port}.`;
  if (code === 'ECONNRESET') return 'Smaart closed the connection. Check that its API is enabled, then retry.';
  return `Could not connect: ${msg || code || 'unknown error'}`;
}

function testConnection(cfg, password, timeoutMs = 5000) {
  const bad = checkConfig(cfg);
  if (bad) return Promise.resolve({ ok: false, message: bad, code: 'config' });
  const url = smaartUrl(cfg);
  return new Promise((resolve) => {
    let ws, done = false, stage = 'connect';
    const finish = (ok, message, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.terminate(); } catch (e) {}
      resolve({ ok, message, url, ...extra });
    };
    const timer = setTimeout(() => stage === 'discover'
      ? (found.inputs = found.inputs || [], found.measurements = found.measurements || [], finish(true, summary(), { sources: found, server }))
      : finish(false, stage === 'connect'
      ? describeError({ code: 'ETIMEDOUT' }, cfg)
      : 'Smaart connected but didn\'t answer the handshake. Check the Smaart version setting (v9 uses /api/v4/).', { code: 'timeout' }), timeoutMs);

    try { ws = new WebSocket(url, { handshakeTimeout: timeoutMs }); }
    catch (e) { finish(false, `Invalid address: ${e.message}`); return; }

    ws.on('open', () => {
      stage = 'handshake';
      ws.send(JSON.stringify({ sequenceNumber: 1, action: 'get' }));
    });
    let server = null, found = null;
    const summary = () => {
      const name = server ? `${server.name}${server.version ? ' ' + server.version : ''}` : 'Smaart';
      if (!found) return `Connected to ${name}.`;
      const n = (a, one, many) => `${a.length} ${a.length === 1 ? one : many}`;
      const list = (a) => a.length ? ` (${a.slice(0, 3).join(', ')}${a.length > 3 ? ', …' : ''})` : '';
      return `Connected to ${name}: ${n(found.inputs, 'calibrated SPL input', 'calibrated SPL inputs')}${list(found.inputs.map(V4.splKey))}, ` +
        `${n(found.measurements, 'running spectrum measurement', 'running spectrum measurements')}${list(found.measurements.map(m => m.measurement))}.` +
        (!found.inputs.length && !found.measurements.length ? ' Calibrate an input or start a spectrum measurement in Smaart to get live data.' : '');
    };
    // Smaart v9: ask what's available, like the live connection does (seq 10/11)
    const discover = () => {
      stage = 'discover';
      found = { inputs: null, measurements: null };
      ws.send(JSON.stringify({ sequenceNumber: 10, ...V4.Q.inputs }));
      ws.send(JSON.stringify({ sequenceNumber: 11, ...V4.Q.measurements }));
    };
    const gotSource = (seq, resp) => {
      if (seq === 10) found.inputs = V4.parseInputs(resp);
      else found.measurements = V4.parseMeasurements(resp);
      if (found.inputs && found.measurements) finish(true, (stage2 === 'confirm' ? 'Logged in. ' : '') + summary(), { sources: found, server });
    };
    let stage2 = '';
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      const resp = msg && msg.response;
      if (resp && resp.applicationName) server = { name: resp.applicationName, version: resp.applicationVersion || '' };
      if (stage === 'discover' && (msg.sequenceNumber === 10 || msg.sequenceNumber === 11)) {
        return gotSource(msg.sequenceNumber, resp && resp.error === undefined ? resp : null);   // an error = edition without it
      }
      if (resp && resp.error !== undefined) {
        return finish(false, /password/i.test(String(resp.error))
          ? 'Smaart rejected the API password.' : `Smaart returned an error: ${resp.error}`, { code: 'smaart-error' });
      }
      if (stage === 'handshake' && resp && resp.authenticationRequired) {
        if (!password) return finish(false, 'Connected, but Smaart requires its API password. Enter it and test again.', { code: 'password-required' });
        stage = 'auth';
        ws.send(JSON.stringify({ sequenceNumber: 2, action: 'set', properties: [{ password }] }));
        return;
      }
      if (stage === 'auth') {
        // Smaart answers the login; confirm with one more get
        stage = 'confirm';
        ws.send(JSON.stringify({ sequenceNumber: 3, action: 'get' }));
        return;
      }
      if (stage === 'discover') return;
      stage2 = stage;
      if (cfg.mode !== 'custom') return discover();
      finish(true, stage === 'confirm' ? `Connected and logged in to ${server ? server.name : 'Smaart'}.` : summary(), { sample: String(raw).slice(0, 400) });
    });
    ws.on('unexpected-response', (req, res) => finish(false,
      res.statusCode === 404 ? `Smaart is there, but not at path "${cfg.path}". Smaart v9 uses /api/v4/, Smaart 8 uses /api/v3/.` : `Smaart refused the connection (HTTP ${res.statusCode}).`));
    ws.on('error', (e) => finish(false, describeError(e, cfg), { code: e.code }));
  });
}

module.exports = { testConnection, smaartUrl, checkConfig, describeError };
