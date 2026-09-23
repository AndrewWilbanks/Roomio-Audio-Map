const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const A = require('../renderer/js/auditorium.js');

test('example hall parses and normalises (y-up flipped)', () => {
  const r = A.parseAuditoriumJson(fs.readFileSync(path.join(__dirname, '../docs/examples/example-hall.auditorium.json'), 'utf8'));
  assert.ok(r.ok, r.errors.join('; '));
  const R = A.normalise(r.auditorium);
  assert.strictEqual(R.seats.length, 198);
  assert.strictEqual(R.flip, -1);
  assert.ok(R.stage.y < 0, 'stage y flipped to screen coordinates');
  assert.ok(R.pitch > 0.5 && R.pitch < 1.5);
});

test('JSON errors are specific', () => {
  const r = A.parseAuditoriumJson({ name: '', seats: [{ id: 'A1', x: 'q' }, { id: 'A1', x: 1, y: 2 }] });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => /"name" is required/.test(e)));
  assert.ok(r.errors.some(e => /seats\[0\]\.x must be a number/.test(e)));
  assert.ok(r.errors.some(e => /used twice/.test(e)));
  assert.ok(!A.parseAuditoriumJson({ name: 'x', schemaVersion: 2, seats: [{ id: 1, x: 0, y: 0 }] }).ok);
  assert.ok(!A.parseAuditoriumJson('{nope').ok);
});

test('CSV: header optional, labels split, errors per line, duplicates caught', () => {
  const ok = A.parseAuditoriumCsv('A-1-1,0,0\nA-1-2,1,0,0.5\nB-2-1,0,2', { name: 'T', yAxis: 'down' });
  assert.ok(ok.ok, ok.errors.join('; '));
  const s = ok.auditorium.seats;
  assert.deepStrictEqual([s[0].section, s[0].row, s[0].seat], ['A', 1, 1]);
  assert.strictEqual(s[1].z, 0.5);
  const bad = A.parseAuditoriumCsv('seat,x,y,z\nA-1-1,0,10,0\nA-1-3,abc,10,0\n,2,3,0\nA-1-1,4,10,0\n');
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some(e => /^Line 3 .*must be numbers/.test(e)));
  assert.ok(bad.errors.some(e => /^Line 4: missing seat label/.test(e)));
  assert.ok(bad.errors.some(e => /^Line 5: seat "A-1-1" is listed twice/.test(e)));
  assert.ok(!A.parseAuditoriumCsv('').ok);
});

test('explicit section/row/number columns win over label parsing', () => {
  const r = A.parseAuditoriumCsv('seat,x,y,section,row,number\n101,0,0,Balcony,C,7', { name: 'T' });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.auditorium.seats[0].section, r.auditorium.seats[0].row, r.auditorium.seats[0].seat], ['Balcony', 'C', 7]);
});
