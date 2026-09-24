// Microsoft Store (MSIX / appx) build:  npm run dist:appx   (must run on Windows)
// ⚠️ PLACEHOLDERS — replace with the values from Partner Center → Product identity before submitting.
const store = require('./store-common');

module.exports = store('appx', {
  win: {
    target: [{ target: 'appx', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.png',
  },
  appx: {
    identityName: 'REPLACE_ME.Roomio',                 // Package/Identity/Name
    publisher: 'CN=REPLACE-ME-PUBLISHER-ID',           // Package/Identity/Publisher
    publisherDisplayName: 'REPLACE ME Publisher Name', // Package/Properties/PublisherDisplayName
    applicationId: 'Roomio',
    displayName: 'Roomio',
    backgroundColor: '#081A26',
    languages: ['en-US'],
    artifactName: 'Roomio-${version}-store.${ext}',
  },
});
