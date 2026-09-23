// metrics.js — what each map page shows.
// Measured metrics get a booth value (from Smaart or typed in) and per-seat offsets.
// "dev" is derived: it shows the seat-minus-booth offset of another metric.

const METRICS = [
  { id: 'spl',    label: 'SPL',                 unit: 'dBA', short: 'SPL',
    desc: 'Overall A-weighted level (Smaart SPL / Leq meter)', band: null },
  { id: 'low',    label: 'Low-End Impact',      unit: 'dB',  short: 'Low',
    desc: 'Sub and kick energy, 20–120 Hz band', band: [20, 120] },
  { id: 'lowmid', label: 'Low-Mid',             unit: 'dB',  short: 'Lo-Mid',
    desc: 'Body and mud, 200–500 Hz band', band: [200, 500] },
  { id: 'high',   label: 'High Frequency',      unit: 'dB',  short: 'HF',
    desc: 'Clarity and intelligibility, 2–8 kHz band', band: [2000, 8000] },
  { id: 'dev',    label: 'Deviation from Booth', unit: 'dB', short: 'Dev',
    desc: 'How much louder (+) or quieter (−) each seat is than what FOH hears', derived: true },
];
const MEASURED = METRICS.filter(m => !m.derived);
const metricById = (id) => METRICS.find(m => m.id === id);

// Heat-map color scales (stops from low -> high)
const SCALE_LEVEL = ['#3b4cc0', '#4f94d4', '#6cc3b8', '#b5d86a', '#f3c64c', '#ec8a3c', '#c8324a'];
function scaleDiverging() {
  const mid = getComputedStyle(document.documentElement).getPropertyValue('--neutral').trim() || '#efece2';
  return ['#2f6fb0', '#8fc1e3', mid, '#f0a37a', '#c8324a'];
}

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function colorAt(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
function gradientCss(stops) { return `linear-gradient(90deg, ${stops.join(', ')})`; }

const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
const fmtSigned = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);

// ---- Frequency response: 31 ISO 1/3-octave bands, 20 Hz – 20 kHz ----
const THIRDS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const fmtHz = (f) => f >= 1000 ? String(+(f / 1000).toFixed(2)) + 'k' : String(f);

// Any [[freq, dB], ...] trace (FFT or banded) -> 31 third-octave levels.
// Power-averages the bins inside each band so FFT resolution doesn't tilt the curve;
// bands with no bins (coarse data) take the nearest bin on a log-frequency axis.
function toThirds(bins) {
  if (!bins || !bins.length) return null;
  const pts = bins.filter(([f, db]) => f > 0 && isFinite(db)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return null;
  return THIRDS.map(fc => {
    const lo = fc * Math.pow(2, -1 / 6), hi = fc * Math.pow(2, 1 / 6);
    let e = 0, n = 0;
    for (const [f, db] of pts) if (f >= lo && f < hi) { e += Math.pow(10, db / 10); n++; }
    if (n) return Math.round(10 * Math.log10(e / n) * 10) / 10;
    if (fc < pts[0][0] / 1.5 || fc > pts[pts.length - 1][0] * 1.5) return null;   // outside the trace
    let best = pts[0];
    for (const p of pts) if (Math.abs(Math.log(p[0] / fc)) < Math.abs(Math.log(best[0] / fc))) best = p;
    return best[1];
  });
}

// Band level (e.g. Low 20–120 Hz) from third-octave levels: energy sum of bands inside.
function bandFromThirds(t, lo, hi) {
  if (!t) return null;
  let e = 0, n = 0;
  THIRDS.forEach((fc, i) => { if (fc >= lo && fc <= hi && t[i] != null) { e += Math.pow(10, t[i] / 10); n++; } });
  return n ? 10 * Math.log10(e) : null;
}

// Paste/file text from a Smaart ASCII export (or any "freq  dB ..." columns) -> [[f, dB]]
function parseTrace(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const nums = line.trim().split(/[\s,;]+/).map(Number);
    if (nums.length >= 2 && isFinite(nums[0]) && isFinite(nums[1]) && nums[0] > 0) out.push([nums[0], nums[1]]);
  }
  // a bare list of 31 levels (one per line) = already third-octave
  if (!out.length) {
    const vals = String(text || '').split(/[\s,;]+/).map(Number).filter(isFinite);
    if (vals.length === THIRDS.length) return THIRDS.map((f, i) => [f, vals[i]]);
  }
  return out;
}

// A-weighting (IEC 61672) at the 31 third-octave centres, dB
const A_WEIGHT = [-50.5, -44.7, -39.4, -34.6, -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6,
  -4.8, -3.2, -1.9, -0.8, 0, 0.6, 1.0, 1.2, 1.3, 1.2, 1.0, 0.5, -0.1, -1.1, -2.5, -4.3, -6.6, -9.3];

// A metric's level from a third-octave curve: SPL = A-weighted total, bands = energy sum of the band.
// `mask[i]` false skips a band, so two curves can be compared over the same bands only.
function metricFromCurve(metricId, t, mask) {
  if (!t) return null;
  const m = metricById(metricId);
  let e = 0, n = 0;
  THIRDS.forEach((fc, i) => {
    if (t[i] == null || (mask && !mask[i])) return;
    if (m.band ? fc >= m.band[0] && fc <= m.band[1] : true) { e += Math.pow(10, (t[i] + (m.band ? 0 : A_WEIGHT[i])) / 10); n++; }
  });
  return n ? 10 * Math.log10(e) : null;
}

// Default fixed color ranges (dB) so the map gets hotter/cooler with the live FOH level
const FIXED_RANGE = { spl: [75, 105], low: [85, 115], lowmid: [75, 100], high: [65, 95], dev: [-6, 6] };
