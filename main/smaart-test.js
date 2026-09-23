// smaart-test.js — one-shot "Test connection" for the setup wizard and Smaart settings.
// Connects, does Smaart's handshake ({"sequenceNumber":1,"action":"get"}), logs in if Smaart
// asks for the API password, and reports back in plain language.
const WebSocket = require('ws');

function smaartUrl({ host, port, path }) {
  let p = path == null ? '/api/v4/' : String(path).trim();
  if (p && !p.startsWith('/')) p = '/' + p;
  return `ws://${host || 'localhost'}:${port || 26000}${p}`;
}

function testConnection(cfg, password, timeoutMs = 5000) {
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
      ? `No answer from ${url}. Check that Smaart is running, its API is enabled, and the host/port are right.`
      : 'Smaart connected but didn\'t answer the handshake. Check the API path (v9 uses /api/v4/).'), timeoutMs);

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
    ws.on('error', (e) => finish(false, e.code === 'ECONNREFUSED'
      ? `Nothing is listening at ${cfg.host || 'localhost'}:${cfg.port || 26000}. Start Smaart and enable its API (Options → Preferences → API).`
      : e.code === 'ENOTFOUND' ? `Can't find a computer called "${cfg.host}".` : `Could not connect: ${e.message}`));
  });
}

module.exports = { testConnection, smaartUrl };
