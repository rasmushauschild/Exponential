// electron-builder config. Notarization runs only when Apple credentials are present in the environment
// (APPLE_KEYCHAIN_PROFILE, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID).
const notarize = !!(process.env.APPLE_KEYCHAIN_PROFILE || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD));

module.exports = {
  appId: 'com.airy.exponential',
  productName: 'Exponential',
  files: ['dist/**', 'electron/**', '!electron/google.client.example.json', 'build/icon.png', 'build/trayTemplate*.png', 'package.json'],
  // The MCP server ships inside the app as ONE esbuild-bundled file (electron-builder refuses to
  // copy node_modules via extraResources). "Connect to Claude" registers it; the app binary doubles
  // as its Node runtime via ELECTRON_RUN_AS_NODE, so users need nothing else installed.
  extraResources: [{ from: 'mcp/server.bundle.mjs', to: 'mcp/server.bundle.mjs' }],
  directories: { output: 'release', buildResources: 'build' },
  publish: [{ provider: 'github', owner: 'rasmushauschild', repo: 'Exponential' }],
  mac: {
    // arm64 only. The zip target must stay: electron-updater on macOS updates from the zip, not the dmg.
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      CFBundleIconName: 'exponential',
      LSUIElement: false,
      // Without this string macOS never shows the mic prompt to the PACKAGED app and
      // getUserMedia silently delivers a dead track (dev runs under Electron's own
      // Info.plist, which has one — recording worked in dev and not in the shipped app).
      NSMicrophoneUsageDescription: 'Exponential uses the microphone to record meetings when you press Record.',
    },
    extraResources: [{ from: 'build/Assets.car', to: 'Assets.car' }],
    notarize,
  },
  dmg: { sign: false, writeUpdateInfo: false },
  // x64 explicitly: building on Apple Silicon otherwise defaults to a Windows arm64 build.
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/icon.png' },
};
