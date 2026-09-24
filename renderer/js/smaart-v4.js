// smaart-v4.js — the Smaart v9 API (v4) protocol, from Rational Acoustics' Smaart API v4 SDK.
// Pure helpers (no sockets) shared by main/smaart-service.js, main/smaart-test.js, main/demo.js and the page.
//
// How Smaart v9 hands out live data:
//   root  ws://host:port/api/v4/         get → server props (applicationName, authenticationRequired)
//         {"action":"get","target":"activeCalibratedInputs"} → devices[].activeCalibratedChannels[].streamEndpoint
//         {"action":"get","target":"activeMeasurements"}     → spectrumMeasurements[].streamEndpoint
//   SPL stream       /api/v4/devices/<dev>/channels/<ch>  → {metrics:[{"SPL A Slow":74.8}, …]}   (≤ 8 fps)
//   spectrum stream  /api/v4/measurements/<name>          → {data:[[freq, dB], …], banding}       (≤ 23 fps)
// Stream endpoints are taken from Smaart's own replies; only host and port come from venue.json.
//
// Every stream frame is re-shaped into one small "envelope" the window understands:
//   {"smaart":{"booth":{"spl":{"SPL A Slow":91.2,…}}}}   {"smaart":{"seat":{"spectrum":[[f,dB],…]}}}
// so the page's field mapping is fixed: see mappingFor() below.

const ROLES = ['booth', 'seat'];
const STREAM_FPS = { spl: 4, spectrum: 4 };
const SPECTRUM_BANDING = '1/3 Octave';          // 31 bands, matches the app's frequency-response grid

// Smaart's SPL metric names (the list Smaart reports can add user Leq metrics)
const SPL_METRICS = ['SPL A Slow', 'SPL A Fast', 'LAeq 1', 'LAeq 10', 'SPL C Slow', 'SPL C Fast', 'LCeq 1', 'LCeq 10', 'SPL Slow', 'SPL Fast', 'Leq 1', 'Leq 10'];
const DEFAULT_SPL_METRIC = 'SPL A Slow';

const Q = {
  inputs: { action: 'get', target: 'activeCalibratedInputs' },
  measurements: { action: 'get', target: 'activeMeasurements' },
  fps: (n) => ({ action: 'set', properties: [{ targetFPS: n }] }),
  banding: (b) => ({ action: 'set', properties: [{ banding: b }] }),
  password: (pw) => ({ action: 'set', properties: [{ password: pw }] }),
};

// A source is saved in venue.json as {device, channel} (SPL) or {measurement} (spectrum).
const splKey = (s) => s && s.device != null && s.channel != null ? `${s.device} · ${s.channel}` : '';

// activeCalibratedInputs reply -> [{device, channel, streamEndpoint}]
function parseInputs(resp) {
  const out = [];
  for (const d of (resp && resp.devices) || []) {
    for (const c of d.activeCalibratedChannels || []) {
      if (c && c.streamEndpoint) out.push({ device: d.deviceName, channel: c.channelName, streamEndpoint: c.streamEndpoint });
    }
  }
  return out;
}
// activeMeasurements reply -> [{measurement, streamEndpoint}]  (spectrum measurements only)
function parseMeasurements(resp) {
  return ((resp && resp.spectrumMeasurements) || [])
    .filter(m => m && m.streamEndpoint)
    .map(m => ({ measurement: m.measurementName, streamEndpoint: m.streamEndpoint }));
}

// Which stream feeds which role. Booth falls back to the first available source when none
// is chosen yet, so a one-mic Smaart setup works with no configuration.
// sources = {inputs, measurements}; chosen = venue.smaart.sources
function resolveStreams(sources, chosen) {
  const want = [];
  const inputs = (sources && sources.inputs) || [], meas = (sources && sources.measurements) || [];
  for (const role of ROLES) {
    const c = (chosen && chosen[role]) || {};
    const auto = role === 'booth';
    const spl = c.spl ? inputs.find(i => i.device === c.spl.device && i.channel === c.spl.channel) : (auto ? inputs[0] : null);
    if (spl) want.push({ role, kind: 'spl', endpoint: spl.streamEndpoint, label: splKey(spl) });
    const sp = c.spectrum ? meas.find(m => m.measurement === c.spectrum.measurement) : (auto ? meas[0] : null);
    if (sp) want.push({ role, kind: 'spectrum', endpoint: sp.streamEndpoint, label: sp.measurement });
  }
  return want;
}

// Stream frame -> envelope object, or null if it carries nothing usable
function envelope(role, kind, msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (kind === 'spl') {
    if (!Array.isArray(msg.metrics)) return null;
    const spl = {};
    for (const m of msg.metrics) for (const [k, v] of Object.entries(m || {})) if (typeof v === 'number') spl[k] = v;
    return Object.keys(spl).length ? { smaart: { [role]: { spl } } } : null;
  }
  if (kind === 'spectrum') {
    if (!Array.isArray(msg.data) || !msg.data.length) return null;
    return { smaart: { [role]: { spectrum: msg.data, banding: msg.banding } } };
  }
  return null;
}

// The page's field mapping for the built-in Smaart v9 mode
function mappingFor(cfg) {
  const metric = (cfg && cfg.splMetric) || DEFAULT_SPL_METRIC;
  return {
    paths: { spl: `smaart.booth.spl.${metric}` },
    seatPaths: { spl: `smaart.seat.spl.${metric}` },
    spectrumPath: 'smaart.booth.spectrum',
    seatSpectrumPath: 'smaart.seat.spectrum',
  };
}

// Stream URL: host/port from venue.json + the endpoint path exactly as Smaart reported it
function streamUrl(rootUrl, endpoint) {
  const u = new URL(rootUrl);
  return `${u.protocol}//${u.host}${String(endpoint).startsWith('/') ? '' : '/'}${endpoint}`;
}

const api = { ROLES, STREAM_FPS, SPECTRUM_BANDING, SPL_METRICS, DEFAULT_SPL_METRIC, Q, splKey,
  parseInputs, parseMeasurements, resolveStreams, envelope, mappingFor, streamUrl };

// main process: require(); page: <script> → window.SmaartV4
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.SmaartV4 = api;
