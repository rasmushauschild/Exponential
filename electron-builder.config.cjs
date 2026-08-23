// electron-builder config. Notarization runs only when Apple credentials are present in the environment
// (APPLE_KEYCHAIN_PROFILE, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID).
const notarize = !!(process.env.APPLE_KEYCHAIN_PROFILE || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD));

module.exports = {
  appId: 'com.airy.exponential',
  productName: 'Exponential',
  files: ['dist/**', 'electron/**', '!electron/google.client.example.json', 'build/icon.png', 'build/trayTemplate*.png', 'package.json'],
  directories: { output: 'release', buildResources: 'build' },
  publish: [{ provider: 'github', owner: 'rasmushauschild', repo: 'Exponential' }],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: { CFBundleIconName: 'exponential', LSUIElement: false },
    extraResources: [{ from: 'build/Assets.car', to: 'Assets.car' }],
    notarize,
  },
  dmg: { sign: false },
  win: { target: ['nsis'], icon: 'build/icon.png' },
};
