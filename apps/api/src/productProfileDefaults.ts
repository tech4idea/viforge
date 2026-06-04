import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultGlobalWorkspaceFilesForProfile, type ProductProfile, type TemplateFile } from '@viwork/shared';

const sharedSrcRoot = fileURLToPath(new URL('../../../packages/shared/src', import.meta.url));

const PROMPT_FILE_BY_GLOBAL_PATH: Record<string, string> = {
  'Agent 配置/AGENTS.md': 'system-agent.md',
};

export async function createDefaultGlobalWorkspaceFilesFromProfile(profile: ProductProfile): Promise<TemplateFile[]> {
  const files = createDefaultGlobalWorkspaceFilesForProfile(profile);

  return Promise.all(
    files.map(async (file) => ({
      ...file,
      content: await readDefaultGlobalFileContent(profile, file),
    })),
  );
}

async function readDefaultGlobalFileContent(profile: ProductProfile, file: TemplateFile): Promise<string> {
  const promptFileName = PROMPT_FILE_BY_GLOBAL_PATH[file.path] ?? skillPromptFileName(file.path);

  if (!promptFileName) {
    return file.content;
  }

  try {
    return await readFile(path.join(sharedSrcRoot, 'product-profiles', profile.id, 'prompts', promptFileName), 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return file.content;
    }
    throw error;
  }
}

function skillPromptFileName(filePath: string): string | undefined {
  const match = /^Agent 配置\/skills\/([^/]+)\/SKILL\.md$/.exec(filePath);
  return match ? `${match[1]}.md` : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
