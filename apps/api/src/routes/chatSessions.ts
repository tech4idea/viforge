import { Hono } from 'hono';
import { z } from 'zod';

import type { ChatMessage } from '@viwork/shared';

import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { WechatStore } from '../wechat/wechatStore';

const chatSessionKindSchema = z.enum(['assistant', 'image']);

const chatMessageAttachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['reference-image', 'generated-image']),
  name: z.string().min(1),
  path: z.string().min(1),
  projectId: z.string().min(1),
  mimeType: z.string().min(1),
  prompt: z.string().optional(),
  model: z.string().min(1).optional(),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  createdAt: z.string().min(1),
});

const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string().min(1),
  attachments: z.array(chatMessageAttachmentSchema).default([]),
  events: z.array(z.unknown()).optional(),
  referencedFiles: z.array(z.object({ path: z.string().min(1), label: z.string().min(1) })).default([]),
  referencedSnippets: z.array(z.object({
    id: z.string().min(1),
    messageId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    label: z.string().min(1),
    text: z.string().min(1),
    createdAt: z.string().min(1),
  })).default([]),
  streamEvents: z.array(z.unknown()).default([]),
  status: z.enum(['idle', 'running', 'success', 'error']).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().trim().min(1).optional(),
  modelConfig: z.object({
    chatModel: z.string().trim().min(1).optional(),
    imageModel: z.string().trim().min(1).optional(),
    imageAspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional(),
    imageThinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    imageCount: z.number().int().min(1).max(4).optional(),
  }).optional(),
});

const createSessionSchema = z.object({
  kind: chatSessionKindSchema.optional(),
  title: z.string().trim().min(1).optional(),
}).default({});

export function createChatSessionRoutes(
  store: ChatSessionStore,
  workspaceStore?: WorkspaceStore,
  wechatStore?: WechatStore,
): Hono {
  const routes = new Hono();

  routes.get('/projects/:projectId/chat-sessions', async (context) => {
    const includeArchived = context.req.query('includeArchived') === 'true';
    const kind = chatSessionKindSchema.safeParse(context.req.query('kind')).success
      ? chatSessionKindSchema.parse(context.req.query('kind'))
      : undefined;
    return context.json(await store.listProjectSessions(context.req.param('projectId'), { includeArchived, kind }));
  });

  routes.post('/projects/:projectId/chat-sessions', async (context) => {
    const parsed = createSessionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid chat session' }, 400);
    }
    return context.json(await store.createSession(context.req.param('projectId'), parsed.data), 201);
  });

  routes.get('/temporary-chat-sessions', async (context) => {
    const includeArchived = context.req.query('includeArchived') === 'true';
    const kind = chatSessionKindSchema.safeParse(context.req.query('kind')).success
      ? chatSessionKindSchema.parse(context.req.query('kind'))
      : undefined;
    return context.json(await store.listTemporarySessions({ includeArchived, kind }));
  });

  routes.post('/temporary-chat-sessions', async (context) => {
    if (!workspaceStore) {
      return context.json({ error: 'Temporary workspace support is not configured' }, 500);
    }

    const parsed = createSessionSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) {
      return context.json({ error: 'Invalid chat session' }, 400);
    }

    const project = await workspaceStore.createTemporaryProject();
    return context.json(await store.createSession(project.id, parsed.data), 201);
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

  routes.delete('/chat-sessions/:sessionId', async (context) => {
    const sessionId = context.req.param('sessionId');
    const result = await store.deleteSession(sessionId);
    if (!result.existed) {
      return context.json({ error: 'Chat session not found' }, 404);
    }
    if (wechatStore) {
      await wechatStore.clearActiveChatSessionBindings(sessionId);
    }
    return context.json({ deleted: true });
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
