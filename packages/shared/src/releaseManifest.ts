import type { ReleaseInfo } from './contracts';

export const RELEASE_PRODUCT_NAME = 'ViForge';
export const RELEASE_VERSION = '0.1.0';
export const RELEASE_CHANNEL = 'beta' satisfies ReleaseInfo['channel'];

export const releaseManifest: ReleaseInfo = {
  productName: RELEASE_PRODUCT_NAME,
  version: RELEASE_VERSION,
  channel: RELEASE_CHANNEL,
  tag: normalizeReleaseTag(RELEASE_VERSION),
  releaseDate: '2026-07-15',
  commit: '',
  updateHeadline: '建立统一版本管理链路',
  updateNotes: [
    '统一源码 tag、桌面制品包、产品内版本展示与更新说明的数据来源。',
    '新增版本信息 API，前端与桌面端可读取同一份 release metadata。',
    '发布流程改为围绕 canonical release manifest 组织，降低人工维护漂移。',
  ],
  artifacts: [
    {
      platform: 'windows-x64',
      fileName: buildReleaseArtifactFileName({
        productName: RELEASE_PRODUCT_NAME,
        version: RELEASE_VERSION,
        channel: RELEASE_CHANNEL,
        platform: 'win32-x64',
        qualifier: 'installer',
        extension: 'exe',
      }),
      target: 'nsis',
    },
  ],
};

export function normalizeReleaseTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

export function buildReleaseArtifactFileName(input: {
  productName: string;
  version: string;
  channel: ReleaseInfo['channel'];
  platform: string;
  qualifier?: string;
  extension: string;
}): string {
  const qualifier = input.qualifier ? `-${input.qualifier}` : '';
  return `${input.productName}-${input.version}-${input.channel}-${input.platform}${qualifier}.${input.extension}`;
}
