import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'node:path';

import { workspaceStore } from './storage/workspaceStore';
import { createBehaviorRulesStore } from './storage/behaviorRulesStore';
import { createChatSessionStore } from './chat/chatSessionStore';
import { createLangGraphRunService } from './runs/langGraphRunService';
import { runBus } from './runs/runBus';
import { createAigcHubRoutes } from './routes/aigcHub';
import { createChatSessionRoutes } from './routes/chatSessions';
import { createImageGenerationRoutes } from './routes/imageGenerations';
import { createProjectsRoutes } from './routes/projects';
import { createRunEventsRoutes } from './routes/runEvents';
import { createRunsRoutes } from './routes/runs';
import { createBehaviorRulesRoutes } from './routes/behaviorRules';
import { createSkillsRoutes } from './routes/skills';
import { createWechatRoutes } from './routes/wechat';
import { createGitRoutes } from './routes/git';
import { createGitService } from './storage/gitService';
import { createGitConfigStore } from './storage/gitConfigStore';
import { createSkillStore } from './skills/skillStore';
import { createWechatStore } from './wechat/wechatStore';
import { createWechatCommandService } from './wechat/wechatCommandService';
import { createAssistantChatBridge } from './wechat/assistantChatBridge';
import { createWechatIlinkClient } from './wechat/wechatIlinkClient';
import { createWechatPoller } from './wechat/wechatPoller';
import { createWechatSessionRouter, type WechatSessionRouter } from './wechat/wechatSessionRouter';
import type { PendingSessionAction } from './wechat/wechatStore';
import type { WechatIlinkClient } from './wechat/wechatIlinkClient';
import type { WechatPoller } from './wechat/wechatPoller';
import { WORKSPACES_ROOT } from './env';

export function createApp(): Hono {
  const app = new Hono();
  const chatSessionStore = createChatSessionStore(path.join(WORKSPACES_ROOT, '..', 'chat-sessions.json'));

  app.use('/api/*', cors());
  app.onError((error, context) => {
    console.error('[api] request failed', { method: context.req.method, path: context.req.path }, error);
    return context.json({ error: 'Internal server error' }, 500);
  });

  app.route('/api', createProjectsRoutes(workspaceStore));
  app.route('/api', createAigcHubRoutes());

  // WeChat + ilink (zero-config: uses official WeChat https://ilinkai.weixin.qq.com)
  const wechatStore = createWechatStore(path.join(WORKSPACES_ROOT, '..', 'wechat.json'));

  app.route('/api', createChatSessionRoutes(chatSessionStore, workspaceStore, wechatStore));
  app.route('/api', createImageGenerationRoutes(chatSessionStore, workspaceStore));

  const gitService = createGitService();
  const gitConfigStore = createGitConfigStore(workspaceStore);

  const langGraphRunService = createLangGraphRunService(workspaceStore, runBus, {
    gitService,
    gitConfigStore,
  });
  app.route('/api', createRunsRoutes(langGraphRunService, runBus));
  app.route('/api', createRunEventsRoutes(runBus));

  app.route('/api', createSkillsRoutes(createSkillStore({
    agentConfigSkillsRoot: path.join(WORKSPACES_ROOT, '_global', 'Agent 配置', 'skills'),
  })));

  app.route('/api', createBehaviorRulesRoutes(createBehaviorRulesStore(workspaceStore)));

  app.route('/api', createGitRoutes(gitService, gitConfigStore, workspaceStore));

  const wechatCommandService = createWechatCommandService(wechatStore, workspaceStore, chatSessionStore);
  const ilinkClient: WechatIlinkClient = createWechatIlinkClient();
  const assistantChatBridge = createAssistantChatBridge(chatSessionStore, langGraphRunService, runBus, wechatStore, ilinkClient);
  const sessionRouter: WechatSessionRouter = createWechatSessionRouter(wechatStore, chatSessionStore, workspaceStore);

  const wechatPoller: WechatPoller = createWechatPoller(ilinkClient, wechatStore, async (update) => {
    try {
      console.info('[wechat] inbound message received', {
        fromUserId: update.fromUserId,
        displayName: update.fromDisplayName,
        messageId: update.messageId,
        textLength: update.text.length,
        hasContextToken: Boolean(update.contextToken),
      });

      if (update.contextToken) {
        await wechatStore.setIlinkContextToken(update.fromUserId, update.contextToken);
      }

      const routing = await sessionRouter.routeMessage({
        text: update.text,
        externalUserId: update.fromUserId,
        displayName: update.fromDisplayName,
      });

      if (routing.type === 'pending_confirmation') {
        await ilinkClient.sendText({
          to: update.fromUserId,
          text: routing.replyText,
          contextToken: update.contextToken,
        });
        return;
      }

      let processText = update.text;
      if (routing.type === 'confirmed') {
        await executeConfirmedSessionAction(wechatStore, chatSessionStore, workspaceStore, update.fromUserId, routing.action);
        processText = routing.action.originalPrompt;
        console.info('[wechat] session action confirmed', {
          fromUserId: update.fromUserId,
          actionType: routing.action.type,
          projectName: routing.action.projectName,
        });
      }

      const result = await wechatCommandService.processMessage({
        text: processText,
        externalUserId: update.fromUserId,
        displayName: update.fromDisplayName,
      });

      console.info('[wechat] command processed', {
        fromUserId: update.fromUserId,
        messageId: update.messageId,
        resultType: result.type,
      });

      if (result.type === 'error') {
        if (result.message) {
          await ilinkClient.sendText({
            to: update.fromUserId,
            text: result.message,
            contextToken: update.contextToken,
          });
        }
        return;
      }

      if (result.type === 'route_switch') {
        await ilinkClient.sendText({
          to: update.fromUserId,
          text: result.replyText,
          contextToken: update.contextToken,
        });
        return;
      }

      if (result.type === 'create_run') {
        if (result.replyText) {
          await ilinkClient.sendText({
            to: update.fromUserId,
            text: result.replyText,
            contextToken: update.contextToken,
          });
          console.info('[wechat] sent processing acknowledgment', {
            fromUserId: update.fromUserId,
            projectId: result.input.projectId,
          });
        }

        console.info('[wechat] starting bridge run', {
          fromUserId: update.fromUserId,
          projectId: result.input.projectId,
          prompt: update.text.slice(0, 80),
        });

        const { replyText, attachments } = await assistantChatBridge.handleCreationRequest({
          runInput: result.input,
          externalUserId: update.fromUserId,
          displayName: update.fromDisplayName,
          userMessageText: update.text,
        });

        console.info('[wechat] bridge returned', {
          fromUserId: update.fromUserId,
          replyTextLength: replyText.length,
          replyPreview: replyText.slice(0, 100),
        });

        if (replyText) {
          await ilinkClient.sendText({
            to: update.fromUserId,
            text: replyText,
            contextToken: update.contextToken,
          });
          console.info('[wechat] sent reply', { fromUserId: update.fromUserId });
        }

        for (const attachment of attachments.filter((item) => item.kind === 'generated-image')) {
          try {
            const asset = await workspaceStore.readWorkspaceFileBytes(attachment.projectId, attachment.path);
            await ilinkClient.sendImage({
              to: update.fromUserId,
              bytes: asset.bytes,
              name: attachment.name,
              mimeType: attachment.mimeType,
              contextToken: update.contextToken,
            });
            console.info('[wechat] sent generated image', {
              fromUserId: update.fromUserId,
              path: attachment.path,
            });
          } catch (error) {
            console.error('[wechat] failed to send generated image', {
              fromUserId: update.fromUserId,
              path: attachment.path,
            }, error);
          }
        }
      }
    } catch (err) {
      console.error('[wechat-poller] error', err);
    }
  });

  // Restore poller if previously connected
  void (async () => {
    const botToken = await wechatStore.getIlinkBotToken();
    if (botToken) {
      ilinkClient.setBotToken(botToken);
      console.info('[wechat] restored ilink bot token');
    }

    if (botToken && await wechatStore.isIlinkPollerEnabled()) {
      console.info('[wechat] restoring ilink poller');
      wechatPoller.start();
    }
  })();

  app.route('/api', createWechatRoutes({
    wechatStore,
    workspaceStore,
    commandService: wechatCommandService,
    chatBridge: assistantChatBridge,
    ilinkClient,
    poller: wechatPoller,
    sessionRouter,
  }));

  return app;
}

async function executeConfirmedSessionAction(
  wechatStore: import('./wechat/wechatStore').WechatStore,
  chatSessionStore: import('./chat/chatSessionStore').ChatSessionStore,
  workspaceStore: import('./storage/workspaceStore').WorkspaceStore,
  externalUserId: string,
  action: PendingSessionAction,
): Promise<void> {
  if (action.type === 'new_session') {
    await wechatStore.setActiveChatSessionId(externalUserId, null);
    console.info('[wechat] cleared active session for new session', { externalUserId });
    return;
  }

  if (action.type === 'switch_session') {
    const route: import('./wechat/wechatStore').WechatRouteState = {
      scope: 'project',
      projectId: action.projectId,
      projectName: action.projectName,
      lastCommandAt: new Date().toISOString(),
    };
    await wechatStore.setRouteState(externalUserId, route);
    await wechatStore.setActiveChatSessionId(externalUserId, null);
    console.info('[wechat] switched route to project', {
      externalUserId,
      projectId: action.projectId,
      projectName: action.projectName,
    });
  }
}
