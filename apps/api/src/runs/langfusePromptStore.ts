import { LangfuseClient } from '@langfuse/client';

import { LANGFUSE_BASE_URL, LANGFUSE_PROMPT_CACHE_TTL, LANGFUSE_PROMPT_LABEL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } from '../env';

export type PromptStoreOptions = {
  label?: string;
  cacheTtlSeconds?: number;
};

let cachedClient: LangfuseClient | null = null;

function getLangfuseClient(): LangfuseClient | null {
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !LANGFUSE_BASE_URL) {
    return null;
  }
  if (!cachedClient) {
    cachedClient = new LangfuseClient({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_BASE_URL,
    });
  }
  return cachedClient;
}

export async function getPromptText(
  name: string,
  fallback: string,
  options?: PromptStoreOptions,
): Promise<string> {
  const client = getLangfuseClient();
  if (!client) return fallback;

  try {
    const prompt = await client.prompt.get(name, {
      type: 'text',
      label: options?.label ?? LANGFUSE_PROMPT_LABEL,
      cacheTtlSeconds: options?.cacheTtlSeconds ?? LANGFUSE_PROMPT_CACHE_TTL,
      fallback,
    });
    return prompt.prompt;
  } catch {
    return fallback;
  }
}

export async function createLangfusePrompt(
  name: string,
  prompt: string,
  labels?: string[],
): Promise<void> {
  const client = getLangfuseClient();
  if (!client) {
    throw new Error('Langfuse credentials not configured');
  }

  await client.prompt.create({
    name,
    prompt,
    type: 'text',
    labels: labels ?? [LANGFUSE_PROMPT_LABEL],
  });
}

export function isPromptStoreAvailable(): boolean {
  return getLangfuseClient() !== null;
}
