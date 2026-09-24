// Smaart v9 (API v4) built-in support: protocol helpers, the live service against a fake Smaart
// that follows the SDK (root + SPL/spectrum stream endpoints), and Test connection's report.
const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const V4 = require('../renderer/js/smaart-v4.js');
const { SmaartService } = require('../main/smaart-service');
const { testConnection } = require('../main/smaart-test');

const INPUTS = { devices: [{ deviceName: 'Smaart I-O', activeCalibratedChannels: [
  { channelIndex: 0, channelName: 'FOH', streamEndpoint: '/api/v4/devices/Smaart%20I-O/channels/FOH' },
  { channelIndex: 1, channelName: 'Walk', streamEndpoint: '/api/v4/devices/Smaart%20I-O/channels/Walk' }] }], metrics: ['SPL A Slow'] };
const MEAS = { spectrumMeasurements: [
  { measurementName: 'FOH RTA', active: true, streamEndpoint: '/api/v4/measurements/FOH%20RTA' },
  { measurementName: 'Stopped', active: false }], transferFunctionMeasurements: [] };

test('parses Smaart replies, picks streams (FOH = first available), builds envelopes and URLs', () => {
  const inputs = V4.parseInputs(INPUTS), measurements = V4.parseMeasurements(MEAS);
  assert.deepStrictEqual(inputs.map(V4.splKey), ['Smaart I-O · FOH', 'Smaart I-O · Walk']);
  assert.deepStrictEqual(measurements.map(m => m.measurement), ['FOH RTA'], 'inactive measurements have no stream');
  assert.deepStrictEqual(V4.parseInputs(null), []);
  const auto = V4.resolveStreams({ inputs, measurements }, {});
  assert.deepStrictEqual(auto.map(w => `${w.role}/${w.kind}/${w.label}`), ['booth/spl/Smaart I-O · FOH', 'booth/spectrum/FOH RTA']);
  const chosen = V4.resolveStreams({ inputs, measurements }, { booth: { spl: { device: 'Smaart I-O', channel: 'Walk' } }, seat: { spl: { device: 'Smaart I-O', channel: 'FOH' } } });
  assert.deepStrictEqual(chosen.map(w => `${w.role}/${w.kind}/${w.label}`), ['booth/spl/Smaart I-O · Walk', 'booth/spectrum/FOH RTA', 'seat/spl/Smaart I-O · FOH']);
  assert.strictEqual(V4.resolveStreams({ inputs, measurements }, { booth: { spl: { device: 'X', channel: 'gone' } } }).filter(w => w.kind === 'spl').length, 0, 'a chosen input that is not running is not replaced');
  assert.deepStrictEqual(V4.envelope('booth', 'spl', { metrics: [{ 'SPL A Slow': 91.2 }, { 'LAeq 10': 90 }] }), { smaart: { booth: { spl: { 'SPL A Slow': 91.2, 'LAeq 10': 90 } } } });
  assert.strictEqual(V4.envelope('seat', 'spectrum', { data: [] }), null);
  assert.strictEqual(V4.mappingFor({ splMetric: 'LAeq 1' }).paths.spl, 'smaart.booth.spl.LAeq 1');
  assert.strictEqual(V4.streamUrl('ws://10.0.0.5:26000/api/v4/', '/api/v4/measurements/FOH%20RTA'), 'ws://10.0.0.5:26000/api/v4/measurements/FOH%20RTA');
});

// A fake Smaart v9: root at /api/v4/, stream endpoints for the inputs/measurements above.
function fakeSmaart(port, { password = '' } = {}) {
  const wss = new WebSocketServer({ port });
  const seen = [], streamCmds = [];
  wss.on('connection', (ws, req) => {
    const url = req.url;
    let authed = !password;
    if (url === '/api/v4/') {
      ws.on('message', (m) => {
        const j = JSON.parse(String(m)); seen.push(j);
        const reply = (response) => ws.send(JSON.stringify({ sequenceNumber: j.sequenceNumber, response }));
        const props = Object.assign({}, ...(j.properties || []));
        if (j.action === 'set' && 'password' in props) { authed = props.password === password; return reply(authed ? {} : { error: 'incorrect password' }); }
        if (j.action === 'get' && !j.target) return reply({ applicationName: 'Smaart Suite', applicationVersion: '9.5.0', authenticationRequired: !authed });
        if (!authed) return reply({ error: 'authentication required' });
        if (j.target === 'activeCalibratedInputs') return reply(INPUTS);
        if (j.target === 'activeMeasurements') return reply(MEAS);
        reply({ error: 'unknown target' });
      });
      return;
    }
    ws.on('message', (m) => streamCmds.push([url, JSON.parse(String(m))]));
    const timer = setInterval(() => {
      if (url.includes('/channels/')) ws.send(JSON.stringify({ deviceName: 'Smaart I-O', metrics: [{ 'SPL A Slow': url.endsWith('FOH') ? 93.4 : 88.1 }, { 'LAeq 1': 92 }] }));
      else ws.send(JSON.stringify({ banding: '1/3 Octave', data: [[31.5, 80], [63, 84], [125, 82], [1000, 78], [8000, 70]] }));
    }, 50);
    ws.on('close', () => clearInterval(timer));
  });
  return { wss, seen, streamCmds, close: () => new Promise(r => { wss.clients.forEach(c => c.terminate()); wss.close(r); }) };
}
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };
const cleanup = [];
test.afterEach(async () => { while (cleanup.length) { const x = cleanup.pop(); if (x.stop) x.stop(true); else await x.close(); } });

test('live: logs in, discovers sources, streams FOH SPL + spectrum and the chosen roaming mic', async () => {
  const s = fakeSmaart(27201, { password: 'pw' }); cleanup.push(s);
  const svc = new SmaartService(() => 'pw'); cleanup.push(svc);
  const env = [];
  svc.on('message', (m) => env.push(JSON.parse(m)));
  svc.connect({ host: '127.0.0.1', port: 27201, path: '/api/v4/', sources: { seat: { spl: { device: 'Smaart I-O', channel: 'Walk' } } } });
  assert.ok(await waitFor(() => env.some(e => e.smaart.booth && e.smaart.booth.spl) && env.some(e => e.smaart.booth && e.smaart.booth.spectrum) && env.some(e => e.smaart.seat)), 'all three streams deliver');
  assert.match(svc.state.message, /Smaart Suite 9\.5\.0/);
  assert.strictEqual(env.find(e => e.smaart.booth && e.smaart.booth.spl).smaart.booth.spl['SPL A Slow'], 93.4);
  assert.strictEqual(env.find(e => e.smaart.seat).smaart.seat.spl['SPL A Slow'], 88.1);
  assert.strictEqual(svc.state.sources.inputs.length, 2);
  assert.strictEqual(svc.state.streams.filter(x => x.open).length, 3);
  assert.ok(env.every(e => e.smaart), 'only envelopes reach the page (no raw root replies)');
  // per stream: frame rate throttled, spectrum banded to 1/3 octave
  assert.ok(s.streamCmds.some(([u, j]) => u.includes('FOH%20RTA') && j.properties[0].banding === '1/3 Octave'));
  assert.ok(s.streamCmds.some(([u, j]) => u.includes('/channels/FOH') && j.properties[0].targetFPS === 4));
  svc.stop();
  assert.strictEqual(svc.state.streams.length, 0, 'streams closed on stop');
});

test('Test connection reports the Smaart edition and what it offers', async () => {
  const s = fakeSmaart(27202); cleanup.push(s);
  const r = await testConnection({ host: '127.0.0.1', port: 27202, path: '/api/v4/' });
  assert.ok(r.ok, r.message);
  assert.match(r.message, /Smaart Suite 9\.5\.0: 2 calibrated SPL inputs \(Smaart I-O · FOH, Smaart I-O · Walk\), 1 running spectrum measurement \(FOH RTA\)/);
  const bad = await testConnection({ host: '127.0.0.1', port: 27202, path: '/api/v4/', mode: 'custom' });
  assert.match(bad.message, /Connected to Smaart Suite/);
});
