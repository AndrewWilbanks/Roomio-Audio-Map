// venue-store.js — the venue profile and measurements on disk, in the OS user-data folder:
//   macOS   ~/Library/Application Support/Roomio/
//   Windows %APPDATA%\Roomio\
// Files: venue.json (auditorium with its areas, FOH, Smaart settings, preferences)
//        measurements.json (area readings + frequency responses; keyed by area id in seat_id)
//        credentials.json (Smaart API password, encrypted with the OS keychain via safeStorage)
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const Auditorium = require('../renderer/js/auditorium.js');

const VENUE_SCHEMA_VERSION = 2;       // v2: the room is a set of areas (v1: individual seats)
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

// v1 (individual seats) -> v2 (areas): each section's seats become one area; seat edits are
// applied first; readings and responses taken at a seat move to its area (from_seat keeps the seat).
// Pure: returns { venue, measurements, changed }.
function upgradeV1(v, m) {
  if (!v || v.schemaVersion > VENUE_SCHEMA_VERSION) throw new Error(`venue.json is from a newer version of Roomio (schema ${v && v.schemaVersion}). Update the app.`);
  const a = v.auditorium;
  if (v.schemaVersion === VENUE_SCHEMA_VERSION && a && Array.isArray(a.areas)) return { venue: v, measurements: m, changed: false };
  let aud = a;
  if (a && Array.isArray(a.seats)) {
    const ed = v.seatEdits || {}, flip = a.yAxis === 'up' ? -1 : 1;
    const del = new Set(ed.deleted || []), labels = ed.labels || {};
    const seats = a.seats.filter(s => !del.has(s.id)).map(s => ({ ...s, ...(labels[s.id] && labels[s.id].section ? { section: labels[s.id].section } : {}) }))
      .concat((ed.added || []).map(s => ({ id: s.id, x: s.x, y: s.y * flip, section: s.section })));   // edits were in map coords
    aud = { ...a, schemaVersion: 1, seats: seats.length ? seats : a.seats };
  }
  const r = Auditorium.parseAuditoriumJson(aud);
  if (!r.ok) throw new Error('The saved venue could not be upgraded: ' + r.errors[0]);
  const map = r.seatToArea || {};
  const move = (row) => map[row.seat_id] ? { ...row, seat_id: map[row.seat_id], from_seat: row.seat_id } : row;
  const nv = { ...v, schemaVersion: VENUE_SCHEMA_VERSION, auditorium: r.auditorium, upgradedAt: new Date().toISOString() };
  delete nv.seatEdits;
  const nm = m ? { ...m, readings: (m.readings || []).map(move), spectra: (m.spectra || []).map(move) } : m;
  return { venue: nv, measurements: nm, changed: true };
}
function migrateVenue(v) { return upgradeV1(v, null).venue; }

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
    if (!v) return null;
    const up = upgradeV1(v, data.get());
    if (up.changed) {
      // keep the v1 files, then write the upgraded venue + measurements
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), bdir = path.join(dir(), 'backups');
      fs.mkdirSync(bdir, { recursive: true });
      for (const name of ['venue.json', 'measurements.json']) if (fs.existsSync(file(name))) fs.copyFileSync(file(name), path.join(bdir, `${stamp}-v1-${name}`));
      writeJson('venue.json', up.venue);
      data.save(up.measurements);
    }
    return up.venue;
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
  let m = null;
  if (p.measurements) {
    if (!Array.isArray(p.measurements.readings) || !Array.isArray(p.measurements.spectra)) throw new Error('The venue profile\'s measurements are damaged.');
    m = { readings: p.measurements.readings, spectra: p.measurements.spectra };
  }
  let up;
  try { up = upgradeV1(p.venue || {}, m); } catch (e) { throw new Error('The venue profile is damaged: ' + e.message); }
  const v = up.venue; m = up.measurements;
  const err = validateVenue(v);
  if (err) throw new Error('The venue profile is damaged: ' + err);
  return { venue: stripSecrets(v), measurements: m,
    summary: { name: v.auditorium.name, areas: v.auditorium.areas.length, readings: m ? m.readings.length : 0, spectra: m ? m.spectra.length : 0, exportedAt: p.exportedAt } };
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
  VENUE_SCHEMA_VERSION, venue, data, credentials, upgradeV1, userDataDir: dir, exportProfile, parseProfile, importProfile,
  setDemo, writeDemo, isDemo: () => demoMode,
};
