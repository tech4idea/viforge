import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const manifestPath = path.resolve('packages/shared/src/releaseManifest.ts');
const source = readFileSync(manifestPath, 'utf8');

const metadata = {
  version: readConstString('RELEASE_VERSION'),
  channel: readConstString('RELEASE_CHANNEL'),
};

metadata.tag = normalizeReleaseTag(metadata.version);

if (process.argv.includes('--github-output')) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set.');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(output, `version=${metadata.version}\n`, 'utf8');
  appendFileSync(output, `channel=${metadata.channel}\n`, 'utf8');
  appendFileSync(output, `tag=${metadata.tag}\n`, 'utf8');
} else {
  console.log(JSON.stringify(metadata, null, 2));
}

function readConstString(name) {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['\"]([^'\"]+)['\"]`));
  if (!match) {
    throw new Error(`Unable to read ${name} from ${manifestPath}. Keep release metadata as exported string constants.`);
  }
  return match[1];
}

function normalizeReleaseTag(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

