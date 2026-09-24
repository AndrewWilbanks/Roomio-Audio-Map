// build/store-common.js — shared electron-builder config for the store builds (mas, appx).
// Starts from package.json "build" (the direct-download config) and removes self-update:
// buildTarget is baked into the packaged package.json and electron-updater isn't packaged.
const base = require('../package.json').build;

module.exports = (buildTarget, extra) => ({
  ...base,
  // buildTarget is baked into the packaged package.json. (Its "dependencies" list still names
  // electron-updater — metadata only; the files below keep its code out of the package.)
  extraMetadata: { ...(base.extraMetadata || {}), buildTarget },
  files: [
    ...base.files,
    // no self-update code in store builds: drop electron-updater and everything only it needs
    '!node_modules/electron-updater{,/**/*}', '!node_modules/builder-util-runtime{,/**/*}',
    '!node_modules/fs-extra{,/**/*}', '!node_modules/js-yaml{,/**/*}', '!node_modules/lazy-val{,/**/*}',
    '!node_modules/lodash.escaperegexp{,/**/*}', '!node_modules/lodash.isequal{,/**/*}', '!node_modules/semver{,/**/*}',
    '!node_modules/tiny-typed-emitter{,/**/*}', '!node_modules/debug{,/**/*}', '!node_modules/ms{,/**/*}',
    '!node_modules/sax{,/**/*}', '!node_modules/graceful-fs{,/**/*}', '!node_modules/jsonfile{,/**/*}',
    '!node_modules/universalify{,/**/*}', '!node_modules/argparse{,/**/*}',
    '!main/updater.js',
  ],
  publish: null,                   // stores distribute the build, not GitHub Releases
  ...extra,
});
