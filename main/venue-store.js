// venue-store.js — the venue profile and measurements on disk, in the OS user-data folder:
//   macOS   ~/Library/Application Support/Roomio/
//   Windows %APPDATA%\Roomio\
// Files: venue.json (auditorium, FOH, Smaart settings, seat edits, preferences)
//        measurements.json (seat readings + frequency responses)
//        credentials.json (Smaart API password, encrypted with the OS keychain via safeStorage)
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const Auditorium = require('../renderer/js/auditorium.js');

const VENUE_SCHEMA_VERSION = 1;
const DATA_SCHEMA_VERSION = 1;

// Demo mode keeps its own venue + measurements in userData/demo, away from the real venue.
let demoMode = false;
const baseDir = () => app.getPath('userData');
const dir = () => demoMode ? path.join(baseDir(), 'demo') : baseDir();
function setDemo(on) { demoMode = !!on; }
const file = (name) => path.join(dir(), name);

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${name} could not be read: ${e.message}`); }
}

// write to a temp file then rename, so a crash mid-write never leaves a half-written file
function writeJson(name, obj) {
  fs.mkdirSync(dir(), { recursive: true });
  const target = file(name), tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, target);
}

// Upgrade older files here as the schema grows (v1 is the first release).
function migrateVenue(v) {
  if (v.schemaVersion > VENUE_SCHEMA_VERSION) throw new Error(`venue.json is from a newer version of Roomio (schema ${v.schemaVersion}). Update the app.`);
  return v;
}

function validateVenue(v) {
  if (!v || typeof v !== 'object') return 'Venue profile must be an object.';
  if (v.schemaVersion !== VENUE_SCHEMA_VERSION) return `Venue profile schemaVersion must be ${VENUE_SCHEMA_VERSION}.`;
  const r = Auditorium.parseAuditoriumJson(v.auditorium);
  if (!r.ok) return 'Auditorium: ' + r.errors[0];
  if (v.foh && (typeof v.foh.x !== 'number' || typeof v.foh.y !== 'number')) return 'FOH position must have numeric x and y.';
  return null;
}

function stripSecrets(v) {
  if (v && v.smaart) { const s = { ...v.smaart }; delete s.password; return { ...v, smaart: s }; }
  return v;
}

const venue = {
  path: () => file('venue.json'),
  exists: () => fs.existsSync(file('venue.json')),
  get() {
    const v = readJson('venue.json');
    return v ? migrateVenue(v) : null;
  },
  save(v) {
    const err = validateVenue(v);
    if (err) throw new Error(err);
    writeJson('venue.json', stripSecrets(v));        // the password never goes in venue.json
  },
  // Settings → Reset, New venue, Import profile: move the current venue aside as a dated
  // backup (in userData/backups) instead of deleting it.
  backup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bdir = path.join(dir(), 'backups');
    let moved = false;
    for (const name of ['venue.json', 'measurements.json']) {
      if (fs.existsSync(file(name))) {
        fs.mkdirSync(bdir, { recursive: true });
        fs.renameSync(file(name), path.join(bdir, `${stamp}-${name}`));
        moved = true;
      }
    }
    return moved ? bdir : null;
  },
  reset() {
    const where = this.backup();
    credentials.set('');
    return where;
  },
  validate: validateVenue,
  stripSecrets,
};

const data = {
  get() {
    const d = readJson('measurements.json');
    return d ? { readings: d.readings || [], spectra: d.spectra || [] } : { readings: [], spectra: [] };
  },
  save(d) {
    if (!d || !Array.isArray(d.readings) || !Array.isArray(d.spectra)) throw new Error('Measurements must have readings[] and spectra[].');
    writeJson('measurements.json', { schemaVersion: DATA_SCHEMA_VERSION, readings: d.readings, spectra: d.spectra });
  },
};

// Smaart API password, encrypted with the OS keychain (Keychain / DPAPI). Never exported.
const credentials = {
  get() {
    if (demoMode) return '';
    const c = readJson('credentials.json');
    if (!c || !c.smaartPassword) return '';
    try {
      return c.encrypted ? safeStorage.decryptString(Buffer.from(c.smaartPassword, 'base64')) : '';
    } catch (e) { return ''; }
  },
  set(pw) {
    if (!pw) { if (fs.existsSync(file('credentials.json'))) fs.unlinkSync(file('credentials.json')); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer can\'t store the password securely.');
    writeJson('credentials.json', { encrypted: true, smaartPassword: safeStorage.encryptString(pw).toString('base64') });
  },
  has() { return !!this.get(); },
};

// ---- venue profiles: one portable file for moving a venue between computers
const PROFILE_FORMAT = 'roomio-venue-profile';

function exportProfile(includeMeasurements, appVersion) {
  const v = venue.get();
  if (!v) throw new Error('There is no venue to export.');
  const out = { format: PROFILE_FORMAT, schemaVersion: 1, exportedAt: new Date().toISOString(), appVersion, venue: stripSecrets(v) };
  if (includeMeasurements) out.measurements = data.get();
  return out;
}

// -> { venue, measurements|null, summary } or throws with a readable message
function parseProfile(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error('This isn\'t a venue profile (not valid JSON).'); }
  if (p && p.format === Auditorium.FORMAT) throw new Error('This is an auditorium file, not a venue profile. Use New venue to set up a venue from it.');
  if (!p || p.format !== PROFILE_FORMAT) throw new Error('This isn\'t a Roomio venue profile.');
  if (p.schemaVersion !== 1) throw new Error(`This venue profile is version ${p.schemaVersion}; this app reads version 1. Update the app.`);
  const v = migrateVenue(p.venue || {});
  const err = validateVenue(v);
  if (err) throw new Error('The venue profile is damaged: ' + err);
  let m = null;
  if (p.measurements) {
    if (!Array.isArray(p.measurements.readings) || !Array.isArray(p.measurements.spectra)) throw new Error('The venue profile\'s measurements are damaged.');
    m = { readings: p.measurements.readings, spectra: p.measurements.spectra };
  }
  return { venue: stripSecrets(v), measurements: m,
    summary: { name: v.auditorium.name, seats: v.auditorium.seats.length, readings: m ? m.readings.length : 0, spectra: m ? m.spectra.length : 0, exportedAt: p.exportedAt } };
}

function importProfile(parsed) {
  const where = venue.backup();
  venue.save(parsed.venue);
  data.save(parsed.measurements || { readings: [], spectra: [] });
  return where;
}

// Demo mode: write a fresh demo venue + measurements into userData/demo
function writeDemo({ venue: v, measurements }) {
  setDemo(true);
  writeJson('venue.json', v);
  writeJson('measurements.json', { schemaVersion: DATA_SCHEMA_VERSION, ...measurements });
}

module.exports = {
  VENUE_SCHEMA_VERSION, venue, data, credentials, userDataDir: dir, exportProfile, parseProfile, importProfile,
  setDemo, writeDemo, isDemo: () => demoMode,
};
