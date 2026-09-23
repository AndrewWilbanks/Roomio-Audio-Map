// venue-store: venue.json / measurements / profiles / backups, with Electron stubbed out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-store-'));
const fakeElectron = {
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')), decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : origLoad.call(this, req, ...rest); };
const store = require('../main/venue-store');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const hall = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/examples/example-hall.auditorium.json'), 'utf8'));
const venue = (name = hall.name) => ({ schemaVersion: 1, auditorium: { ...hall, name }, foh: { x: 0, y: 2 }, smaart: { host: 'localhost', port: 26000, password: 'leak?' }, preferences: {} });

test('save rejects bad venues and never writes a password', () => {
  assert.throws(() => store.venue.save({ schemaVersion: 1, auditorium: { name: 'x', seats: [] } }), /Auditorium/);
  assert.throws(() => store.venue.save({ ...venue(), schemaVersion: 3 }), /schemaVersion/);
  store.venue.save(venue());
  const text = fs.readFileSync(path.join(dir, 'venue.json'), 'utf8');
  assert.ok(!text.includes('leak?'));
  assert.strictEqual(JSON.parse(text).schemaVersion, 1);
});

test('credentials are encrypted at rest and removable', () => {
  store.credentials.set('s3cret');
  assert.ok(!fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('s3cret'));
  assert.strictEqual(store.credentials.get(), 's3cret');
  store.credentials.set('');
  assert.strictEqual(store.credentials.has(), false);
});

test('export → import round-trip, with backup of the replaced venue', () => {
  store.venue.save(venue('Hall A'));
  store.data.save({ readings: [{ id: 'r1', seat_id: 'M-1-1', metric: 'spl', seat_value: 90, booth_value: 93, delta: -3, measured_at: '2026-01-01' }], spectra: [] });
  const withData = store.exportProfile(true, '0.1.0');
  const bare = store.exportProfile(false, '0.1.0');
  assert.strictEqual(withData.format, 'roomio-venue-profile');
  assert.ok(!JSON.stringify(withData).includes('leak?'), 'no password in profiles');
  assert.strictEqual(withData.measurements.readings.length, 1);
  assert.strictEqual(bare.measurements, undefined);

  store.venue.save(venue('Hall B'));                        // a different current venue
  const parsed = store.parseProfile(JSON.stringify(withData));
  assert.strictEqual(parsed.summary.name, 'Hall A');
  assert.strictEqual(parsed.summary.readings, 1);
  const bdir = store.importProfile(parsed);
  assert.strictEqual(store.venue.get().auditorium.name, 'Hall A');
  assert.strictEqual(store.data.get().readings.length, 1);
  const backups = fs.readdirSync(bdir);
  assert.ok(backups.some(f => f.endsWith('-venue.json')), 'Hall B kept as a backup');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(bdir, backups.find(f => f.endsWith('-venue.json'))), 'utf8')).auditorium.name, 'Hall B');
});

test('profile import errors are readable', () => {
  assert.throws(() => store.parseProfile('nope'), /not valid JSON/);
  assert.throws(() => store.parseProfile(JSON.stringify(hall)), /auditorium file, not a venue profile/);
  assert.throws(() => store.parseProfile(JSON.stringify({ format: 'roomio-venue-profile', schemaVersion: 9 })), /version 9/);
  assert.throws(() => store.parseProfile(JSON.stringify({ format: 'roomio-venue-profile', schemaVersion: 1, venue: { schemaVersion: 1, auditorium: { name: 'x', seats: [] } } })), /damaged/);
});

test('reset moves venue + measurements to backups and clears the password', () => {
  store.credentials.set('pw');
  store.venue.reset();
  assert.strictEqual(store.venue.exists(), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'measurements.json')), false);
  assert.strictEqual(store.credentials.has(), false);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).length >= 2);
});
