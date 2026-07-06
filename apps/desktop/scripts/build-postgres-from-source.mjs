import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformArch = process.env.VIWORK_POSTGRES_PLATFORM_ARCH || `${hostPlatform}-${hostArch}`;
const postgresVersion = process.env.VIWORK_POSTGRES_SOURCE_VERSION || '16.10';
const workRoot = path.resolve(process.env.VIWORK_POSTGRES_BUILD_ROOT || path.join(os.tmpdir(), 'viwork-postgres-build'));
const sourceRoot = path.resolve(process.env.VIWORK_POSTGRES_SOURCE_DIR || path.join(workRoot, `postgresql-${postgresVersion}`));
const installRoot = path.resolve(process.env.VIWORK_POSTGRES_INSTALL_ROOT || path.join(workRoot, `install-${platformArch}`));
const targetRoot = path.join(desktopRoot, 'resources', 'postgres', platformArch);

if (process.platform === 'win32') {
  throw new Error('Source build automation currently supports Linux/macOS hosts. For Windows, build PostgreSQL in a suitable CI image and set VIWORK_POSTGRES_BUNDLE_SOURCE.');
}

if (!(await exists(path.join(sourceRoot, 'configure')))) {
  throw new Error([
    `PostgreSQL source was not found at ${sourceRoot}.`,
    'Download the official stable source tarball from https://www.postgresql.org/ftp/source/ and extract it there,',
    'or set VIWORK_POSTGRES_SOURCE_DIR to an extracted PostgreSQL source tree.',
  ].join(' '));
}

await rm(installRoot, { recursive: true, force: true });
await mkdir(installRoot, { recursive: true });

await run('./configure', [
  `--prefix=${installRoot}`,
  '--without-readline',
  '--without-zlib',
  '--without-icu',
  '--without-ldap',
  '--without-pam',
  '--without-openssl',
], { cwd: sourceRoot });
await run('make', ['-j', String(os.cpus().length || 2)], { cwd: sourceRoot });
await run('make', ['install'], { cwd: sourceRoot });

await mkdir(path.dirname(targetRoot), { recursive: true });
await rm(targetRoot, { recursive: true, force: true });
await cp(installRoot, targetRoot, { recursive: true, dereference: true });

console.info(`Built official PostgreSQL ${postgresVersion} bundle: ${targetRoot}`);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
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
