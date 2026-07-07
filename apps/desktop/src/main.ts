import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

import { app, BrowserWindow, dialog, ipcMain, Menu, Tray } from 'electron';
import started from 'electron-squirrel-startup';

if (started) {
  app.quit();
}

const PREFERRED_API_PORT = 3001;
const API_START_TIMEOUT_MS = 120_000;
const PLAYWRITER_RELAY_HOST = '127.0.0.1';
const PLAYWRITER_RELAY_PORT = 19988;
const WINDOWS_REGISTRY_KEY = 'HKCU\\Software\\viwork';
let apiProcess: ChildProcessWithoutNullStreams | null = null;
let playwriterProcess: ChildProcessWithoutNullStreams | null = null;
const desktopAccessToken = randomUUID();
const apiOutputTail: string[] = [];
let currentDesktopDataRoot: string | null = null;
let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let startupPromise: Promise<void> | null = null;
let appQuitting = false;
let cleanupStarted = false;
let closingStartupWindow = false;
let closeConfirmationOpen = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

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

async function startDesktopApp(): Promise<void> {
  if (startupPromise) return startupPromise;
  startupPromise = startDesktopAppOnce().finally(() => {
    startupPromise = null;
  });
  return startupPromise;
}

async function startDesktopAppOnce(): Promise<void> {
  Menu.setApplicationMenu(null);
  ensureStartupWindow();

  try {
    const apiUrl = await startApiServer();
    await createMainWindow(apiUrl);
    closingStartupWindow = true;
    startupWindow?.close();
    closingStartupWindow = false;
    startupWindow = null;
  } catch (error) {
    closingStartupWindow = true;
    startupWindow?.close();
    closingStartupWindow = false;
    startupWindow = null;
    app.quit();
    throw error;
  }
}

async function createMainWindow(apiUrl: string): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

  Menu.setApplicationMenu(null);
  ensureTray();
  mainWindow = new BrowserWindow({
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
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close', (event) => {
    if (appQuitting) return;
    event.preventDefault();
    void confirmMainWindowClose();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`${apiUrl}/?desktopToken=${encodeURIComponent(desktopAccessToken)}`);
}

function ensureStartupWindow(): void {
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.show();
    startupWindow.focus();
    return;
  }

  startupWindow = new BrowserWindow({
    width: 360,
    height: 180,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'viwork 正在打开',
    icon: resolveWindowIcon(process.resourcesPath),
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupWindow.setMenuBarVisibility(false);
  startupWindow.on('close', (event) => {
    if (appQuitting || closingStartupWindow) return;
    event.preventDefault();
  });
  startupWindow.on('closed', () => {
    startupWindow = null;
  });
  void startupWindow.loadURL(startupHtmlUrl());
}

function startupHtmlUrl(): string {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>viwork 正在打开</title>
  <style>
    body { margin: 0; height: 100vh; display: grid; place-items: center; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f7f7f4; color: #1e2428; }
    main { width: 280px; }
    h1 { margin: 0 0 12px; font-size: 18px; font-weight: 650; }
    p { margin: 0; color: #5c666d; font-size: 13px; line-height: 1.6; }
    .bar { margin-top: 22px; height: 4px; overflow: hidden; background: #d7ddd7; border-radius: 999px; }
    .bar::before { content: ""; display: block; width: 38%; height: 100%; background: #2f6f5e; border-radius: inherit; animation: loading 1.2s ease-in-out infinite; }
    @keyframes loading { 0% { transform: translateX(-105%); } 100% { transform: translateX(270%); } }
  </style>
</head>
<body>
  <main>
    <h1>viwork 正在打开</h1>
    <p>正在打开，请稍候。</p>
    <div class="bar"></div>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function ensureTray(): void {
  if (tray || process.platform === 'darwin') return;
  tray = new Tray(resolveWindowIcon(process.resourcesPath));
  tray.setToolTip('viwork');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 viwork', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '完全退出', click: () => quitApp() },
  ]));
  tray.on('double-click', () => showMainWindow());
}

async function confirmMainWindowClose(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (closeConfirmationOpen) {
    window.focus();
    return;
  }

  closeConfirmationOpen = true;
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: '关闭 viwork',
    message: '要如何关闭 viwork？',
    detail: '选择“仅关闭窗口”会保留本地 API 和 PostgreSQL 运行，再次点击桌面图标会回到当前实例；选择“完全退出”会停止后台服务。',
    buttons: ['仅关闭窗口', '完全退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }).finally(() => {
    closeConfirmationOpen = false;
  });

  if (result.response === 0) {
    window.hide();
    return;
  }
  if (result.response === 1) quitApp();
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.show();
    startupWindow.focus();
    return;
  }
  launchDesktopApp();
}

function quitApp(): void {
  if (cleanupStarted) return;
  appQuitting = true;
  tray?.destroy();
  tray = null;
  cleanupStarted = true;
  void stopDesktopServices().finally(() => app.quit());
}

function launchDesktopApp(): void {
  void startDesktopApp().catch((error) => {
    console.error('Failed to start viwork desktop app:', error);
  });
}

async function startApiServer(): Promise<string> {
  const resourcesPath = process.resourcesPath;
  const dataRoot = await resolveDesktopDataRoot();
  currentDesktopDataRoot = dataRoot;
  const apiEntry = resolveApiEntry(resourcesPath);
  const playwriterEntry = resolvePlaywriterEntry(resourcesPath);
  const resourceRoots = resolveResourceRoots(resourcesPath);
  const apiPort = await findAvailableLocalPort(PREFERRED_API_PORT);
  startPlaywriterRelay(playwriterEntry, dataRoot);
  const playwriterHost = `http://${PLAYWRITER_RELAY_HOST}:${PLAYWRITER_RELAY_PORT}`;

  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      PORT: String(apiPort),
      ELECTRON_RUN_AS_NODE: '1',
      VIWORK_DESKTOP: '1',
      VIWORK_DESKTOP_ACCESS_TOKEN: desktopAccessToken,
      VIWORK_DESKTOP_DATA_ROOT: dataRoot,
      VIWORK_DESKTOP_CONFIG_ROOT: app.getPath('userData'),
      VIWORK_PLAYWRITER_BIN: playwriterEntry,
      VIWORK_PLAYWRITER_HOST: playwriterHost,
      PLAYWRITER_HOST: playwriterHost,
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
    await waitForApi(apiPort, desktopAccessToken, API_START_TIMEOUT_MS, apiProcess);
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

function startPlaywriterRelay(playwriterEntry: string, dataRoot: string): void {
  if (playwriterProcess) return;

  const playwriterLogDir = path.join(dataRoot, 'logs', 'playwriter');

  playwriterProcess = spawn(process.execPath, [playwriterEntry, 'serve', '--host', PLAYWRITER_RELAY_HOST], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRITER_HOST: `http://${PLAYWRITER_RELAY_HOST}:${PLAYWRITER_RELAY_PORT}`,
      PLAYWRITER_LOG_FILE_PATH: path.join(playwriterLogDir, 'relay-server.log'),
      PLAYWRITER_CDP_LOG_FILE_PATH: path.join(playwriterLogDir, 'cdp.jsonl'),
      VIWORK_PLAYWRITER_HOST: `http://${PLAYWRITER_RELAY_HOST}:${PLAYWRITER_RELAY_PORT}`,
    },
    stdio: 'pipe',
  });

  playwriterProcess.stderr.on('data', (chunk) => appendPlaywriterOutput('stderr', chunk));
  playwriterProcess.stdout.on('data', (chunk) => appendPlaywriterOutput('stdout', chunk));
  playwriterProcess.on('error', (error) => {
    console.warn(`Playwriter relay failed to start: ${error.message}`);
    playwriterProcess = null;
  });
  playwriterProcess.on('exit', (code) => {
    if (playwriterProcess && code !== 0) console.error(`[playwriter] exited with code ${code ?? 'unknown'}`);
    playwriterProcess = null;
  });

  waitForPlaywriterRelay(10_000).catch((error) => {
    console.warn(`Playwriter relay did not become ready: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function waitForPlaywriterRelay(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await isPlaywriterRelayReady()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Playwriter relay did not open port ${PLAYWRITER_RELAY_PORT} within ${timeoutMs}ms.`));
        return;
      }
      setTimeout(poll, 250);
    };
    void poll();
  });
}

async function isPlaywriterRelayReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://${PLAYWRITER_RELAY_HOST}:${PLAYWRITER_RELAY_PORT}/extensions/status`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
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
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return readDesktopDataRootFromRegistry();
    }
    throw error;
  }
}

async function writeDesktopDataRoot(dataRoot: string): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(desktopDataRootFile(), `${dataRoot}\n`, 'utf8');
  await writeDesktopDataRootToRegistry(dataRoot);
}

function readDesktopDataRootFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn('reg', ['query', WINDOWS_REGISTRY_KEY, '/v', 'DataRoot'], { stdio: 'pipe', windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const match = stdout.match(/DataRoot\s+REG_SZ\s+(.+)$/m);
      resolve(match?.[1]?.trim() || null);
    });
  });
}

function writeDesktopDataRootToRegistry(dataRoot: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn('reg', ['add', WINDOWS_REGISTRY_KEY, '/v', 'DataRoot', '/t', 'REG_SZ', '/d', dataRoot, '/f'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
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

function appendPlaywriterOutput(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
  const prefixed = `[playwriter:${stream}] ${String(chunk)}`;
  if (stream === 'stderr') {
    console.error(prefixed);
  } else {
    console.info(prefixed);
  }
}

async function stopDesktopServices(): Promise<void> {
  await stopEmbeddedPostgresFromDesktop();
  if (apiProcess?.exitCode === null) apiProcess.kill();
  if (playwriterProcess?.exitCode === null) playwriterProcess.kill();
}

async function stopEmbeddedPostgresFromDesktop(): Promise<void> {
  if (!currentDesktopDataRoot) return;
  const resourceRoots = resolveResourceRoots(process.resourcesPath);
  const binDir = process.env.VIWORK_POSTGRES_BIN_DIR ?? path.join(resourceRoots.postgres, platformArch(), 'bin');
  const pgCtl = path.join(binDir, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  const dataDir = path.join(currentDesktopDataRoot, 'postgres-data');
  if (!fs.existsSync(pgCtl) || !fs.existsSync(dataDir)) return;

  try {
    await runCommand(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  } catch (error) {
    console.warn(`Failed to stop embedded PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCommand(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', (error) => {
      if (options.allowFailure) {
        resolve(false);
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
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

function formatApiOutputTail(): string {
  if (apiOutputTail.length === 0) return '';
  return `最近 API 日志:\n${apiOutputTail.join('\n')}`;
}

function resolveApiEntry(resourcesPath: string): string {
  const packagedEntry = path.join(resourcesPath, 'api', 'index.mjs');
  if (app.isPackaged) return packagedEntry;
  return path.resolve(projectRoot(), 'apps', 'desktop', 'dist', 'api', 'index.mjs');
}

function resolvePlaywriterEntry(resourcesPath: string): string {
  const packagedEntry = path.join(resourcesPath, 'app.asar', 'dist', 'playwriter-cli.mjs');
  if (app.isPackaged) return packagedEntry;
  return path.resolve(projectRoot(), 'apps', 'desktop', 'dist', 'playwriter-cli.mjs');
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

function waitForApi(port: number, token: string, timeoutMs: number, processToWatch: ChildProcessWithoutNullStreams): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      processToWatch.off('exit', onExit);
      callback();
    };
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`API server exited before it became ready with code ${code ?? 'unknown'}.`)));
    };
    processToWatch.once('exit', onExit);

    const poll = async () => {
      if (await isApiReady(port, token)) {
        finish(resolve);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        finish(() => reject(new Error(`API server did not open port ${port} within ${timeoutMs}ms.`)));
        return;
      }
      timeout = setTimeout(poll, 250);
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

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  launchDesktopApp();
  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && appQuitting) app.quit();
});

app.on('before-quit', (event) => {
  if (appQuitting) return;
  event.preventDefault();
  quitApp();
});
