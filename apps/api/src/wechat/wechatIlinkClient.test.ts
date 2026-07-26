import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWechatIlinkClient } from './wechatIlinkClient';

describe('wechat ilink client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('includes endpoint and fetch cause details when getUpdates cannot reach ilink', async () => {
    const error = new TypeError('fetch failed') as TypeError & { cause?: unknown };
    error.cause = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      syscall: 'connect',
      hostname: 'ilink.example.test',
      port: 443,
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw error; }));

    const client = createWechatIlinkClient('bot-token', 'https://ilink.example.test');

    await expect(client.getUpdates('')).rejects.toThrow(
      'ilink /ilink/bot/getupdates fetch failed at https://ilink.example.test/ilink/bot/getupdates: fetch failed; cause=ETIMEDOUT connect ilink.example.test 443 connect ETIMEDOUT',
    );
  });

  it('parses ilink text updates even when the envelope message type is not 1', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ret: 0,
      get_updates_buf: 'cursor-next',
      msgs: [{
        msg_id: 'msg-1',
        from_user_id: 'writer@im.wechat',
        message_type: 2,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '请帮我分析第一幕' } }],
      }],
    }), { status: 200 })));

    const client = createWechatIlinkClient('bot-token', 'https://ilink.example.test');
    const result = await client.getUpdates('cursor-prev');

    expect(result.cursor).toBe('cursor-next');
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({
      updateId: 'msg-1',
      fromUserId: 'writer@im.wechat',
      text: '请帮我分析第一幕',
      contextToken: 'ctx-1',
      messageType: 2,
    });
  });
});
