import { Hono } from 'hono';
import { z } from 'zod';

import type { WechatStore } from '../wechat/wechatStore';

const completeSetupSchema = z.object({
  displayName: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  externalUserId: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
});

const inboundSchema = z.object({
  externalMessageId: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  externalUserId: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  displayName: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  text: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
});

export function createWechatRoutes(store: WechatStore): Hono {
  const routes = new Hono();

  routes.get('/wechat/status', async (context) => context.json(await store.getStatus()));

  routes.post('/wechat/setup-sessions', async (context) => {
    return context.json(await store.createSetupSession(), 201);
  });

  routes.post('/wechat/setup-sessions/:sessionId/complete', async (context) => {
    const parsed = completeSetupSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid setup completion' }, 400);
    }
    try {
      return context.json(await store.completeSetupSession(context.req.param('sessionId'), parsed.data));
    } catch (error) {
      if (error instanceof Error && error.message === 'Setup session not found') {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  routes.post('/wechat/inbound', async (context) => {
    const parsed = inboundSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid inbound message' }, 400);
    }
    const result = await store.acceptInbound(parsed.data);
    return context.json(result, result.accepted ? 202 : 403);
  });

  return routes;
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
