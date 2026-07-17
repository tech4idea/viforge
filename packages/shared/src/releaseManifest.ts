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
  updateHeadline: 'ViForge第一个版本发布，欢迎使用！',
  updateNotes: [
    '本地优先工作区：项目文件、Agent 配置、记忆、和评测产物默认保存在用户本机',
    '多产品 profile：内置小说改编、情景剧创作和学习研究模板，可按项目选择不同Agent一起协作完成各种任务',
    '桌面单机版：当前支持 Windows 安装包，下载安装后即可使用',
    '微信接入与浏览器协作：支持微信入口和经过用户授权的浏览器自动化边界'
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
