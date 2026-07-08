import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatSessionStore } from '../chat/chatSessionStore';
import { createWorkspaceStore } from '../storage/workspaceStore';
import { createChatSessionRoutes } from './chatSessions';
import { createImageGenerationRoutes } from './imageGenerations';
import { createProjectsRoutes } from './projects';

let root: string;
let app: Hono;
let originalFetch: typeof fetch;
let originalBaseUrl: string | undefined;
let originalApiKey: string | undefined;
let originalModel: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-image-generations-'));
  const chatStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
  const workspaceStore = createWorkspaceStore(path.join(root, 'workspaces'));
  app = new Hono()
    .route('/api', createProjectsRoutes(workspaceStore))
    .route('/api', createChatSessionRoutes(chatStore, workspaceStore))
    .route('/api', createImageGenerationRoutes(chatStore, workspaceStore));

  originalFetch = globalThis.fetch;
  originalBaseUrl = process.env.VIWORK_AIGC_HUB_BASE_URL;
  originalApiKey = process.env.VIWORK_AIGC_HUB_API_KEY;
  originalModel = process.env.VIWORK_AIGC_HUB_IMAGE_MODEL;
  process.env.VIWORK_AIGC_HUB_BASE_URL = 'http://127.0.0.1:8000/v1';
  process.env.VIWORK_AIGC_HUB_API_KEY = 'hub_test_key';
  process.env.VIWORK_AIGC_HUB_IMAGE_MODEL = 'gpt-image-1';
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv('VIWORK_AIGC_HUB_BASE_URL', originalBaseUrl);
  restoreEnv('VIWORK_AIGC_HUB_API_KEY', originalApiKey);
  restoreEnv('VIWORK_AIGC_HUB_IMAGE_MODEL', originalModel);
  await rm(root, { recursive: true, force: true });
});

describe('image generation routes', () => {
  it('sends image requests through AIGC Hub and saves results in an assistant project session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: Buffer.from('fake-png').toString('base64'), revised_prompt: 'revised prompt' }],
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const projectResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '办公室奇遇记' }),
    });
    const project = await projectResponse.json() as { id: string };

    const sessionResponse = await app.request(`/api/projects/${project.id}/chat-sessions`, { method: 'POST' });
    const session = await sessionResponse.json() as { id: string };

    const response = await app.request('/api/image-generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        prompt: '生成一张办公室场景图',
        aspectRatio: '16:9',
        count: 1,
      }),
    });

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer hub_test_key',
          appid: 'viforge-novel-adaptation',
          traceid: expect.any(String),
        }),
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: '生成一张办公室场景图',
          size: '1536x1024',
          n: 1,
          response_format: 'b64_json',
        }),
      }),
    );
    expect(response.headers.get('traceid')).toBeTruthy();

    const body = await response.json() as { session: { messages: Array<{ attachments?: Array<{ path: string; projectId: string }> }> } };
    const generatedAttachment = body.session.messages.at(-1)?.attachments?.[0];
    expect(generatedAttachment).toEqual(expect.objectContaining({ projectId: project.id }));

    const rawResponse = await app.request(`/api/projects/${project.id}/raw/${generatedAttachment?.path}`);
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe('fake-png');
  });

  it('forwards an incoming trace id to AIGC Hub image requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: Buffer.from('trace-image').toString('base64') }],
    }, { headers: { traceid: 'gateway-trace-456' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await app.request('/api/image-generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceid: 'client-trace-123' },
      body: JSON.stringify({ prompt: '生成场景图', aspectRatio: '1:1', count: 1 }),
    });

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/images/generations',
      expect.objectContaining({
        headers: expect.objectContaining({
          appid: 'viforge-novel-adaptation',
          traceid: 'client-trace-123',
        }),
      }),
    );
    expect(response.headers.get('traceid')).toBe('gateway-trace-456');
  });

  it('requires AIGC Hub configuration', async () => {
    process.env.VIWORK_AIGC_HUB_BASE_URL = '';
    process.env.VIWORK_AIGC_HUB_API_KEY = '';

    const response = await app.request('/api/image-generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '生成图片', aspectRatio: '1:1', count: 1 }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '未配置 VIWORK_AIGC_HUB_BASE_URL 或 VIWORK_AIGC_HUB_API_KEY，无法通过 AIGC Hub 生成图片。',
    });
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
