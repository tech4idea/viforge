import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProductProfile } from '@viwork/shared';

const SHARED_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'shared', 'src');
const PRODUCT_PROMPTS_ROOT = path.join(SHARED_SRC_ROOT, 'product-profiles');

export async function readProductSystemAgentPrompt(productProfile: ProductProfile): Promise<string> {
  return readProductPrompt(productProfile, 'system-agent');
}

export async function readProductSkillPrompt(productProfile: ProductProfile, agentId: string): Promise<string> {
  return readProductPrompt(productProfile, agentId);
}

async function readProductPrompt(productProfile: ProductProfile, promptName: string): Promise<string> {
  const promptPath = path.join(PRODUCT_PROMPTS_ROOT, productProfile.id, 'prompts', `${promptName}.md`);
  return readFile(promptPath, 'utf8');
}

