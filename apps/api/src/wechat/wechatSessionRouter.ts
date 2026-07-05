import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { buildModelConfig } from '../runs/langGraphAgents';
import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { WorkspaceStore } from '../storage/workspaceStore';

import type { PendingSessionAction, WechatStore } from './wechatStore';

export type SessionRoutingResult =
  | { type: 'continue' }
  | { type: 'pending_confirmation'; replyText: string }
  | { type: 'confirmed'; action: PendingSessionAction; replyText?: string };

export type WechatSessionRouter = {
  routeMessage(input: {
    text: string;
    externalUserId: string;
    displayName: string;
  }): Promise<SessionRoutingResult>;
};

const CONFIRM_RE = /^(好[的吧]?|确认|确定|可以|没问题|对|是的|行|ok|yes|y)$/i;
const CANCEL_RE = /^(不[用了行好]?|取消|算了|不用了|返回|留在当前|继续当前|no|n)$/i;
const NEW_SESSION_RE = /^新建$/;

export function createWechatSessionRouter(
  wechatStore: WechatStore,
  chatSessionStore: ChatSessionStore,
  workspaceStore: WorkspaceStore,
  modelOptions: {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  } = {},
): WechatSessionRouter {
  const modelConfig = buildModelConfig({ ...modelOptions, model: 'minimax/minimax-m2.7' });

  return {
    async routeMessage(input) {
      const { text, externalUserId } = input;
      const pending = await wechatStore.getPendingSessionAction(externalUserId);

      if (pending) {
        return handlePendingResponse(wechatStore, externalUserId, text, pending);
      }

      return classifyAndRoute(wechatStore, chatSessionStore, workspaceStore, modelConfig, externalUserId, text);
    },
  };
}

async function handlePendingResponse(
  wechatStore: WechatStore,
  externalUserId: string,
  text: string,
  pending: PendingSessionAction,
): Promise<SessionRoutingResult> {
  const trimmed = text.trim();

  const selectedIndex = Number(trimmed);
  if (pending.type === 'switch_session' && Number.isInteger(selectedIndex) && pending.sessionOptions?.length) {
    const option = pending.sessionOptions.find((item) => item.index === selectedIndex);
    if (option) {
      await wechatStore.setPendingSessionAction(externalUserId, null);
      return {
        type: 'confirmed',
        replyText: `已切换到「${option.projectName}」下的会话「${option.sessionTitle}」。`,
        action: {
          type: 'switch_session',
          projectName: option.projectName,
          projectId: option.projectId,
          sessionId: option.sessionId,
          sessionTitle: option.sessionTitle,
          originalPrompt: '',
        },
      };
    }
  }

  if (NEW_SESSION_RE.test(trimmed)) {
    await wechatStore.setPendingSessionAction(externalUserId, null);
    return {
      type: 'confirmed',
      replyText: `已准备在「${pending.projectName}」下新建会话。`,
      action: {
        type: 'new_session',
        projectName: pending.projectName,
        projectId: pending.projectId,
        originalPrompt: '',
      },
    };
  }

  if (CONFIRM_RE.test(trimmed)) {
    await wechatStore.setPendingSessionAction(externalUserId, null);
    return { type: 'confirmed', action: pending };
  }

  if (CANCEL_RE.test(trimmed)) {
    await wechatStore.setPendingSessionAction(externalUserId, null);
    return { type: 'continue' };
  }

  const actionDesc = pending.type === 'new_session'
    ? `新建会话（${pending.projectName}）`
    : `切换到「${pending.projectName}」`;

  return {
    type: 'pending_confirmation',
    replyText: `你之前想${actionDesc}。\n回复「确认」继续，或「取消」留在当前会话。`,
  };
}

async function classifyAndRoute(
  wechatStore: WechatStore,
  chatSessionStore: ChatSessionStore,
  workspaceStore: WorkspaceStore,
  modelConfig: ReturnType<typeof buildModelConfig>,
  externalUserId: string,
  text: string,
): Promise<SessionRoutingResult> {
  const route = await wechatStore.getRouteState(externalUserId);
  const activeSessionId = await wechatStore.getActiveChatSessionId(externalUserId);

  let sessionContext = '当前无活跃会话。';
  if (activeSessionId) {
    try {
      const session = await chatSessionStore.getSession(activeSessionId);
      if (session) {
        sessionContext = `当前活跃会话：「${session.title ?? '未命名'}」(ID: ${session.id})`;
      }
    } catch {
      // session not found
    }
  }

  const projects = await workspaceStore.listProjects();
  const projectList = projects.map((p) => `「${p.name}」`).join('、') || '（无项目）';

  const classificationPrompt = [
    '# 会话路由判断',
    '',
    `当前工作目录：${route.scope === 'project' && route.projectName ? `项目「${route.projectName}」` : '草稿区'}`,
    sessionContext,
    `可用项目：${projectList}`,
    '',
    '用户发来一条微信消息。判断用户意图：',
    '- **continue**：继续在当前会话下聊天和工作（大多数情况）',
    '- **new_session**：用户明确要求新建一个会话/对话/聊天',
    '- **switch_session**：用户明确要求切换到另一个项目或会话',
    '',
    `用户消息：${text}`,
    '',
    '请只输出一行 JSON：',
    '{"intent":"<continue|new_session|switch_session>","target":"<项目名，仅 switch_session 时填>","reason":"<一句话理由>"}',
  ].join('\n');

  let classificationText = '';
  try {
    const response = await fetch(`${modelConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildAigcHubHeaders({ apiKey: modelConfig.apiKey, contentType: 'application/json' }),
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: modelConfig.model,
        messages: [
          { role: 'system', content: '你是微信会话路由器。只分析用户意图并分类，不执行任何创作。回复必须是一行 JSON。' },
          { role: 'user', content: classificationPrompt },
        ],
        temperature: 0,
        max_tokens: 1024,
      }),
    });
    if (!response.ok) return { type: 'continue' };
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    classificationText = body.choices?.[0]?.message?.content ?? '';
  } catch {
    return { type: 'continue' };
  }

  const jsonMatch = classificationText.match(/\{[^}]+\}/);
  if (!jsonMatch) return { type: 'continue' };

  let intent = 'continue';
  let target = '';
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    intent = parsed.intent ?? 'continue';
    target = parsed.target ?? '';
  } catch {
    return { type: 'continue' };
  }

  if (intent === 'continue') return { type: 'continue' };

  if (intent === 'new_session') {
    const projectName = route.projectName ?? '草稿区';
    const projectId = route.projectId;
    const action: PendingSessionAction = {
      type: 'new_session',
      projectName,
      projectId,
      originalPrompt: text,
    };
    await wechatStore.setPendingSessionAction(externalUserId, action);
    return {
      type: 'pending_confirmation',
      replyText: `你想在当前项目「${projectName}」下新建一个会话吗？回复「确认」新建，或「取消」留在当前会话。`,
    };
  }

  if (intent === 'switch_session') {
    const allSessions = await Promise.all(
      projects.map(async (p) => {
        const sessions = await chatSessionStore.listProjectSessions(p.id, { includeArchived: false });
        return { project: p, sessions: sessions.slice(0, 5) };
      }),
    );

    if (target) {
      const matchProject = projects.find((p) => p.name.toLowerCase().includes(target.toLowerCase()));
      if (matchProject) {
        const entry = allSessions.find((e) => e.project.id === matchProject.id);
        const sessions = entry?.sessions ?? [];
        if (sessions.length > 0) {
          const sessionLines = sessions.map((s, i) => {
            const title = s.title ?? '未命名会话';
            const msgCount = s.messages.length ?? 0;
            return `  ${i + 1}. ${title}（${msgCount} 条）`;
          }).join('\n');
          const lines = [
            `项目「${matchProject.name}」的最近会话：`,
            sessionLines,
            '',
            '回复序号切换到对应会话，或回复「新建」创建新会话。',
          ];
          const action: PendingSessionAction = {
            type: 'switch_session',
            projectName: matchProject.name,
            projectId: matchProject.id,
            originalPrompt: text,
          };
          await wechatStore.setPendingSessionAction(externalUserId, action);
          return { type: 'pending_confirmation', replyText: lines.join('\n') };
        }

        const action: PendingSessionAction = {
          type: 'switch_session',
          projectName: matchProject.name,
          projectId: matchProject.id,
          originalPrompt: text,
        };
        await wechatStore.setPendingSessionAction(externalUserId, action);
        return {
          type: 'pending_confirmation',
          replyText: `项目「${matchProject.name}」暂无会话。回复「确认」切换到此项目，或「新建」创建新会话。`,
        };
      }

      const matchedSession = allSessions.flatMap((e) =>
        e.sessions.map((s) => ({ ...s, projectName: e.project.name, projectId: e.project.id })),
      ).find((s) => (s.title ?? '').toLowerCase().includes(target.toLowerCase()));

      if (matchedSession) {
        const action: PendingSessionAction = {
          type: 'switch_session',
          projectName: matchedSession.projectName,
          projectId: matchedSession.projectId,
          originalPrompt: text,
        };
        await wechatStore.setPendingSessionAction(externalUserId, action);
        return {
          type: 'pending_confirmation',
          replyText: `你想切换到「${matchedSession.projectName}」下的会话「${matchedSession.title ?? '未命名'}」吗？回复「确认」切换，或「取消」留在当前会话。`,
        };
      }
    }

    const lines: string[] = ['可选项目和会话：', ''];
    const sessionOptions: NonNullable<Extract<PendingSessionAction, { type: 'switch_session' }>['sessionOptions']> = [];
    let idx = 1;
    for (const entry of allSessions) {
      lines.push(`【${entry.project.name}】`);
      if (entry.sessions.length === 0) {
        lines.push('  （暂无会话）');
      } else {
        for (const s of entry.sessions) {
          const title = s.title ?? '未命名会话';
          const msgCount = s.messages.length ?? 0;
          lines.push(`  ${idx}. ${title}（${msgCount} 条）`);
          sessionOptions.push({
            index: idx,
            projectId: entry.project.id,
            projectName: entry.project.name,
            sessionId: s.id,
            sessionTitle: title,
          });
          idx++;
        }
      }
      lines.push('');
    }
    lines.push('回复项目名称或会话序号切换，回复「新建」创建新会话。');
    await wechatStore.setPendingSessionAction(externalUserId, {
      type: 'switch_session',
      projectName: route.projectName ?? '当前项目',
      projectId: route.projectId ?? projects[0]?.id ?? '',
      originalPrompt: text,
      sessionOptions,
    });
    return { type: 'pending_confirmation', replyText: lines.join('\n') };
  }

  return { type: 'continue' };
}
