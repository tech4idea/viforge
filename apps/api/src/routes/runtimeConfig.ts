import { Hono } from 'hono';
import { z } from 'zod';

import type { RuntimeConfig, RuntimeMemoryRebuildResponse, RuntimeModelTestResponse, UpdateRuntimeConfigInput } from '@viforge/shared';

import { buildAigcHubHeaders } from '../aigcHubHeaders';

import type { RuntimeConfigStore } from '../runtimeConfigStore';
import type { WorkspaceStore } from '../storage/workspaceStore';
import { MemoryEmbeddingRebuildInProgressError, reindexProjectMemories } from '../runs/langGraphAgents';

const updateRuntimeConfigSchema = z.object({
  modelProvider: z.object({
    testTarget: z.enum(['chat', 'image', 'embedding']).optional(),
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

export function createRuntimeConfigRoutes(store: RuntimeConfigStore, workspaceStore?: WorkspaceStore): Hono {
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


  routes.post('/runtime-config/rebuild-memory-index', async (context) => {
    if (!workspaceStore) {
      return context.json({ error: 'Workspace store is not available for memory rebuild.' }, 500);
    }
    try {
      const projects = await workspaceStore.listProjects();
      const result = await reindexProjectMemories(projects.map((project) => project.id));
      const config = await store.markMemoryEmbeddingReindexed();
      return context.json({
        ok: true,
        ...result,
        message: result.reindexedCount > 0
          ? `已重建 ${result.reindexedCount} 条长期记忆索引。`
          : '没有发现需要重建的长期记忆，已更新索引配置状态。',
        config,
      } satisfies RuntimeMemoryRebuildResponse);
    } catch (error) {
      if (error instanceof MemoryEmbeddingRebuildInProgressError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
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
  const target = input.testTarget ?? 'chat';
  const globalBaseUrl = input.baseUrl || process.env.VIFORGE_AIGC_HUB_BASE_URL || 'https://api.openai.com/v1';
  const globalApiKey = input.apiKey !== undefined ? input.apiKey : process.env.VIFORGE_AIGC_HUB_API_KEY || '';
  const baseUrl = trimTrailingSlashes(
    target === 'image'
      ? input.imageBaseUrl || globalBaseUrl
      : target === 'embedding'
        ? input.embeddingBaseUrl || globalBaseUrl
        : input.chatBaseUrl || globalBaseUrl,
  );
  const apiKey = target === 'image'
    ? input.imageApiKey || globalApiKey
    : target === 'embedding'
      ? input.embeddingApiKey || globalApiKey
      : input.chatApiKey || globalApiKey;
  const model = target === 'image'
    ? input.imageModel || process.env.VIFORGE_AIGC_HUB_IMAGE_MODEL || 'gpt-image-2'
    : target === 'embedding'
      ? input.embeddingModel || process.env.VIFORGE_AIGC_HUB_EMBEDDING_MODEL || 'text-embedding-3-large'
      : input.chatModel || process.env.VIFORGE_AIGC_HUB_CHAT_MODEL || 'gpt-5.5';
  if (!apiKey) return { ok: false, message: '请先填写 API Key 后再测试。' };

  try {
    const response = await fetch(`${baseUrl}/${target === 'image' ? 'images/generations' : target === 'embedding' ? 'embeddings' : 'chat/completions'}`, {
      method: 'POST',
      headers: buildAigcHubHeaders({ apiKey, contentType: 'application/json' }),
      body: JSON.stringify(modelTestBody(target, model)),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, message: await modelTestErrorMessage(response) };
    }
    return { ok: true, status: response.status, message: modelTestSuccessMessage(target) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function modelTestBody(target: NonNullable<UpdateRuntimeConfigInput['modelProvider']>['testTarget'], model: string): Record<string, unknown> {
  if (target === 'image') {
    return { model, prompt: 'test', size: '1024x1024', n: 1 };
  }
  if (target === 'embedding') {
    return { model, input: 'ping' };
  }
  return {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 8,
    temperature: 0,
  };
}

function modelTestSuccessMessage(target: NonNullable<UpdateRuntimeConfigInput['modelProvider']>['testTarget']): string {
  if (target === 'image') return '图片模型调用测试成功。';
  if (target === 'embedding') return 'Embedding 模型调用测试成功。';
  return '文本模型调用测试成功。';
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
