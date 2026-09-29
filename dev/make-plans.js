// dev/make-plans.js — writes test floor plans (PNG, vector PDF, SVG) of the synthetic fan hall
// from test/helpers/synthetic-plan.js, for dev/e2e-plan.js.   node dev/make-plans.js <outDir>
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const S = require('../test/helpers/synthetic-plan.js');
const out = process.argv[2] || path.join(require('os').tmpdir(), 'roomio-plans');
fs.mkdirSync(out, { recursive: true });

// PNG (greyscale) from the RGBA raster
function png(img) {
  const { width: W, height: H, data } = img;
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; for (let x = 0; x < W; x++) raw[y * (W + 1) + 1 + x] = data[(y * W + x) * 4]; }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// chairs as vector rectangles (same geometry as synthetic-plan.js chair())
function chairRects(x, y, sz, face) {
  const th = face + Math.PI / 2, t = Math.max(1, sz / 12), h = sz / 2;
  const fx = Math.cos(face), fy = Math.sin(face), rx = Math.cos(th), ry = Math.sin(th);
  return [[x + fx * h, y + fy * h, h, t / 2, th], [x - fx * (h - t), y - fy * (h - t), h, t * 1.4, th], [x + rx * h, y + ry * h, h, t / 2, face], [x - rx * h, y - ry * h, h, t / 2, face]];
}
const corners = ([cx, cy, hw, hh, a]) => { const c = Math.cos(a), s = Math.sin(a); return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, w]) => [cx + u * c - w * s, cy + u * s + w * c]); };

const plan = S.fanPlan({ sz: 18 });
fs.writeFileSync(path.join(out, 'fan-hall.png'), png(plan.img));
const rects = plan.truth.flatMap(q => chairRects(q.x, q.y, 18, Math.atan2(plan.stage.y - q.y, plan.stage.x - q.x)));
const W = plan.img.width, H = plan.img.height;
// SVG
fs.writeFileSync(path.join(out, 'fan-hall.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
  rects.map(r => `<polygon points="${corners(r).map(p => p.map(v => v.toFixed(2)).join(',')).join(' ')}"/>`).join('') + '</svg>');
// PDF (one page, the same polygons; PDF y goes up)
const ops = rects.map(r => { const c = corners(r).map(([x, y]) => [x, H - y]); return `${c[0][0].toFixed(2)} ${c[0][1].toFixed(2)} m ` + c.slice(1).map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)} l`).join(' ') + ' h f'; }).join('\n');
const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R >>`, `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`];
let pdf = '%PDF-1.4\n', offs = [];
objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(path.join(out, 'fan-hall.pdf'), pdf);
fs.writeFileSync(path.join(out, 'fan-hall.truth.json'), JSON.stringify({ seats: plan.truth.length, sample: plan.truth[Math.floor(plan.truth.length / 2) + 3], sz: 18, W, H }));
console.log('wrote', out, plan.truth.length, 'seats');
