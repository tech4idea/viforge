import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = path.join(desktopRoot, 'dist', 'api');
const playwriterPackageJson = JSON.parse(await readFile(path.join(repoRoot, 'apps', 'api', 'node_modules', 'playwriter', 'package.json'), 'utf8'));
const playwriterVersion = playwriterPackageJson.version;
const playwriterCliOutfile = path.join(desktopRoot, 'dist', 'playwriter-cli.mjs');

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

const playwriterUtilsShimPlugin = {
  name: 'playwriter-utils-shim',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]playwriter[\\/]dist[\\/]utils\.js$/ }, () => ({
      loader: 'js',
      contents: `
        import os from 'node:os';
        import path from 'node:path';
        export const EXTENSION_IDS = [
          'jfeammnjpkecdekppnclgkkffahnhfhe',
          'pebbngnfojnignonigcnkdilknapkgid',
        ];
        export function parseRelayHost(host, port = 19988) {
          if (host.startsWith('https://') || host.startsWith('http://')) {
            const url = new URL(host);
            const httpBaseUrl = url.origin;
            const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsBaseUrl = wsProtocol + '//' + url.host;
            return { httpBaseUrl, wsBaseUrl };
          }
          return { httpBaseUrl: 'http://' + host + ':' + port, wsBaseUrl: 'ws://' + host + ':' + port };
        }
        export function getCdpUrl({ port = 19988, host = '127.0.0.1', token, extensionId } = {}) {
          const id = Math.random().toString(36).substring(2, 15) + '_' + Date.now();
          const params = new URLSearchParams();
          if (token) params.set('token', token);
          if (extensionId) params.set('extensionId', extensionId);
          const suffix = params.toString() ? '?' + params.toString() : '';
          const { wsBaseUrl } = parseRelayHost(host, port);
          return wsBaseUrl + '/cdp/' + id + suffix;
        }
        export function shouldAutoEnablePlaywriter() {
          return process.env.PLAYWRITER_AUTO_ENABLE?.toLowerCase() !== 'false';
        }
        const LOG_BASE_DIR = path.join(os.homedir(), '.playwriter');
        export const LOG_FILE_PATH = process.env.PLAYWRITER_LOG_FILE_PATH || path.join(LOG_BASE_DIR, 'relay-server.log');
        export const LOG_CDP_FILE_PATH = process.env.PLAYWRITER_CDP_LOG_FILE_PATH || path.join(path.dirname(LOG_FILE_PATH), 'cdp.jsonl');
        export const VERSION = ${JSON.stringify(playwriterVersion)};
        export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
      `,
    }));
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
    js: "import { createRequire as __viforgeCreateRequire } from 'node:module'; const require = __viforgeCreateRequire(import.meta.url);",
  },
  external: [
    'electron',
  ],
});

await build({
  entryPoints: [path.join(repoRoot, 'apps', 'api', 'node_modules', 'playwriter', 'bin.js')],
  outfile: playwriterCliOutfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "import { createRequire as __viforgeCreateRequire } from 'node:module'; import { fileURLToPath as __viforgeFileURLToPath } from 'node:url'; import * as __viforgePath from 'node:path'; const require = __viforgeCreateRequire(import.meta.url); const __dirname = __viforgePath.dirname(__viforgeFileURLToPath(import.meta.url));",
  },
  external: [
    'electron',
    'fsevents',
  ],
  plugins: [chromiumBidiShimPlugin, playwriterUtilsShimPlugin],
});


await patchPlaywriterBundle(playwriterCliOutfile);

await cp(
  path.join(repoRoot, 'packages', 'shared', 'src', 'product-profiles'),
  path.join(outDir, 'product-profiles'),
  { recursive: true },
);


async function patchPlaywriterBundle(outfile) {
  const source = await readFile(outfile, 'utf8');
  const target = '__require.resolve("../../../package.json")';
  const replacement = 'import.meta.url';
  if (!source.includes(target)) {
    throw new Error(`Playwriter bundle patch target was not found in ${outfile}`);
  }
  await writeFile(outfile, source.replaceAll(target, replacement), 'utf8');
}