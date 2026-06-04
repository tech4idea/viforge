import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspaceStore } from '../storage/workspaceStore';
import { createChatSessionStore } from '../chat/chatSessionStore';
import { createRunBus } from '../runs/runBus';
import type { RunBus } from '../runs/runBus';
import { createWechatRoutes } from './wechat';
import { createWechatStore } from '../wechat/wechatStore';
import { createWechatCommandService } from '../wechat/wechatCommandService';
import type { WechatRouteDeps } from './wechat';
import type { AssistantChatBridge } from '../wechat/assistantChatBridge';

let root: string;
let app: Hono;
let runBus: RunBus;
let sentImages: Array<{ to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }>;

function createMockIlinkClient() {
  sentImages = [];
  return {
    getQrCode: async () => { throw new Error('ilink unavailable'); },
    checkQrCodeStatus: async () => ({ status: 'pending' as const }),
    getUpdates: async () => ({ cursor: '', updates: [] }),
    sendText: async () => {},
    sendImage: async (input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }) => {
      sentImages.push(input);
    },
  } as any;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-wechat-'));
  runBus = createRunBus();
  const workspaceStore = createWorkspaceStore(path.join(root, 'workspaces'));
  const chatSessionStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
  const wechatStore = createWechatStore(path.join(root, 'wechat.json'));
  const commandService = createWechatCommandService(wechatStore, workspaceStore);
  const chatBridge: AssistantChatBridge = {
    async handleCreationRequest(input) {
      if (input.userMessageText.includes('生成一张')) {
        const projectId = input.runInput.projectId;
        const imageBytes = Buffer.from('fake-image-binary');
        const imagePath = '生成图片/test-image.png';
        await workspaceStore.createWorkspaceAsset(projectId, imagePath, imageBytes, 'image/png');
        return {
          sessionId: 'mock-session',
          replyText: '已生成图片。',
          attachments: [{
            id: 'attachment-generated-image',
            kind: 'generated-image',
            name: 'test-image.png',
            path: imagePath,
            projectId,
            mimeType: 'image/png',
            createdAt: new Date().toISOString(),
          }],
        };
      }

      return {
        sessionId: 'mock-session',
        replyText: '已收到。',
        attachments: [],
      };
    },
  };
  const deps: WechatRouteDeps = {
    wechatStore,
    workspaceStore,
    commandService,
    chatBridge,
    ilinkClient: createMockIlinkClient(),
    poller: null,
  };
  app = new Hono().route('/api', createWechatRoutes(deps));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wechat routes', () => {
  it('reports disconnected status and creates a setup session with QR', async () => {
    const statusResponse = await app.request('/api/wechat/status');
    expect(statusResponse.status).toBe(200);
    const statusBody = await statusResponse.json();
    expect(statusBody.state).toBe('not_connected');
    expect(statusBody.ilink.configured).toBe(false);

    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    expect(setupResponse.status).toBe(201);
    const setup = await setupResponse.json() as { sessionId: string; qrUrl: string };
    expect(setup.qrUrl).toContain('viwork-wechat://pair/');
    expect(setup.sessionId).toBeTruthy();

    // Test QR endpoint
    const qrResponse = await app.request(`/api/wechat/setup-sessions/${encodeURIComponent(setup.sessionId)}/qr`);
    expect(qrResponse.status).toBe(200);
    expect(qrResponse.headers.get('Content-Type')).toBe('image/png');
  });

  it('connects a setup session and accepts inbound text with project routing', async () => {
    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    const setup = await setupResponse.json() as { sessionId: string };

    const connectResponse = await app.request(`/api/wechat/setup-sessions/${setup.sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '编剧微信', externalUserId: 'writer-openid' }),
    });
    expect(connectResponse.status).toBe(200);

    const statusResponse = await app.request('/api/wechat/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalMessageId: 'msg-status',
        externalUserId: 'writer-openid',
        displayName: '编剧微信',
        text: '/状态',
      }),
    });
    expect(statusResponse.status).toBe(202);
    const statusResult = await statusResponse.json();
    expect(statusResult.accepted).toBe(true);
    expect(statusResult.reply).toContain('草稿区');
  });

  it('switches projects and processes creation commands', async () => {
    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    const setup = await setupResponse.json() as { sessionId: string };

    await app.request(`/api/wechat/setup-sessions/${setup.sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '编剧微信', externalUserId: 'writer-openid' }),
    });

    const inboundResponse = await app.request('/api/wechat/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalMessageId: 'msg-create',
        externalUserId: 'writer-openid',
        displayName: '编剧微信',
        text: '分析一下平凡的世界里孙少安这个人物',
      }),
    });

    expect(inboundResponse.status).toBe(202);
    const inboundResult = await inboundResponse.json();
    expect(inboundResult.accepted).toBe(true);
    expect(inboundResult.reply).toBeTruthy();
  });

  it('sends generated images through ilink sender for inbound runs', async () => {
    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    const setup = await setupResponse.json() as { sessionId: string };

    await app.request(`/api/wechat/setup-sessions/${setup.sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '编剧微信', externalUserId: 'writer-openid' }),
    });

    const inboundResponse = await app.request('/api/wechat/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalMessageId: 'msg-image',
        externalUserId: 'writer-openid',
        displayName: '编剧微信',
        text: '生成一张陕北黄土高坡上孙少平的角色图',
      }),
    });

    expect(inboundResponse.status).toBe(202);
    expect(sentImages.length).toBeGreaterThan(0);
    expect(sentImages[0]?.to).toBe('writer-openid');
    expect(sentImages[0]?.mimeType.startsWith('image/')).toBe(true);
  });

  it('supports /帮助 command without connection', async () => {
    const helpResponse = await app.request('/api/wechat/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalMessageId: 'msg-help',
        externalUserId: 'someone',
        displayName: '测试用户',
        text: '/帮助',
      }),
    });
    expect(helpResponse.status).toBe(403); // not connected
  });
  it('disconnects and allows rebinding', async () => {
    // Connect first
    const setupResponse = await app.request('/api/wechat/setup-sessions', { method: 'POST' });
    const setup = await setupResponse.json() as { sessionId: string };
    await app.request(`/api/wechat/setup-sessions/${setup.sessionId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '测试', externalUserId: 'test-disconnect' }),
    });

    // Disconnect
    const disconnectResponse = await app.request('/api/wechat/connection', { method: 'DELETE' });
    expect(disconnectResponse.status).toBe(200);
    const body = await disconnectResponse.json();
    expect(body.disconnected).toBe(true);

    // Should be not_connected now
    const statusResponse = await app.request('/api/wechat/status');
    const statusBody = await statusResponse.json();
    expect(statusBody.state).toBe('not_connected');
    expect(statusBody.connection).toBeNull();
  });



});
