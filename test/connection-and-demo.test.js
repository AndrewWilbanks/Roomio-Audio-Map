const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { checkConfig, smaartUrl, describeError } = require('../main/smaart-test');
const { SmaartService } = require('../main/smaart-service');
const demo = require('../main/demo');
const A = require('../renderer/js/auditorium.js');

test('no silent Smaart defaults: missing host/port is a clear error', () => {
  assert.match(checkConfig({ port: 26000 }), /host isn't set/);
  assert.match(checkConfig({ host: 'x' }), /port isn't set/);
  assert.match(checkConfig({ host: 'x', port: 70000 }), /port/);
  assert.strictEqual(checkConfig({ host: 'x', port: 26000 }), null);
  assert.throws(() => smaartUrl({}), /host/);
  assert.strictEqual(smaartUrl({ host: '10.0.0.5', port: 26000, path: 'api/v4/' }), 'ws://10.0.0.5:26000/api/v4/');
  const svc = new SmaartService(() => '');
  svc.connect({ host: '', port: 26000 });
  assert.strictEqual(svc.state.status, 'error');
  assert.match(svc.state.message, /host isn't set/);
});

test('connection errors are worded plainly (timeout, unreachable, permission, refused)', () => {
  const cfg = { host: 'booth', port: 26000 };
  assert.match(describeError({ code: 'ECONNREFUSED' }, cfg), /Nothing is listening at booth:26000/);
  assert.match(describeError({ message: 'Opening handshake has timed out' }, cfg), /No answer from booth:26000/);
  assert.match(describeError({ code: 'EHOSTUNREACH' }, cfg), /Can't reach booth:26000/);
  assert.match(describeError({ code: 'EACCES' }, cfg), /local network|permission/i);
  assert.match(describeError({ code: 'ENOTFOUND' }, cfg), /Can't find a computer called "booth"/);
});

test('demo: valid venue in the app format, ~40% of seats pre-measured, simulated feed maps onto its paths', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../renderer/examples/example-hall.auditorium.json'), 'utf8');
  const { venue, measurements } = demo.buildDemo(text);
  assert.ok(A.parseAuditoriumJson(venue.auditorium).ok);
  assert.strictEqual(venue.demo, true);
  assert.ok(measurements.spectra.length > 50 && measurements.spectra.length < 120);
  assert.strictEqual(measurements.readings.length, measurements.spectra.length * 4);
  const s = new demo.DemoSmaart();
  const msgs = [];
  s.on('message', (m) => msgs.push(JSON.parse(m)));
  s.connect();
  assert.strictEqual(s.state.status, 'live');
  await new Promise(r => setTimeout(r, 600));
  s.stop(true);
  assert.ok(msgs.length >= 2);
  const m = msgs[0];
  assert.ok(m.meters.find(x => x.name === 'Booth').dBA > 80, 'booth SPL at meters.name=Booth.dBA');
  assert.strictEqual(m.spectrum.find(x => x.name === 'Booth').bins.length, 31);
  assert.strictEqual(venue.smaart.paths.spl, 'meters.name=Booth.dBA');
});
