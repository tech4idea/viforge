import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformArch = process.env.VIFORGE_POSTGRES_PLATFORM_ARCH || `${hostPlatform}-${hostArch}`;
const targetRoot = path.join(desktopRoot, 'resources', 'postgres', platformArch);
const bundledLibRoot = path.join(targetRoot, 'lib');
const requiredBinaries = platformArch.startsWith('win32-')
  ? ['createdb.exe', 'initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe']
  : ['createdb', 'initdb', 'pg_ctl', 'postgres', 'psql'];
const pgvectorLibraries = platformArch.startsWith('win32-') ? ['vector.dll'] : ['vector.so'];
const libraryRootCandidates = [path.join(targetRoot, 'lib'), path.join(targetRoot, '16', 'lib')];
const defaultBinaryReleaseRepo = 'YukeonWayne/pg_pgvector_binary';

if (process.env.VIFORGE_POSTGRES_BUNDLE_SOURCE) {
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await rm(targetRoot, { recursive: true, force: true });
  await cp(process.env.VIFORGE_POSTGRES_BUNDLE_SOURCE, targetRoot, { recursive: true, dereference: true });
}

if (process.env.VIFORGE_POSTGRES_BUNDLE_LIB_SOURCE) {
  await copyLinuxRuntimeLibraries(process.env.VIFORGE_POSTGRES_BUNDLE_LIB_SOURCE);
}

await ensurePostgresBundleAvailable();
await normalizePgvectorLibrary();

const missing = [];
for (const binary of requiredBinaries) {
  if (!(await exists(path.join(targetRoot, 'bin', binary)))) {
    missing.push(path.join(targetRoot, 'bin', binary));
  }
}
const pgvectorReady = await hasPgvectorExtension();
if (!pgvectorReady && process.env.VIFORGE_REQUIRE_PGVECTOR === '1') {
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
    'Set VIFORGE_POSTGRES_BUNDLE_SOURCE to a PostgreSQL distribution root, or publish a matching zip asset to the configured GitHub release repo before packaging.',
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

async function ensurePostgresBundleAvailable() {
  if (await localBundleSatisfiesRequirements()) return;
  if (process.env.VIFORGE_POSTGRES_BUNDLE_SOURCE) return;

  const releaseAsset = await resolvePostgresReleaseAsset();
  if (!releaseAsset) return;

  console.info(`Downloading PostgreSQL bundle for ${platformArch}: ${releaseAsset.name}`);
  const downloadRoot = await mkdtemp(path.join(tmpdir(), `viforge-postgres-bundle-${platformArch}-`));
  const archivePath = path.join(downloadRoot, releaseAsset.name);
  const extractRoot = path.join(downloadRoot, 'extract');
  await mkdir(extractRoot, { recursive: true });

  try {
    await downloadFile(releaseAsset.downloadUrl, archivePath, { githubAssetApi: releaseAsset.githubAssetApi });
    await verifySha256(archivePath, releaseAsset.sha256);
    await extractArchive(archivePath, extractRoot);
    const postgresRoot = await findPostgresRoot(extractRoot);
    if (!postgresRoot) {
      throw new Error(`Downloaded PostgreSQL bundle does not contain bin/${requiredBinaries[0]}.`);
    }

    await mkdir(path.dirname(targetRoot), { recursive: true });
    await rm(targetRoot, { recursive: true, force: true });
    await cp(postgresRoot, targetRoot, { recursive: true, dereference: true });
  } finally {
    await rm(downloadRoot, { recursive: true, force: true });
  }
}

async function hasRequiredBinaries() {
  for (const binary of requiredBinaries) {
    if (!(await exists(path.join(targetRoot, 'bin', binary)))) return false;
  }
  return true;
}

async function localBundleSatisfiesRequirements() {
  if (!(await hasRequiredBinaries())) return false;
  if (process.env.VIFORGE_REQUIRE_PGVECTOR !== '1') return true;
  return hasPgvectorExtension();
}

async function resolvePostgresReleaseAsset() {
  if (process.env.VIFORGE_POSTGRES_BUNDLE_ASSET_URL) {
    return {
      name: process.env.VIFORGE_POSTGRES_BUNDLE_ASSET_NAME || path.basename(new URL(process.env.VIFORGE_POSTGRES_BUNDLE_ASSET_URL).pathname),
      downloadUrl: process.env.VIFORGE_POSTGRES_BUNDLE_ASSET_URL,
      sha256: process.env.VIFORGE_POSTGRES_BUNDLE_SHA256,
    };
  }

  const repo = process.env.VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO || defaultBinaryReleaseRepo;
  const releaseTag = process.env.VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG;
  const releases = releaseTag
    ? [await githubJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`)]
    : await githubJson(`https://api.github.com/repos/${repo}/releases?per_page=30`);
  const releaseList = Array.isArray(releases) ? releases : [releases];
  const requestedAssetName = process.env.VIFORGE_POSTGRES_BUNDLE_ASSET_NAME;

  for (const release of releaseList) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((item) => {
      if (typeof item?.name !== 'string' || !item.name.endsWith('.zip')) return false;
      if (requestedAssetName) return item.name === requestedAssetName;
      return item.name.includes(platformArch);
    });
    if (!asset) continue;

    return {
      name: asset.name,
      downloadUrl: asset.url,
      sha256: parseReleaseAssetSha256(asset.digest),
      githubAssetApi: true,
    };
  }

  return null;
}

function parseReleaseAssetSha256(digest) {
  if (process.env.VIFORGE_POSTGRES_BUNDLE_SHA256) return process.env.VIFORGE_POSTGRES_BUNDLE_SHA256;
  if (typeof digest === 'string' && digest.startsWith('sha256:')) return digest.slice('sha256:'.length);
  return undefined;
}

async function githubJson(url) {
  const text = await httpGetText(url, {
    accept: 'application/vnd.github+json',
    authorization: process.env.VIFORGE_POSTGRES_BUNDLE_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
  });
  return JSON.parse(text);
}

function httpGetText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: requestHeaders(options) }, (response) => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        httpGetText(new URL(response.headers.location, url).toString(), options).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => reject(new Error(`GET ${url} failed with ${response.statusCode}: ${body.trim()}`)));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}

function downloadFile(url, destination, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: requestHeaders({
        accept: options.githubAssetApi ? 'application/octet-stream' : undefined,
        authorization: process.env.VIFORGE_POSTGRES_BUNDLE_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
      }),
    }, (response) => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, url).toString(), destination, options).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Download ${url} failed with ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function requestHeaders(options = {}) {
  return {
    'user-agent': 'viforge-desktop-packager',
    ...(options.accept ? { accept: options.accept } : {}),
    ...(options.authorization ? { authorization: `Bearer ${options.authorization}` } : {}),
  };
}

function isRedirect(statusCode) {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

async function verifySha256(filePath, expectedSha256) {
  if (!expectedSha256) return;
  const actual = await fileSha256(filePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`PostgreSQL bundle checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const file = createReadStream(filePath);
    file.on('data', (chunk) => hash.update(chunk));
    file.on('end', () => resolve(hash.digest('hex')));
    file.on('error', reject);
  });
}

async function extractArchive(archivePath, destination) {
  if (archivePath.endsWith('.zip')) {
    await extractZip(archivePath, destination);
    return;
  }

  await runProcess('tar', ['-xf', archivePath, '-C', destination]);
}

async function extractZip(archivePath, destination) {
  const archive = await readFile(archivePath);
  const eocdOffset = findEndOfCentralDirectory(archive);
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  while (offset < centralDirectoryEnd) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip central directory header.');
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const fileName = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    await extractZipEntry({ archive, destination, fileName, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid zip file: end of central directory was not found.');
}

async function extractZipEntry({ archive, destination, fileName, compressionMethod, compressedSize, localHeaderOffset }) {
  const outputPath = safeZipOutputPath(destination, fileName);
  if (fileName.endsWith('/')) {
    await mkdir(outputPath, { recursive: true });
    return;
  }

  if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid zip local header for ${fileName}.`);
  const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  const content = compressionMethod === 0
    ? compressed
    : compressionMethod === 8
      ? inflateRawSync(compressed)
      : null;
  if (!content) throw new Error(`Unsupported zip compression method ${compressionMethod} for ${fileName}.`);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
}

function safeZipOutputPath(destination, fileName) {
  const normalized = fileName.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe zip entry path: ${fileName}`);
  }
  const outputPath = path.resolve(destination, normalized);
  const destinationRoot = path.resolve(destination);
  if (outputPath !== destinationRoot && !outputPath.startsWith(`${destinationRoot}${path.sep}`)) {
    throw new Error(`Unsafe zip entry path: ${fileName}`);
  }
  return outputPath;
}

async function findPostgresRoot(root) {
  if (await hasBinariesAt(root)) return root;

  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findPostgresRoot(path.join(root, entry.name));
    if (found) return found;
  }
  return null;
}

async function hasBinariesAt(root) {
  for (const binary of requiredBinaries) {
    if (!(await exists(path.join(root, 'bin', binary)))) return false;
  }
  return true;
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
  const smokeRoot = path.join(tmpdir(), `viforge-postgres-smoke-${process.pid}-${Date.now()}`);
  const dataDir = path.join(smokeRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  try {
    await runPostgresCommand(path.join(targetRoot, 'bin', 'initdb'), [
      '-D', dataDir,
      '-L', path.join(targetRoot, 'share'),
      '-U', 'viforge_smoke',
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
