/* plan-detect.js — find seats in a floor-plan picture, then number them.
   Runs entirely on this computer (no network, no native code). Used by plan-import.js
   (the setup wizard) and by the tests.

   detectSeats(img, box, opts)
     img = { width, height, data: Uint8ClampedArray RGBA }   (a rendered PDF/SVG page or a PNG/JPEG)
     box = { x, y, w, h }  one seat the user boxed, in image pixels
     -> { seats: [{x, y, angle, score}], work: {scale} }
   How: every seat in a plan is drawn the same way, just turned to face the stage.
     1. ring projection: the average ink at each distance from a point doesn't change when the
        drawing turns, so it finds look-alikes at any angle, fast
     2. the best candidates are checked against the sample rotated in 10° steps (normalised
        cross-correlation), which rejects shapes that only look alike in the average
     3. overlaps are removed (one hit per seat)

   labelSeats(points, stage?) -> { seats: [{x, y, section, row, seat, id}], stage, pitch }
     rows = chains of seats a seat-width apart; sections = rows stacked behind each other
     (a wide aisle splits them); rows count out from the stage; seat 1 is on the audience's left. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlanDetect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TARGET = 22;            // the sample is resized to about this many pixels across
  const MAX_WORK_PX = 6e6;      // cap on the working image (memory/time)

  // ---------------------------------------------------------------- image prep
  // RGBA -> "ink" 0..1 (dark lines on a light page; a dark page is inverted), resampled by `scale`
  function inkImage(img, scale) {
    const W = Math.max(1, Math.round(img.width * scale)), H = Math.max(1, Math.round(img.height * scale));
    const acc = new Float32Array(W * H), cnt = new Float32Array(W * H);
    const d = img.data, iw = img.width, ih = img.height;
    // area average: every source pixel adds to the working pixel it falls in (thin lines never vanish)
    for (let y = 0; y < ih; y++) {
      const ty = Math.min(H - 1, Math.floor(y * scale)) * W;
      for (let x = 0; x < iw; x++) {
        const i = (y * iw + x) * 4, a = d[i + 3] / 255;
        const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        const t = ty + Math.min(W - 1, Math.floor(x * scale));
        acc[t] += 1 - (lum * a + (1 - a)); cnt[t]++;             // transparent = white paper
      }
    }
    let sum = 0;
    for (let i = 0; i < acc.length; i++) { acc[i] = cnt[i] ? acc[i] / cnt[i] : 0; sum += acc[i]; }
    if (sum / (W * H) > 0.5) for (let i = 0; i < acc.length; i++) acc[i] = 1 - acc[i];
    // paper isn't always white (scans, photos of prints): the typical pixel is paper, so its level
    // (median) and grain (spread below it) are subtracted, leaving 0 on blank areas
    const sm = blur3(acc, W, H);
    const sample = [];
    for (let i = 0; i < sm.length; i += Math.max(1, Math.floor(sm.length / 20000))) sample.push(sm[i]);
    sample.sort((a, b) => a - b);
    const paper = sample[Math.floor(sample.length * 0.5)], grain = paper - sample[Math.floor(sample.length * 0.05)];
    const floor = Math.min(0.9, paper + 2 * grain), span = 1 - floor;
    for (let i = 0; i < sm.length; i++) sm[i] = sm[i] > floor ? (sm[i] - floor) / span : 0;
    return { W, H, ink: sm };
  }
  // light [1 2 1] smoothing: crisp one-pixel lines otherwise alias differently from seat to seat
  function blur3(a, W, H) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, l = x > 0 ? a[i - 1] : a[i], r = x < W - 1 ? a[i + 1] : a[i];
      t[i] = (l + 2 * a[i] + r) / 4;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, u = y > 0 ? t[i - W] : t[i], d = y < H - 1 ? t[i + W] : t[i];
      o[i] = (u + 2 * t[i] + d) / 4;
    }
    return o;
  }

  // ---------------------------------------------------------------- templates
  function ringOffsets(R, K) {
    const rings = Array.from({ length: K }, () => []);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const r = Math.hypot(dx, dy);
      if (r > R) continue;
      rings[Math.min(K - 1, Math.floor(r / R * K))].push(dy, dx);
    }
    return rings;
  }
  function ringVector(ink, W, H, cx, cy, rings) {
    const v = new Float32Array(rings.length);
    for (let k = 0; k < rings.length; k++) {
      const o = rings[k]; let t = 0, n = 0;
      for (let j = 0; j < o.length; j += 2) {
        const y = cy + o[j], x = cx + o[j + 1];
        if (x >= 0 && y >= 0 && x < W && y < H) { t += ink[y * W + x]; n++; }
      }
      v[k] = n ? t / n : 0;
    }
    return v;
  }
  // rotated copies of the sample: lists of [dx, dy, value], zero-mean, unit-norm
  function rotatedTemplates(ink, W, H, cx, cy, R, stepDeg) {
    const out = [];
    for (let a = 0; a < 360; a += stepDeg) {
      const th = a * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const pts = [];
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        // sample the original at the inverse-rotated position (bilinear)
        const sx = cx + dx * c + dy * s, sy = cy - dx * s + dy * c;
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) continue;
        const v = ink[y0 * W + x0] * (1 - fx) * (1 - fy) + ink[y0 * W + x0 + 1] * fx * (1 - fy) +
                  ink[(y0 + 1) * W + x0] * (1 - fx) * fy + ink[(y0 + 1) * W + x0 + 1] * fx * fy;
        pts.push(dx, dy, v);
      }
      normalise3(pts);
      out.push({ angle: a, pts });
    }
    return out;
  }
  function normalise3(pts) {
    let m = 0; const n = pts.length / 3;
    for (let i = 2; i < pts.length; i += 3) m += pts[i];
    m /= n; let e = 0;
    for (let i = 2; i < pts.length; i += 3) { pts[i] -= m; e += pts[i] * pts[i]; }
    e = Math.sqrt(e) || 1;
    for (let i = 2; i < pts.length; i += 3) pts[i] /= e;
  }
  // normalised cross-correlation of a template at (cx, cy)
  function ncc(ink, W, H, cx, cy, t) {
    const p = t.pts; let sx = 0, sxx = 0, sxt = 0, n = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = cx + p[i], y = cy + p[i + 1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const v = ink[y * W + x];
      sx += v; sxx += v * v; sxt += v * p[i + 2]; n++;
    }
    if (n < p.length / 6) return 0;
    const varI = sxx - sx * sx / n;
    return varI > 1e-9 ? sxt / Math.sqrt(varI) : 0;   // template is zero-mean, unit-norm
  }

  // ---------------------------------------------------------------- detection
  // opts.sensitivity 0..1 (higher finds more, and more false hits); opts.onProgress(0..1)
  // opts.area {x, y, w, h}: only look for seats inside this rectangle (image pixels)
  async function detectSeats(img, box, opts = {}) {
    const sens = Math.max(0, Math.min(1, opts.sensitivity == null ? 0.5 : opts.sensitivity));
    const side = Math.max(4, Math.max(box.w, box.h));
    let scale = Math.min(1, TARGET / side);
    scale = Math.min(scale, Math.sqrt(MAX_WORK_PX / (img.width * img.height)));
    const { W, H, ink } = inkImage(img, scale);
    const cx = Math.round((box.x + box.w / 2) * scale), cy = Math.round((box.y + box.h / 2) * scale);
    const R = Math.max(3, Math.round(Math.min(box.w, box.h) * scale / 2));
    const K = Math.max(4, Math.min(10, R));
    const rings = ringOffsets(R, K);
    const tv = ringVector(ink, W, H, cx, cy, rings);
    const tMean = tv.reduce((a, b) => a + b, 0) / K;
    const tc = tv.map(v => v - tMean), tNorm = Math.sqrt(tc.reduce((a, b) => a + b * b, 0)) || 1;
    if (tMean < 0.01) return { seats: [], work: { scale }, error: 'The box looks empty — draw it tightly around one seat.' };
    const A = opts.area && opts.area.w > 0 && opts.area.h > 0
      ? { x0: opts.area.x * scale, y0: opts.area.y * scale, x1: (opts.area.x + opts.area.w) * scale, y1: (opts.area.y + opts.area.h) * scale } : null;
    const inside = (x, y) => !A || (x >= A.x0 && x <= A.x1 && y >= A.y0 && y <= A.y1);

    // 1. ring-projection score on a 2-px grid
    const stride = R >= 6 ? 2 : 1;
    const GW = Math.ceil(W / stride), GH = Math.ceil(H / stride);
    const score = new Float32Array(GW * GH);
    const yieldEvery = Math.max(1, Math.floor(GH / 40));
    const gx0 = A ? Math.max(0, Math.floor(A.x0 / stride)) : 0, gx1 = A ? Math.min(GW - 1, Math.ceil(A.x1 / stride)) : GW - 1;
    const gy0 = A ? Math.max(0, Math.floor(A.y0 / stride)) : 0, gy1 = A ? Math.min(GH - 1, Math.ceil(A.y1 / stride)) : GH - 1;
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = gy * stride;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * stride;
        const v = ringVector(ink, W, H, x, y, rings);
        let m = 0; for (let k = 0; k < K; k++) m += v[k]; m /= K;
        if (m < tMean * 0.35 || m > tMean * 2.8) continue;      // far too little / too much ink
        let dot = 0, e = 0;
        for (let k = 0; k < K; k++) { const c = v[k] - m; dot += c * tc[k]; e += c * c; }
        const corr = e > 1e-12 ? dot / (Math.sqrt(e) * tNorm) : 0;
        score[gy * GW + gx] = corr * Math.exp(-Math.abs(Math.log(m / tMean)));
      }
      if (opts.onProgress && gy % yieldEvery === 0) { opts.onProgress(0.7 * (gy - gy0) / (gy1 - gy0 + 1)); await tick(); }
    }
    // local maxima above the ring threshold
    const ringMin = 0.62 - 0.22 * sens;
    const cand = [];
    const nr = Math.max(1, Math.round(R * 0.6 / stride));
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const s = score[gy * GW + gx];
      if (s < ringMin) continue;
      let peak = true;
      for (let dy = -nr; dy <= nr && peak; dy++) for (let dx = -nr; dx <= nr; dx++) {
        if (!dx && !dy) continue;
        const X = gx + dx, Y = gy + dy;
        if (X < 0 || Y < 0 || X >= GW || Y >= GH) continue;
        const o = score[Y * GW + X];
        if (o > s || (o === s && (dy < 0 || (dy === 0 && dx < 0)))) { peak = false; break; }
      }
      if (peak) cand.push([gx * stride, gy * stride, s]);
    }
    cand.sort((a, b) => b[2] - a[2]);
    if (cand.length > 40000) cand.length = 40000;

    // 2. verify with rotated NCC (±1 px, 10° steps, then refine ±5°)
    // the check uses the whole box plus its corners, so the gap between two seats (which can look
    // like a seat in the ring average) doesn't pass
    // (+15% each side: people tend to draw the box tight)
    const RV = Math.max(R + 1, Math.round(Math.hypot(box.w, box.h) * 1.3 * scale / 2));
    const STEP = 5;
    const temps = rotatedTemplates(ink, W, H, cx, cy, RV, STEP);
    const nccMin = 0.8 - 0.25 * sens;
    // best fit near (x0, y0): the best few angles, then the whole area around the point
    const rad = Math.max(stride, Math.ceil(R * 0.5));
    // how much ink a seat-sized disc holds: a match must hold about as much as the sample
    const disc = []; for (let dy = -RV; dy <= RV; dy++) for (let dx = -RV; dx <= RV; dx++) if (dx * dx + dy * dy <= RV * RV) disc.push(dx, dy);
    const inkAt = (x, y) => { let t = 0; for (let j = 0; j < disc.length; j += 2) { const X = x + disc[j], Y = y + disc[j + 1]; if (X >= 0 && Y >= 0 && X < W && Y < H) t += ink[Y * W + X]; } return t; };
    const sampleInk = inkAt(cx, cy) || 1;
    const fit = (x0, y0) => {
      const byAngle = temps.map((t, k) => [ncc(ink, W, H, x0, y0, t), k]).sort((a, b) => b[0] - a[0]).slice(0, 3);
      if (byAngle[0][0] < nccMin - 0.3) return null;
      let best = -1, bx = x0, by = y0, ba = 0;
      for (const [, k0] of byAngle) {
        for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const v = ncc(ink, W, H, x0 + dx, y0 + dy, temps[k0]);
          if (v > best) { best = v; bx = x0 + dx; by = y0 + dy; ba = k0; }
        }
      }
      for (const dk of [-1, 1]) {
        const kk = (ba + dk + temps.length) % temps.length, v = ncc(ink, W, H, bx, by, temps[kk]);
        if (v > best) { best = v; ba = kk; }
      }
      if (best < nccMin || !inside(bx, by)) return null;
      const amount = inkAt(bx, by) / sampleInk;
      return amount > 0.6 && amount < 1.7 ? { x: bx, y: by, angle: temps[ba].angle, score: best } : null;
    };
    const hits = [];
    for (let i = 0; i < cand.length; i++) {
      const h = fit(cand[i][0], cand[i][1]);
      if (h) hits.push(h);
      if (opts.onProgress && i % 200 === 0) { opts.onProgress(0.7 + 0.22 * i / cand.length); await tick(); }
    }
    // 3. one hit per seat
    hits.sort((a, b) => b.score - a.score);
    const minD = Math.max(2, Math.min(box.w, box.h) * scale * 0.7);
    let kept = suppress(hits, minD);
    // real seats are never closer than one seat-spacing apart; a weaker hit crowding a stronger
    // one is a look-alike (e.g. the strip between two rows). Spacing from the confident half.
    let crowd = minD;
    if (kept.length >= 8) {
      const top = kept.slice(0, Math.max(4, Math.ceil(kept.length / 2)));
      const pitch = median(nearestDist(top));
      crowd = Math.max(minD, pitch * 0.88);
      kept = suppress(kept, crowd);
      // …and within a full spacing, a much weaker hit next to a strong one (neighbouring seats are
      // drawn alike, so they score alike)
      kept = kept.filter(h => !kept.some(o => o !== h && o.score > h.score + 0.1 && Math.hypot(o.x - h.x, o.y - h.y) < pitch * 1.02));
    }
    // 4. fill gaps: a seat is usually one seat-spacing past its neighbour, in line with the row
    for (let pass = 0; pass < 4 && kept.length >= 2; pass++) {
      const pitch = median(nearestDist(kept));
      const added = [];
      for (const p of kept) for (const q of kept) {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (q === p || d > pitch * 1.3) continue;
        const px = Math.round(2 * q.x - p.x), py = Math.round(2 * q.y - p.y);    // one more step along p → q
        if (px < 0 || py < 0 || px >= W || py >= H || !inside(px, py)) continue;
        if (kept.concat(added).some(o => Math.hypot(o.x - px, o.y - py) < crowd)) continue;
        const h = fit(px, py);
        if (h && !kept.concat(added).some(o => Math.hypot(o.x - h.x, o.y - h.y) < crowd)) added.push(h);
      }
      if (!added.length) break;
      kept = kept.concat(added);
      if (opts.onProgress) { opts.onProgress(0.92 + 0.02 * pass); await tick(); }
    }
    if (opts.onProgress) opts.onProgress(1);
    return {
      seats: kept.map(h => ({ x: h.x / scale, y: h.y / scale, angle: h.angle, score: Math.round(h.score * 1000) / 1000 })),
      work: { scale, width: W, height: H },
      ...(opts.debug ? { debug: { crowd: crowd / scale, candidates: cand.map(c => ({ x: c[0] / scale, y: c[1] / scale, ring: c[2] })), hits: hits.map(h => ({ ...h, x: h.x / scale, y: h.y / scale })) } } : {}),
    };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  function suppress(pts, minD) {
    const cell = minD, grid = new Map(), out = [];
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (const p of pts) {
      const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
      let clash = false;
      for (let dy = -1; dy <= 1 && !clash; dy++) for (let dx = -1; dx <= 1 && !clash; dx++) {
        for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) if (Math.hypot(o.x - p.x, o.y - p.y) < minD) { clash = true; break; }
      }
      if (clash) continue;
      out.push(p);
      const k = key(p.x, p.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p);
    }
    return out;
  }

  // ---------------------------------------------------------------- numbering
  function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }
  function nearestDist(pts) {
    return pts.map((p, i) => {
      let b = Infinity;
      for (let j = 0; j < pts.length; j++) if (j !== i) { const d = Math.hypot(pts[j].x - p.x, pts[j].y - p.y); if (d < b) b = d; }
      return b;
    });
  }
  class DSU { constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
    f(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
    u(a, b) { this.p[this.f(a)] = this.f(b); } }
  function groups(n, dsu) { const m = new Map(); for (let i = 0; i < n; i++) { const r = dsu.f(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); } return [...m.values()]; }
  // principal direction of a set of points
  function pca(pts) {
    const n = pts.length, mx = pts.reduce((t, p) => t + p.x, 0) / n, my = pts.reduce((t, p) => t + p.y, 0) / n;
    let xx = 0, xy = 0, yy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { mx, my, ux: Math.cos(th), uy: Math.sin(th) };
  }
  function letters(i) { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

  // Rows: link each seat to its side-by-side neighbours (≤ 1.4 × seat spacing), keeping links
  // that run along the local row direction. Seats in a straight or curved row chain up.
  function findRows(pts, pitch) {
    const n = pts.length, dsu = new DSU(n), lim = pitch * 1.45, far = pitch * 2.2;   // far: bridges one missing seat
    const cell = far, grid = new Map();
    pts.forEach((p, i) => { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const near = pts.map((p) => {
      const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell), out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
        const d = Math.hypot(pts[j].x - p.x, pts[j].y - p.y);
        if (d > 0 && d <= far) out.push([j, d]);
      }
      return out.sort((a, b) => a[1] - b[1]);
    });
    // local row direction = direction to the nearest neighbour
    const dir = pts.map((p, i) => { const nn = near[i][0]; if (!nn) return null; const q = pts[nn[0]], d = nn[1]; return [(q.x - p.x) / d, (q.y - p.y) / d]; });
    for (let i = 0; i < n; i++) for (const [j, d] of near[i]) {
      if (j <= i || !dir[i] || !dir[j]) continue;
      const ux = (pts[j].x - pts[i].x) / d, uy = (pts[j].y - pts[i].y) / d;
      const need = d <= lim ? 0.8 : 0.95;                   // longer links must be very straight
      if (Math.abs(ux * dir[i][0] + uy * dir[i][1]) > need && Math.abs(ux * dir[j][0] + uy * dir[j][1]) > need) dsu.u(i, j);
    }
    return groups(n, dsu);
  }

  // Where rows point: the stage sits where the rows' perpendiculars meet (fans, arcs).
  // Straight parallel rows: the side where rows are shorter, else the top of the plan.
  function guessStage(pts, rows) {
    const segs = rows.filter(r => r.length >= 3).map(r => ({ ...pca(r.map(i => pts[i])), n: r.length }));
    const all = pca(pts);
    if (segs.length >= 2) {
      // least squares point closest to every normal line (normal of row = (-uy, ux))
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (const s of segs) {
        const nx = -s.uy, ny = s.ux, w = s.n;
        const p11 = 1 - nx * nx, p12 = -nx * ny, p22 = 1 - ny * ny;       // projector onto the line's normal space
        a11 += w * p11; a12 += w * p12; a22 += w * p22;
        b1 += w * (p11 * s.mx + p12 * s.my); b2 += w * (p12 * s.mx + p22 * s.my);
      }
      const det = a11 * a22 - a12 * a12;
      const spread = Math.max(...pts.map(p => Math.hypot(p.x - all.mx, p.y - all.my)));
      if (Math.abs(det) > 1e-6 * (a11 + a22) * (a11 + a22)) {
        const x = (a22 * b1 - a12 * b2) / det, y = (a11 * b2 - a12 * b1) / det;
        const d = Math.hypot(x - all.mx, y - all.my);
        if (d < spread * 4 && !pts.some(p => Math.hypot(p.x - x, p.y - y) < spread * 0.08)) return { x, y };
      }
    }
    // parallel rows: along the common normal, towards the shorter rows
    const main = segs.length ? segs.reduce((a, b) => (b.n > a.n ? b : a)) : all;
    let nx = -main.uy, ny = main.ux;
    const side = (s) => (s.mx - all.mx) * nx + (s.my - all.my) * ny;
    const front = segs.filter(s => side(s) > 0), back = segs.filter(s => side(s) < 0);
    const avg = (a) => a.length ? a.reduce((t, s) => t + s.n, 0) / a.length : 0;
    let sign = avg(front) && avg(back) && Math.abs(avg(front) - avg(back)) > 0.5 ? (avg(front) < avg(back) ? 1 : -1) : (ny < 0 ? 1 : -1);   // tie: top of the plan (y down)
    const ext = Math.max(...pts.map(p => Math.abs((p.x - all.mx) * nx + (p.y - all.my) * ny)));
    return { x: all.mx + nx * sign * (ext * 1.3 + 1), y: all.my + ny * sign * (ext * 1.3 + 1) };
  }

  function labelSeats(points, stageIn) {
    const pts = points.map(p => ({ x: p.x, y: p.y }));
    if (!pts.length) return { seats: [], stage: stageIn || null, pitch: 0 };
    const pitch = median(nearestDist(pts)) || 1;
    const rows = findRows(pts, pitch);
    const stage = stageIn || guessStage(pts, rows);
    // seats' facing: towards the stage; audience-left vector at each point
    const all = pca(pts);
    const fwd = (() => { const dx = stage.x - all.mx, dy = stage.y - all.my, d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; })();
    const left = [fwd[1], -fwd[0]];                        // screen coords (y down): facing up → left is -x
    // sections: rows stacked behind each other (parallel, overlapping side to side, < 2.4 pitches apart)
    const R = rows.map(r => ({ idx: r, ...pca(r.map(i => pts[i])) }));
    const dsu = new DSU(R.length);
    const extent = (r, ux, uy) => { let lo = Infinity, hi = -Infinity; for (const i of r.idx) { const t = pts[i].x * ux + pts[i].y * uy; if (t < lo) lo = t; if (t > hi) hi = t; } return [lo, hi]; };
    for (let a = 0; a < R.length; a++) for (let b = a + 1; b < R.length; b++) {
      const A = R[a], B = R[b];
      if (A.idx.length >= 2 && B.idx.length >= 2 && Math.abs(A.ux * B.ux + A.uy * B.uy) < Math.cos(25 * Math.PI / 180)) continue;
      let dmin = Infinity;
      for (const i of A.idx) for (const j of B.idx) { const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y); if (d < dmin) dmin = d; }
      if (dmin > pitch * 2.4) continue;
      const ux = A.idx.length >= 2 ? A.ux : B.ux, uy = A.idx.length >= 2 ? A.uy : B.uy;
      const [a0, a1] = extent(A, ux, uy), [b0, b1] = extent(B, ux, uy);
      const overlap = Math.min(a1, b1) - Math.max(a0, b0) + pitch;             // single seats count as one pitch wide
      if (overlap > 0.3 * Math.min(a1 - a0 + pitch, b1 - b0 + pitch)) dsu.u(a, b);
    }
    const secs = groups(R.length, dsu).map(g => {
      const seatIdx = g.flatMap(k => R[k].idx);
      const cx = seatIdx.reduce((t, i) => t + pts[i].x, 0) / seatIdx.length, cy = seatIdx.reduce((t, i) => t + pts[i].y, 0) / seatIdx.length;
      const vx = cx - stage.x, vy = cy - stage.y;
      return { rows: g.map(k => R[k]), angle: Math.atan2(vx * left[0] + vy * left[1], -(vx * fwd[0] + vy * fwd[1])) };
    });
    secs.sort((a, b) => b.angle - a.angle);                 // audience-left first
    const out = new Array(pts.length);
    secs.forEach((sec, si) => {
      const name = letters(si);
      const dist = (r) => Math.hypot(r.mx - stage.x, r.my - stage.y);
      sec.rows.sort((a, b) => dist(a) - dist(b)).forEach((r, ri) => {
        const lx = (i) => { const vx = pts[i].x - stage.x, vy = pts[i].y - stage.y; return Math.atan2(vx * left[0] + vy * left[1], -(vx * fwd[0] + vy * fwd[1])); };
        r.idx.slice().sort((a, b) => lx(b) - lx(a)).forEach((i, k) => {
          out[i] = { x: pts[i].x, y: pts[i].y, section: name, row: ri + 1, seat: k + 1, id: `${name}-${ri + 1}-${k + 1}` };
        });
      });
    });
    return { seats: out, stage, pitch };
  }

  return { detectSeats, labelSeats, _internal: { inkImage, ringOffsets, rotatedTemplates, ncc, findRows, guessStage } };
});
