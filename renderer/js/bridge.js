/* bridge.js — the only place the UI touches persistence and the Smaart backend.
   Desktop: window.raNative (preload.js) -> main process (venue.json + measurements in userData).
   Plain browser (development only): localStorage stand-ins, so the UI can be worked on without Electron. */
(function () {
  const native = window.raNative || null;
  const LS = { venue: 'ra_dev_venue', data: 'ra_dev_data' };
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  // Browser-only fallbacks (development). The desktop app always uses the native dialogs.
  function browserOpen(accept) {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept || '';
      i.onchange = async () => { const f = i.files[0]; resolve(f ? { name: f.name, text: await f.text() } : null); };
      i.click();
    });
  }
  function browserSave(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return Promise.resolve(name);
  }
  const ACCEPT = { auditorium: '.json,.csv,.txt', trace: '.txt,.csv,.asc', readings: '.csv' };

  window.RA = {
    desktop: !!native,
    // user files: native Open/Save dialogs only (SANDBOX.md) -> {name, text} | null
    openTextFile: (purpose) => native ? native.fileOpenText(purpose) : browserOpen(ACCEPT[purpose]),
    saveTextFile: (purpose, defaultName, text) => native ? native.fileSaveText(purpose, defaultName, text) : browserSave(defaultName, text),
    venue: {
      get: () => native ? native.venueGet() : Promise.resolve(read(LS.venue)),
      save: (v) => native ? native.venueSave(v) : Promise.resolve(write(LS.venue, v)),
    },
    data: {
      get: () => native ? native.dataGet() : Promise.resolve(read(LS.data) || { readings: [], spectra: [] }),
      save: (d) => native ? native.dataSave(d) : Promise.resolve(write(LS.data, d)),
    },
    native,
  };
})();
