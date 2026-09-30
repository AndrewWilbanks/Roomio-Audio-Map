const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const A = require('../renderer/js/auditorium.js');

test('example hall (v2 areas) parses and normalises', () => {
  const r = A.parseAuditoriumJson(fs.readFileSync(path.join(__dirname, '../docs/examples/example-hall.auditorium.json'), 'utf8'));
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepStrictEqual(r.warnings, []);
  const R = A.normalise(r.auditorium);
  assert.strictEqual(R.areas.length, 7);
  assert.ok(R.areas.every(a => a.poly.length >= 3 && A.pointInPolygon(a.x, a.y, a.poly)), 'labels sit inside their areas');
  assert.ok(R.pitch > 0.5 && R.pitch < 3);
  const rear = R.areas.find(a => a.id === 'rear');
  assert.ok(A.pointInPolygon(rear.x, rear.y, rear.poly), 'notched outline still labelled inside');
});

test('area errors are specific', () => {
  const r = A.parseAuditoriumJson({ name: '', schemaVersion: 2, areas: [{ id: 'a', points: [[0, 0], [1, 1]] }, { id: 'a', points: [[0, 0], [1, 0], [2, 0]] }, { name: 'x', points: [[0, 0], [1, 0], [1, 'q']] }] });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => /"name" is required/.test(e)));
  assert.ok(r.errors.some(e => /areas\[0\]\.points needs at least 3 corners/.test(e)));
  assert.ok(r.errors.some(e => /used twice/.test(e)));
  assert.ok(r.errors.some(e => /no size/.test(e)));
  assert.ok(r.errors.some(e => /areas\[2\]\.id is required/.test(e)));
  assert.ok(!A.parseAuditoriumJson({ name: 'x', schemaVersion: 3, areas: [] }).ok);
  assert.ok(!A.parseAuditoriumJson({ name: 'x', schemaVersion: 2, areas: [] }).ok);
  assert.ok(!A.parseAuditoriumJson('{nope').ok);
});

test('v1 seat files: each section becomes one area around its seats; seat ids map to areas', () => {
  const seats = [];
  for (let r = 0; r < 4; r++) for (let k = 0; k < 6; k++) {
    seats.push({ id: `A-${r + 1}-${k + 1}`, section: 'Stalls', x: k, y: r });
    seats.push({ id: `B-${r + 1}-${k + 1}`, section: 'Balcony', x: k, y: 10 + r, z: 3 });
  }
  seats.push({ id: 'solo', x: 20, y: 20 });                             // no section, single seat
  const r = A.parseAuditoriumJson({ name: 'Old', schemaVersion: 1, seats });
  assert.ok(r.ok, r.errors.join('; '));
  assert.strictEqual(r.auditorium.schemaVersion, 2);
  assert.deepStrictEqual(r.auditorium.areas.map(a => [a.id, a.name]), [['stalls', 'Stalls'], ['balcony', 'Balcony'], ['main', 'Main']]);
  assert.strictEqual(r.seatToArea['B-2-3'], 'balcony');
  assert.strictEqual(r.auditorium.areas[1].z, 3);
  assert.match(r.warnings[0], /49 seats grouped into 3 areas/);
  for (const ar of r.auditorium.areas) {
    const mine = seats.filter(s => r.seatToArea[s.id] === ar.id);
    assert.ok(mine.every(s => A.pointInPolygon(s.x, s.y, ar.points)), `${ar.name} outline contains its seats`);
  }
  // seat-level errors are still reported
  const bad = A.parseAuditoriumJson({ name: 'x', seats: [{ id: 'A1', x: 'q' }, { id: 'A1', x: 1, y: 2 }] });
  assert.ok(bad.errors.some(e => /seats\[0\]\.x must be a number/.test(e)));
  assert.ok(bad.errors.some(e => /used twice/.test(e)));
});

test('CSV seat lists: header optional, labels give sections, errors per line, duplicates caught', () => {
  const ok = A.parseAuditoriumCsv('A-1-1,0,0\nA-1-2,1,0,0.5\nA-2-1,0,1\nB-2-1,5,2\nB-2-2,6,2\nB-3-1,5,3', { name: 'T', yAxis: 'down' });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.deepStrictEqual(ok.auditorium.areas.map(a => a.name), ['A', 'B']);
  const bad = A.parseAuditoriumCsv('seat,x,y,z\nA-1-1,0,10,0\nA-1-3,abc,10,0\n,2,3,0\nA-1-1,4,10,0\n');
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some(e => /^Line 3 .*must be numbers/.test(e)));
  assert.ok(bad.errors.some(e => /^Line 4: missing seat label/.test(e)));
  assert.ok(bad.errors.some(e => /^Line 5: seat "A-1-1" is listed twice/.test(e)));
  assert.ok(!A.parseAuditoriumCsv('').ok);
  const col = A.parseAuditoriumCsv('seat,x,y,section\n101,0,0,Balcony\n102,1,0,Balcony\n103,0,1,Balcony', { name: 'T' });
  assert.deepStrictEqual(col.auditorium.areas.map(a => a.name), ['Balcony'], 'an explicit section column wins');
});

test('geometry helpers: point in polygon, L-shaped label point, y-up files flipped', () => {
  const L = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
  assert.ok(A.pointInPolygon(1, 5, L) && !A.pointInPolygon(6, 6, L));
  const lp = A.labelPoint(L);
  assert.ok(A.pointInPolygon(lp.x, lp.y, L), 'label point inside an L shape');
  const r = A.parseAuditoriumJson({ name: 'Up', schemaVersion: 2, yAxis: 'up', areas: [{ id: 'a', points: [[0, 0], [4, 0], [4, 4], [0, 4]] }], stage: { x: 2, y: 10 } });
  const R = A.normalise(r.auditorium);
  assert.strictEqual(R.flip, -1);
  assert.ok(R.stage.y < R.areas[0].y, 'stage above the area on screen');
});

test('big sections split into blocks of at most 40 seats that don\'t overlap, named front to back', () => {
  // a 15 × 15 block of seats (225) facing a stage on the left, plus a small 3 × 4 section
  const seats = [];
  for (let r = 0; r < 15; r++) for (let k = 0; k < 15; k++) seats.push({ id: `C-${r}-${k}`, section: 'C', x: 10 + r * 3, y: k * 1.75 });
  for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) seats.push({ id: `E-${r}-${k}`, section: 'E', x: 10 + r * 3, y: 40 + k * 1.75 });
  const r = A.parseAuditoriumJson({ name: 'Big', schemaVersion: 1, stage: { x: 0, y: 12 }, seats });
  assert.ok(r.ok, r.errors.join('; '));
  const count = {}; for (const id of Object.values(r.seatToArea)) count[id] = (count[id] || 0) + 1;
  const c = r.auditorium.areas.filter(a => a.name.startsWith('C '));
  assert.ok(c.length >= 6 && c.length <= 8, `${c.length} blocks for 225 seats`);
  assert.ok(c.every(a => count[a.id] <= 40), 'no block over 40 seats');
  assert.deepStrictEqual(r.auditorium.areas.filter(a => a.name === 'E').length, 1, 'small sections stay whole');
  for (const s of seats) {
    const inside = r.auditorium.areas.filter(a => A.pointInPolygon(s.x, s.y, a.points));
    assert.deepStrictEqual(inside.map(a => a.id), [r.seatToArea[s.id]], `${s.id} is inside exactly its own area`);
  }
  const cx = (a) => a.points.reduce((t, p) => t + p[0], 0) / a.points.length;
  assert.ok(cx(c[0]) <= cx(c[c.length - 1]), 'numbered from the stage outward');
  assert.match(r.warnings[0], /at most 40 seats each/);
});

test('default area names never repeat', () => {
  assert.strictEqual(A.nextAreaName([{ name: 'Area 1' }, { name: 'Area 3' }]), 'Area 4');
  assert.strictEqual(A.nextAreaName([{ name: 'Area 3' }, { name: 'Area 2' }]), 'Area 4');
  assert.strictEqual(A.nextAreaName([]), 'Area 1');
});
