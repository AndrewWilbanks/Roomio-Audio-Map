// Floor-plan seat finding (renderer/js/plan-detect.js) on synthetic plans drawn by
// test/helpers/synthetic-plan.js: a fan-shaped hall and a flat hall with straight rows.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../renderer/js/plan-detect.js');
const S = require('./helpers/synthetic-plan.js');

const boxAround = (q, sz, k = 1.2) => ({ x: q.x - sz * k / 2, y: q.y - sz * k / 2, w: sz * k, h: sz * k });
function score(truth, seats, tol) {
  return {
    found: truth.filter(q => seats.some(s => Math.hypot(s.x - q.x, s.y - q.y) < tol)).length,
    falseHits: seats.filter(s => !truth.some(q => Math.hypot(s.x - q.x, s.y - q.y) < tol)).length,
  };
}

test('fan hall: finds every seat at any angle from one boxed sample, no false hits', async () => {
  const { img, truth, stage } = S.fanPlan({ sz: 18 });
  const r = await P.detectSeats(img, boxAround(truth[103], 18), { sensitivity: 0.5 });
  const s = score(truth, r.seats, 7);
  assert.ok(s.found >= truth.length * 0.97, `found ${s.found}/${truth.length}`);
  assert.strictEqual(s.falseHits, 0);
  const L = P.labelSeats(r.seats);
  assert.ok(Math.hypot(L.stage.x - stage.x, L.stage.y - stage.y) < 20, 'stage found where the rows point');
  assert.strictEqual(new Set(L.seats.map(x => x.section)).size, 3, 'three sections split by the aisles');
});

test('flat hall, scanned (blur, noise, grey paper): straight rows, stage side guessed', async () => {
  const plan = S.gridPlan({ sz: 20 });
  S.degrade(plan.img, { noise: 30 });
  const { img, truth } = plan;
  const r = await P.detectSeats(img, boxAround(truth[125], 20), { sensitivity: 0.5 });
  const s = score(truth, r.seats, 8);
  assert.ok(s.found >= truth.length * 0.97, `found ${s.found}/${truth.length}`);
  assert.strictEqual(s.falseHits, 0);
  const L = P.labelSeats(r.seats);
  assert.ok(L.stage.y < Math.min(...truth.map(q => q.y)), 'stage in front of the rows (top of the plan)');
  assert.strictEqual(new Set(L.seats.map(x => x.section)).size, 2);
});

test('numbering: sections from the audience\'s left, row 1 nearest the stage, seat 1 on the left', () => {
  const { truth } = S.fanPlan({ sz: 18 });
  const L = P.labelSeats(truth);
  const lab = (i) => L.seats[i];
  // each true row maps to exactly one labelled row
  const rows = new Map();
  truth.forEach((q, i) => { const k = `${q.section}/${q.row}`; if (!rows.has(k)) rows.set(k, new Set()); rows.get(k).add(`${lab(i).section}-${lab(i).row}`); });
  assert.ok([...rows.values()].every(v => v.size === 1), 'rows are not split or merged');
  const meanX = (sec) => { const a = truth.filter((q, i) => lab(i).section === sec); return a.reduce((t, q) => t + q.x, 0) / a.length; };
  assert.ok(meanX('A') < meanX('B') && meanX('B') < meanX('C'), 'stage at the top: audience-left is screen-left');
  assert.ok(truth.every((q, i) => (lab(i).row === 1) === (q.row === 0)), 'row 1 = front row');
  const b3 = truth.map((q, i) => [q, lab(i)]).filter(([, l]) => l.section === 'B' && l.row === 3).sort((a, b) => a[1].seat - b[1].seat);
  assert.ok(b3.every(([q], j) => !j || q.x > b3[j - 1][0].x), 'seat numbers run left to right');
  assert.strictEqual(new Set(L.seats.map(x => x.id)).size, truth.length, 'ids are unique');
});

test('an empty box is reported instead of matching blank paper', async () => {
  const { img } = S.fanPlan({ sz: 18 });
  const r = await P.detectSeats(img, { x: 100, y: 700, w: 20, h: 20 });   // blank paper, away from walls and seats
  assert.match(r.error, /empty/);
  assert.strictEqual(r.seats.length, 0);
});
