import { execFile } from 'node:child_process';
import path from 'node:path';

export type PlaywriterStatus = {
  enabled: boolean;
  binary: string;
  host?: string;
  error?: string;
};

export type PlaywriterInstallGuide = PlaywriterStatus & {
  relayReachable: boolean;
  connectedBrowsers: number;
  steps: string[];
};

export type PlaywriterNavigateInput = {
  url: string;
  sessionId?: string;
};

export type PlaywriterSnapshotInput = {
  sessionId?: string;
};

export type PlaywriterEvaluateInput = {
  code: string;
  sessionId?: string;
  timeoutMs?: number;
};

export type PlaywriterService = {
  status(): Promise<PlaywriterStatus>;
  installGuide(): Promise<PlaywriterInstallGuide>;
  navigate(input: PlaywriterNavigateInput): Promise<unknown>;
  snapshot(input?: PlaywriterSnapshotInput): Promise<unknown>;
  evaluate(input: PlaywriterEvaluateInput): Promise<unknown>;
};

export function createPlaywriterService(options: { binary?: string; host?: string; token?: string; defaultSessionId?: string } = {}): PlaywriterService {
  const binary = options.binary || process.env.PLAYWRITER_BIN || process.env.VIWORK_PLAYWRITER_BIN || 'playwriter';
  const host = trimTrailingSlashes(options.host || process.env.PLAYWRITER_HOST || process.env.VIWORK_PLAYWRITER_HOST || 'http://127.0.0.1:19988');
  const token = options.token || process.env.PLAYWRITER_TOKEN || process.env.VIWORK_PLAYWRITER_TOKEN || '';
  const configuredSessionId = options.defaultSessionId || process.env.PLAYWRITER_SESSION_ID || process.env.VIWORK_PLAYWRITER_SESSION_ID || '';
  const hostHeader = process.env.PLAYWRITER_HOST_HEADER || process.env.VIWORK_PLAYWRITER_HOST_HEADER || '';
  let createdSessionId: string | null = null;

  async function resolveSessionId(inputSessionId?: string): Promise<string> {
    if (inputSessionId) return inputSessionId;
    if (configuredSessionId) return configuredSessionId;
    if (!createdSessionId) {
      createdSessionId = await createPlaywriterSession({ binary, host, token });
    }
    return createdSessionId;
  }

  return {
    async status() {
      const cli = await checkPlaywriterCli(binary);
      return cli.ok
        ? { enabled: true, binary, host }
        : { enabled: false, binary, host, error: cli.error };
    },

    async installGuide() {
      const cli = await checkPlaywriterCli(binary);
      const relay = cli.ok ? await checkPlaywriterRelay({ host, token, hostHeader }) : { reachable: false, connectedBrowsers: 0 };
      return {
        enabled: cli.ok && relay.reachable && relay.connectedBrowsers > 0,
        binary,
        host,
        error: cli.ok ? relay.error : cli.error,
        relayReachable: relay.reachable,
        connectedBrowsers: relay.connectedBrowsers,
        steps: playwriterInstallSteps(),
      };
    },

    navigate(input) {
      const url = normalizeUrl(input.url);
      return executeWithResolvedSession({
        binary,
        host,
        token,
        inputSessionId: input.sessionId,
        resolveSessionId,
        retryWithNewSession: async () => {
          createdSessionId = await createPlaywriterSession({ binary, host, token });
          return createdSessionId;
        },
        code: `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' }); console.log(JSON.stringify({ url: page.url(), title: await page.title() }));`,
      });
    },

    snapshot(input = {}) {
      return executeWithResolvedSession({
        binary,
        host,
        token,
        inputSessionId: input.sessionId,
        resolveSessionId,
        retryWithNewSession: async () => {
          createdSessionId = await createPlaywriterSession({ binary, host, token });
          return createdSessionId;
        },
        code: 'console.log(await snapshot({ page }));',
      });
    },

    evaluate(input) {
      return executeWithResolvedSession({
        binary,
        host,
        token,
        inputSessionId: input.sessionId,
        resolveSessionId,
        retryWithNewSession: async () => {
          createdSessionId = await createPlaywriterSession({ binary, host, token });
          return createdSessionId;
        },
        code: input.code,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}

async function executeWithResolvedSession(input: {
  binary: string;
  host: string;
  token: string;
  inputSessionId?: string;
  code: string;
  timeoutMs?: number;
  resolveSessionId: (inputSessionId?: string) => Promise<string>;
  retryWithNewSession: () => Promise<string>;
}): Promise<unknown> {
  const sessionId = await input.resolveSessionId(input.inputSessionId);
  try {
    return await executePlaywriterCode({ ...input, sessionId });
  } catch (error) {
    if (input.inputSessionId || !isMissingPlaywriterSessionError(error)) {
      throw error;
    }
    const nextSessionId = await input.retryWithNewSession();
    return executePlaywriterCode({ ...input, sessionId: nextSessionId });
  }
}

async function checkPlaywriterRelay(input: { host: string; token: string; hostHeader: string }): Promise<{ reachable: boolean; connectedBrowsers: number; error?: string }> {
  try {
    const response = await fetch(new URL('/extensions/status', input.host), {
      headers: playwriterRequestHeaders(input),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { reachable: false, connectedBrowsers: 0, error: `relay returned ${response.status}` };
    }
    const body = await response.json() as { extensions?: unknown };
    return { reachable: true, connectedBrowsers: Array.isArray(body.extensions) ? body.extensions.length : 0 };
  } catch (error) {
    return { reachable: false, connectedBrowsers: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function playwriterRequestHeaders(input: { token: string; hostHeader: string }): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.hostHeader) headers.host = input.hostHeader;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function checkPlaywriterCli(binary: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const command = playwriterCommand(binary, ['--version']);
    execFile(command.file, command.args, { env: command.env, timeout: 5_000, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function createPlaywriterSession(input: { binary: string; host: string; token: string }): Promise<string> {
  const env = {
    ...process.env,
    PLAYWRITER_HOST: input.host,
    ...(input.token ? { PLAYWRITER_TOKEN: input.token } : {}),
  };

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const command = playwriterCommand(input.binary, ['session', 'new'], env);
    execFile(command.file, command.args, { env: command.env, timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Playwriter session creation failed: ${error.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const sessionId = parseCreatedSessionId(result.stdout);
  if (!sessionId) {
    throw new Error(`Playwriter session creation returned empty output${result.stderr ? `: ${result.stderr}` : ''}`);
  }
  return sessionId;
}

function parseCreatedSessionId(output: string): string | null {
  const match = output.match(/Session\s+(\S+)\s+created/i);
  return match?.[1] ?? null;
}

async function executePlaywriterCode(input: { binary: string; host: string; token: string; sessionId: string; code: string; timeoutMs?: number }): Promise<unknown> {
  const timeout = input.timeoutMs ?? 30_000;
  const env = {
    ...process.env,
    PLAYWRITER_HOST: input.host,
    ...(input.token ? { PLAYWRITER_TOKEN: input.token } : {}),
  };

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const command = playwriterCommand(input.binary, ['-s', input.sessionId, '-e', input.code], env);
    execFile(command.file, command.args, {
      env: command.env,
      timeout,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Playwriter command failed: ${error.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  return {
    sessionId: input.sessionId,
    stdout: parseJsonOrText(result.stdout.trim()),
    stderr: result.stderr.trim() || undefined,
  };
}

function isMissingPlaywriterSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Session\s+\S+\s+not found/i.test(message);
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('url is required');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseJsonOrText(text: string): unknown {
  if (!text.trim()) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function playwriterCommand(binary: string, args: string[], env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (/\.[cm]?js$/i.test(path.basename(binary))) {
    return {
      file: process.execPath,
      args: [binary, ...args],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { file: binary, args, env };
}

function playwriterInstallSteps(): string[] {
  if (process.env.VIWORK_DESKTOP === '1') {
    return [
      '在浏览器所在机器安装 Playwriter Chrome 扩展。',
      '打开需要让 agent 访问的标签页，点击 Playwriter 扩展图标授权该标签页。',
      '无需手动启动 relay 或创建 session；viwork 桌面版会在后台自动启动 relay，并在首次调用浏览器工具时自动创建和复用 Playwriter session。',
    ];
  }

  return [
    '在浏览器所在机器安装 Playwriter Chrome 扩展。',
    '在浏览器所在机器启动 relay：playwriter serve --host 127.0.0.1 --replace。',
    '打开需要让 agent 访问的标签页，点击 Playwriter 扩展图标授权该标签页。',
    'Docker/WSL 部署可使用 host.docker.internal 指向宿主机；如果 Playwriter relay 拒绝该 Host header，可设置 VIWORK_PLAYWRITER_HOST_HEADER=127.0.0.1:19988。',
    '如果 API 不在同一台机器，把 VIWORK_PLAYWRITER_HOST 设置为浏览器机器对 API 可访问的地址，并在远程监听时配置 VIWORK_PLAYWRITER_TOKEN。',
    '无需手动创建 session；viwork 会在首次调用浏览器工具时自动创建并复用 Playwriter session。',
  ];
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
