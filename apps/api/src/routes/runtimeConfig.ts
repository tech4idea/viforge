import { Hono } from 'hono';
import { z } from 'zod';

import type { RuntimeConfig, RuntimeModelTestResponse, UpdateRuntimeConfigInput } from '@viforge/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';

import type { RuntimeConfigStore } from '../runtimeConfigStore';

const updateRuntimeConfigSchema = z.object({
  modelProvider: z.object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    chatBaseUrl: z.string().optional(),
    chatApiKey: z.string().optional(),
    chatModel: z.string().optional(),
    imageBaseUrl: z.string().optional(),
    imageApiKey: z.string().optional(),
    imageModel: z.string().optional(),
    embeddingBaseUrl: z.string().optional(),
    embeddingApiKey: z.string().optional(),
    embeddingModel: z.string().optional(),
    embeddingDims: z.number().int().positive().optional(),
  }).optional(),
  database: z.object({
    mode: z.enum(['embedded-postgres', 'external-postgres', 'custom']).optional(),
    connectionString: z.string().optional(),
    customAdapter: z.string().optional(),
    vectorStore: z.enum(['pgvector', 'external']).optional(),
  }).optional(),
});

export function createRuntimeConfigRoutes(store: RuntimeConfigStore): Hono {
  const routes = new Hono();

  routes.get('/runtime-config', async (context) => {
    return context.json(await store.getConfig() satisfies RuntimeConfig);
  });

  routes.put('/runtime-config', async (context) => {
    const parsed = updateRuntimeConfigSchema.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json({ error: 'Invalid runtime config', details: parsed.error.flatten() }, 400);
    }

    return context.json(await store.updateConfig(parsed.data satisfies UpdateRuntimeConfigInput) satisfies RuntimeConfig);
  });

  routes.post('/runtime-config/test-model', async (context) => {
    const parsed = updateRuntimeConfigSchema.pick({ modelProvider: true }).safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json({ error: 'Invalid model config', details: parsed.error.flatten() }, 400);
    }

    return context.json(await testModelProvider(parsed.data.modelProvider ?? {}) satisfies RuntimeModelTestResponse);
  });

  return routes;
}

async function testModelProvider(input: NonNullable<UpdateRuntimeConfigInput['modelProvider']>): Promise<RuntimeModelTestResponse> {
  const baseUrl = trimTrailingSlashes(input.chatBaseUrl || input.baseUrl || process.env.VIFORGE_AIGC_HUB_CHAT_BASE_URL || process.env.VIFORGE_AIGC_HUB_BASE_URL || 'https://api.openai.com/v1');
  const apiKey = input.chatApiKey !== undefined
    ? input.chatApiKey
    : input.apiKey !== undefined
      ? input.apiKey
      : process.env.VIFORGE_AIGC_HUB_CHAT_API_KEY || process.env.VIFORGE_AIGC_HUB_API_KEY || '';
  const model = input.chatModel || process.env.VIFORGE_AIGC_HUB_CHAT_MODEL || 'MiniMax-M3';
  if (!apiKey) return { ok: false, message: '请先填写 API Key 后再测试。' };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildAigcHubHeaders({ apiKey, contentType: 'application/json' }),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, message: await modelTestErrorMessage(response) };
    }
    return { ok: true, status: response.status, message: '模型调用测试成功。' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function modelTestErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `模型调用失败，HTTP ${response.status}。`;
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === 'string') return body.error;
    return body.error?.message || body.message || `模型调用失败，HTTP ${response.status}。`;
  } catch {
    return text.slice(0, 300);
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
