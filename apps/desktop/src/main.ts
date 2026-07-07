import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import started from 'electron-squirrel-startup';

if (started) {
  app.quit();
}

const PREFERRED_API_PORT = 3001;
const API_START_TIMEOUT_MS = 120_000;
let apiProcess: ChildProcessWithoutNullStreams | null = null;
const desktopAccessToken = randomUUID();
const apiOutputTail: string[] = [];
let currentDesktopDataRoot: string | null = null;

ipcMain.handle('viwork:select-data-root', async () => {
  const selected = await promptForDesktopDataRoot({ required: false });
  if (!selected) return { canceled: true };

  await writeDesktopDataRoot(selected);
  return {
    canceled: false,
    dataRoot: selected,
    restartRequired: selected !== currentDesktopDataRoot,
  };
});

async function createWindow(): Promise<void> {
  const apiUrl = await startApiServer();
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'viwork',
    icon: resolveWindowIcon(process.resourcesPath),
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadEntry(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);

  await window.loadURL(`${apiUrl}/?desktopToken=${encodeURIComponent(desktopAccessToken)}`);
}

async function startApiServer(): Promise<string> {
  const resourcesPath = process.resourcesPath;
  const dataRoot = await resolveDesktopDataRoot();
  currentDesktopDataRoot = dataRoot;
  const apiEntry = resolveApiEntry(resourcesPath);
  const resourceRoots = resolveResourceRoots(resourcesPath);
  const apiPort = await findAvailableLocalPort(PREFERRED_API_PORT);

  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      PORT: String(apiPort),
      ELECTRON_RUN_AS_NODE: '1',
      VIWORK_DESKTOP: '1',
      VIWORK_DESKTOP_ACCESS_TOKEN: desktopAccessToken,
      VIWORK_DESKTOP_DATA_ROOT: dataRoot,
      VIWORK_DESKTOP_CONFIG_ROOT: app.getPath('userData'),
      VIWORK_DATABASE_MODE: process.env.VIWORK_DATABASE_MODE ?? 'embedded-postgres',
      VIWORK_POSTGRES_BIN_DIR: process.env.VIWORK_POSTGRES_BIN_DIR ?? path.join(resourceRoots.postgres, platformArch(), 'bin'),
      WORKSPACES_ROOT: path.join(dataRoot, 'workspaces'),
      LOGS_ROOT: path.join(dataRoot, 'logs'),
      VIWORK_STATIC_WEB_ROOT: resourceRoots.web,
      VIWORK_PRODUCT_PROMPTS_ROOT: resourceRoots.productPrompts,
    },
    stdio: 'pipe',
  });

  apiProcess.stderr.on('data', (chunk) => appendApiOutput('stderr', chunk));
  apiProcess.stdout.on('data', (chunk) => appendApiOutput('stdout', chunk));
  apiProcess.on('exit', (code) => {
    if (code !== 0) console.error(`[api] exited with code ${code ?? 'unknown'}`);
  });

  try {
    await waitForApi(apiPort, desktopAccessToken, API_START_TIMEOUT_MS);
  } catch (error) {
    const message = [
      error instanceof Error ? error.message : 'API server failed to start.',
      formatApiOutputTail(),
    ].filter(Boolean).join('\n\n');
    await dialog.showMessageBox({ type: 'error', title: 'viwork 启动失败', message });
    throw error;
  }

  return `http://127.0.0.1:${apiPort}`;
}

async function resolveDesktopDataRoot(): Promise<string> {
  const configured = await readDesktopDataRoot();
  if (configured) return configured;

  const selected = await promptForDesktopDataRoot({ required: true });
  if (!selected) {
    app.quit();
    throw new Error('Desktop data root was not selected.');
  }

  await writeDesktopDataRoot(selected);
  return selected;
}

async function promptForDesktopDataRoot(options: { required: boolean }): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择 viwork 数据路径',
    message: options.required
      ? '首次启动需要选择 viwork 保存项目、配置和本地数据库的位置。未选择数据路径时应用不会继续启动。'
      : '请选择 viwork 保存项目、配置和本地数据库的位置。修改后需要重启应用生效。',
    buttonLabel: '使用此路径',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) {
    if (options.required) {
      await dialog.showMessageBox({
        type: 'info',
        title: '需要选择数据路径',
        message: 'viwork 需要一个数据路径保存项目、配置和本地 PostgreSQL 数据。请重新启动应用后选择路径。',
      });
    }
    return null;
  }
  return result.filePaths[0];
}

async function readDesktopDataRoot(): Promise<string | null> {
  try {
    const value = (await readFile(desktopDataRootFile(), 'utf8')).trim();
    return value || null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeDesktopDataRoot(dataRoot: string): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(desktopDataRootFile(), `${dataRoot}\n`, 'utf8');
}

function desktopDataRootFile(): string {
  return path.join(app.getPath('userData'), 'data-root.txt');
}

function appendApiOutput(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
  const text = String(chunk);
  const prefixed = `[api:${stream}] ${text}`;
  if (stream === 'stderr') {
    console.error(prefixed);
  } else {
    console.info(prefixed);
  }
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    apiOutputTail.push(`[${stream}] ${line}`);
  }
  while (apiOutputTail.length > 30) apiOutputTail.shift();
}

function formatApiOutputTail(): string {
  if (apiOutputTail.length === 0) return '';
  return `最近 API 日志:\n${apiOutputTail.join('\n')}`;
}

function resolveApiEntry(resourcesPath: string): string {
  const packagedEntry = path.join(resourcesPath, 'api', 'index.mjs');
  if (app.isPackaged) return packagedEntry;
  return path.resolve(projectRoot(), 'apps', 'desktop', 'dist', 'api', 'index.mjs');
}

function resolvePreloadEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.js');
}

function resolveResourceRoots(resourcesPath: string): { postgres: string; web: string; productPrompts: string } {
  if (app.isPackaged) {
    return {
      postgres: path.join(resourcesPath, 'postgres'),
      web: path.join(resourcesPath, 'web'),
      productPrompts: path.join(resourcesPath, 'api', 'product-profiles'),
    };
  }

  const root = projectRoot();
  return {
    postgres: path.resolve(root, 'apps', 'desktop', 'resources', 'postgres'),
    web: path.resolve(root, 'apps', 'web', 'dist'),
    productPrompts: path.resolve(root, 'apps', 'desktop', 'dist', 'api', 'product-profiles'),
  };
}

function resolveWindowIcon(resourcesPath: string): string {
  if (app.isPackaged) {
    return process.platform === 'win32'
      ? path.join(resourcesPath, 'app.asar', 'build', 'icon.ico')
      : path.join(resourcesPath, 'app.asar', 'build', 'icon.png');
  }
  return process.platform === 'win32'
    ? path.resolve(projectRoot(), 'apps', 'desktop', 'build', 'icon.ico')
    : path.resolve(projectRoot(), 'apps', 'desktop', 'build', 'icon.png');
}

function projectRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    current = path.dirname(current);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function platformArch(): string {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${platform}-${arch}`;
}

function waitForApi(port: number, token: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await isApiReady(port, token)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`API server did not open port ${port} within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(poll, 250);
    };
    void poll();
  });
}

async function isApiReady(port: number, token: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime-config?desktopToken=${encodeURIComponent(token)}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function findAvailableLocalPort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = preferredPort + offset;
    if (!(await isPortOpen(candidate))) return candidate;
  }
  throw new Error(`No available local API port found near ${preferredPort}.`);
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

app.whenReady().then(() => {
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  apiProcess?.kill();
});
