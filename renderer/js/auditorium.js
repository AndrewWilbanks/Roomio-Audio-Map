/* auditorium.js — auditorium file format: validation + normalisation.
   Shared by the renderer (setup wizard, map) and the main process (loading venue.json).
   Spec: docs/auditorium-format.md and docs/auditorium.schema.json

   A room is a set of AREAS — named outlines (polygons) the user draws, e.g. "Front Left",
   "Balcony". Each area is measured and coloured as one spot.
   Version 1 files (a list of individual seats) are still read: each section's seats become one
   area outlined around them (seatsToAreas), and readings taken at those seats follow into it.

   parseAuditoriumJson(text | object) -> { ok, errors[], warnings[], auditorium (always v2), seatToArea? }
   parseAuditoriumCsv(text, { name, yAxis })  -> same shape (a seat list, converted)
   normalise(auditorium) -> ROOM (internal, y-down, with viewBox / areas) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Auditorium = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 'roomio-auditorium';
  const SCHEMA_VERSION = 2;
  const MAX_AREAS = 500, MAX_POINTS = 1000, MAX_SEATS = 20000;
  const MAX_BG_BYTES = 25 * 1024 * 1024;
  const UNITS = ['px', 'ft', 'in', 'm', 'cm', 'mm'];
  const BG_TYPES = /^data:image\/(svg\+xml|png|jpeg|webp);base64,/;

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const numOrNumeric = (v) => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);
  const r3 = (v) => Math.round(v * 1000) / 1000;

  function result(errors, warnings, auditorium, extra) {
    return { ok: errors.length === 0, errors, warnings, auditorium: errors.length ? null : auditorium, ...(extra || {}) };
  }
  function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }

  // ---------------------------------------------------------------- geometry
  // polygon = [[x, y], ...] (not closed)
  function polygonArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; } return s / 2; }
  function polygonCentroid(p) {
    const A = polygonArea(p);
    if (Math.abs(A) < 1e-12) return { x: p.reduce((t, q) => t + q[0], 0) / p.length, y: p.reduce((t, q) => t + q[1], 0) / p.length };
    let cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length], f = x1 * y2 - x2 * y1; cx += (x1 + x2) * f; cy += (y1 + y2) * f; }
    return { x: cx / (6 * A), y: cy / (6 * A) };
  }
  function pointInPolygon(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // a point well inside the area for its label (the centroid, unless the shape is L/C-shaped)
  function labelPoint(p) {
    const c = polygonCentroid(p);
    if (pointInPolygon(c.x, c.y, p)) return c;
    let best = null, bd = -1;
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
      const x = x0 + (x1 - x0) * i / 12, y = y0 + (y1 - y0) * j / 12;
      if (!pointInPolygon(x, y, p)) continue;
      let d = Infinity;
      for (let k = 0; k < p.length; k++) d = Math.min(d, segDist(x, y, p[k], p[(k + 1) % p.length]));
      if (d > bd) { bd = d; best = { x, y }; }
    }
    return best || c;
  }
  function segDist(x, y, [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function median(a) { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; }
  // typical distance to the nearest neighbouring seat (v1 seat lists)
  function seatPitch(seats) {
    const sample = seats.length > 400 ? seats.filter((_, i) => i % Math.ceil(seats.length / 400) === 0) : seats;
    const d = sample.map(s => { let best = Infinity; for (const o of seats) if (o !== s) { const dd = Math.hypot(o.x - s.x, o.y - s.y); if (dd > 0 && dd < best) best = dd; } return best; }).filter(isFinite);
    return median(d) || 1;
  }
  function slug(name, used) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'area';
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  }

  // v1 seat list -> one area per section, outlined around its seats (half a seat spacing out)
  // -> { areas, seatToArea: {seatId: areaId} }   (file coordinates, unchanged axis)
  function seatsToAreas(seats) {
    const pitch = seatPitch(seats), pad = pitch * 0.6;
    const by = new Map();
    for (const s of seats) { const k = s.section || 'Main'; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
    const used = new Set(), areas = [], seatToArea = {};
    for (const [name, list] of by) {
      const id = slug(name, used);
      let hull = convexHull(list.map(s => [+s.x, +s.y]));
      if (hull.length < 3 || Math.abs(polygonArea(hull)) < pitch * pitch * 0.5) {
        const xs = list.map(s => +s.x), ys = list.map(s => +s.y);
        const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
        hull = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      } else {
        const c = polygonCentroid(hull);
        hull = hull.map(([x, y]) => { const dx = x - c.x, dy = y - c.y, d = Math.hypot(dx, dy) || 1; return [x + dx / d * pad, y + dy / d * pad]; });
      }
      const zs = list.map(s => s.z).filter(isNum);
      areas.push(clean({ id, name, points: hull.map(([x, y]) => [r3(x), r3(y)]), z: zs.length ? r3(median(zs)) : undefined }));
      for (const s of list) seatToArea[String(s.id)] = id;
    }
    return { areas, seatToArea };
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
    const hasAreas = a.areas !== undefined, hasSeats = a.seats !== undefined;
    const version = a.schemaVersion === undefined ? (hasAreas || !hasSeats ? 2 : 1) : a.schemaVersion;
    if (version !== 1 && version !== 2) errors.push(`Unsupported "schemaVersion" ${a.schemaVersion} (this app reads versions 1 and 2).`);
    if (typeof a.name !== 'string' || !a.name.trim()) errors.push('"name" is required (the venue or room name, e.g. "Main Auditorium").');
    if (a.units !== undefined && !UNITS.includes(a.units)) errors.push(`"units" must be one of ${UNITS.join(', ')}.`);
    if (a.yAxis !== undefined && a.yAxis !== 'down' && a.yAxis !== 'up') errors.push('"yAxis" must be "down" (screen/SVG style) or "up" (CAD style).');
    const shown = { n: 0 };
    const err = (msg) => { if (shown.n++ < 25) errors.push(msg); };

    let areas = null, seatToArea = null;
    if (version === 2 || hasAreas) {
      if (!Array.isArray(a.areas)) errors.push('"areas" is required and must be a list of areas, e.g. {"id":"front-left","name":"Front Left","points":[[0,0],[10,0],[10,8]]}.');
      else if (!a.areas.length) errors.push('"areas" is empty — the file needs at least one area.');
      else if (a.areas.length > MAX_AREAS) errors.push(`Too many areas (${a.areas.length}); the limit is ${MAX_AREAS}.`);
      else {
        const ids = new Map();
        a.areas.forEach((ar, i) => {
          const at = `areas[${i}]`;
          if (!ar || typeof ar !== 'object') { err(`${at} must be an object like {"id":"front","name":"Front","points":[[0,0],[10,0],[10,8]]}.`); return; }
          const id = typeof ar.id === 'number' ? String(ar.id) : ar.id;
          if (typeof id !== 'string' || !id.trim()) err(`${at}.id is required (a unique label such as "front-left").`);
          else if (ids.has(id)) err(`${at}.id "${id}" is used twice (also areas[${ids.get(id)}]). Area ids must be unique.`);
          else ids.set(id, i);
          if (ar.name !== undefined && typeof ar.name !== 'string') err(`${at}.name must be text.`);
          if (!Array.isArray(ar.points) || ar.points.length < 3) err(`${at}.points needs at least 3 corners, like [[0,0],[10,0],[10,8]].`);
          else if (ar.points.length > MAX_POINTS) err(`${at}.points has more than ${MAX_POINTS} corners.`);
          else if (!ar.points.every(q => Array.isArray(q) && q.length >= 2 && isNum(numOrNumeric(q[0])) && isNum(numOrNumeric(q[1])))) err(`${at}.points must be [x, y] number pairs.`);
          else if (Math.abs(polygonArea(ar.points.map(q => [+q[0], +q[1]]))) < 1e-9) err(`${at} has no size — its corners are all in a line.`);
          if (ar.z !== undefined && ar.z !== null && !isNum(numOrNumeric(ar.z))) err(`${at}.z must be a number if present.`);
        });
        if (!errors.length) areas = a.areas.map(ar => clean({
          id: String(ar.id), name: (ar.name || String(ar.id)).trim(),
          points: ar.points.map(q => [+numOrNumeric(q[0]), +numOrNumeric(q[1])]), z: ar.z == null ? undefined : +numOrNumeric(ar.z),
        }));
      }
    } else {
      // version 1: individual seats — validated, then grouped into areas by section
      if (!Array.isArray(a.seats)) errors.push('"seats" (version 1) or "areas" (version 2) is required.');
      else if (!a.seats.length) errors.push('"seats" is empty — the file needs at least one seat.');
      else if (a.seats.length > MAX_SEATS) errors.push(`Too many seats (${a.seats.length}); the limit is ${MAX_SEATS}.`);
      else {
        const ids = new Map();
        a.seats.forEach((s, i) => {
          const at = `seats[${i}]`;
          if (!s || typeof s !== 'object') { err(`${at} must be an object like {"id":"A-1-1","x":0,"y":0}.`); return; }
          const id = typeof s.id === 'number' ? String(s.id) : s.id;
          if (typeof id !== 'string' || !id.trim()) err(`${at}.id is required (a unique seat label such as "A-1-12").`);
          else if (ids.has(id)) err(`${at}.id "${id}" is used twice (also seats[${ids.get(id)}]). Seat ids must be unique.`);
          else ids.set(id, i);
          for (const k of ['x', 'y']) if (!isNum(numOrNumeric(s[k]))) err(`${at}.${k} must be a number${s[k] === undefined ? ' (missing)' : ` (found ${JSON.stringify(s[k])})`}.`);
          if (s.z !== undefined && s.z !== null && !isNum(numOrNumeric(s.z))) err(`${at}.z must be a number if present.`);
          if (s.section !== undefined && typeof s.section !== 'string') err(`${at}.section must be text.`);
        });
        if (!errors.length) {
          const seats = a.seats.map(s => ({ id: String(s.id), x: +numOrNumeric(s.x), y: +numOrNumeric(s.y), z: s.z == null ? undefined : +numOrNumeric(s.z), section: s.section }));
          ({ areas, seatToArea } = seatsToAreas(seats));
          warnings.push(`${seats.length} seat${seats.length === 1 ? '' : 's'} grouped into ${areas.length} area${areas.length === 1 ? '' : 's'} (one per section). Rename, redraw or add areas later with Edit areas.`);
        }
      }
    }
    if (shown.n > 25) errors.push(`…and ${shown.n - 25} more problems.`);
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
        for (const k of ['x', 'y', 'width', 'height']) if (!isNum(numOrNumeric(b[k]))) errors.push(`"background.${k}" must be a number (the image's position and size in the room's coordinates).`);
        if (isNum(b.width) && b.width <= 0 || isNum(b.height) && b.height <= 0) errors.push('"background.width" and "height" must be above 0.');
      }
    }
    if (!errors.length && !a.stage) warnings.push('No "stage" — you can place it in setup (it sets the map\'s orientation label).');
    const auditorium = errors.length ? null : clean({
      format: FORMAT, schemaVersion: SCHEMA_VERSION, name: a.name.trim(), units: a.units || 'px', yAxis: a.yAxis || 'down',
      areas,
      stage: a.stage ? clean({ x: +a.stage.x, y: +a.stage.y, label: a.stage.label || 'Stage' }) : undefined,
      foh: a.foh ? { x: +a.foh.x, y: +a.foh.y } : undefined,
      background: a.background ? clean({ image: a.background.image, x: +a.background.x, y: +a.background.y, width: +a.background.width, height: +a.background.height, opacity: a.background.opacity }) : undefined,
    });
    return result(errors, warnings, auditorium, seatToArea ? { seatToArea } : null);
  }

  // ---------------------------------------------------------------- CSV (a seat list)
  // Columns: seat,x,y[,z] — optional extra column: section (by header name). Without it, labels like
  // "C-12-4" / "C 12 4" give section C. Each section becomes one area.
  function parseAuditoriumCsv(text, opts = {}) {
    const errors = [], warnings = [];
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!lines.length) return result(['The CSV file is empty.'], []);
    const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === ',' || ch === ';' || ch === '\t') && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
    let rows = lines.map(split);
    let cols = { seat: 0, x: 1, y: 2, z: 3, section: -1 };
    const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const hasHeader = head.includes('x') && head.includes('y');
    if (hasHeader) {
      const find = (...names) => head.findIndex(h => names.includes(h));
      cols = { seat: find('seat', 'id', 'seatid', 'label', 'name'), x: find('x'), y: find('y'), z: find('z', 'height', 'elevation'), section: find('section', 'sec', 'area') };
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
      else {
        const parts = id.split(/[-_ .\/]+/).filter(Boolean);
        if (parts.length >= 3) s.section = parts.slice(0, -2).join(' ');
      }
      seats.push(clean(s));
    });
    if (bad > 25) errors.push(`…and ${bad - 25} more problem lines.`);
    if (errors.length) return result(errors, warnings);
    return parseAuditoriumJson({ format: FORMAT, schemaVersion: 1, name: opts.name || 'Imported room', units: opts.units || 'px', yAxis: opts.yAxis || 'up', seats, stage: opts.stage });
  }

  // ---------------------------------------------------------------- normalise (-> map form)
  function normalise(a) {
    const flip = a.yAxis === 'up' ? -1 : 1;
    const P = (p) => p ? { ...p, y: p.y * flip } : null;
    const stage = a.stage ? P(a.stage) : null;
    const areas = a.areas.map(ar => {
      const poly = ar.points.map(([x, y]) => [x, y * flip]);
      const lp = labelPoint(poly), size = Math.sqrt(Math.abs(polygonArea(poly)));
      return { id: ar.id, name: ar.name || ar.id, poly, x: lp.x, y: lp.y, z: ar.z, size };
    });
    // map proportions (booth marker, strokes, labels) follow the typical area size
    const typical = median(areas.map(ar => ar.size)) || 1;
    const pitch = typical * 0.15;
    let bg = null;
    if (a.background) {
      const b = a.background;
      bg = { href: b.image, x: b.x, y: flip === 1 ? b.y : -(b.y + b.height), width: b.width, height: b.height, opacity: b.opacity };
    }
    const px = areas.flatMap(ar => ar.poly.map(q => q[0])), py = areas.flatMap(ar => ar.poly.map(q => q[1]));
    // the view fits the areas (and stage); a background only widens it when it's roughly the room —
    // a whole drawing sheet (title block, other floors…) would leave the areas small
    const roomArea = Math.max(typical * typical, (Math.max(...px) - Math.min(...px)) * (Math.max(...py) - Math.min(...py)));
    const bgFits = bg && bg.width * bg.height <= roomArea * 4;
    const xs = px.concat(stage ? [stage.x] : [], bgFits ? [bg.x, bg.x + bg.width] : []);
    const ys = py.concat(stage ? [stage.y] : [], bgFits ? [bg.y, bg.y + bg.height] : []);
    const pad = typical * 0.25;
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    const viewBox = [minX, minY, Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY];
    const cx = areas.reduce((t, s) => t + s.x, 0) / areas.length, cy = areas.reduce((t, s) => t + s.y, 0) / areas.length;
    return {
      name: a.name, units: a.units || 'px', flip, viewBox, areas, pitch, background: bg,   // flip: file y = map y * flip
      stage: stage ? { x: stage.x, y: stage.y, label: stage.label || 'Stage' } : null,
      suggestedFoh: a.foh ? P(a.foh) : { x: cx, y: cy },
      center: { x: cx, y: cy },
    };
  }

  return { FORMAT, SCHEMA_VERSION, UNITS, parseAuditoriumJson, parseAuditoriumCsv, normalise, seatsToAreas,
    polygonArea, polygonCentroid, pointInPolygon, labelPoint, slug };
});
