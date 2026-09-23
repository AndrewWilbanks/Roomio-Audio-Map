/* store.js — venue settings + seat readings, persisted through RA (bridge.js).
   The venue profile (venue.json) holds the auditorium, FOH position, Smaart settings,
   seat edits and preferences. Readings and frequency responses live in a separate
   measurements file. Everything is local to this computer. */
(function () {
  const SCHEMA_VERSION = 1;

  const defaultSmaart = () => ({
    host: 'localhost', port: 26000, path: '/api/v4/', autoConnect: true, pollMs: 500,
    pollMessages: '',              // one JSON command per line, sent every poll
    paths: {},                     // booth metric -> JSON path in Smaart messages
    seatPaths: {},                 // roaming-mic metric -> JSON path (optional)
    spectrumPath: '',              // booth spectrum array (FOH response + band levels)
    seatSpectrumPath: '',          // roaming-mic spectrum array (seat response)
    smoothing: 0.35,
  });
  const defaultPrefs = () => ({ ui: { interpolate: false, devBasis: 'spl', labels: true }, manualBooth: {} });

  let venue = null;                  // raw venue.json
  let room = null;                   // normalised auditorium for the map
  let settings = null;               // working view: { booth (map coords), manualBooth, smaart, seatEdits, ui }
  let readings = [];                 // [{id, seat_id, metric, seat_value, booth_value, delta, notes, measured_at}]
  let spectra = [];                  // [{id, seat_id, seat_bins[31], booth_bins[31], source, notes, measured_at}]
  let venueTimer = null, dataTimer = null;

  function merge(base, over) {
    if (!over || typeof over !== 'object') return base;
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') merge(base[k], over[k]);
      else base[k] = over[k];
    }
    return base;
  }

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  // A brand-new venue profile from a validated auditorium + wizard choices
  function newVenue(auditorium, foh, smaart) {
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      auditorium,
      foh,                                           // in the auditorium file's own coordinates
      smaart: merge(defaultSmaart(), smaart || {}),
      seatEdits: { deleted: [], added: [], labels: {} },
      preferences: defaultPrefs(),
    };
  }

  // -> { ready: true } or { ready: false } when no venue has been set up yet
  async function init() {
    venue = await RA.venue.get();
    if (!venue || !venue.auditorium) return { ready: false };
    const parsed = Auditorium.parseAuditoriumJson(venue.auditorium);
    if (!parsed.ok) return { ready: false, error: 'The saved venue is damaged: ' + parsed.errors[0] };
    room = Auditorium.normalise(parsed.auditorium);
    const foh = venue.foh || parsed.auditorium.foh || null;
    const prefs = merge(defaultPrefs(), venue.preferences);
    settings = {
      booth: foh ? { x: foh.x, y: foh.y * room.flip } : { ...room.suggestedFoh },
      manualBooth: prefs.manualBooth,
      smaart: merge(defaultSmaart(), venue.smaart),
      seatEdits: merge({ deleted: [], added: [], labels: {} }, venue.seatEdits),
      ui: prefs.ui,
    };
    const d = await RA.data.get();
    readings = (d && d.readings) || [];
    spectra = (d && d.spectra) || [];
    return { ready: true };
  }

  function toVenue() {
    return {
      ...venue,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      foh: { x: Math.round(settings.booth.x * 10) / 10, y: Math.round(settings.booth.y * room.flip * 10) / 10 },
      smaart: settings.smaart,
      seatEdits: settings.seatEdits,
      preferences: { ui: settings.ui, manualBooth: settings.manualBooth },
    };
  }

  function saveSettings() {
    clearTimeout(venueTimer);
    venueTimer = setTimeout(() => { venueTimer = null; venue = toVenue(); RA.venue.save(venue); }, 300);
  }
  function saveData() {
    clearTimeout(dataTimer);
    dataTimer = setTimeout(() => { dataTimer = null; RA.data.save({ schemaVersion: SCHEMA_VERSION, readings, spectra }); }, 200);
  }
  // flush pending writes (e.g. before a reset or export)
  async function flush() {
    if (venueTimer) { clearTimeout(venueTimer); venueTimer = null; venue = toVenue(); await RA.venue.save(venue); }
    if (dataTimer) { clearTimeout(dataTimer); dataTimer = null; await RA.data.save({ schemaVersion: SCHEMA_VERSION, readings, spectra }); }
  }

  async function addReadings(list) {
    const rows = list.map(r => ({
      id: uid(), seat_id: r.seat_id, metric: r.metric,
      seat_value: +r.seat_value, booth_value: +r.booth_value,
      delta: Math.round((+r.seat_value - +r.booth_value) * 100) / 100,
      notes: r.notes || null, measured_at: r.measured_at || new Date().toISOString(),
    }));
    readings.push(...rows);
    saveData();
    return rows;
  }
  async function deleteReading(id) { readings = readings.filter(r => r.id !== id); saveData(); }
  async function clearReadings() { readings = []; spectra = []; saveData(); }

  async function addSpectrum(sp) {
    const row = { id: uid(), seat_id: sp.seat_id, seat_bins: sp.seat_bins, booth_bins: sp.booth_bins,
      source: sp.source || null, notes: sp.notes || null, measured_at: sp.measured_at || new Date().toISOString() };
    spectra.push(row);
    saveData();
    return row;
  }
  async function deleteSpectrum(id) { spectra = spectra.filter(r => r.id !== id); saveData(); }

  function latest() {
    const m = new Map();
    for (const r of readings) {
      const k = r.seat_id + '|' + r.metric;
      const prev = m.get(k);
      if (!prev || r.measured_at >= prev.measured_at) m.set(k, r);
    }
    return m;
  }
  function latestSpectra() {
    const m = new Map();
    for (const r of spectra) { const p = m.get(r.seat_id); if (!p || r.measured_at >= p.measured_at) m.set(r.seat_id, r); }
    return m;
  }

  window.Store = {
    SCHEMA_VERSION, init, newVenue, saveSettings, flush,
    addReadings, deleteReading, clearReadings, latest,
    addSpectrum, deleteSpectrum, latestSpectra,
    get venue() { return venue; },
    get room() { return room; },
    get settings() { return settings; },
    get readings() { return readings; },
    get spectra() { return spectra; },
  };
})();
