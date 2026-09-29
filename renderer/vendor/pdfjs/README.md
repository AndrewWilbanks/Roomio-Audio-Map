# pdf.js (vendored)

Mozilla pdf.js **6.3.289**, from the npm package `pdfjs-dist@6.3.289`
(https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz, Apache-2.0 — see `LICENSE`).
Used only by the setup wizard to render a PDF floor plan to an image (renderer/js/plan-import.js).

Copied as files rather than an npm dependency because the npm package pulls in an optional
native module (`@napi-rs/canvas`), which the store sandbox rules forbid (SANDBOX.md).

- `pdf.min.mjs`, `pdf.worker.min.mjs` — `build/`
- `wasm/*_nowasm_fallback.js` + licences — JavaScript JBIG2/JPEG 2000 decoders for scanned PDFs.
  The `.wasm` builds are left out so the page's CSP needs no `wasm-unsafe-eval`.
- `standard_fonts/` — the standard 14 PDF fonts (Foxit/Liberation, see their licences)

Rendering runs with `isEvalSupported: false` and `enableScripting: false`.
`MANIFEST.json` pins every file's SHA-256; test/sandbox-guard.test.js checks it.
To update: replace the files from a newer `pdfjs-dist`, then `node dev/vendor-manifest.js`.
