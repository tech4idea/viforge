import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { WechatSetupSession, WechatStatus } from '@viforge/shared';
import type { PendingSessionAction, WechatRouteState } from './wechatTypes';

export type { PendingSessionAction, PendingSessionOption, WechatRouteState } from './wechatTypes';

type WechatConnection = {
  displayName: string;
  externalUserId: string;
  connectedAt: string;
};

export type WechatUserState = {
  route: WechatRouteState;
  activeChatSessionId: string | null;
  pendingSessionAction: PendingSessionAction | null;
};

type WechatIlinkState = {
  /** ilink QR code string from get_bot_qrcode */
  qrcode: string | null;
  /** ilink scan URL (the URL users scan with WeChat) */
  qrUrl: string | null;
  /** ilink bot token (received after QR scan confirmed) */
  botToken: string | null;
  /** ilink getUpdates cursor */
  pollCursor: string | null;
  /** ilink context tokens keyed by externalUserId */
  contextTokens: Record<string, string>;
  /** Whether the ilink poller should be active */
  pollerEnabled: boolean;
};

type WechatState = {
  connection: WechatConnection | null;
  setupSession: WechatSetupSession | null;
  inboundMessageIds: string[];
  users: Record<string, WechatUserState>;
  attachmentRefs: Array<{
    externalMessageId: string;
    assetPath: string;
    mimeType: string;
    name: string;
  }>;
  ilink: WechatIlinkState;
};

export type WechatStore = {
  getStatus(): Promise<WechatStatus>;
  createSetupSession(): Promise<WechatSetupSession>;
  completeSetupSession(
    sessionId: string,
    input: { displayName: string; externalUserId: string },
  ): Promise<WechatStatus>;
  getRouteState(externalUserId: string): Promise<WechatRouteState>;
  setRouteState(externalUserId: string, route: WechatRouteState): Promise<void>;
  getActiveChatSessionId(externalUserId: string): Promise<string | null>;
  setActiveChatSessionId(externalUserId: string, sessionId: string | null): Promise<void>;
  clearActiveChatSessionBindings(sessionId: string): Promise<number>;
  checkAndRecordInbound(externalMessageId: string, externalUserId: string): Promise<{ accepted: boolean }>;
  recordAttachment(ref: { externalMessageId: string; assetPath: string; mimeType: string; name: string }): Promise<void>;
  getAttachmentsForMessage(externalMessageId: string): Promise<Array<{ assetPath: string; mimeType: string; name: string }>>;
  /** ilink: get stored bot token (for session restore) */
  getIlinkBotToken(): Promise<string | null>;
  /** ilink: store bot token after login confirmed */
  setIlinkBotToken(token: string): Promise<void>;
  /** ilink: get QR code string */
  getIlinkQrCode(): Promise<string | null>;
  /** ilink: get scan URL for QR generation */
  getIlinkQrUrl(): Promise<string | null>;
  /** ilink: store QR code + scan URL from get_bot_qrcode */
  setIlinkQrCode(qrcode: string, qrUrl: string): Promise<void>;
  /** ilink: get poll cursor */
  getIlinkPollCursor(): Promise<string | null>;
  setIlinkPollCursor(cursor: string): Promise<void>;
  getIlinkContextToken(externalUserId: string): Promise<string | null>;
  setIlinkContextToken(externalUserId: string, token: string): Promise<void>;
  getIlinkSendTarget(): Promise<{ externalUserId: string; contextToken: string } | null>;
  setIlinkPollerEnabled(enabled: boolean): Promise<void>;
  isIlinkPollerEnabled(): Promise<boolean>;
  getPendingSessionAction(externalUserId: string): Promise<PendingSessionAction | null>;
  setPendingSessionAction(externalUserId: string, action: PendingSessionAction | null): Promise<void>;
  /** Clear connection + ilink state for rebinding */
  disconnect(): Promise<void>;
};

export function createWechatSendContext(input: {
  wechatStore: WechatStore;
  ilinkClient: import('./wechatIlinkClient').WechatIlinkClient;
}): import('../runs/runService').WechatSendContext {
  const { wechatStore, ilinkClient } = input;
  const resolveTarget = async () => {
    const target = await wechatStore.getIlinkSendTarget();
    if (!target) {
      throw new Error('WeChat send target is not ready; send a message to the bot first');
    }
    return target;
  };

  return {
    async sendText({ text }) {
      const target = await resolveTarget();
      await ilinkClient.sendText({ to: target.externalUserId, text, contextToken: target.contextToken });
    },
    async sendFile({ bytes, name, mimeType }) {
      const target = await resolveTarget();
      await ilinkClient.sendFile({ to: target.externalUserId, bytes, name, mimeType, contextToken: target.contextToken });
    },
  };
}

export function createWechatStore(statePath: string): WechatStore {
  let writeQueue = Promise.resolve();

  const defaultState = (): WechatState => ({
    connection: null,
    setupSession: null,
    inboundMessageIds: [],
    users: {},
    attachmentRefs: [],
    ilink: {
      qrcode: null,
      qrUrl: null,
      botToken: null,
      pollCursor: null,
      contextTokens: {},
      pollerEnabled: false,
    },
  });

  function normalizeState(parsed: Partial<WechatState>): WechatState {
    const fallback = defaultState();
    const ilink = parsed.ilink ?? fallback.ilink;
    return {
      connection: (parsed.connection ?? null) as WechatConnection | null,
      setupSession: (parsed.setupSession ?? null) as WechatSetupSession | null,
      inboundMessageIds: Array.isArray(parsed.inboundMessageIds) ? parsed.inboundMessageIds : [],
      users: (parsed.users ?? {}) as Record<string, WechatUserState>,
      attachmentRefs: Array.isArray(parsed.attachmentRefs) ? parsed.attachmentRefs : [],
      ilink: {
        qrcode: ilink.qrcode ?? null,
        qrUrl: ilink.qrUrl ?? null,
        botToken: ilink.botToken ?? null,
        pollCursor: ilink.pollCursor ?? null,
        contextTokens: ilink.contextTokens ?? {},
        pollerEnabled: ilink.pollerEnabled ?? false,
      },
    };
  }

  async function readState(): Promise<WechatState> {
    await writeQueue.catch(() => undefined);
    try {
      const raw = await readFile(statePath, 'utf8');
      if (!raw.trim()) return defaultState();
      return normalizeState(JSON.parse(raw) as Partial<WechatState>);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return defaultState();
      }
      if (error instanceof SyntaxError) {
        console.warn('[wechat-store] ignoring invalid state file', { statePath, error: error.message });
        return defaultState();
      }
      throw error;
    }
  }

  async function writeState(state: WechatState): Promise<void> {
    const write = async () => {
      await mkdir(path.dirname(statePath), { recursive: true });
      const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmpPath, statePath);
    };
    writeQueue = writeQueue.then(write, write);
    await writeQueue;
  }

  const DEFAULT_ROUTE: WechatRouteState = {
    scope: 'temporary', projectId: null, projectName: null, lastCommandAt: null,
  };

  return {
    async getStatus() {
      const s = await readState();
      return {
        state: s.connection ? 'connected' : s.setupSession ? 'pending' : 'not_connected',
        connection: s.connection,
        setupSession: s.setupSession,
        ilink: {
          configured: Boolean(s.ilink.botToken),
          baseUrl: null, accountId: null, routeTag: null, allowFrom: [],
          pollerRunning: s.ilink.pollerEnabled,
          lastPollAt: null, pollError: null,
        },
      };
    },

    async createSetupSession() {
      const s = await readState();
      const sessionId = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const session: WechatSetupSession = {
        sessionId,
        status: 'qr_ready',
        qrUrl: s.ilink.qrUrl ?? `viforge-wechat://pair/${sessionId}`,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
      await writeState({ ...s, setupSession: session });
      return session;
    },

    async completeSetupSession(sessionId, input) {
      const s = await readState();
      if (!s.setupSession || s.setupSession.sessionId !== sessionId) throw new Error('Setup session not found');
      const connection = {
        displayName: input.displayName,
        externalUserId: input.externalUserId,
        connectedAt: new Date().toISOString(),
      };
      await writeState({
        ...s, connection,
        setupSession: { ...s.setupSession, status: 'connected' },
        ilink: { ...s.ilink, pollerEnabled: Boolean(s.ilink.botToken) },
      });
      return {
        state: 'connected', connection,
        setupSession: { ...s.setupSession, status: 'connected' },
        ilink: {
          configured: Boolean(s.ilink.botToken),
          baseUrl: null, accountId: null, routeTag: null, allowFrom: [],
          pollerRunning: s.ilink.pollerEnabled,
          lastPollAt: null, pollError: null,
        },
      };
    },

    async getRouteState(externalUserId) {
      const s = await readState();
      return s.users[externalUserId]?.route ?? { ...DEFAULT_ROUTE };
    },

    async setRouteState(externalUserId, route) {
      const s = await readState();
      const existing = s.users[externalUserId] ?? { route: { ...DEFAULT_ROUTE }, activeChatSessionId: null, pendingSessionAction: null };
      await writeState({ ...s, users: { ...s.users, [externalUserId]: { ...existing, route } } });
    },

    async getActiveChatSessionId(externalUserId) {
      const s = await readState();
      return s.users[externalUserId]?.activeChatSessionId ?? null;
    },

    async setActiveChatSessionId(externalUserId, sessionId) {
      const s = await readState();
      const existing = s.users[externalUserId] ?? { route: { ...DEFAULT_ROUTE }, activeChatSessionId: null, pendingSessionAction: null };
      await writeState({ ...s, users: { ...s.users, [externalUserId]: { ...existing, activeChatSessionId: sessionId } } });
    },

    async clearActiveChatSessionBindings(sessionId) {
      const s = await readState();
      let affected = 0;
      const users = { ...s.users };
      for (const [externalUserId, state] of Object.entries(users)) {
        if (state.activeChatSessionId === sessionId) {
          users[externalUserId] = { ...state, activeChatSessionId: null };
          affected += 1;
        }
      }
      if (affected > 0) {
        await writeState({ ...s, users });
      }
      return affected;
    },

    async checkAndRecordInbound(externalMessageId, externalUserId) {
      const s = await readState();
      if (!s.connection) return { accepted: false };
      const connectionMatches = s.connection.externalUserId === externalUserId;
      const placeholderConnection = s.connection.externalUserId.startsWith('ilink:');
      if (!connectionMatches && !placeholderConnection) return { accepted: false };
      if (s.inboundMessageIds.includes(externalMessageId)) return { accepted: true };
      await writeState({
        ...s,
        connection: placeholderConnection ? { ...s.connection, externalUserId } : s.connection,
        inboundMessageIds: [...s.inboundMessageIds, externalMessageId],
      });
      return { accepted: true };
    },

    async recordAttachment(ref) {
      const s = await readState();
      await writeState({ ...s, attachmentRefs: [...s.attachmentRefs, ref] });
    },

    async getAttachmentsForMessage(externalMessageId) {
      const s = await readState();
      return s.attachmentRefs.filter((r) => r.externalMessageId === externalMessageId);
    },

    async getIlinkBotToken() { return (await readState()).ilink.botToken; },
    async setIlinkBotToken(token) {
      const s = await readState();
      await writeState({ ...s, ilink: { ...s.ilink, botToken: token } });
    },

    async getIlinkQrCode() { return (await readState()).ilink.qrcode; },
    async getIlinkQrUrl() { const s = await readState(); return s.ilink.qrUrl; },
    async setIlinkQrCode(qrcode, qrUrl) {
      const s = await readState();
      await writeState({ ...s, ilink: { ...s.ilink, qrcode, qrUrl } });
    },

    async getIlinkPollCursor() { return (await readState()).ilink.pollCursor; },
    async setIlinkPollCursor(cursor) {
      const s = await readState();
      await writeState({ ...s, ilink: { ...s.ilink, pollCursor: cursor } });
    },

    async getIlinkContextToken(externalUserId) {
      return (await readState()).ilink.contextTokens[externalUserId] ?? null;
    },
    async setIlinkContextToken(externalUserId, token) {
      const s = await readState();
      const connection = s.connection && s.connection.externalUserId.startsWith('ilink:')
        ? { ...s.connection, externalUserId }
        : s.connection;
      await writeState({
        ...s,
        connection,
        ilink: { ...s.ilink, contextTokens: { ...s.ilink.contextTokens, [externalUserId]: token } },
      });
    },

    async getIlinkSendTarget() {
      const s = await readState();
      if (!s.connection) return null;

      const connectedToken = s.ilink.contextTokens[s.connection.externalUserId];
      if (connectedToken) {
        return { externalUserId: s.connection.externalUserId, contextToken: connectedToken };
      }

      const [externalUserId, contextToken] = Object.entries(s.ilink.contextTokens).find(([, value]) => Boolean(value)) ?? [];
      if (!externalUserId || !contextToken) return null;
      return { externalUserId, contextToken };
    },

    async setIlinkPollerEnabled(enabled) {
      const s = await readState();
      await writeState({ ...s, ilink: { ...s.ilink, pollerEnabled: enabled } });
    },
    async isIlinkPollerEnabled() { return (await readState()).ilink.pollerEnabled; },

    async getPendingSessionAction(externalUserId) {
      const s = await readState();
      return s.users[externalUserId]?.pendingSessionAction ?? null;
    },

    async setPendingSessionAction(externalUserId, action) {
      const s = await readState();
      const existing = s.users[externalUserId] ?? { route: { ...DEFAULT_ROUTE }, activeChatSessionId: null, pendingSessionAction: null };
      await writeState({ ...s, users: { ...s.users, [externalUserId]: { ...existing, pendingSessionAction: action } } });
    },

    async disconnect() {
      const s = await readState();
      await writeState({
        ...s,
        connection: null,
        setupSession: null,
        ilink: {
          qrcode: null,
          qrUrl: null,
          botToken: null,
          pollCursor: null,
          contextTokens: {},
          pollerEnabled: false,
        },
      });
    },
  };
}
