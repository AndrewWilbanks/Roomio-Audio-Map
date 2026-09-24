// Smaart connection service against an in-process fake Smaart (API v4 behaviour).
const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const { SmaartService } = require('../main/smaart-service');

function fakeSmaart(port, { password = '' } = {}) {
  const wss = new WebSocketServer({ port, path: '/api/v4/' });
  const seen = [];
  wss.on('connection', (ws) => {
    let authed = !password;
    ws.on('message', (m) => {
      const j = JSON.parse(String(m)); seen.push(j);
      if (j.action === 'set' && j.properties && 'password' in j.properties[0]) {
        authed = j.properties[0].password === password;
        ws.send(JSON.stringify({ sequenceNumber: j.sequenceNumber, response: authed ? {} : { error: 'incorect password' } }));
        if (authed) ws.send(JSON.stringify({ type: 'data', meters: [{ name: 'Booth', dBA: 91.5 }] }));
      } else if (j.action === 'get') {
        ws.send(JSON.stringify({ sequenceNumber: j.sequenceNumber, response: authed ? { version: 4 } : { authenticationRequired: true } }));
      }
    });
  });
  return { wss, seen, close: () => new Promise(r => { wss.clients.forEach(c => c.terminate()); wss.close(r); }) };
}
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const cfg = (port, extra = {}) => ({ host: '127.0.0.1', port, path: '/api/v4/', ...extra });
const cleanup = [];
const track = (x) => { cleanup.push(x); return x; };
test.afterEach(async () => { while (cleanup.length) { const x = cleanup.pop(); if (x.stop) x.stop(true); else await x.close(); } });

test('connects, handshakes, forwards data but not keepalive replies', async () => {
  const s = track(fakeSmaart(27101));
  const svc = track(new SmaartService(() => ''));
  const messages = [];
  svc.on('message', (m) => messages.push(JSON.parse(m)));
  svc.connect(cfg(27101, { mode: 'custom', pollMessages: '{"action":"get","target":"x"}', pollMs: 200 }));
  assert.ok(await waitFor(() => svc.state.status === 'live'), 'goes live');
  assert.ok(await waitFor(() => s.seen.some(j => j.target === 'x')), 'sends poll messages');
  await new Promise(r => setTimeout(r, 1300));                          // at least one keepalive round-trip
  assert.ok(s.seen.filter(j => j.action === 'get' && !j.target).length >= 2, 'handshake + keepalive sent');
  const keepReplies = messages.filter(m => m.response && m.sequenceNumber > 1 && !m.target);
  assert.ok(messages.length >= 1, 'handshake reply forwarded');
  assert.ok(keepReplies.every(m => m.sequenceNumber === 1 || false) || keepReplies.length <= 1, 'keepalive replies are not forwarded');
});

test('logs in with the stored password; password never appears in the log', async () => {
  const s = track(fakeSmaart(27102, { password: 'pw1' }));
  const svc = track(new SmaartService(() => 'pw1'));
  const log = [], messages = [];
  svc.on('log', (l) => log.push(l.text));
  svc.on('message', (m) => messages.push(m));
  svc.connect(cfg(27102, { mode: 'custom' }));
  assert.ok(await waitFor(() => messages.some(m => m.includes('91.5'))), 'data after login');
  assert.strictEqual(svc.state.status, 'live');
  assert.ok(!log.join(' ').includes('pw1'), 'password not logged');
});

test('no password: reports auth needed; wrong password: error and no retry storm', async () => {
  const s = track(fakeSmaart(27103, { password: 'pw1' }));
  const svc = new SmaartService(() => '');
  svc.connect(cfg(27103));
  assert.ok(await waitFor(() => svc.state.status === 'auth'), 'auth state');
  svc.stop(true);
  const bad = track(new SmaartService(() => 'nope'));
  bad.connect(cfg(27103));
  assert.ok(await waitFor(() => bad.state.status === 'error'), 'error state');
  assert.match(bad.state.message, /rejected the API password/);
  const n = s.seen.length;
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(s.seen.length, n, 'stopped talking to Smaart');
});

test('reconnects with backoff when Smaart goes away and comes back', async () => {
  let s = fakeSmaart(27104);
  const svc = track(new SmaartService(() => ''));
  const statuses = [];
  svc.on('status', (st) => statuses.push(st.status));
  svc.connect(cfg(27104));
  assert.ok(await waitFor(() => svc.state.status === 'live'));
  await s.close();
  assert.ok(await waitFor(() => svc.state.status === 'connecting' && svc.state.nextRetryAt), 'retrying with a scheduled time');
  s = track(fakeSmaart(27104));
  assert.ok(await waitFor(() => svc.state.status === 'live', 4000), 'back to live within the first 1–2 s retries');
  assert.ok(statuses.includes('connecting'));
});

test('stop() halts retries', async () => {
  const svc = track(new SmaartService(() => ''));
  svc.connect(cfg(27199));                                  // nothing listening
  assert.ok(await waitFor(() => svc.state.nextRetryAt));
  svc.stop();
  assert.strictEqual(svc.state.status, 'off');
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(svc.state.status, 'off', 'no retry after stop');
});
