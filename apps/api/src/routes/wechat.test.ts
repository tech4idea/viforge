import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStore } from '../storage/workspaceStore';
import { createWechatRoutes } from './wechat';
import { createWechatStore } from '../wechat/wechatStore';

let root: string;
let app: Hono;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-wechat-'));
  const workspaceStore = createWorkspaceStore(path.join(root, 'workspaces'));
  const wechatStore = createWechatStore(path.join(root, 'wechat.json'), workspaceStore);
  app = new Hono().route('/api', createWechatRoutes(wechatStore));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wechat routes', () => {
  it('reports disconnected status and creates a setup session', async () => {
    const statusResponse = await app.request('/api/wechat/status');
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({ state: 'not_connected' });

    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    expect(setupResponse.status).toBe(201);
    await expect(setupResponse.json()).resolves.toMatchObject({
      status: 'qr_ready',
      qrUrl: expect.stringContaining('viwork-wechat://pair/'),
    });
  });

  it('connects a setup session and accepts inbound theater notes', async () => {
    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    const setup = await setupResponse.json() as { sessionId: string };

    const connectResponse = await app.request(`/api/wechat/setup-sessions/${setup.sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '编剧微信', externalUserId: 'writer-openid' }),
    });
    expect(connectResponse.status).toBe(200);

    const inboundResponse = await app.request('/api/wechat/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalMessageId: 'msg-1',
        externalUserId: 'writer-openid',
        displayName: '编剧微信',
        text: '第二集增加一个误会：老板以为实习生是神秘投资人。',
      }),
    });

    expect(inboundResponse.status).toBe(202);
    await expect(inboundResponse.json()).resolves.toMatchObject({
      accepted: true,
      notePath: expect.stringMatching(/^remote-wechat\/.+\.md$/),
    });
  });
});
