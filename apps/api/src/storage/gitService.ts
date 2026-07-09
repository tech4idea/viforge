import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

import type { GitLogEntry, GitSyncResult, ProjectGitStatus } from '@viforge/shared';

export type GitService = {
  initProjectRepo(projectRoot: string, branch: string): Promise<void>;
  ensureRemoteConfigured(projectRoot: string, remoteUrl: string): Promise<void>;
  commitAndPush(projectRoot: string, message: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult>;
  pullFromRemote(projectRoot: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult>;
  getLog(projectRoot: string, maxCount?: number): Promise<GitLogEntry[]>;
  getStatus(projectRoot: string): Promise<ProjectGitStatus>;
  isRepoInitialized(projectRoot: string): Promise<boolean>;
};

export function createGitService(): GitService {
  function git(root: string): SimpleGit {
    return simpleGit(root);
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
    const repo = git(root);
    await repo.addConfig('user.name', 'viforge');
    await repo.addConfig('user.email', 'viforge@local');
  }

  return {
    async isRepoInitialized(projectRoot: string): Promise<boolean> {
      return repoExists(projectRoot);
    },

    async initProjectRepo(projectRoot: string, branch: string): Promise<void> {
      if (await repoExists(projectRoot)) {
        return;
      }

      const repo = git(projectRoot);
      await repo.init();
      await repo.addConfig('core.autocrlf', 'false');
      await ensureGitIdentity(projectRoot);
      await repo.checkoutLocalBranch(branch);
      await repo.add('.');

      const status = await repo.status();
      if (status.files.length === 0) {
        await writeFile(path.join(projectRoot, '.gitkeep'), '', 'utf8');
        await repo.add('.gitkeep');
      }

      await repo.commit('Initial commit');
    },

    async ensureRemoteConfigured(projectRoot: string, remoteUrl: string): Promise<void> {
      const repo = git(projectRoot);
      const remotes = await repo.getRemotes();
      const hasOrigin = remotes.some((r) => r.name === 'origin');

      if (hasOrigin) {
        await repo.remote(['set-url', 'origin', remoteUrl]);
      } else {
        await repo.addRemote('origin', remoteUrl);
      }
    },

    async commitAndPush(projectRoot: string, message: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult> {
      await ensureGitIdentity(projectRoot);
      const repo = git(projectRoot);
      const pushUrl = authenticatedUrl(remoteUrl, token);

      const status = await repo.status();
      const hasChanges = status.files.length > 0;

      if (!hasChanges) {
        const log = await repo.log({ maxCount: 1 });
        const latest = log.latest;
        return {
          success: true,
          commitHash: latest?.hash?.slice(0, 7),
          filesChanged: 0,
          message: 'No changes to commit',
        };
      }

      await repo.add('.');
      const commitResult = await repo.commit(message);
      const changedFiles = status.files.length;

      await repo.push([pushUrl, branch]);

      return {
        success: true,
        commitHash: commitResult.commit.slice(0, 7),
        filesChanged: changedFiles,
        message: `Committed and pushed ${changedFiles} file(s)`,
      };
    },

    async pullFromRemote(projectRoot: string, remoteUrl: string, token: string, branch: string): Promise<GitSyncResult> {
      const repo = git(projectRoot);
      const pullUrl = authenticatedUrl(remoteUrl, token);

      await repo.pull(pullUrl, branch);

      const log = await repo.log({ maxCount: 1 });
      const latest = log.latest;

      return {
        success: true,
        commitHash: latest?.hash?.slice(0, 7),
        filesChanged: 0,
        message: 'Pulled latest from remote',
      };
    },

    async getLog(projectRoot: string, maxCount = 20): Promise<GitLogEntry[]> {
      const repo = git(projectRoot);
      const log = await repo.log({ maxCount });

      return log.all.map((entry) => ({
        hash: entry.hash,
        shortHash: entry.hash.slice(0, 7),
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
      }));
    },

    async getStatus(projectRoot: string): Promise<ProjectGitStatus> {
      const initialized = await repoExists(projectRoot);

      if (!initialized) {
        return { initialized: false, hasRemote: false, changedFiles: 0 };
      }

      const repo = git(projectRoot);
      const status = await repo.status();
      const remotes = await repo.getRemotes();
      const hasRemote = remotes.some((r) => r.name === 'origin');
      const branch = status.current ?? undefined;

      let lastCommitHash: string | undefined;
      try {
        const log = await repo.log({ maxCount: 1 });
        lastCommitHash = log.latest?.hash?.slice(0, 7);
      } catch {
        // No commits yet
      }

      return {
        initialized: true,
        hasRemote,
        changedFiles: status.files.length,
        lastCommitHash,
        branch,
      };
    },
  };
}
