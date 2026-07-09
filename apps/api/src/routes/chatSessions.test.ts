import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChatSessionStore } from '../chat/chatSessionStore';
import { createWorkspaceStore } from '../storage/workspaceStore';
import { createChatSessionRoutes } from './chatSessions';
import { createProjectsRoutes } from './projects';

let root: string;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viforge-chat-sessions-'));
  const workspaceStore = createWorkspaceStore(path.join(root, 'workspaces'));
  app = new Hono()
    .route('/api', createProjectsRoutes(workspaceStore))
    .route(
      '/api',
      createChatSessionRoutes(
        createChatSessionStore(path.join(root, 'chat-sessions.json')),
        workspaceStore,
      ),
    );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('chat session routes', () => {
  it('creates a temporary workspace chat session', async () => {
    const response = await app.request('/api/temporary-chat-sessions', { method: 'POST' });

    expect(response.status).toBe(201);
    const session = await response.json() as { projectId: string; messages: unknown[] };
    expect(session.projectId).toMatch(/^temp-/);
    expect(session.messages).toEqual([]);

    const listResponse = await app.request(`/api/projects/${session.projectId}/chat-sessions`);
    await expect(listResponse.json()).resolves.toEqual([expect.objectContaining({ projectId: session.projectId })]);
  });

  it('creates temporary sessions with an explicit product profile', async () => {
    const response = await app.request('/api/temporary-chat-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'sitcom' }),
    });

    expect(response.status).toBe(201);
    const session = await response.json() as { projectId: string };

    const projectResponse = await app.request(`/api/projects/${session.projectId}`);
    expect(projectResponse.status).toBe(200);
    await expect(projectResponse.json()).resolves.toMatchObject({
      id: session.projectId,
      productId: 'sitcom',
      temporary: true,
    });
  });

  it('lists temporary workspace chat sessions across hidden temporary projects', async () => {
    const firstResponse = await app.request('/api/temporary-chat-sessions', { method: 'POST' });
    const first = await firstResponse.json() as { id: string; projectId: string };
    const secondResponse = await app.request('/api/temporary-chat-sessions', { method: 'POST' });
    const second = await secondResponse.json() as { id: string; projectId: string };
    await app.request('/api/projects/project-1/chat-sessions', { method: 'POST' });

    const response = await app.request('/api/temporary-chat-sessions?includeArchived=true');

    expect(response.status).toBe(200);
    const sessions = await response.json() as Array<{ id: string; projectId: string }>;
    expect(sessions.map((session) => session.id)).toEqual(expect.arrayContaining([second.id, first.id]));
    expect(sessions.every((session) => session.projectId.startsWith('temp-'))).toBe(true);
  });

  it('lists sessions by recent activity and hides archived sessions', async () => {
    const olderResponse = await app.request('/api/projects/project-1/chat-sessions', { method: 'POST' });
    const older = await olderResponse.json() as { id: string };
    const newerResponse = await app.request('/api/projects/project-1/chat-sessions', { method: 'POST' });
    const newer = await newerResponse.json() as { id: string };

    await app.request(`/api/chat-sessions/${older.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'message-1',
        role: 'user',
        content: '第一条',
        createdAt: '2026-05-18T00:00:00.000Z',
        referencedFiles: [],
        streamEvents: [],
      }),
    });
    await app.request(`/api/chat-sessions/${newer.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'message-2',
        role: 'user',
        content: '第二条',
        createdAt: '2026-05-18T01:00:00.000Z',
        referencedFiles: [],
        streamEvents: [],
      }),
    });

    const listResponse = await app.request('/api/projects/project-1/chat-sessions');
    expect(listResponse.status).toBe(200);
    const sessions = await listResponse.json() as Array<{ id: string; updatedAt: string }>;
    expect(sessions.map((session) => session.id)).toEqual([newer.id, older.id]);

    const archiveResponse = await app.request(`/api/chat-sessions/${newer.id}/archive`, { method: 'POST' });
    expect(archiveResponse.status).toBe(200);

    const activeListResponse = await app.request('/api/projects/project-1/chat-sessions');
    const activeSessions = await activeListResponse.json() as Array<{ id: string }>;
    expect(activeSessions.map((session) => session.id)).toEqual([older.id]);

    const archivedListResponse = await app.request('/api/projects/project-1/chat-sessions?includeArchived=true');
    const archivedSessions = await archivedListResponse.json() as Array<{ id: string }>;
    expect(archivedSessions.map((session) => session.id)).toContain(newer.id);

    const restoreResponse = await app.request(`/api/chat-sessions/${newer.id}/restore`, { method: 'POST' });
    expect(restoreResponse.status).toBe(200);

    const restoredListResponse = await app.request('/api/projects/project-1/chat-sessions');
    const restoredSessions = await restoredListResponse.json() as Array<{ id: string }>;
    expect(restoredSessions.map((session) => session.id)).toContain(newer.id);
  });

  it('updates thread id and assistant messages', async () => {
    const createResponse = await app.request('/api/projects/project-1/chat-sessions', { method: 'POST' });
    const session = await createResponse.json() as { id: string };

    const updateResponse = await app.request(`/api/chat-sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '更新后的标题' }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({ title: '更新后的标题' });

    const appendResponse = await app.request(`/api/chat-sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-18T00:00:00.000Z',
        referencedFiles: [],
        streamEvents: [],
        status: 'running',
      }),
    });
    expect(appendResponse.status).toBe(201);

    const messageUpdateResponse = await app.request(`/api/chat-sessions/${session.id}/messages/assistant-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'assistant-1',
        role: 'assistant',
        content: '完成',
        createdAt: '2026-05-18T00:00:00.000Z',
        referencedFiles: [],
        streamEvents: [],
        status: 'success',
      }),
    });
    expect(messageUpdateResponse.status).toBe(200);
    await expect(messageUpdateResponse.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 'assistant-1', content: '完成', status: 'success' })],
    });
  });

  it('hides stale empty assistant placeholders when loading history', async () => {
    const createResponse = await app.request('/api/projects/project-1/chat-sessions', { method: 'POST' });
    const session = await createResponse.json() as { id: string };

    const firstAppendResponse = await app.request(`/api/chat-sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'assistant-stale',
        role: 'assistant',
        content: '',
        createdAt: '2026-05-18T00:00:00.000Z',
        referencedFiles: [],
        streamEvents: [],
        status: 'running',
      }),
    });
    expect(firstAppendResponse.status).toBe(201);

    const secondAppendResponse = await app.request(`/api/chat-sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'assistant-legacy-interrupted',
        role: 'assistant',
        content: '回复未完成，可能是服务重启或连接中断。可以发送“继续”让创作助手接着聊。',
        createdAt: '2026-05-18T00:01:00.000Z',
        referencedFiles: [],
        streamEvents: [],
        status: 'error',
      }),
    });
    expect(secondAppendResponse.status).toBe(201);

    const listResponse = await app.request('/api/projects/project-1/chat-sessions?includeArchived=true');
    const sessions = await listResponse.json() as Array<{ messages: Array<{ id: string; content: string; status: string }> }>;

    expect(sessions[0].messages).toEqual([]);
  });
});
