import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

type EmbeddedPostgresOptions = {
  dataRoot?: string;
  binDir?: string;
  database?: string;
  user?: string;
  password?: string;
  port?: number;
};

type EmbeddedPostgresRuntime = {
  connectionString: string;
  dataDir: string;
  port: number;
};

const DEFAULT_DATABASE = 'viwork';
const DEFAULT_USER = 'viwork';

let runtime: Promise<EmbeddedPostgresRuntime> | null = null;
let shutdownRegistered = false;
let stopEmbeddedPostgres: (() => Promise<void>) | null = null;

export async function ensureEmbeddedPostgres(options: EmbeddedPostgresOptions = {}): Promise<EmbeddedPostgresRuntime> {
  if (!runtime) {
    runtime = startEmbeddedPostgres(options);
  }
  return runtime;
}

async function startEmbeddedPostgres(options: EmbeddedPostgresOptions): Promise<EmbeddedPostgresRuntime> {
  const dataRoot = options.dataRoot ?? path.join(os.homedir(), '.viwork', 'desktop');
  const dataDir = path.join(dataRoot, 'postgres-data');
  const binDir = options.binDir ?? resolveBundledPostgresBinDir();
  const initdb = executablePath(binDir, 'initdb');
  const pgCtl = executablePath(binDir, 'pg_ctl');
  const createdb = executablePath(binDir, 'createdb');
  const psql = executablePath(binDir, 'psql');
  const preferredPort = options.port ?? Number(process.env.VIWORK_EMBEDDED_POSTGRES_PORT ?? '15432');
  const database = options.database ?? DEFAULT_DATABASE;
  const user = options.user ?? DEFAULT_USER;
  const password = options.password ?? process.env.VIWORK_EMBEDDED_POSTGRES_PASSWORD ?? randomBytes(18).toString('base64url');

  await assertExecutable(initdb, 'initdb');
  await assertExecutable(pgCtl, 'pg_ctl');
  await assertExecutable(createdb, 'createdb');
  await assertExecutable(psql, 'psql');
  await mkdir(dataRoot, { recursive: true });

  if (!(await exists(path.join(dataDir, 'PG_VERSION')))) {
    await mkdir(dataDir, { recursive: true });
    await runCommand(initdb, ['-D', dataDir, '-L', postgresShareDir(binDir), '-U', user, '--auth=trust', '--encoding=UTF8']);
  }

  await removeStalePostmasterPid(pgCtl, dataDir);
  await stopExistingDataDirServer(pgCtl, dataDir);

  const port = await findAvailableLocalPort(preferredPort);
  await runCommand(pgCtl, [
    '-D', dataDir,
    '-l', path.join(dataRoot, 'postgres.log'),
    '-o', `-p ${port} -h 127.0.0.1`,
    '-w',
    'start',
  ]);

  await ensureDatabase({ createdb, psql, port, user, database, password });

  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  process.env.DATABASE_URL = connectionString;
  registerEmbeddedPostgresShutdown(pgCtl, dataDir);

  return { connectionString, dataDir, port };
}

async function isDataDirServerRunning(pgCtl: string, dataDir: string): Promise<boolean> {
  return runCommand(pgCtl, ['-D', dataDir, 'status'], { allowFailure: true });
}

async function removeStalePostmasterPid(pgCtl: string, dataDir: string): Promise<void> {
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (!(await exists(pidFile))) return;
  if (await isDataDirServerRunning(pgCtl, dataDir)) return;
  await rm(pidFile, { force: true });
}

async function stopExistingDataDirServer(pgCtl: string, dataDir: string): Promise<void> {
  if (!(await isDataDirServerRunning(pgCtl, dataDir))) return;
  await runCommand(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
}

async function findAvailableLocalPort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = preferredPort + offset;
    if (!(await isPortOpen(candidate))) return candidate;
  }
  throw new Error(`No available local PostgreSQL port found near ${preferredPort}.`);
}

function registerEmbeddedPostgresShutdown(pgCtl: string, dataDir: string): void {
  stopEmbeddedPostgres = async () => {
    await runCommand(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  };
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  process.once('beforeExit', () => {
    void stopEmbeddedPostgres?.();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stopEmbeddedPostgres?.().finally(() => process.exit(0));
    });
  }
}

async function ensureDatabase(input: { createdb: string; psql: string; port: number; user: string; database: string; password: string }): Promise<void> {
  const baseArgs = ['-h', '127.0.0.1', '-p', String(input.port), '-U', input.user];
  if (!(await databaseExists({ psql: input.psql, baseArgs, database: input.database }))) {
    await runCommand(input.createdb, [...baseArgs, input.database]);
  }
  await runCommand(input.psql, [...baseArgs, '-d', 'postgres', '-c', `ALTER USER ${quoteIdentifier(input.user)} WITH PASSWORD '${escapeSqlLiteral(input.password)}'`]);
  if (!(await pgvectorExtensionAvailable(input.psql))) {
    process.env.VIWORK_PGVECTOR_AVAILABLE = '0';
    console.warn('[desktop] pgvector extension is not available in the embedded PostgreSQL bundle; LangGraph memory will use PostgreSQL text search only.');
    return;
  }

  const vectorReady = await runCommand(input.psql, [...baseArgs, '-d', input.database, '-c', 'CREATE EXTENSION IF NOT EXISTS vector'], {
    ignoreStderrIncludes: 'extension "vector" already exists',
    allowFailure: true,
  });
  process.env.VIWORK_PGVECTOR_AVAILABLE = vectorReady ? '1' : '0';
  if (!vectorReady) {
    console.warn('[desktop] pgvector extension is not available in the embedded PostgreSQL bundle; LangGraph memory will use PostgreSQL text search only.');
  }
}

async function databaseExists(input: { psql: string; baseArgs: string[]; database: string }): Promise<boolean> {
  const query = `SELECT 1 FROM pg_database WHERE datname = '${escapeSqlLiteral(input.database)}'`;
  const output = await runCommand(input.psql, [...input.baseArgs, '-d', 'postgres', '-tAc', query], { captureStdout: true });
  return typeof output === 'string' && output.trim() === '1';
}

async function pgvectorExtensionAvailable(psql: string): Promise<boolean> {
  const pgRoot = path.resolve(path.dirname(psql), '..');
  return (await exists(path.join(pgRoot, 'share', 'extension', 'vector.control')))
    && (await exists(path.join(pgRoot, 'lib', process.platform === 'win32' ? 'vector.dll' : 'vector.so'))
      || await exists(path.join(pgRoot, '16', 'lib', process.platform === 'win32' ? 'vector.dll' : 'vector.so')));
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveBundledPostgresBinDir(): string {
  if (process.env.VIWORK_POSTGRES_BIN_DIR) return process.env.VIWORK_POSTGRES_BIN_DIR;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.resolve(process.cwd(), 'resources', 'postgres', `${platform}-${arch}`, 'bin');
}

function executablePath(binDir: string, name: string): string {
  return path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
}

async function assertExecutable(filePath: string, name: string): Promise<void> {
  if (await exists(filePath)) return;
  throw new Error(`Embedded PostgreSQL ${name} binary was not found at ${filePath}. Set VIWORK_POSTGRES_BIN_DIR or install the desktop resource bundle.`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function runCommand(command: string, args: string[], options: { ignoreStderrIncludes?: string; allowFailure?: boolean; captureStdout: true }): Promise<string>;
function runCommand(command: string, args: string[], options?: { ignoreStderrIncludes?: string; allowFailure?: boolean; captureStdout?: false }): Promise<boolean>;
function runCommand(command: string, args: string[], options: { ignoreStderrIncludes?: string; allowFailure?: boolean; captureStdout?: boolean } = {}): Promise<boolean | string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', env: postgresProcessEnv(command) });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(command)} timed out after 30000ms: ${args.join(' ')}`));
    }, 30_000);
    let settled = false;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0 || (options.ignoreStderrIncludes && stderr.includes(options.ignoreStderrIncludes))) {
        resolve(options.captureStdout ? stdout : true);
        return;
      }
      if (options.allowFailure) {
        resolve(false);
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function postgresProcessEnv(command: string): NodeJS.ProcessEnv {
  const pgRoot = path.resolve(path.dirname(command), '..');
  return {
    ...process.env,
    LD_LIBRARY_PATH: process.platform === 'linux'
      ? [path.join(pgRoot, 'lib'), path.join(pgRoot, '16', 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
      : process.env.LD_LIBRARY_PATH,
    PGSHAREDIR: postgresShareDir(path.dirname(command)),
  };
}

function postgresShareDir(binDir: string): string {
  return path.join(path.resolve(binDir, '..'), 'share');
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
