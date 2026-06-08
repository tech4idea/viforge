import { Hono } from 'hono';
import QRCode from 'qrcode';
import { z } from 'zod';

import type { AssistantChatBridge } from '../wechat/assistantChatBridge';
import type { WechatCommandService } from '../wechat/wechatCommandService';
import type { WechatIlinkClient } from '../wechat/wechatIlinkClient';
import type { WechatPoller } from '../wechat/wechatPoller';
import type { WechatSessionRouter } from '../wechat/wechatSessionRouter';
import type { WechatStore } from '../wechat/wechatStore';
import type { WorkspaceStore } from '../storage/workspaceStore';

const completeSetupSchema = z.object({
  displayName: z.string().min(1),
  externalUserId: z.string().min(1),
});

const inboundSchema = z.object({
  externalMessageId: z.string().min(1),
  externalUserId: z.string().min(1),
  displayName: z.string().min(1),
  text: z.string().min(1),
});

export type WechatRouteDeps = {
  wechatStore: WechatStore;
  workspaceStore: WorkspaceStore;
  commandService: WechatCommandService;
  chatBridge: AssistantChatBridge;
  ilinkClient: WechatIlinkClient;
  poller: WechatPoller | null;
  sessionRouter?: WechatSessionRouter;
};

export function createWechatRoutes(deps: WechatRouteDeps): Hono {
  const { wechatStore, workspaceStore, commandService, chatBridge, ilinkClient, poller, sessionRouter } = deps;
  const routes = new Hono();

  routes.get('/wechat/status', async (context) => {
    const status = await wechatStore.getStatus();
    const pollStatus = poller?.status();
    return context.json({
      ...status,
      ilink: { ...status.ilink, pollerRunning: pollStatus?.running ?? false },
    });
  });

  // -- Setup: create QR via ilink --
  routes.post('/wechat/setup-sessions', async (context) => {
    try {
      // Call ilink to get a real QR code
      const qr = await ilinkClient.getQrCode();

      // Persist ilink QR data so the /qr endpoint can serve the official image
      await wechatStore.setIlinkQrCode(qr.qrcode, qr.scanUrl);

      const session = await wechatStore.createSetupSession();

      // Start polling QR status in background
      void (async () => {
        console.info('[wechat] QR status polling started', {
          sessionId: session.sessionId,
          qrcode: qr.qrcode,
        });

        while (true) {
          try {
            const status = await ilinkClient.checkQrCodeStatus(qr.qrcode);
            if (status.status === 'confirmed') {
              if (status.botToken) {
                await wechatStore.setIlinkBotToken(status.botToken);
              }
              await wechatStore.completeSetupSession(session.sessionId, {
                displayName: status.displayName ?? '微信用户',
                externalUserId: status.externalUserId ?? `ilink:${qr.qrcode}`,
              });
              await wechatStore.setIlinkPollerEnabled(true);
              poller?.start();
              console.info('[wechat] QR setup completed', {
                sessionId: session.sessionId,
                externalUserId: status.externalUserId ?? `ilink:${qr.qrcode}`,
                hasBotToken: Boolean(status.botToken),
              });
              break;
            }
            if (status.status === 'expired') {
              console.info('[wechat] QR expired', { sessionId: session.sessionId, qrcode: qr.qrcode });
              break;
            }
            await new Promise((r) => setTimeout(r, 2000));
          } catch (error) {
            console.error('[wechat] QR status polling failed', {
              sessionId: session.sessionId,
              qrcode: qr.qrcode,
              error: error instanceof Error ? error.message : String(error),
            });
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      })();

      return context.json(session, 201);
    } catch (err) {
      console.error('[wechat] ilink QR creation failed', err);
      // Fallback to simulated mode
      const session = await wechatStore.createSetupSession();
      return context.json(session, 201);
    }
  });

  // -- QR Code Image (generated from ilink scan URL) --
  routes.get('/wechat/setup-sessions/:sessionId/qr', async (context) => {
    const status = await wechatStore.getStatus();
    if (!status.setupSession || status.setupSession.sessionId !== context.req.param('sessionId')) {
      return context.json({ error: 'Setup session not found' }, 404);
    }

    try {
      // Use the official ilink scan URL (e.g. https://liteapp.weixin.qq.com/q/...)
      // to generate a QR code image that opens WeChat when scanned
      const ilinkQrUrl = await wechatStore.getIlinkQrUrl();
      const qrContent = ilinkQrUrl ?? status.setupSession.qrUrl;

      const dataUrl = await QRCode.toDataURL(qrContent, {
        width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' },
      });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      return new Response(Buffer.from(base64, 'base64'), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
      });
    } catch {
      return context.json({ error: 'QR generation failed' }, 500);
    }
  });

  // -- Complete Setup (simulated, also used by background QR check) --
  routes.post('/wechat/setup-sessions/:sessionId/complete', async (context) => {
    const parsed = completeSetupSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid' }, 400);
    try {
      return context.json(await wechatStore.completeSetupSession(context.req.param('sessionId'), parsed.data));
    } catch (error) {
      if (error instanceof Error && error.message === 'Setup session not found') {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // -- Inbound Messages --
  routes.post('/wechat/inbound', async (context) => {
    const parsed = inboundSchema.safeParse(await parseJson(context.req.raw));
    if (!parsed.success) return context.json({ error: 'Invalid inbound message' }, 400);

    const { externalMessageId, externalUserId, displayName } = parsed.data;
    let text = parsed.data.text;
    const { accepted } = await wechatStore.checkAndRecordInbound(externalMessageId, externalUserId);
    if (!accepted) return context.json({ accepted: false, reply: null }, 403);

    if (/^[\/／]帮助\s*$/.test(text)) {
      return context.json({ accepted: true, reply: HELP_TEXT, notePath: null }, 202);
    }

    if (sessionRouter) {
      const routing = await sessionRouter.routeMessage({ text, externalUserId, displayName });

      if (routing.type === 'pending_confirmation') {
        return context.json({ accepted: true, reply: routing.replyText, notePath: null }, 202);
      }

      if (routing.type === 'confirmed') {
        if (routing.action.type === 'new_session') {
          await wechatStore.setActiveChatSessionId(externalUserId, null);
        } else if (routing.action.type === 'switch_session') {
          await wechatStore.setRouteState(externalUserId, {
            scope: 'project',
            projectId: routing.action.projectId,
            projectName: routing.action.projectName,
            lastCommandAt: new Date().toISOString(),
          });
          await wechatStore.setActiveChatSessionId(externalUserId, null);
        }
        text = routing.action.originalPrompt;
      }
    }

    const result = await commandService.processMessage({ text, externalUserId, displayName });

    if (result.type === 'error') {
      return context.json({ accepted: true, reply: result.message || null, notePath: null }, 202);
    }
    if (result.type === 'route_switch' || result.type === 'session_switch' || result.type === 'session_list') {
      return context.json({ accepted: true, reply: result.replyText, notePath: null }, 202);
    }
    if (result.type === 'create_run') {
      const { replyText, attachments } = await chatBridge.handleCreationRequest({
        runInput: result.input, externalUserId, displayName, userMessageText: text,
      });

      const contextToken = await wechatStore.getIlinkContextToken(externalUserId) ?? '';
      for (const attachment of attachments.filter((item) => item.kind === 'generated-image')) {
        try {
          const asset = await workspaceStore.readWorkspaceFileBytes(attachment.projectId, attachment.path);
          await ilinkClient.sendImage({
            to: externalUserId,
            bytes: asset.bytes,
            name: attachment.name,
            mimeType: attachment.mimeType,
            contextToken,
          });
        } catch (error) {
          console.error('[wechat] failed to send generated image from inbound route', {
            externalUserId,
            path: attachment.path,
          }, error);
        }
      }

      return context.json({ accepted: true, reply: (result.replyText ? `${result.replyText}\n\n` : '') + replyText, notePath: null }, 202);
    }

    return context.json({ accepted: true, reply: null, notePath: null }, 202);
  });
  // -- Disconnect / Rebind --
  routes.delete('/wechat/connection', async (context) => {
    await poller?.stop();
    await wechatStore.disconnect();
    return context.json({ disconnected: true });
  });


  return routes;
}

const HELP_TEXT = [
  '📖 viwork 微信指令',
  '',
  '/项目 <名称> — 切换到指定改编项目',
  '/草稿 — 切换到临时草稿区',
  '/草稿 新建 — 创建新的草稿会话',
  '/发送 <路径> — 发送工作区文件',
  '/状态 — 查看当前工作目录',
  '/帮助 — 显示此帮助',
  '',
  '也可以直接发送创作指令，助手会自动在当前目录下处理。',
].join('\n');

async function parseJson(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return undefined; }
}
