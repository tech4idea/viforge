import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformArch = process.env.VIWORK_POSTGRES_PLATFORM_ARCH || `${hostPlatform}-${hostArch}`;
const targetRoot = path.join(desktopRoot, 'resources', 'postgres', platformArch);
const bundledLibRoot = path.join(targetRoot, 'lib');
const requiredBinaries = platformArch.startsWith('win32-')
  ? ['createdb.exe', 'initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe']
  : ['createdb', 'initdb', 'pg_ctl', 'postgres', 'psql'];
const pgvectorLibraries = platformArch.startsWith('win32-') ? ['vector.dll'] : ['vector.so'];
const libraryRootCandidates = [path.join(targetRoot, 'lib'), path.join(targetRoot, '16', 'lib')];

if (process.env.VIWORK_POSTGRES_BUNDLE_SOURCE) {
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await rm(targetRoot, { recursive: true, force: true });
  await cp(process.env.VIWORK_POSTGRES_BUNDLE_SOURCE, targetRoot, { recursive: true, dereference: true });
}

if (process.env.VIWORK_POSTGRES_BUNDLE_LIB_SOURCE) {
  await copyLinuxRuntimeLibraries(process.env.VIWORK_POSTGRES_BUNDLE_LIB_SOURCE);
}

await normalizePgvectorLibrary();

const missing = [];
for (const binary of requiredBinaries) {
  if (!(await exists(path.join(targetRoot, 'bin', binary)))) {
    missing.push(path.join(targetRoot, 'bin', binary));
  }
}
const pgvectorReady = await hasPgvectorExtension();
if (!pgvectorReady && process.env.VIWORK_REQUIRE_PGVECTOR === '1') {
  missing.push(`${targetRoot}/{lib,16/lib}/vector extension files`);
  missing.push(path.join(targetRoot, 'share', 'extension', 'vector.control'));
}

if (hostPlatform === 'linux' && platformArch.startsWith('linux-')) {
  const unresolved = await collectMissingLinuxLibraries(requiredBinaries.map((binary) => path.join(targetRoot, 'bin', binary)));
  missing.push(...unresolved.map((item) => `${item.binary}: ${item.library}`));
  if (unresolved.length === 0) {
    const smokeError = await smokeTestLinuxInitdb();
    if (smokeError) missing.push(`linux initdb smoke test failed: ${smokeError}`);
  }
}

if (missing.length > 0) {
  console.error([
    `Missing bundled PostgreSQL files for ${platformArch}:`,
    ...missing.map((item) => `  - ${item}`),
    '',
    'Set VIWORK_POSTGRES_BUNDLE_SOURCE to a PostgreSQL distribution root before packaging.',
    `Expected layout: apps/desktop/resources/postgres/${platformArch}/bin/<postgres binaries>`,
  ].join('\n'));
  process.exit(1);
}

console.info(`PostgreSQL bundle ready: ${targetRoot}`);
if (!pgvectorReady) {
  console.warn('PostgreSQL bundle does not include pgvector; semantic vector indexing will be unavailable until a vector extension bundle is supplied.');
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

async function existsInAny(roots, relativePath) {
  for (const root of roots) {
    if (await exists(path.join(root, relativePath))) return true;
  }
  return false;
}

async function hasPgvectorExtension() {
  const hasLibrary = await Promise.all(pgvectorLibraries.map((library) => existsInAny(libraryRootCandidates, library)));
  return hasLibrary.every(Boolean) && await exists(path.join(targetRoot, 'share', 'extension', 'vector.control'));
}

async function normalizePgvectorLibrary() {
  const libraryName = platformArch.startsWith('win32-') ? 'vector.dll' : 'vector.so';
  const target = path.join(targetRoot, 'lib', libraryName);
  if (await exists(target)) return;

  const nested = path.join(targetRoot, '16', 'lib', libraryName);
  if (!(await exists(nested))) return;

  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(nested, target);
}

async function copyLinuxRuntimeLibraries(sourceRoot) {
  if (!platformArch.startsWith('linux-')) return;
  const binaries = requiredBinaries.map((binary) => path.join(targetRoot, 'bin', binary));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const missingLibraries = new Set((await collectMissingLinuxLibraries(binaries)).map((item) => item.library));
    if (missingLibraries.size === 0) return;

    let copied = 0;
    for (const library of missingLibraries) {
      const source = await findFileByName(sourceRoot, library);
      if (!source) continue;
      await mkdir(bundledLibRoot, { recursive: true });
      await copyFile(source, path.join(bundledLibRoot, library));
      copied += 1;
    }
    if (copied === 0) return;
  }
}

async function collectMissingLinuxLibraries(binaries) {
  const unresolvedByBinary = [];
  for (const binaryPath of binaries) {
    if (!(await exists(binaryPath))) continue;
    const output = await runLdd(binaryPath);
    const unresolved = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('=> not found'))
      .map((line) => line.split('=>')[0].trim());
    for (const library of unresolved) {
      unresolvedByBinary.push({ binary: binaryPath, library });
    }
  }
  return unresolvedByBinary;
}

function runLdd(binaryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ldd', [binaryPath], {
      env: postgresRuntimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`ldd failed for ${binaryPath}: ${stderr.trim()}`));
    });
  });
}

async function smokeTestLinuxInitdb() {
  const smokeRoot = path.join(tmpdir(), `viwork-postgres-smoke-${process.pid}-${Date.now()}`);
  const dataDir = path.join(smokeRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  try {
    await runPostgresCommand(path.join(targetRoot, 'bin', 'initdb'), [
      '-D', dataDir,
      '-L', path.join(targetRoot, 'share'),
      '-U', 'viwork_smoke',
      '--auth=trust',
      '--encoding=UTF8',
    ]);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function runPostgresCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: postgresRuntimeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function postgresRuntimeEnv() {
  return {
    ...process.env,
    LD_LIBRARY_PATH: [path.join(targetRoot, 'lib'), path.join(targetRoot, '16', 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    PGSHAREDIR: path.join(targetRoot, 'share'),
  };
}

async function findFileByName(root, fileName) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === fileName) return entryPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileByName(path.join(root, entry.name), fileName);
    if (found) return found;
  }
  return null;
}
