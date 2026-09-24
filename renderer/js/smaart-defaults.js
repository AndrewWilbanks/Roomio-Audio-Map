/* smaart-defaults.js — Smaart's own factory settings, used ONLY to pre-fill the setup
   wizard (and the Smaart dialog for a venue saved without them). The live connection
   always uses the values saved in venue.json; see SANDBOX.md. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SMAART_DEFAULTS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  return Object.freeze({ host: 'localhost', port: 26000, path: '/api/v4/' });
});
