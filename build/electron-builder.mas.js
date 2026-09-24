// Mac App Store build:  npm run dist:mas
// Signing needs an "Apple Distribution" + "Mac Installer Distribution" certificate and a
// provisioning profile saved as build/embedded.provisionprofile (not in the repo).
const fs = require('fs');
const path = require('path');
const store = require('./store-common');
const profile = path.join(__dirname, 'embedded.provisionprofile');

module.exports = store('mas', {
  mas: {
    type: 'distribution',
    hardenedRuntime: false,              // the App Store uses the sandbox instead
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    ...(fs.existsSync(profile) ? { provisioningProfile: 'build/embedded.provisionprofile' } : {}),
    artifactName: 'Roomio-${version}-mas.${ext}',
    extendInfo: require('../package.json').build.mac.extendInfo,
  },
});
