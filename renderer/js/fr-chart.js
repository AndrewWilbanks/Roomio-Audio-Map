/* fr-chart.js — frequency-response line chart (log frequency, one dB axis).
   FRChart.render(el, { series:[{key,label,values[31],cls,dash}], band:[lo,hi]|null, relative:bool })
   Series colors come from CSS (.fr-foh / .fr-seat / .fr-avg); text always uses ink tokens. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const state = new WeakMap();           // el -> {hover index}

  function render(el, opts) {
    const st = state.get(el) || { hover: null };
    state.set(el, st);
    const W = Math.max(280, el.clientWidth || 600), H = opts.height || 230;
    const m = { l: 42, r: 14, t: 12, b: 28 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const lf0 = Math.log10(20), lf1 = Math.log10(20000);
    const x = (f) => m.l + (Math.log10(f) - lf0) / (lf1 - lf0) * pw;

    const all = opts.series.flatMap(s => s.values.filter(v => v != null && isFinite(v)));
    let lo, hi, step;
    if (opts.relative) {
      const a = Math.max(6, Math.ceil(Math.max(0, ...all.map(Math.abs)) / 3) * 3);
      lo = -a; hi = a; step = a > 12 ? 6 : 3;
    } else {
      lo = all.length ? Math.floor(Math.min(...all) / 6) * 6 : 60;
      hi = all.length ? Math.ceil(Math.max(...all) / 6) * 6 : 100;
      if (hi - lo < 24) { const c = (hi + lo) / 2; lo = Math.floor((c - 12) / 6) * 6; hi = lo + 24; }
      step = hi - lo > 48 ? 12 : 6;
    }
    const y = (v) => m.t + (hi - v) / (hi - lo) * ph;

    let g = '';
    if (opts.band) {
      const x0 = x(Math.max(20, opts.band[0])), x1 = x(Math.min(20000, opts.band[1]));
      g += `<rect class="fr-band" x="${x0}" y="${m.t}" width="${x1 - x0}" height="${ph}" rx="3"/>`;
      g += `<text class="fr-band-l" x="${(x0 + x1) / 2}" y="${m.t + 12}" text-anchor="middle">${opts.bandLabel || ''}</text>`;
    }
    for (let v = lo; v <= hi + 1e-9; v += step) {
      g += `<line class="${opts.relative && v === 0 ? 'fr-zero' : 'fr-grid'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      g += `<text class="fr-ax" x="${m.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${opts.relative && v > 0 ? '+' : ''}${v}</text>`;
    }
    for (const f of TICKS) {
      g += `<line class="fr-grid v" x1="${x(f)}" x2="${x(f)}" y1="${m.t}" y2="${m.t + ph}"/>`;
      g += `<text class="fr-ax" x="${x(f)}" y="${H - 9}" text-anchor="middle">${fmtHz(f)}</text>`;
    }
    for (const s of opts.series) {
      let d = '', pen = false;
      s.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(THIRDS[i]).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
      });
      g += `<path class="fr-line ${s.cls}" d="${d}"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
    }
    g += `<g class="fr-hover"></g><rect class="fr-hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>`;

    const legend = opts.series.map(s => `<span class="fr-key"><svg width="22" height="8"><line class="fr-line ${s.cls}" x1="1" x2="21" y1="4" y2="4"${s.dash ? ' stroke-dasharray="5 4"' : ''}/></svg>${s.label}</span>`).join('');
    el.innerHTML = `<div class="fr-legend">${legend}</div>
      <div class="fr-plot"><svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Frequency response chart">${g}</svg><div class="fr-tip"></div></div>`;

    const svg = el.querySelector('svg'), hov = el.querySelector('.fr-hover'), tip = el.querySelector('.fr-tip');
    const show = (i) => {
      st.hover = i;
      if (i == null) { hov.innerHTML = ''; tip.style.display = 'none'; return; }
      const f = THIRDS[i], cx = x(f);
      let dots = `<line class="fr-cross" x1="${cx}" x2="${cx}" y1="${m.t}" y2="${m.t + ph}"/>`;
      const rows = [];
      for (const s of opts.series) {
        const v = s.values[i];
        if (v == null || !isFinite(v)) continue;
        dots += `<circle class="fr-dot ${s.cls}" cx="${cx}" cy="${y(v)}" r="4"/>`;
        rows.push(`<div><span class="fr-sw ${s.cls}"></span>${s.label}<b>${opts.relative ? fmtSigned(v) : fmt(v)} dB</b></div>`);
      }
      hov.innerHTML = dots;
      tip.innerHTML = `<div class="fr-tip-h">${fmtHz(f)} Hz</div>${rows.join('') || '<div class="muted">No data at this band</div>'}`;
      tip.style.display = 'block';
      const left = cx + 14 + tip.offsetWidth > W ? cx - 14 - tip.offsetWidth : cx + 14;
      tip.style.left = left + 'px';
      tip.style.top = m.t + 'px';
    };
    const pick = (e) => {
      const r = svg.getBoundingClientRect();
      const lf = lf0 + (e.clientX - r.left - m.l) / pw * (lf1 - lf0);
      let best = 0;
      THIRDS.forEach((f, i) => { if (Math.abs(Math.log10(f) - lf) < Math.abs(Math.log10(THIRDS[best]) - lf)) best = i; });
      show(best);
    };
    const hit = el.querySelector('.fr-hit');
    hit.addEventListener('pointermove', pick);
    hit.addEventListener('pointerdown', pick);
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(null); });
    if (st.hover != null) show(st.hover);   // keep the crosshair through live refreshes
  }

  function table(series, relative) {
    const head = series.map(s => `<th class="num"><span class="fr-sw ${s.cls}"></span>${s.label}</th>`).join('');
    const rows = THIRDS.map((f, i) => `<tr><td>${fmtHz(f)} Hz</td>${series.map(s => {
      const v = s.values[i];
      return `<td class="num">${v == null || !isFinite(v) ? '—' : relative ? fmtSigned(v) : fmt(v)}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="fr-table-wrap"><table class="rtable"><thead><tr><th>Band</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  window.FRChart = { render, table };
})();
