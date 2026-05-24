import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { WechatSetupSession, WechatStatus } from '@viwork/shared';
import type { WorkspaceStore } from '../storage/workspaceStore';

type WechatConnection = {
  displayName: string;
  externalUserId: string;
  connectedAt: string;
};

type WechatState = {
  connection: WechatConnection | null;
  setupSession: WechatSetupSession | null;
  inboundMessageIds: string[];
};

export type WechatStore = {
  getStatus(): Promise<WechatStatus>;
  createSetupSession(): Promise<WechatSetupSession>;
  completeSetupSession(
    sessionId: string,
    input: { displayName: string; externalUserId: string },
  ): Promise<WechatStatus>;
  acceptInbound(input: {
    externalMessageId: string;
    externalUserId: string;
    displayName: string;
    text: string;
  }): Promise<{ accepted: boolean; notePath: string | null }>;
};

export function createWechatStore(statePath: string, workspaceStore: WorkspaceStore): WechatStore {
  async function readState(): Promise<WechatState> {
    try {
      return JSON.parse(await readFile(statePath, 'utf8')) as WechatState;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { connection: null, setupSession: null, inboundMessageIds: [] };
      }
      throw error;
    }
  }

  async function writeState(state: WechatState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  return {
    async getStatus() {
      const state = await readState();
      return {
        state: state.connection ? 'connected' : state.setupSession ? 'pending' : 'not_connected',
        connection: state.connection,
        setupSession: state.setupSession,
      };
    },

    async createSetupSession() {
      const state = await readState();
      const sessionId = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session: WechatSetupSession = {
        sessionId,
        status: 'qr_ready',
        qrUrl: `viwork-wechat://pair/${sessionId}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
      await writeState({ ...state, setupSession: session });
      return session;
    },

    async completeSetupSession(sessionId, input) {
      const state = await readState();
      if (!state.setupSession || state.setupSession.sessionId !== sessionId) {
        throw new Error('Setup session not found');
      }
      const connection = {
        displayName: input.displayName,
        externalUserId: input.externalUserId,
        connectedAt: new Date().toISOString(),
      };
      await writeState({
        ...state,
        connection,
        setupSession: { ...state.setupSession, status: 'connected' },
      });
      return { state: 'connected', connection, setupSession: { ...state.setupSession, status: 'connected' } };
    },

    async acceptInbound(input) {
      const state = await readState();
      if (!state.connection || state.connection.externalUserId !== input.externalUserId) {
        return { accepted: false, notePath: null };
      }
      if (state.inboundMessageIds.includes(input.externalMessageId)) {
        return { accepted: true, notePath: null };
      }
      const projects = await workspaceStore.listProjects();
      const project = projects[0] ?? await workspaceStore.createProject({
        name: '远程微信灵感箱',
        description: '从微信远程收集的情景剧创作灵感。',
      });
      const notePath = `remote-wechat/${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      await workspaceStore.createWorkspaceFile(
        project.id,
        notePath,
        [
          '# 微信远程灵感',
          '',
          `来源：${input.displayName}`,
          `消息 ID：${input.externalMessageId}`,
          '',
          input.text,
          '',
        ].join('\n'),
      );
      await writeState({
        ...state,
        inboundMessageIds: [...state.inboundMessageIds, input.externalMessageId],
      });
      return { accepted: true, notePath };
    },
  };
}
