import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformArch = process.env.VIFORGE_GIT_PLATFORM_ARCH || process.env.VIFORGE_POSTGRES_PLATFORM_ARCH || `${hostPlatform}-${hostArch}`;
const targetRoot = path.join(desktopRoot, 'resources', 'git', platformArch);
const binaryName = platformArch.startsWith('win32-') ? 'git.exe' : 'git';
const expectedBinary = path.join(targetRoot, 'bin', binaryName);

if (process.env.VIFORGE_GIT_BUNDLE_SOURCE) {
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await rm(targetRoot, { recursive: true, force: true });
  await cp(process.env.VIFORGE_GIT_BUNDLE_SOURCE, targetRoot, { recursive: true, dereference: true });
}

if (!(await exists(expectedBinary))) {
  console.error([
    `Missing bundled Git binary for ${platformArch}:`,
    `  - ${expectedBinary}`,
    '',
    'Desktop releases must include a portable Git runtime; end users are not required to install Git globally.',
    'Set VIFORGE_GIT_BUNDLE_SOURCE to a portable Git distribution root before packaging.',
    `Expected layout: apps/desktop/resources/git/${platformArch}/bin/${binaryName}`,
  ].join('\n'));
  process.exit(1);
}

try {
  const version = await runGitVersion(expectedBinary);
  console.info(`Git bundle ready: ${targetRoot} (${version})`);
} catch (error) {
  console.error([
    `Bundled Git binary is not executable for ${platformArch}:`,
    `  - ${expectedBinary}`,
    '',
    error instanceof Error ? error.message : String(error),
  ].join('\n'));
  process.exit(1);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function runGitVersion(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `${path.basename(binary)} exited with code ${code}`));
    });
  });
}
