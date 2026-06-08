import { Hono } from 'hono';
import { z } from 'zod';

import type { BehaviorRulesStore } from '../storage/behaviorRulesStore';

const saveRulesSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      content: z.string(),
      enabled: z.boolean(),
      builtIn: z.boolean(),
    }),
  ),
});

export function createBehaviorRulesRoutes(store: BehaviorRulesStore): Hono {
  const routes = new Hono();

  routes.get('/behavior-rules', async (context) => {
    const rules = await store.getRules();
    return context.json({ rules });
  });

  routes.put('/behavior-rules', async (context) => {
    const parsed = saveRulesSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid behavior rules' }, 400);
    }
    const rules = await store.saveRules(parsed.data.rules);
    return context.json({ rules });
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
