import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GitLogEntry, GitSyncResult, ProjectGitStatus } from '@viforge/shared';
import { appendJsonLog } from '../logger';

export type GitService = {
  initProjectRepo(projectRoot: string, branch: string): Promise<void>;
  ensureRemoteConfigured(projectRoot: string, remoteUrl: string): Promise<void>;
  commitAndPush(projectRoot: string, message: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult>;
  pullFromRemote(projectRoot: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult>;
  getLog(projectRoot: string, maxCount?: number): Promise<GitLogEntry[]>;
  getStatus(projectRoot: string): Promise<ProjectGitStatus>;
  isRepoInitialized(projectRoot: string): Promise<boolean>;
};

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

class GitRuntimeUnavailableError extends Error {
  constructor(message = '版本管理组件不可用，请更新桌面版或检查安装包是否完整。') {
    super(message);
    this.name = 'GitRuntimeUnavailableError';
  }
}

export function createGitService(): GitService {
  function gitBinary(): string {
    return process.env.VIFORGE_GIT_BIN || process.env.GIT_BIN || 'git';
  }

  function authenticatedUrl(remoteUrl: string, token: string): string {
    try {
      const url = new URL(remoteUrl);
      if (token) {
        url.username = 'oauth2';
        url.password = token;
      }
      return url.toString();
    } catch {
      return remoteUrl;
    }
  }

  async function repoExists(root: string): Promise<boolean> {
    try {
      await stat(path.join(root, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async function ensureGitIdentity(root: string): Promise<void> {
    await runGit(root, ['config', 'user.name', 'viforge']);
    await runGit(root, ['config', 'user.email', 'viforge@local']);
  }

  async function statusFiles(root: string): Promise<string[]> {
    const { stdout } = await runGit(root, ['status', '--porcelain']);
    return stdout.split(/\r?\n/).filter(Boolean);
  }

  async function latestCommit(root: string): Promise<GitLogEntry | null> {
    const entries = await getLogEntries(root, 1);
    return entries[0] ?? null;
  }

  async function getLogEntries(root: string, maxCount: number): Promise<GitLogEntry[]> {
    const separator = '\x1f';
    const lineSeparator = '\x1e';
    const { stdout } = await runGit(root, [
      'log',
      `--max-count=${maxCount}`,
      `--pretty=format:%H${separator}%h${separator}%s${separator}%an${separator}%aI${lineSeparator}`,
    ]);
    return stdout
      .split(lineSeparator)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash = '', shortHash = '', message = '', author = '', date = ''] = line.split(separator);
        return { hash, shortHash, message, author, date };
      });
  }

  return {
    async isRepoInitialized(projectRoot: string): Promise<boolean> {
      return repoExists(projectRoot);
    },

    async initProjectRepo(projectRoot: string, branch: string): Promise<void> {
      if (await repoExists(projectRoot)) {
        return;
      }

      await runGit(projectRoot, ['init']);
      await runGit(projectRoot, ['config', 'core.autocrlf', 'false']);
      await ensureGitIdentity(projectRoot);
      await runGit(projectRoot, ['checkout', '-B', branch]);
      await runGit(projectRoot, ['add', '.']);

      if ((await statusFiles(projectRoot)).length === 0) {
        await writeFile(path.join(projectRoot, '.gitkeep'), '', 'utf8');
        await runGit(projectRoot, ['add', '.gitkeep']);
      }

      await runGit(projectRoot, ['commit', '-m', 'Initial commit']);
    },

    async ensureRemoteConfigured(projectRoot: string, remoteUrl: string): Promise<void> {
      const { stdout } = await runGit(projectRoot, ['remote']);
      const hasOrigin = stdout.split(/\r?\n/).some((name) => name.trim() === 'origin');

      if (hasOrigin) {
        await runGit(projectRoot, ['remote', 'set-url', 'origin', remoteUrl]);
      } else {
        await runGit(projectRoot, ['remote', 'add', 'origin', remoteUrl]);
      }
    },

    async commitAndPush(projectRoot: string, message: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult> {
      await ensureGitIdentity(projectRoot);
      const pushUrl = authenticatedUrl(remoteUrl, token);
      const files = await statusFiles(projectRoot);

      if (files.length === 0) {
        const latest = await latestCommit(projectRoot);
        return {
          success: true,
          commitHash: latest?.shortHash,
          filesChanged: 0,
          message: 'No changes to commit',
        };
      }

      await runGit(projectRoot, ['add', '.']);
      await runGit(projectRoot, ['commit', '-m', message]);
      const latest = await latestCommit(projectRoot);

      await runGit(projectRoot, ['push', pushUrl, branch]);

      return {
        success: true,
        commitHash: latest?.shortHash,
        filesChanged: files.length,
        message: `Committed and pushed ${files.length} file(s)`,
      };
    },

    async pullFromRemote(projectRoot: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult> {
      const pullUrl = authenticatedUrl(remoteUrl, token);
      await runGit(projectRoot, ['pull', pullUrl, branch]);
      const latest = await latestCommit(projectRoot);

      return {
        success: true,
        commitHash: latest?.shortHash,
        filesChanged: 0,
        message: 'Pulled latest from remote',
      };
    },

    async getLog(projectRoot: string, maxCount = 20): Promise<GitLogEntry[]> {
      return getLogEntries(projectRoot, maxCount);
    },

    async getStatus(projectRoot: string): Promise<ProjectGitStatus> {
      const initialized = await repoExists(projectRoot);

      if (!initialized) {
        return { initialized: false, hasRemote: false, changedFiles: 0 };
      }

      const [{ stdout: branchStdout }, { stdout: remoteStdout }, files] = await Promise.all([
        runGit(projectRoot, ['branch', '--show-current']),
        runGit(projectRoot, ['remote']),
        statusFiles(projectRoot),
      ]);

      let lastCommitHash: string | undefined;
      try {
        lastCommitHash = (await latestCommit(projectRoot))?.shortHash;
      } catch {
        // No commits yet.
      }

      return {
        initialized: true,
        hasRemote: remoteStdout.split(/\r?\n/).some((name) => name.trim() === 'origin'),
        changedFiles: files.length,
        lastCommitHash,
        branch: branchStdout.trim() || undefined,
      };
    },
  };

  function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
    const binary = gitBinary();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        stdio: 'pipe',
        windowsHide: true,
        env: gitProcessEnv(binary),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (error) => {
        logGitCommandFailure('runtime_unavailable', cwd, binary, args, error);
        if (isGitRuntimeUnavailable(error)) {
          reject(new GitRuntimeUnavailableError());
          return;
        }
        reject(error);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const message = sanitizeGitError(stderr || stdout || `git exited with code ${code}`);
        logGitCommandFailure('command_failed', cwd, binary, args, { code, message, stderr: sanitizeGitError(stderr), stdout: sanitizeGitError(stdout) });
        reject(new Error(message));
      });
    });
  }

  function gitProcessEnv(binary: string): NodeJS.ProcessEnv {
    const binaryDir = binary.includes(path.sep) || path.isAbsolute(binary) ? path.dirname(binary) : '';
    const pathValue = binaryDir ? `${binaryDir}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH;
    return {
      ...process.env,
      ...(pathValue ? { PATH: pathValue } : {}),
      GIT_TERMINAL_PROMPT: '0',
    };
  }
}


function isGitRuntimeUnavailable(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM';
}

function logGitCommandFailure(stage: string, cwd: string, binary: string, args: string[], error: unknown): void {
  appendJsonLog('api.error.log', {
    scope: 'git',
    stage,
    cwd,
    binary,
    args,
    error: gitErrorDetails(error),
  });
}

function gitErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      name: error.name,
      message: error.message,
      code: nodeError.code,
      errno: nodeError.errno,
      syscall: nodeError.syscall,
      path: nodeError.path,
      spawnargs: 'spawnargs' in nodeError ? nodeError.spawnargs : undefined,
      stack: error.stack,
    };
  }
  if (error && typeof error === 'object') {
    return { ...error as Record<string, unknown> };
  }
  return { message: String(error) };
}
function sanitizeGitError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s:@/]+:[^\s@/]+@/g, 'https://***:***@')
    .trim();
}
