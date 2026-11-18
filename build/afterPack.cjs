// Ad-hoc sign the macOS app after packaging.
//
// We don't have an Apple Developer ID yet, so electron-builder skips signing.
// That leaves Electron's stock signature broken (the bundle was modified),
// and Apple Silicon won't run code with an invalid signature. An ad-hoc
// signature ("-") needs no certificate and fixes that. Gatekeeper still
// warns on first open (see README, "Troubleshooting installs").
//
// If a real signing identity is configured later, electron-builder's own
// signing step runs after this and replaces the ad-hoc signature.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
