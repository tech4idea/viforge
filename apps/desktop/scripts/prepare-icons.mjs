import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const sourceSvg = path.join(repoRoot, 'apps', 'web', 'public', 'viwork-logo.svg');
const buildRoot = path.join(desktopRoot, 'build');

await mkdir(buildRoot, { recursive: true });

await sharp(sourceSvg)
  .resize(512, 512)
  .png()
  .toFile(path.join(buildRoot, 'icon.png'));

await sharp(sourceSvg)
  .resize(256, 256)
  .png()
  .toFile(path.join(buildRoot, 'icon.ico'));

console.info(`Prepared desktop icons from ${sourceSvg}`);
