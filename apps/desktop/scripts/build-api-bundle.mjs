import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.join(desktopRoot, 'dist', 'api');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'apps', 'api', 'src', 'index.ts')],
  outfile: path.join(outDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "import { createRequire as __viworkCreateRequire } from 'node:module'; const require = __viworkCreateRequire(import.meta.url);",
  },
  external: [
    'electron',
  ],
});

await cp(
  path.join(repoRoot, 'packages', 'shared', 'src', 'product-profiles'),
  path.join(outDir, 'product-profiles'),
  { recursive: true },
);
