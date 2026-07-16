import { readFileSync } from 'node:fs';
import path from 'node:path';

const manifestSource = readFileSync(path.resolve('..', '..', 'packages', 'shared', 'src', 'releaseManifest.ts'), 'utf8');
const productName = readConstString('RELEASE_PRODUCT_NAME');
const manifestVersion = readConstString('RELEASE_VERSION');
const manifestChannel = readConstString('RELEASE_CHANNEL');
const releaseVersion = process.env.VIFORGE_RELEASE_VERSION?.trim() || manifestVersion;
const releaseChannel = normalizeReleaseChannel(process.env.VIFORGE_RELEASE_CHANNEL?.trim()) || manifestChannel;

export default {
  appId: 'cn.viforge.desktop',
  productName: 'ViForge',
  executableName: 'viforge',
  npmRebuild: false,
  directories: {
    output: '../../release/desktop',
  },
  files: [
    'dist/**/*',
    'build/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: '../web/dist',
      to: 'web',
    },
    {
      from: 'dist/api',
      to: 'api',
      filter: ['**/*'],
    },
    {
      from: 'resources/postgres',
      to: 'postgres',
      filter: ['**/*'],
    },
    {
      from: '../../LICENSE',
      to: 'LICENSE',
    },
    {
      from: '../../NOTICE',
      to: 'NOTICE',
    },
    {
      from: '../../THIRD_PARTY_NOTICES.md',
      to: 'THIRD_PARTY_NOTICES.md',
    },
  ],
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    artifactName: buildReleaseArtifactFileName({
      productName,
      version: releaseVersion,
      channel: releaseChannel,
      platform: 'win32-x64',
      qualifier: 'installer',
      extension: 'exe',
    }),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    include: 'installer.nsh',
  },
  mac: {
    target: ['dmg'],
    icon: 'build/icon.png',
  },
  linux: {
    target: ['AppImage'],
    icon: 'build/icon.png',
  },
};

function readConstString(name) {
  const pattern = new RegExp("export\\s+const\\s+" + name + "\\s*=\\s*['\"]([^'\"]+)['\"]");
  const match = manifestSource.match(pattern);
  if (!match) throw new Error("Unable to read " + name + " from releaseManifest.ts");
  return match[1];
}

function buildReleaseArtifactFileName(input) {
  const qualifier = input.qualifier ? '-' + input.qualifier : '';
  return input.productName + '-' + input.version + '-' + input.channel + '-' + input.platform + qualifier + '.' + input.extension;
}

function normalizeReleaseChannel(value) {
  return value === 'dev' || value === 'beta' || value === 'stable' ? value : undefined;
}
