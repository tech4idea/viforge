import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { CreateRunInput } from '../runs/runService';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { WechatRouteState, WechatStore } from './wechatStore';

export type WechatCommandResult =
  | { type: 'route_switch'; route: WechatRouteState; replyText: string }
  | { type: 'session_switch'; replyText: string; sessionId: string }
  | { type: 'session_list'; replyText: string }
  | { type: 'create_run'; input: CreateRunInput; replyText?: string }
  | { type: 'error'; message: string };

export type WechatCommandService = {
  processMessage(input: {
    text: string;
    externalUserId: string;
    displayName: string;
  }): Promise<WechatCommandResult>;
};

const PROJECT_COMMAND = /^[\/／]项目\s*(.+)/;
const DRAFT_COMMAND = /^[\/／]草稿\s*$/;
const DRAFT_NEW_COMMAND = /^[\/／]草稿\s+新建\s*$/;
const SEND_COMMAND = /^[\/／]发送\s+(.+)/;
const STATUS_COMMAND = /^[\/／]状态\s*$/;
const HELP_COMMAND = /^[\/／]帮助\s*$/;
const SESSION_COMMAND = /^[\/／]会话(?:\s+(.+))?$/;
const SESSION_LIST_LIMIT = 10;

export function createWechatCommandService(
  wechatStore: WechatStore,
  workspaceStore: WorkspaceStore,
  chatSessionStore?: ChatSessionStore,
): WechatCommandService {
  return {
    async processMessage(input) {
      const text = input.text.trim();
      const externalUserId = input.externalUserId;

      if (HELP_COMMAND.test(text)) {
        return { type: 'error', message: '' };
      }

      if (STATUS_COMMAND.test(text)) {
        const route = await wechatStore.getRouteState(externalUserId);
        const location = route.scope === 'temporary' || !route.projectId
          ? '草稿区（临时工作目录）'
          : `项目「${route.projectName ?? route.projectId}」`;
        return { type: 'error', message: `📍 当前位置：${location}` };
      }

      const sessionMatch = text.match(SESSION_COMMAND);
      if (sessionMatch) {
        return await handleSessionCommand(
          wechatStore,
          chatSessionStore,
          externalUserId,
          (sessionMatch[1] ?? '').trim(),
        );
      }

      const projectMatch = text.match(PROJECT_COMMAND);
      if (projectMatch) {
        return await handleProjectCommand(wechatStore, workspaceStore, externalUserId, projectMatch[1].trim());
      }

      if (DRAFT_NEW_COMMAND.test(text)) {
        const route: WechatRouteState = {
          scope: 'temporary',
          projectId: null,
          projectName: '草稿区',
          lastCommandAt: new Date().toISOString(),
        };
        await wechatStore.setRouteState(externalUserId, route);
        return { type: 'route_switch', route, replyText: '✅ 已创建新草稿会话。请发送你的创作指令。' };
      }

      if (DRAFT_COMMAND.test(text)) {
        const route: WechatRouteState = {
          scope: 'temporary',
          projectId: null,
          projectName: '草稿区',
          lastCommandAt: new Date().toISOString(),
        };
        await wechatStore.setRouteState(externalUserId, route);
        return { type: 'route_switch', route, replyText: '✅ 已切换到草稿区。请发送你的创作指令。' };
      }

      if (SEND_COMMAND.test(text)) {
        return { type: 'error', message: '⏳ 文件发送功能将在后续版本支持。' };
      }

      const route = await wechatStore.getRouteState(externalUserId);
      return await resolveAndCreateRun(wechatStore, workspaceStore, chatSessionStore, externalUserId, route, text);
    },
  };
}

async function resolveAndCreateRun(
  wechatStore: WechatStore,
  workspaceStore: WorkspaceStore,
  chatSessionStore: ChatSessionStore | undefined,
  externalUserId: string,
  route: WechatRouteState,
  text: string,
): Promise<WechatCommandResult> {
  let projectId: string;
  let projectName = route.projectName ?? '草稿区';

  if (route.scope === 'project' && route.projectId) {
    try {
      const project = await workspaceStore.getProject(route.projectId);
      if (!project) throw new Error('Project not found');
      projectId = project.id;
      projectName = project.name;
    } catch {
      const project = await workspaceStore.createTemporaryProject();
      projectId = project.id;
      projectName = '临时会话';
      await wechatStore.setRouteState(externalUserId, {
        scope: 'temporary',
        projectId: null,
        projectName,
        lastCommandAt: new Date().toISOString(),
      });
    }
  } else {
    const project = await workspaceStore.createTemporaryProject();
    projectId = project.id;
    projectName = '临时会话';
    await wechatStore.setRouteState(externalUserId, {
      scope: 'temporary',
      projectId: null,
      projectName,
      lastCommandAt: new Date().toISOString(),
    });
  }

  const sessionId = chatSessionStore
    ? await resolveActiveSessionId(wechatStore, chatSessionStore, externalUserId, projectId, text)
    : undefined;

  return {
    type: 'create_run',
    input: { projectId, sessionId, prompt: text, source: 'wechat' },
    replyText: `📝 在「${projectName}」中处理你的请求...`,
  };
}

async function resolveActiveSessionId(
  wechatStore: WechatStore,
  chatSessionStore: ChatSessionStore,
  externalUserId: string,
  projectId: string,
  text: string,
): Promise<string> {
  const activeId = await wechatStore.getActiveChatSessionId(externalUserId);
  if (activeId) {
    const active = await chatSessionStore.getSession(activeId);
    if (active?.projectId === projectId && !active.archivedAt) return active.id;
  }

  const session = await chatSessionStore.createSession(projectId, {
    title: text.slice(0, 40) || '微信创作请求',
  });
  await wechatStore.setActiveChatSessionId(externalUserId, session.id);
  return session.id;
}

async function handleProjectCommand(
  wechatStore: WechatStore,
  workspaceStore: WorkspaceStore,
  externalUserId: string,
  name: string,
): Promise<WechatCommandResult> {
  const projects = await workspaceStore.listProjects();
  const match = projects.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));

  if (!match) {
    const names = projects.map((p) => p.name).join('、');
    return { type: 'error', message: `❌ 未找到项目「${name}」。\n\n可用项目：${names || '（暂无项目）'}` };
  }

  const route: WechatRouteState = {
    scope: 'project',
    projectId: match.id,
    projectName: match.name,
    lastCommandAt: new Date().toISOString(),
  };
  await wechatStore.setRouteState(externalUserId, route);

  return { type: 'route_switch', route, replyText: `✅ 已切换到项目「${match.name}」。请发送你的创作指令。` };
}

async function handleSessionCommand(
  wechatStore: WechatStore,
  chatSessionStore: ChatSessionStore | undefined,
  externalUserId: string,
  argument: string,
): Promise<WechatCommandResult> {
  if (!chatSessionStore) {
    return { type: 'error', message: '❌ 会话管理尚未配置。' };
  }

  const route = await wechatStore.getRouteState(externalUserId);
  if (route.scope !== 'project' || !route.projectId) {
    return { type: 'error', message: '❌ 请先通过「/项目 <名称>」切换到一个项目，再使用「/会话」。' };
  }

  const sessions = await chatSessionStore.listProjectSessions(route.projectId, { includeArchived: false });

  if (!argument) {
    if (sessions.length === 0) {
      return { type: 'session_list', replyText: `📭 「${route.projectName ?? route.projectId}」当前没有活跃会话。\n\n直接发送任意创作指令即可新建一个。` };
    }
    const activeId = await wechatStore.getActiveChatSessionId(externalUserId);
    const lines = sessions.slice(0, SESSION_LIST_LIMIT).map((session, index) => {
      const marker = session.id === activeId ? ' ▶' : '';
      const messageCount = session.messages.length;
      const relative = formatRelativeTime(session.updatedAt);
      return `${index + 1}. ${session.title}${marker}\n   ${messageCount} 条 · ${relative}`;
    });
    const truncated = sessions.length > SESSION_LIST_LIMIT ? `\n（仅列出最近 ${SESSION_LIST_LIMIT} 个）` : '';
    const replyText = `📋 「${route.projectName ?? route.projectId}」的活跃会话：\n\n${lines.join('\n\n')}${truncated}\n\n回复 /会话 <序号> 切换，或 /会话 <关键词> 按标题匹配。`;
    return { type: 'session_list', replyText };
  }

  const index = Number(argument);
  let target;
  if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
    target = sessions[index - 1];
  } else {
    const keyword = argument.toLowerCase();
    const matches = sessions.filter((session) => session.title.toLowerCase().includes(keyword));
    if (matches.length === 0) {
      return { type: 'error', message: `❌ 未找到匹配「${argument}」的会话。\n\n发送 /会话 查看最近会话列表。` };
    }
    if (matches.length > 1) {
      const titles = matches.slice(0, SESSION_LIST_LIMIT).map((session, i) => `${i + 1}. ${session.title}`).join('\n');
      return {
        type: 'session_list',
        replyText: `🔍 匹配到多个会话，请改用序号精确切换：\n\n${titles}`,
      };
    }
    target = matches[0];
  }

  if (!target) {
    return { type: 'error', message: '❌ 未能解析到目标会话。' };
  }

  await wechatStore.setActiveChatSessionId(externalUserId, target.id);
  await wechatStore.setPendingSessionAction(externalUserId, null);
  return { type: 'session_switch', replyText: `✅ 已切换到会话「${target.title}」。下一条消息会落入该会话。`, sessionId: target.id };
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '未知时间';
  const diffMs = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}
