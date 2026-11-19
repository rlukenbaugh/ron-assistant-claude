'use strict';
// Packaging settings for electron-builder (npm run dist:win / publish:win).
//
// Windows code signing is chosen from the environment, so the same file works signed and unsigned:
//   1. Microsoft Artifact Signing (formerly Trusted Signing), when all of
//      ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT, ARTIFACT_SIGNING_PROFILE and
//      ARTIFACT_SIGNING_PUBLISHER are set. Azure sign-in comes from AZURE_TENANT_ID,
//      AZURE_CLIENT_ID and AZURE_CLIENT_SECRET (an app registration allowed to sign).
//   2. A code-signing certificate file, when CSC_LINK (and CSC_KEY_PASSWORD) are set.
//   3. Otherwise the build is unsigned, and Windows SmartScreen will warn when it is run.
// See docs/code-signing.md.

const env = process.env;
const artifactSigning = ['ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE', 'ARTIFACT_SIGNING_PUBLISHER'].every((k) => env[k]);
const certificate = Boolean(env.CSC_LINK);

/** @type {'artifact-signing' | 'certificate' | 'unsigned'} */
const signing = artifactSigning ? 'artifact-signing' : certificate ? 'certificate' : 'unsigned';

/** @type {import('app-builder-lib').Configuration} */
const config = {
  appId: 'com.rlukenbaugh.ronassistant.claude',
  productName: 'Ron Assistant',
  directories: { output: 'release' },
  // Uploads go into a draft that the release workflow creates first and publishes last. Letting
  // electron-builder create the release itself raced: the installer and the portable exe each
  // created one, leaving two releases with the same tag (seen with v0.3.0).
  publish: { provider: 'github', owner: 'rlukenbaugh', repo: 'ron-assistant-claude', releaseType: 'draft' },
  files: ['src/**/*', 'build/icons/**/*', 'package.json', '!**/*.map', '!**/*.d.ts'],
  win: {
    icon: 'build/icons/icon.ico',
    target: ['nsis', 'portable'],
    ...(signing === 'artifact-signing' ? {
      azureSignOptions: {
        endpoint: env.ARTIFACT_SIGNING_ENDPOINT,
        codeSigningAccountName: env.ARTIFACT_SIGNING_ACCOUNT,
        certificateProfileName: env.ARTIFACT_SIGNING_PROFILE,
        publisherName: env.ARTIFACT_SIGNING_PUBLISHER,
      },
    } : {}),
    ...(signing === 'unsigned' ? { signExecutable: false } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Ron Assistant',
    artifactName: 'Ron-Assistant-Setup-${version}-${arch}.${ext}',
  },
  portable: { artifactName: 'Ron-Assistant-Portable-${version}-${arch}.${ext}' },
};

if (require.main !== module) console.log(`[electron-builder.config] Windows signing: ${signing}`);

module.exports = config;
