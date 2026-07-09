import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { GlobalGitConfig } from '@viforge/shared';

import type { WorkspaceStore } from './workspaceStore';

const GIT_CONFIG_FILE = 'git-config.json';
const AGENT_CONFIG_DIR = 'Agent 配置';

export type GitConfigStore = {
  getGlobalGitConfig(): Promise<GlobalGitConfig | null>;
  setGlobalGitConfig(config: GlobalGitConfig): Promise<void>;
};

export function createGitConfigStore(store: WorkspaceStore): GitConfigStore {
  function configFilePath(): string {
    return path.join(store.getGlobalRoot(), AGENT_CONFIG_DIR, GIT_CONFIG_FILE);
  }

  return {
    async getGlobalGitConfig(): Promise<GlobalGitConfig | null> {
      try {
        const content = await readFile(configFilePath(), 'utf8');
        return JSON.parse(content) as GlobalGitConfig;
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },

    async setGlobalGitConfig(config: GlobalGitConfig): Promise<void> {
      const filePath = configFilePath();
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
    },
  };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
