// smaart-test.js — one-shot "Test connection" for the setup wizard and Smaart settings,
// plus the shared helpers for building the Smaart URL and wording connection errors.
// Connects, does Smaart's handshake ({"sequenceNumber":1,"action":"get"}), logs in if Smaart
// asks for the API password, and reports back in plain language.
const WebSocket = require('ws');

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
    const timer = setTimeout(() => finish(false, stage === 'connect'
      ? describeError({ code: 'ETIMEDOUT' }, cfg)
      : 'Smaart connected but didn\'t answer the handshake. Check the Smaart version setting (v9 uses /api/v4/).', { code: 'timeout' }), timeoutMs);

    try { ws = new WebSocket(url, { handshakeTimeout: timeoutMs }); }
    catch (e) { finish(false, `Invalid address: ${e.message}`); return; }

    ws.on('open', () => {
      stage = 'handshake';
      ws.send(JSON.stringify({ sequenceNumber: 1, action: 'get' }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      const resp = msg && msg.response;
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
      finish(true, stage === 'confirm' ? 'Connected and logged in to Smaart.' : 'Connected to Smaart.', { sample: String(raw).slice(0, 400) });
    });
    ws.on('unexpected-response', (req, res) => finish(false,
      res.statusCode === 404 ? `Smaart is there, but not at path "${cfg.path}". Smaart v9 uses /api/v4/, Smaart 8 uses /api/v3/.` : `Smaart refused the connection (HTTP ${res.statusCode}).`));
    ws.on('error', (e) => finish(false, describeError(e, cfg), { code: e.code }));
  });
}

module.exports = { testConnection, smaartUrl, checkConfig, describeError };
