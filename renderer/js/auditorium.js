/* auditorium.js — auditorium file format: validation + normalisation.
   Shared by the renderer (setup wizard, map) and the main process (loading venue.json).
   Spec: docs/auditorium-format.md and docs/auditorium.schema.json

   parseAuditoriumJson(text | object) -> { ok, errors[], warnings[], auditorium }
   parseAuditoriumCsv(text, { name, yAxis })  -> same shape
   normalise(auditorium) -> ROOM (internal, y-down, with viewBox / sections / pitch) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Auditorium = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 'roomio-auditorium';
  const SCHEMA_VERSION = 1;
  const MAX_SEATS = 20000;
  const MAX_BG_BYTES = 25 * 1024 * 1024;
  const UNITS = ['px', 'ft', 'in', 'm', 'cm', 'mm'];
  const BG_TYPES = /^data:image\/(svg\+xml|png|jpeg|webp);base64,/;

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const numOrNumeric = (v) => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);

  function result(errors, warnings, auditorium) {
    return { ok: errors.length === 0, errors, warnings, auditorium: errors.length ? null : auditorium };
  }

  // ---------------------------------------------------------------- JSON
  function parseAuditoriumJson(input) {
    const errors = [], warnings = [];
    let a = input;
    if (typeof input === 'string') {
      try { a = JSON.parse(input); } catch (e) { return result([`Not valid JSON: ${e.message}`], []); }
    }
    if (!a || typeof a !== 'object' || Array.isArray(a)) return result(['The file must contain a JSON object ({ ... }).'], []);
    if (a.format !== undefined && a.format !== FORMAT) errors.push(`"format" must be "${FORMAT}" (found "${a.format}").`);
    if (a.schemaVersion === undefined) warnings.push(`No "schemaVersion" — assuming ${SCHEMA_VERSION}.`);
    else if (a.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported "schemaVersion" ${a.schemaVersion} (this app reads version ${SCHEMA_VERSION}).`);
    if (typeof a.name !== 'string' || !a.name.trim()) errors.push('"name" is required (the venue or room name, e.g. "Main Auditorium").');
    if (a.units !== undefined && !UNITS.includes(a.units)) errors.push(`"units" must be one of ${UNITS.join(', ')}.`);
    if (a.yAxis !== undefined && a.yAxis !== 'down' && a.yAxis !== 'up') errors.push('"yAxis" must be "down" (screen/SVG style) or "up" (CAD style).');

    if (!Array.isArray(a.seats)) errors.push('"seats" is required and must be a list of seats.');
    else if (!a.seats.length) errors.push('"seats" is empty — the file needs at least one seat.');
    else if (a.seats.length > MAX_SEATS) errors.push(`Too many seats (${a.seats.length}); the limit is ${MAX_SEATS}.`);
    else {
      const ids = new Map();
      const shown = { n: 0 };
      const err = (msg) => { if (shown.n++ < 25) errors.push(msg); };
      a.seats.forEach((s, i) => {
        const at = `seats[${i}]`;
        if (!s || typeof s !== 'object') { err(`${at} must be an object like {"id":"A-1-1","x":0,"y":0}.`); return; }
        const id = typeof s.id === 'number' ? String(s.id) : s.id;
        if (typeof id !== 'string' || !id.trim()) err(`${at}.id is required (a unique seat label such as "A-1-12").`);
        else if (ids.has(id)) err(`${at}.id "${id}" is used twice (also seats[${ids.get(id)}]). Seat ids must be unique.`);
        else ids.set(id, i);
        for (const k of ['x', 'y']) if (!isNum(numOrNumeric(s[k]))) err(`${at}.${k} must be a number${s[k] === undefined ? ' (missing)' : ` (found ${JSON.stringify(s[k])})`}.`);
        for (const k of ['z', 'rotation']) if (s[k] !== undefined && s[k] !== null && !isNum(numOrNumeric(s[k]))) err(`${at}.${k} must be a number if present.`);
        if (s.section !== undefined && typeof s.section !== 'string') err(`${at}.section must be text.`);
      });
      if (shown.n > 25) errors.push(`…and ${shown.n - 25} more seat problems.`);
    }
    const pt = (o, key) => {
      if (o === undefined || o === null) return;
      if (typeof o !== 'object' || !isNum(numOrNumeric(o.x)) || !isNum(numOrNumeric(o.y))) errors.push(`"${key}" must look like {"x": 0, "y": 0}.`);
    };
    pt(a.stage, 'stage'); pt(a.foh, 'foh');
    if (a.background !== undefined && a.background !== null) {
      const b = a.background;
      if (typeof b !== 'object') errors.push('"background" must be an object.');
      else {
        if (typeof b.image !== 'string' || !BG_TYPES.test(b.image)) errors.push('"background.image" must be a data URI of an SVG, PNG, JPEG or WebP image (data:image/...;base64,...).');
        else if (b.image.length * 0.75 > MAX_BG_BYTES) errors.push('"background.image" is larger than 25 MB.');
        for (const k of ['x', 'y', 'width', 'height']) if (!isNum(numOrNumeric(b[k]))) errors.push(`"background.${k}" must be a number (the image's position and size in seat coordinates).`);
        if (isNum(b.width) && b.width <= 0 || isNum(b.height) && b.height <= 0) errors.push('"background.width" and "height" must be above 0.');
      }
    }
    if (!errors.length) {
      if (!a.stage) warnings.push('No "stage" — seats will be drawn facing up, and rows can\'t be told apart from the stage side.');
      const dupPos = countStacked(a.seats);
      if (dupPos) warnings.push(`${dupPos} seat${dupPos > 1 ? 's sit' : ' sits'} exactly on top of another seat — check the coordinates.`);
    }
    const auditorium = errors.length ? null : {
      format: FORMAT, schemaVersion: SCHEMA_VERSION, name: a.name.trim(), units: a.units || 'px', yAxis: a.yAxis || 'down',
      seats: a.seats.map(s => clean({
        id: String(s.id), x: +numOrNumeric(s.x), y: +numOrNumeric(s.y), z: s.z == null ? undefined : +numOrNumeric(s.z),
        section: s.section || undefined, row: s.row == null ? undefined : numOrNumeric(s.row), seat: s.seat == null ? undefined : numOrNumeric(s.seat),
        rotation: s.rotation == null ? undefined : +numOrNumeric(s.rotation),
      })),
      stage: a.stage ? clean({ x: +a.stage.x, y: +a.stage.y, label: a.stage.label || 'Stage' }) : undefined,
      foh: a.foh ? { x: +a.foh.x, y: +a.foh.y } : undefined,
      background: a.background ? { image: a.background.image, x: +a.background.x, y: +a.background.y, width: +a.background.width, height: +a.background.height, opacity: a.background.opacity } : undefined,
    };
    return result(errors, warnings, auditorium && clean(auditorium));
  }

  function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }

  function countStacked(seats) {
    const seen = new Set(); let n = 0;
    for (const s of seats) { const k = `${+s.x}|${+s.y}`; if (seen.has(k)) n++; else seen.add(k); }
    return n;
  }

  // ---------------------------------------------------------------- CSV
  // Columns: seat,x,y[,z] — optional extra columns: section,row,number (by header name).
  // Without those, "seat" labels like "C-12-4" / "C 12 4" are split into section-row-seat, "12-4" into row-seat.
  function parseAuditoriumCsv(text, opts = {}) {
    const errors = [], warnings = [];
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!lines.length) return result(['The CSV file is empty.'], []);
    const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === ',' || ch === ';' || ch === '\t') && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
    let rows = lines.map(split);
    let cols = { seat: 0, x: 1, y: 2, z: 3, section: -1, row: -1, number: -1 };
    const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const hasHeader = head.includes('x') && head.includes('y');
    if (hasHeader) {
      const find = (...names) => head.findIndex(h => names.includes(h));
      cols = { seat: find('seat', 'id', 'seatid', 'label', 'name'), x: find('x'), y: find('y'), z: find('z', 'height', 'elevation'),
               section: find('section', 'sec'), row: find('row'), number: find('number', 'seatnumber', 'num', 'no') };
      if (cols.seat < 0) errors.push('CSV header needs a "seat" column (the seat label). Expected: seat,x,y,z');
      rows = rows.slice(1);
    } else if (rows[0].length < 3) errors.push('Each CSV line needs at least seat,x,y (found only ' + rows[0].length + ' value' + (rows[0].length === 1 ? '' : 's') + ' on line 1).');
    if (errors.length) return result(errors, warnings);
    const seats = [];
    const seenAt = new Map();
    let bad = 0;
    rows.forEach((r, i) => {
      const line = i + (hasHeader ? 2 : 1);
      const id = r[cols.seat], x = Number(r[cols.x]), y = Number(r[cols.y]);
      if (id && seenAt.has(id)) { if (bad++ < 25) errors.push(`Line ${line}: seat "${id}" is listed twice (also line ${seenAt.get(id)}). Seat labels must be unique.`); return; }
      if (id) seenAt.set(id, line);
      const z = cols.z >= 0 && r[cols.z] !== undefined && r[cols.z] !== '' ? Number(r[cols.z]) : undefined;
      if (!id) { if (bad++ < 25) errors.push(`Line ${line}: missing seat label.`); return; }
      if (!isFinite(x) || !isFinite(y) || r[cols.x] === '' || r[cols.y] === '') { if (bad++ < 25) errors.push(`Line ${line} (${id}): x and y must be numbers (found "${r[cols.x] ?? ''}", "${r[cols.y] ?? ''}").`); return; }
      if (z !== undefined && !isFinite(z)) { if (bad++ < 25) errors.push(`Line ${line} (${id}): z must be a number or empty.`); return; }
      const s = { id, x, y, z };
      if (cols.section >= 0 && r[cols.section]) s.section = r[cols.section];
      if (cols.row >= 0 && r[cols.row]) s.row = numOrNumeric(r[cols.row]);
      if (cols.number >= 0 && r[cols.number]) s.seat = numOrNumeric(r[cols.number]);
      if (s.row === undefined && s.seat === undefined) {
        const parts = id.split(/[-_ .\/]+/).filter(Boolean);
        if (parts.length >= 3) { s.section = s.section || parts.slice(0, -2).join(' '); s.row = numOrNumeric(parts[parts.length - 2]); s.seat = numOrNumeric(parts[parts.length - 1]); }
        else if (parts.length === 2) { s.row = numOrNumeric(parts[0]); s.seat = numOrNumeric(parts[1]); }
      }
      seats.push(clean(s));
    });
    if (bad > 25) errors.push(`…and ${bad - 25} more problem lines.`);
    if (errors.length) return result(errors, warnings);
    return parseAuditoriumJson({ format: FORMAT, schemaVersion: SCHEMA_VERSION, name: opts.name || 'Imported room', units: opts.units || 'px', yAxis: opts.yAxis || 'up', seats, stage: opts.stage });
  }

  // ---------------------------------------------------------------- normalise (-> map form)
  function sectionCode(name, used) {
    const short = /^[A-Za-z0-9]{1,4}$/.test(name);                 // "LS1", "A", "101" stay as they are
    let base = (short ? name : name.split(/\s+/).map(w => /^\d+$/.test(w) ? w : w[0]).join('')).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'S';
    let code = base, n = 2;
    while (used.has(code)) code = base + n++;
    used.add(code);
    return code;
  }

  function median(a) { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; }

  // typical distance to the nearest neighbouring seat, used to size seats and hit targets
  function seatPitch(seats) {
    const sample = seats.length > 400 ? seats.filter((_, i) => i % Math.ceil(seats.length / 400) === 0) : seats;
    const d = sample.map(s => { let best = Infinity; for (const o of seats) if (o !== s) { const dd = Math.hypot(o.x - s.x, o.y - s.y); if (dd > 0 && dd < best) best = dd; } return best; }).filter(isFinite);
    return median(d) || 1;
  }

  function normalise(a) {
    const flip = a.yAxis === 'up' ? -1 : 1;
    const P = (p) => p ? { ...p, y: p.y * flip } : null;
    const stage = a.stage ? P(a.stage) : null;
    const used = new Set(), codes = new Map();
    const seats = a.seats.map((s, i) => {
      const section = s.section || 'Main';
      if (!codes.has(section)) codes.set(section, sectionCode(section, used));
      const y = s.y * flip;
      let rot = s.rotation;
      if (rot == null) rot = stage ? Math.atan2(stage.y - y, stage.x - s.x) * 180 / Math.PI + 90 : 0;
      return { id: s.id, section, code: codes.get(section), row: s.row ?? 1, seat: s.seat ?? i + 1, x: s.x, y, z: s.z, rot: Math.round(rot * 10) / 10 };
    });
    const pitch = seatPitch(seats);
    let bg = null;
    if (a.background) {
      const b = a.background;
      bg = { href: b.image, x: b.x, y: flip === 1 ? b.y : -(b.y + b.height), width: b.width, height: b.height, opacity: b.opacity };
    }
    const xs = seats.map(s => s.x).concat(stage ? [stage.x] : [], bg ? [bg.x, bg.x + bg.width] : []);
    const ys = seats.map(s => s.y).concat(stage ? [stage.y] : [], bg ? [bg.y, bg.y + bg.height] : []);
    const pad = pitch * 3;
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    const viewBox = [minX, minY, Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY];
    const sections = [...codes.entries()].map(([name, code]) => ({ name, code, seats: seats.filter(s => s.section === name).length }));
    const cx = seats.reduce((t, s) => t + s.x, 0) / seats.length, cy = seats.reduce((t, s) => t + s.y, 0) / seats.length;
    return {
      name: a.name, units: a.units || 'px', flip, viewBox, seats, sections, pitch, background: bg,   // flip: file y = map y * flip
      stage: stage ? { x: stage.x, y: stage.y, label: stage.label || 'Stage' } : null,
      suggestedFoh: a.foh ? P(a.foh) : { x: cx, y: cy },
      center: { x: cx, y: cy },
    };
  }

  return { FORMAT, SCHEMA_VERSION, UNITS, parseAuditoriumJson, parseAuditoriumCsv, normalise, seatPitch };
});
