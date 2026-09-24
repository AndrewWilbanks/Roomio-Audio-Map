// dev/build-help.js — turns README.md into renderer/help.html (the in-app Help window).
// Help is shown inside Roomio instead of opening another app (SANDBOX.md).
// Handles the Markdown the README uses: headings, paragraphs, lists, tables, code, emphasis, links.
//   node dev/build-help.js          (writes renderer/help.html)
//   node dev/build-help.js --check  (exit 1 if help.html is out of date — used by the tests)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');

function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    /^https?:/.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
      : url.startsWith('#') ? `<a href="${url}">${label}</a>`
      : `<span class="ref">${label}</span>`);               // repo-relative links aren't bundled
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0;
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>\n`; para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>\n`; i++; continue;
    }
    const h = l.match(/^(#{1,4}) (.*)$/);
    if (h) { flush(); const txt = inline(h[2]); html += `<h${h[1].length} id="${slug(h[2])}">${txt}</h${h[1].length}>\n`; i++; continue; }
    if (/^---+\s*$/.test(l)) { flush(); html += '<hr>\n'; i++; continue; }
    if (/^\|/.test(l)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|')));
      const body = rows.filter((_, k) => k !== 1);
      html += '<table><thead><tr>' + cells(body[0]).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        body.slice(1).map(r => '<tr>' + cells(r).map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>\n';
      continue;
    }
    const li = l.match(/^(\s*)([-*]|\d+\.) (.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.) (.*)$/);
        if (m) { items.push(m[3]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      html += `<${ordered ? 'ol' : 'ul'}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>\n`;
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return html;
}

function page(body) {
  return `<!DOCTYPE html>
<!-- Generated from README.md by dev/build-help.js — do not edit by hand. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Roomio Help</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'none'">
<link rel="stylesheet" href="css/theme.css">
<style>
  body{max-width:820px;margin:0 auto;padding:28px 32px 60px;font-size:14.5px;line-height:1.6;background:var(--paper);}
  h1{font-size:30px;margin-top:0} h2{font-size:22px;margin-top:34px} h3{font-size:17px;margin-top:22px}
  code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--surface);border:1px solid var(--line2);border-radius:5px;padding:1px 5px}
  pre{background:var(--surface);border:1.5px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto}
  pre code{border:none;padding:0;background:none}
  table{margin:10px 0 16px;font-size:13px} th,td{vertical-align:top}
  hr{border:none;border-top:1px solid var(--line2);margin:26px 0}
  .ref{font-weight:700}
</style>
</head>
<body>
${body}</body>
</html>
`;
}

// the developer section is for contributors, not end users
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split(/\n## For developers/)[0];
const out = page(render(readme));
const target = path.join(ROOT, 'renderer', 'help.html');
if (process.argv.includes('--check')) {
  // compare ignoring line endings (Git on Windows may check files out with CRLF)
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (norm(cur) !== norm(out)) { console.error('renderer/help.html is out of date — run: node dev/build-help.js'); process.exit(1); }
} else {
  fs.writeFileSync(target, out);
  console.log('wrote', path.relative(ROOT, target));
}
