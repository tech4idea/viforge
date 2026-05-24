import { Hono } from 'hono';
import { z } from 'zod';

import type { ChatMessage } from '@viwork/shared';

import type { ChatSessionStore } from '../chat/chatSessionStore';

const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string().min(1),
  events: z.array(z.unknown()).optional(),
  referencedFiles: z.array(z.object({ path: z.string().min(1), label: z.string().min(1) })).default([]),
  streamEvents: z.array(z.unknown()).default([]),
  status: z.enum(['idle', 'running', 'success', 'error']).optional(),
});

const updateSessionSchema = z.object({
  codexThreadId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(1).optional(),
});

export function createChatSessionRoutes(store: ChatSessionStore): Hono {
  const routes = new Hono();

  routes.get('/projects/:projectId/chat-sessions', async (context) => {
    const includeArchived = context.req.query('includeArchived') === 'true';
    return context.json(await store.listProjectSessions(context.req.param('projectId'), { includeArchived }));
  });

  routes.post('/projects/:projectId/chat-sessions', async (context) => {
    return context.json(await store.createSession(context.req.param('projectId')), 201);
  });

  routes.patch('/chat-sessions/:sessionId', async (context) => {
    const parsed = updateSessionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid chat session update' }, 400);
    }

    const session = await store.updateSession(context.req.param('sessionId'), parsed.data);
    if (!session) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    return context.json(session);
  });

  routes.post('/chat-sessions/:sessionId/archive', async (context) => {
    const session = await store.archiveSession(context.req.param('sessionId'));
    if (!session) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    return context.json(session);
  });

  routes.post('/chat-sessions/:sessionId/restore', async (context) => {
    const session = await store.restoreSession(context.req.param('sessionId'));
    if (!session) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    return context.json(session);
  });

  routes.post('/chat-sessions/:sessionId/messages', async (context) => {
    const parsed = chatMessageSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid chat message' }, 400);
    }

    const session = await store.appendMessage(context.req.param('sessionId'), parsed.data as ChatMessage);
    if (!session) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    return context.json(session, 201);
  });

  routes.put('/chat-sessions/:sessionId/messages/:messageId', async (context) => {
    const parsed = chatMessageSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid chat message' }, 400);
    }

    const session = await store.updateMessage(context.req.param('sessionId'), context.req.param('messageId'), parsed.data as ChatMessage);
    if (!session) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    return context.json(session);
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
