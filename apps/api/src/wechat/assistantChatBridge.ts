import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { RunBus } from '../runs/runBus';
import type { CreateRunInput, RunService } from '../runs/runService';
import type { ChatMessageAttachment, StreamEvent } from '@viwork/shared';
import type { WechatStore } from './wechatStore';
import type { WechatIlinkClient } from './wechatIlinkClient';

export type AssistantChatBridge = {
  /** Creates or picks a chat session for the user, appends a user message, starts a LangGraph run, and returns the session id. */
  handleCreationRequest(input: {
    runInput: CreateRunInput;
    externalUserId: string;
    displayName: string;
    userMessageText: string;
  }): Promise<{ sessionId: string; replyText: string; attachments: ChatMessageAttachment[] }>;
};

const MAX_REPLY_LENGTH = 1500;

export function createAssistantChatBridge(
  chatSessionStore: ChatSessionStore,
  runService: RunService,
  runBus: RunBus,
  wechatStore: WechatStore,
  ilinkClient: WechatIlinkClient,
): AssistantChatBridge {
  return {
    async handleCreationRequest(input) {
      const { runInput, externalUserId, displayName, userMessageText } = input;

      // 1. Find or create a chat session
      let sessionId = await wechatStore.getActiveChatSessionId(externalUserId);

      if (sessionId) {
        try {
          await chatSessionStore.getSession(sessionId);
        } catch {
          sessionId = null;
        }
      }

      if (!sessionId) {
        const session = await chatSessionStore.createSession(runInput.projectId, {
          title: userMessageText.slice(0, 40) || '微信创作请求',
        });
        sessionId = session.id;
        await wechatStore.setActiveChatSessionId(externalUserId, session.id);
      }

      const session = await chatSessionStore.getSession(sessionId);
      const modelConfig = session?.modelConfig ?? {};
      // WeChat should not inherit a web-selected session model: some upstream models reject the agent runtime's planning/tool features.
      const runModel = resolveWechatChatModel(runInput.model);
      const runImageGeneration = {
        model: runInput.imageGeneration?.model ?? modelConfig.imageModel,
      };

      // 2. Append user message
      await chatSessionStore.appendMessage(sessionId, {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: `[微信 · ${displayName}] ${userMessageText}`,
        createdAt: new Date().toISOString(),
        attachments: [],
        referencedFiles: [],
        referencedSnippets: [],
        streamEvents: [],
        status: 'success',
        events: [],
      });

      // 3. Start LangGraph run with source: 'wechat'
      let replyText = '';
      try {
        const contextToken = await wechatStore.getIlinkContextToken(externalUserId);
        const wechatContext = contextToken
          ? { ilinkClient, userId: externalUserId, contextToken }
          : undefined;

        const { run } = await runService.createRun({
          ...runInput,
          model: runModel,
          imageGeneration: runImageGeneration,
          sessionId,
          source: 'wechat',
          wechat: wechatContext,
        });

        console.info('[wechat-bridge] run created', { runId: run.id, sessionId });

        // Subscribe to run events, accumulate response + stream events for persistence
        const runResult = await new Promise<{ text: string; events: StreamEvent[]; attachments: ChatMessageAttachment[]; status: 'success' | 'error' }>((resolve) => {
          const parts: string[] = [];
          const events: StreamEvent[] = [];
          const attachments: ChatMessageAttachment[] = [];
          const sentFilePaths = new Set<string>();
          let resolved = false;
          let textEventCount = 0;
          let firstTextAt: number | null = null;
          const startedAt = Date.now();

          const unsubscribe = runBus.subscribe(run.id, (event) => {
            events.push(event);
            if (event.type === 'text.delta') {
              textEventCount++;
              if (!firstTextAt) firstTextAt = Date.now() - startedAt;
              parts.push(event.delta);
            }
            if (event.type === 'image.generated' && !attachments.some((attachment) => attachment.id === event.attachment.id || attachment.path === event.attachment.path)) {
              attachments.push(event.attachment);
            }
            if (event.type === 'wechat.file_sent') {
              sentFilePaths.add(event.path);
            }
            if (event.type === 'run.end') {
              console.info('[wechat-bridge] run.end received', {
                runId: run.id,
                status: event.status,
                errorMessage: event.errorMessage,
                textEventCount,
                firstTextMs: firstTextAt,
                elapsedMs: Date.now() - startedAt,
              });
              if (!resolved) {
                resolved = true;
                unsubscribe();
                const fullText = parts.join('');
                const filtered = attachments.filter((a) => !sentFilePaths.has(a.path));
                if (event.status === 'error') {
                  resolve({
                    text: `❌ 创作助手运行失败：${event.errorMessage ?? '未知错误'}`,
                    events,
                    attachments: filtered,
                    status: 'error',
                  });
                } else {
                  resolve({
                    text: fullText.slice(0, MAX_REPLY_LENGTH) + (fullText.length > MAX_REPLY_LENGTH ? '…\n\n（回复过长已截断，请在工作台查看完整内容）' : ''),
                    events,
                    attachments: filtered,
                    status: 'success',
                  });
                }
              }
            }
          });

          // Timeout after 5 minutes
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              unsubscribe();
              const partial = parts.join('');
              resolve({
                text: partial.slice(0, MAX_REPLY_LENGTH) + '\n\n⏳ （回复仍在生成中，请稍后在工作台查看）',
                events,
                attachments: attachments.filter((a) => !sentFilePaths.has(a.path)),
                status: 'success',
              });
            }
          }, 5 * 60 * 1000);
        });

        replyText = runResult.text;

        // 4. Save assistant reply to chat session for frontend display
        try {
          await chatSessionStore.appendMessage(sessionId, {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            content: replyText,
            createdAt: new Date().toISOString(),
            attachments: runResult.attachments,
            referencedFiles: [],
            referencedSnippets: [],
            streamEvents: runResult.events,
            status: runResult.status,
          });
        } catch (err) {
          console.error('[wechat-bridge] failed to persist assistant message', err);
        }
      } catch (error) {
        replyText = `❌ 创作助手启动失败：${error instanceof Error ? error.message : '未知错误'}`;
      }

      const latestSession = await chatSessionStore.getSession(sessionId);
      const latestAssistantMessage = latestSession?.messages.slice().reverse().find((message) => message.role === 'assistant');
      return { sessionId, replyText, attachments: latestAssistantMessage?.attachments ?? [] };
    },
  };
}

function resolveWechatChatModel(runInputModel?: string): string | undefined {
  return process.env.VIWORK_WECHAT_CHAT_MODEL
    || process.env.VIWORK_AIGC_HUB_WECHAT_MODEL
    || runInputModel
    || 'minimax/minimax-m2.7';
}
