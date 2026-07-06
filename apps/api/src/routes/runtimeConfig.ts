import { Hono } from 'hono';
import { z } from 'zod';

import type { RuntimeConfig, UpdateRuntimeConfigInput } from '@viwork/shared';

import type { RuntimeConfigStore } from '../runtimeConfigStore';

const updateRuntimeConfigSchema = z.object({
  modelProvider: z.object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    chatModel: z.string().optional(),
    imageModel: z.string().optional(),
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

  return routes;
}
