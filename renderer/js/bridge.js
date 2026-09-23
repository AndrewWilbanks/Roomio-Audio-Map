/* bridge.js — the only place the UI touches persistence and the Smaart backend.
   Desktop: window.raNative (preload.js) -> main process (venue.json + measurements in userData).
   Plain browser (development only): localStorage stand-ins, so the UI can be worked on without Electron. */
(function () {
  const native = window.raNative || null;
  const LS = { venue: 'ra_dev_venue', data: 'ra_dev_data' };
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  window.RA = {
    desktop: !!native,
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
