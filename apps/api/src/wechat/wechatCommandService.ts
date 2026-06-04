import type { CreateRunInput } from '../runs/runService';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { WechatRouteState, WechatStore } from './wechatStore';

export type WechatCommandResult =
  | { type: 'route_switch'; route: WechatRouteState; replyText: string }
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

export function createWechatCommandService(
  wechatStore: WechatStore,
  workspaceStore: WorkspaceStore,
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
      return await resolveAndCreateRun(wechatStore, workspaceStore, externalUserId, route, text);
    },
  };
}

async function resolveAndCreateRun(
  wechatStore: WechatStore,
  workspaceStore: WorkspaceStore,
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
      // Project deleted; fall back to creating inbox
      const projects = await workspaceStore.listProjects();
      const inbox = projects.find((p) => p.name === '远程微信灵感箱');
      projectId = inbox?.id ?? (await createInboxProject(workspaceStore)).id;
      projectName = '远程微信灵感箱';
    }
  } else {
    const projects = await workspaceStore.listProjects();
    const inbox = projects.find((p) => p.name === '远程微信灵感箱');
    if (inbox) {
      projectId = inbox.id;
      projectName = inbox.name;
    } else {
      const created = await createInboxProject(workspaceStore);
      projectId = created.id;
      projectName = created.name;
    }

    const newRoute: WechatRouteState = {
      scope: 'project',
      projectId,
      projectName,
      lastCommandAt: new Date().toISOString(),
    };
    await wechatStore.setRouteState(externalUserId, newRoute);
  }

  return {
    type: 'create_run',
    input: { projectId, prompt: text, source: 'wechat' },
    replyText: `📝 在「${projectName}」中处理你的请求...`,
  };
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

async function createInboxProject(workspaceStore: WorkspaceStore) {
  return workspaceStore.createProject({
    name: '远程微信灵感箱',
    description: '从微信远程收集的小说改编创作灵感。',
  });
}
