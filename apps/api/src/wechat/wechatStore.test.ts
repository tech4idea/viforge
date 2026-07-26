import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWechatStore } from './wechatStore';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viforge-wechat-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wechat store ilink state', () => {
  it('persists the ilink base URL with the bot token', async () => {
    const statePath = path.join(root, 'wechat.json');
    const store = createWechatStore(statePath);

    await store.setIlinkBotToken('bot-token', 'https://ilink-region.example.test');

    expect(await store.getIlinkBotToken()).toBe('bot-token');
    expect(await store.getIlinkBaseUrl()).toBe('https://ilink-region.example.test');

    const status = await store.getStatus();
    expect(status.ilink.configured).toBe(true);
    expect(status.ilink.baseUrl).toBe('https://ilink-region.example.test');

    const restored = createWechatStore(statePath);
    expect(await restored.getIlinkBaseUrl()).toBe('https://ilink-region.example.test');
  });
  it('resets stale poll cursor and context tokens when the ilink token changes', async () => {
    const statePath = path.join(root, 'wechat.json');
    const store = createWechatStore(statePath);

    await store.setIlinkBotToken('old-token', 'https://ilink-old.example.test');
    await store.setIlinkPollCursor('old-cursor');
    await store.setIlinkContextToken('writer@im.wechat', 'old-context');

    await store.setIlinkBotToken('new-token', 'https://ilink-new.example.test');

    expect(await store.getIlinkBotToken()).toBe('new-token');
    expect(await store.getIlinkBaseUrl()).toBe('https://ilink-new.example.test');
    expect(await store.getIlinkPollCursor()).toBeNull();
    expect(await store.getIlinkContextToken('writer@im.wechat')).toBeNull();
  });

  it('rejects duplicate inbound message ids while allowing the first matching user message', async () => {
    const statePath = path.join(root, 'wechat.json');
    const store = createWechatStore(statePath);
    const setup = await store.createSetupSession();
    await store.completeSetupSession(setup.sessionId, {
      displayName: '编剧微信',
      externalUserId: 'writer@im.wechat',
    });

    await expect(store.checkAndRecordInbound('msg-1', 'writer@im.wechat')).resolves.toEqual({ accepted: true });
    await expect(store.checkAndRecordInbound('msg-1', 'writer@im.wechat')).resolves.toEqual({ accepted: false });
    await expect(store.checkAndRecordInbound('msg-2', 'other@im.wechat')).resolves.toEqual({ accepted: false });
  });

  it('binds placeholder ilink connections to the first real inbound user only once', async () => {
    const statePath = path.join(root, 'wechat.json');
    const store = createWechatStore(statePath);
    const setup = await store.createSetupSession();
    await store.completeSetupSession(setup.sessionId, {
      displayName: '微信用户',
      externalUserId: 'ilink:qr-placeholder',
    });

    await expect(store.checkAndRecordInbound('msg-1', 'writer@im.wechat')).resolves.toEqual({ accepted: true });
    await expect(store.checkAndRecordInbound('msg-2', 'other@im.wechat')).resolves.toEqual({ accepted: false });

    const status = await store.getStatus();
    expect(status.connection?.externalUserId).toBe('writer@im.wechat');
  });
});
