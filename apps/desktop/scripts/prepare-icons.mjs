import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const sourceSvg = path.join(repoRoot, 'apps', 'web', 'public', 'viforge-logo.svg');
const buildRoot = path.join(desktopRoot, 'build');

await mkdir(buildRoot, { recursive: true });

await sharp(sourceSvg)
  .resize(512, 512)
  .png()
  .toFile(path.join(buildRoot, 'icon.png'));

const icoPng = await sharp(sourceSvg)
  .resize(256, 256)
  .png()
  .toBuffer();

await writeFile(path.join(buildRoot, 'icon.ico'), createIcoFromPng(icoPng, 256, 256));

console.info(`Prepared desktop icons from ${sourceSvg}`);

function createIcoFromPng(pngBuffer, width, height) {
  const headerSize = 6;
  const directorySize = 16;
  const imageOffset = headerSize + directorySize;
  const ico = Buffer.alloc(imageOffset + pngBuffer.length);

  ico.writeUInt16LE(0, 0); // reserved
  ico.writeUInt16LE(1, 2); // icon type
  ico.writeUInt16LE(1, 4); // image count
  ico.writeUInt8(width >= 256 ? 0 : width, 6);
  ico.writeUInt8(height >= 256 ? 0 : height, 7);
  ico.writeUInt8(0, 8); // no color palette
  ico.writeUInt8(0, 9); // reserved
  ico.writeUInt16LE(1, 10); // color planes
  ico.writeUInt16LE(32, 12); // bits per pixel
  ico.writeUInt32LE(pngBuffer.length, 14);
  ico.writeUInt32LE(imageOffset, 18);
  pngBuffer.copy(ico, imageOffset);

  return ico;
}
