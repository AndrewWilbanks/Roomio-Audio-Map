// demo.js — demo mode: the bundled example hall, pre-measured seats, and a simulated Smaart
// feed generated in-process (no server, no network, no child processes — see SANDBOX.md).
// DemoSmaart has the same surface as SmaartService (connect/stop/retryNow/send/state + events).
const EventEmitter = require('events');
const Auditorium = require('../renderer/js/auditorium.js');
const SMAART_DEFAULTS = require('../renderer/js/smaart-defaults.js');
const V4 = require('../renderer/js/smaart-v4.js');

const THIRDS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

// Simulated Smaart v9 sources: an FOH and a roaming mic, each with a calibrated input + RTA
const DEMO_SOURCES = {
  inputs: [{ device: 'Demo I-O', channel: 'FOH', streamEndpoint: '(simulated)' }, { device: 'Demo I-O', channel: 'Roaming', streamEndpoint: '(simulated)' }],
  measurements: [{ measurement: 'FOH RTA', streamEndpoint: '(simulated)' }, { measurement: 'Roaming RTA', streamEndpoint: '(simulated)' }],
};
const DEMO_SMAART = {
  ...SMAART_DEFAULTS, mode: 'v4', autoConnect: true, smoothing: 0.35, splMetric: V4.DEFAULT_SPL_METRIC,
  sources: {
    booth: { spl: { device: 'Demo I-O', channel: 'FOH' }, spectrum: { measurement: 'FOH RTA' } },
    seat: { spl: { device: 'Demo I-O', channel: 'Roaming' }, spectrum: { measurement: 'Roaming RTA' } },
  },
  pollMs: 500, pollMessages: '', paths: {}, seatPaths: {}, spectrumPath: '', seatSpectrumPath: '',
};

// deterministic pseudo-random, so every demo looks the same
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// A plausible FOH program spectrum (sub-heavy worship mix), dB per third-octave band
function programCurve(level, t = 0) {
  return THIRDS.map((f, i) => {
    const lf = f < 100 ? 7 : f < 200 ? 3 : 0;
    const hf = f > 6000 ? -3 - (f - 6000) / 3000 : 0;
    return Math.round((level - 13 + lf + hf + 1.5 * Math.sin(t * 0.6 + i / 3)) * 10) / 10;
  });
}

// How a seat differs from FOH per band: farther = quieter and duller, near walls = more low end
function seatDeltaCurve(seat, room, foh, r) {
  const stage = room.stage || { x: room.center.x, y: room.viewBox[1] };
  const dSeat = Math.max(1, Math.hypot(seat.x - stage.x, seat.y - stage.y));
  const dFoh = Math.max(1, Math.hypot(foh.x - stage.x, foh.y - stage.y));
  const level = -20 * Math.log10(dSeat / dFoh);
  const [vx, , vw] = room.viewBox;
  const edge = Math.min(seat.x - vx, vx + vw - seat.x) / vw;          // 0 at the side walls
  const wall = Math.max(0, 0.18 - edge) * 25;
  return THIRDS.map((f) => {
    const hfLoss = f > 2000 ? -(dSeat / dFoh - 1) * 2.5 * Math.log2(f / 2000) : 0;
    const lfGain = f < 160 ? wall + 1 : 0;
    return Math.round((level + hfLoss + lfGain + (r() - 0.5) * 1.6) * 10) / 10;
  });
}

const energy = (t, lo, hi, weight) => {
  let e = 0; THIRDS.forEach((f, i) => { if (f >= lo && f <= hi) e += Math.pow(10, (t[i] + (weight ? weight[i] : 0)) / 10); });
  return 10 * Math.log10(e);
};
const A_WEIGHT = [-50.5, -44.7, -39.4, -34.6, -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6,
  -4.8, -3.2, -1.9, -0.8, 0, 0.6, 1.0, 1.2, 1.3, 1.2, 1.0, 0.5, -0.1, -1.1, -2.5, -4.3, -6.6, -9.3];
const BANDS = { spl: null, low: [20, 120], lowmid: [200, 500], high: [2000, 8000] };
const r1 = (v) => Math.round(v * 10) / 10;

// -> { venue, measurements } for userData/demo/
function buildDemo(exampleText) {
  const parsed = Auditorium.parseAuditoriumJson(exampleText);
  if (!parsed.ok) throw new Error('Bundled example hall is invalid: ' + parsed.errors[0]);
  const a = parsed.auditorium;
  const room = Auditorium.normalise(a);
  const fohFile = a.foh || { x: room.center.x, y: (room.center.y + (room.viewBox[1] + room.viewBox[3])) / 2 * room.flip };
  const fohMap = { x: fohFile.x, y: fohFile.y * room.flip };
  const venue = {
    schemaVersion: 1, createdAt: new Date().toISOString(), demo: true,
    auditorium: { ...a, name: `${a.name} (demo)` },
    foh: fohFile,
    smaart: DEMO_SMAART,
    seatEdits: { deleted: [], added: [], labels: {} },
    preferences: { ui: { interpolate: true, devBasis: 'spl', labels: true }, manualBooth: {} },
  };
  // measure about 40% of the seats, spread across the room
  const r = rng(42);
  const readings = [], spectra = [];
  const when = new Date(Date.now() - 3600_000).toISOString();
  const booth = programCurve(94);
  room.seats.forEach((s, i) => {
    if (r() > 0.4) return;
    const delta = seatDeltaCurve(s, room, fohMap, r);
    const seatCurve = booth.map((v, k) => r1(v + delta[k]));
    spectra.push({ id: `demo-sp-${i}`, seat_id: s.id, seat_bins: seatCurve, booth_bins: booth, source: 'demo', notes: null, measured_at: when });
    for (const [metric, band] of Object.entries(BANDS)) {
      const sv = band ? energy(seatCurve, band[0], band[1]) : energy(seatCurve, 0, 1e9, A_WEIGHT);
      const bv = band ? energy(booth, band[0], band[1]) : energy(booth, 0, 1e9, A_WEIGHT);
      readings.push({ id: `demo-r-${i}-${metric}`, seat_id: s.id, metric, seat_value: r1(sv), booth_value: r1(bv), delta: Math.round((sv - bv) * 100) / 100, notes: 'demo', measured_at: when });
    }
  });
  return { venue, measurements: { readings, spectra } };
}

class DemoSmaart extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.t0 = Date.now();
    this.state = { status: 'off', message: 'Demo — not started', url: '', attempt: 0, nextRetryAt: null };
  }
  setStatus(status, message) { this.state = { ...this.state, status, message }; this.emit('status', this.state); }
  connect() {
    this.stop(true);
    this.state = { ...this.state, url: 'simulated (demo mode)', server: { name: 'Smaart (simulated)', version: '' }, sources: DEMO_SOURCES,
      streams: [['spl', 'Demo I-O · FOH', 'booth'], ['spectrum', 'FOH RTA', 'booth'], ['spl', 'Demo I-O · Roaming', 'seat'], ['spectrum', 'Roaming RTA', 'seat']]
        .map(([kind, label, role]) => ({ kind, label, roles: [role], open: true })) };
    this.setStatus('live', 'Demo — simulated Smaart data');
    this.timer = setInterval(() => this.sample().forEach(m => this.emit('message', JSON.stringify(m))), 250);
  }
  // FOH level drifts ±3 dB and the program's low end breathes, so seats visibly follow it
  sample() {
    const t = (Date.now() - this.t0) / 1000;
    const level = 94 + 3 * Math.sin(t / 5) + (Math.random() - 0.5) * 0.6;
    const booth = programCurve(level, t).map((v, i) => r1(v + (THIRDS[i] < 120 ? 2 * Math.sin(t / 7) : 0)));
    const roam = booth.map((v, i) => r1(v - 3 + (THIRDS[i] > 4000 ? -2 : 0) + (Math.random() - 0.5)));
    const dba = (c) => r1(energy(c, 0, 1e9, A_WEIGHT));
    // the same frames Smaart v9 streams, run through the same envelope as the live service
    const splFrame = (c) => ({ metrics: [{ 'SPL A Slow': dba(c) }, { 'SPL A Fast': dba(c) }, { 'LAeq 1': r1(dba(c) - 0.4) }] });
    const specFrame = (c) => ({ banding: V4.SPECTRUM_BANDING, data: THIRDS.map((f, i) => [f, c[i]]) });
    return [V4.envelope('booth', 'spl', splFrame(booth)), V4.envelope('booth', 'spectrum', specFrame(booth)),
            V4.envelope('seat', 'spl', splFrame(roam)), V4.envelope('seat', 'spectrum', specFrame(roam))];
  }
  send() { return this.state.status === 'live'; }
  retryNow() { this.connect(); }
  stop(silent) {
    clearInterval(this.timer); this.timer = null;
    if (silent) this.state = { ...this.state, status: 'off', message: 'Demo — stopped' };
    else this.setStatus('off', 'Demo — stopped');
  }
}

module.exports = { buildDemo, DemoSmaart, DEMO_SMAART };
