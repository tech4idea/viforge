import { Hono } from 'hono';
import { z } from 'zod';

import type { SkillStore } from '../skills/skillStore';

const updateSkillSchema = z.object({
  enabled: z.boolean(),
});

const createSkillSchema = z.object({
  title: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  description: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  prompt: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
});

export function createSkillsRoutes(store: SkillStore): Hono {
  const routes = new Hono();

  routes.get('/skills', async (context) => context.json(await store.listSkills()));

  routes.post('/skills', async (context) => {
    const parsed = createSkillSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid skill' }, 400);
    }
    return context.json(await store.createSkill(parsed.data), 201);
  });

  routes.patch('/skills/:slug', async (context) => {
    const parsed = updateSkillSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid skill update' }, 400);
    }

    const skill = await store.setEnabled(context.req.param('slug'), parsed.data.enabled);
    if (!skill) {
      return context.json({ error: 'Skill not found' }, 404);
    }
    return context.json(skill);
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
