import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.join(desktopRoot, 'dist', 'api');

const chromiumBidiShimPlugin = {
  name: 'chromium-bidi-shim',
  setup(build) {
    build.onResolve({ filter: /^chromium-bidi\/lib\/cjs\/(bidiMapper\/BidiMapper|cdp\/CdpConnection)$/ }, (args) => ({
      path: args.path,
      namespace: 'chromium-bidi-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'chromium-bidi-shim' }, (args) => {
      if (args.path.endsWith('/bidiMapper/BidiMapper')) {
        return {
          contents: 'export const BidiServer = { createAndStart() { throw new Error("Playwriter desktop bundle does not include chromium-bidi."); } };',
          loader: 'js',
        };
      }
      return {
        contents: 'export class MapperCdpConnection { constructor() { throw new Error("Playwriter desktop bundle does not include chromium-bidi."); } }',
        loader: 'js',
      };
    });
  },
};

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

await build({
  entryPoints: [path.join(repoRoot, 'apps', 'api', 'node_modules', 'playwriter', 'bin.js')],
  outfile: path.join(desktopRoot, 'dist', 'playwriter-cli.mjs'),
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
    'fsevents',
  ],
  plugins: [chromiumBidiShimPlugin],
});

await cp(
  path.join(repoRoot, 'packages', 'shared', 'src', 'product-profiles'),
  path.join(outDir, 'product-profiles'),
  { recursive: true },
);

