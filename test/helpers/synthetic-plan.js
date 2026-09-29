// Draws a fake floor plan (white page, black chair outlines) for the seat-detector tests.
// Chairs: a square seat outline + a thick backrest, rotated to face the stage.
function blank(W, H) { const d = new Uint8ClampedArray(W * H * 4).fill(255); return { width: W, height: H, data: d }; }
function fillQuad(img, cx, cy, hw, hh, th, v = 0) {
  const c = Math.cos(th), s = Math.sin(th), R = Math.ceil(Math.hypot(hw, hh)) + 1;
  for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, u = dx * c + dy * s, w = -dx * s + dy * c;
    if (Math.abs(u) <= hw && Math.abs(w) <= hh) { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
  }
}
// one chair of size `sz` px at (x, y), front facing angle `face` (radians, direction to the stage)
function chair(img, x, y, sz, face) {
  const th = face + Math.PI / 2;             // row direction
  const t = Math.max(1, sz / 12);
  const fx = Math.cos(face), fy = Math.sin(face), rx = Math.cos(th), ry = Math.sin(th);
  const h = sz / 2;
  fillQuad(img, x + fx * h, y + fy * h, h, t / 2, th);            // front edge
  fillQuad(img, x - fx * (h - t), y - fy * (h - t), h, t * 1.4, th); // backrest (thick)
  fillQuad(img, x + rx * h, y + ry * h, h, t / 2, face);          // arms
  fillQuad(img, x - rx * h, y - ry * h, h, t / 2, face);
}
// fan of `sections` blocks around a stage at the top; returns { img, truth: [{x,y}], stage }
function fanPlan({ W = 1400, H = 1000, sz = 18, rows = 10, sections = 3, gapDeg = 12, secSpan = 24 } = {}) {   // aisle ≈ 2 seat widths at the front row
  const img = blank(W, H), truth = [], stage = { x: W / 2, y: 60 };
  const pitch = sz * 1.25, rowGap = sz * 2;
  const r0 = sz * 12;
  for (let s = 0; s < sections; s++) {
    const a0 = (s - (sections - 1) / 2) * (secSpan + gapDeg);
    for (let r = 0; r < rows; r++) {
      const rad = r0 + r * rowGap;
      const n = Math.max(1, Math.floor((secSpan * Math.PI / 180) * rad / pitch));   // seats that fit the section's arc
      const step = pitch / rad;            // radians between seats
      for (let k = 0; k < n; k++) {
        const ang = (90 + a0) * Math.PI / 180 + (k - (n - 1) / 2) * step;
        const x = stage.x + Math.cos(ang) * rad, y = stage.y + Math.sin(ang) * rad;
        if (x < sz || y < sz || x > W - sz || y > H - sz) continue;
        chair(img, x, y, sz, Math.atan2(stage.y - y, stage.x - x));
        truth.push({ x, y, section: s, row: r, k });
      }
    }
  }
  // some non-seat linework: walls, a stage arc and text-like marks
  fillQuad(img, W / 2, 20, W / 2 - 20, 2, 0);
  fillQuad(img, 20, H / 2, 2, H / 2 - 20, 0);
  fillQuad(img, W - 20, H / 2, 2, H / 2 - 20, 0);
  for (let i = 0; i < 40; i++) fillQuad(img, 60 + i * 7, H - 40, 1.5, 6, 0);
  return { img, truth, stage };
}
module.exports = { fanPlan, chair, blank };
// straight rows (a flat-floor hall), stage at the top; truth as fanPlan
function gridPlan({ W = 1400, H = 1000, sz = 20, rows = 12, perBlock = 10, blocks = 2, aisle = 2.5 } = {}) {
  const img = blank(W, H), truth = [], stage = { x: W / 2, y: 50 };
  const pitch = sz * 1.25, rowGap = sz * 2;
  const blockW = perBlock * pitch, total = blocks * blockW + (blocks - 1) * aisle * pitch;
  for (let b = 0; b < blocks; b++) for (let r = 0; r < rows; r++) for (let k = 0; k < perBlock; k++) {
    const x = W / 2 - total / 2 + b * (blockW + aisle * pitch) + (k + 0.5) * pitch, y = 200 + r * rowGap;
    chair(img, x, y, sz, -Math.PI / 2);
    truth.push({ x, y, section: b, row: r, k });
  }
  return { img, truth, stage };
}
// make it look scanned: blur + noise + a light grey page
function degrade(img, { noise = 25, blur = 1, seed = 7 } = {}) {
  const { width: W, height: H, data } = img, src = new Uint8ClampedArray(data);
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let t = 0, n = 0;
    for (let dy = -blur; dy <= blur; dy++) for (let dx = -blur; dx <= blur; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) { t += src[(Y * W + X) * 4]; n++; } }
    const v = Math.max(0, Math.min(255, (t / n) * 0.9 + 12 + (rnd() - 0.5) * 2 * noise));
    const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = v;
  }
  return img;
}
module.exports.gridPlan = gridPlan;
module.exports.degrade = degrade;
