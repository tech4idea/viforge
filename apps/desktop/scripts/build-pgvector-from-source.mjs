import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformArch = process.env.VIFORGE_POSTGRES_PLATFORM_ARCH || `${hostPlatform}-${hostArch}`;
const pgvectorVersion = process.env.VIFORGE_PGVECTOR_SOURCE_VERSION || '0.8.0';
const workRoot = path.resolve(process.env.VIFORGE_POSTGRES_BUILD_ROOT || path.join(os.tmpdir(), 'viforge-postgres-build'));
const sourceRoot = path.resolve(process.env.VIFORGE_PGVECTOR_SOURCE_DIR || path.join(workRoot, `pgvector-${pgvectorVersion}`));
const postgresRoot = path.resolve(process.env.VIFORGE_POSTGRES_INSTALL_ROOT || path.join(desktopRoot, 'resources', 'postgres', platformArch));

if (process.platform === 'win32') {
  throw new Error('pgvector source build automation currently supports Linux/macOS hosts. For Windows, build in CI and copy the extension into the PostgreSQL bundle.');
}

if (!(await exists(path.join(sourceRoot, 'Makefile')))) {
  throw new Error([
    `pgvector source was not found at ${sourceRoot}.`,
    'Download a pgvector release from https://github.com/pgvector/pgvector/releases and extract it there,',
    'or set VIFORGE_PGVECTOR_SOURCE_DIR to an extracted pgvector source tree.',
  ].join(' '));
}

const pgConfig = path.join(postgresRoot, 'bin', 'pg_config');
if (!(await exists(pgConfig))) {
  throw new Error(`PostgreSQL pg_config was not found at ${pgConfig}. Build PostgreSQL first with pnpm --filter @viforge/desktop build:postgres.`);
}

await run('make', [], { cwd: sourceRoot, env: buildEnv(pgConfig) });
await run('make', ['install'], { cwd: sourceRoot, env: buildEnv(pgConfig) });

console.info(`Built pgvector ${pgvectorVersion} into PostgreSQL bundle: ${postgresRoot}`);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function buildEnv(pgConfig) {
  return {
    ...process.env,
    PG_CONFIG: pgConfig,
  };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
