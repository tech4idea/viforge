import os from 'node:os';
import process from 'node:process';

import { RELEASE_CHANNEL, RELEASE_VERSION, normalizeReleaseTag, releaseManifest, type ReleaseInfo } from '@viforge/shared';

export function getReleaseInfo(): ReleaseInfo {
  const version = process.env.VIFORGE_RELEASE_VERSION?.trim() || releaseManifest.version;
  const tag = process.env.VIFORGE_RELEASE_TAG?.trim() || normalizeReleaseTag(version);
  const channel = process.env.VIFORGE_RELEASE_CHANNEL?.trim() || RELEASE_CHANNEL;
  const commit = process.env.VIFORGE_RELEASE_COMMIT?.trim() || process.env.GITHUB_SHA?.trim() || releaseManifest.commit;
  const platform = detectPlatform();
  const currentArtifact = releaseManifest.artifacts.find((artifact) => artifact.platform === platform);

  return {
    ...releaseManifest,
    version,
    tag,
    channel: channel === 'dev' || channel === 'beta' || channel === 'stable' ? channel : RELEASE_CHANNEL,
    commit,
    currentArtifact,
  };
}

export { RELEASE_VERSION };

function detectPlatform(): ReleaseInfo['currentArtifact'] extends infer T
  ? T extends { platform: infer P }
    ? P
    : never
  : never {
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return os.platform() === 'win32' ? 'windows-x64' : 'linux-x64';
}
