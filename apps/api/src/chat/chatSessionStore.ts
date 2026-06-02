import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage, ChatSession, ChatSessionKind } from '@viwork/shared';

const INTERRUPTED_ASSISTANT_MESSAGE = '回复未完成，可能是服务重启或连接中断。可以发送“继续”让创作助手接着聊。';

type ChatSessionState = {
  sessions: ChatSession[];
};

export type ChatSessionStore = {
  listProjectSessions(projectId: string, options?: { includeArchived?: boolean; kind?: ChatSessionKind }): Promise<ChatSession[]>;
  listTemporarySessions(options?: { includeArchived?: boolean; kind?: ChatSessionKind }): Promise<ChatSession[]>;
  getSession(sessionId: string): Promise<ChatSession | undefined>;
  createSession(projectId: string, options?: { kind?: ChatSessionKind; title?: string }): Promise<ChatSession>;
  archiveSession(sessionId: string): Promise<ChatSession | undefined>;
  restoreSession(sessionId: string): Promise<ChatSession | undefined>;
  updateSession(sessionId: string, input: { codexThreadId?: string | null; title?: string }): Promise<ChatSession | undefined>;
  appendMessage(sessionId: string, message: ChatMessage): Promise<ChatSession | undefined>;
  updateMessage(sessionId: string, messageId: string, message: ChatMessage): Promise<ChatSession | undefined>;
};

export function createChatSessionStore(statePath: string): ChatSessionStore {
  let stateQueue: Promise<unknown> = Promise.resolve();

  function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = stateQueue.then(operation, operation);
    stateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readState(): Promise<ChatSessionState> {
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<ChatSessionState>;
      return {
        sessions: Array.isArray(parsed.sessions)
          ? parsed.sessions.filter(isChatSession).map(normalizeStoredChatSession)
          : [],
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { sessions: [] };
      }
      throw error;
    }
  }

  async function writeState(state: ChatSessionState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      await rename(tempPath, statePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async function updateSessionById(sessionId: string, update: (session: ChatSession) => ChatSession): Promise<ChatSession | undefined> {
    return withStateLock(async () => {
      const state = await readState();
      let updatedSession: ChatSession | undefined;
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }
        updatedSession = update(session);
        return updatedSession;
      });
      if (!updatedSession) {
        return undefined;
      }
      await writeState({ sessions });
      return updatedSession;
    });
  }

  return {
    async listProjectSessions(projectId, options = {}) {
      return withStateLock(async () => {
        const state = await readState();
        return state.sessions
          .filter((session) => session.projectId === projectId)
          .filter((session) => !options.kind || getSessionKind(session) === options.kind)
          .filter((session) => options.includeArchived || !session.archivedAt)
          .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt))
          .map(normalizeChatSessionForHistory);
      });
    },

    async listTemporarySessions(options = {}) {
      return withStateLock(async () => {
        const state = await readState();
        return state.sessions
          .filter((session) => isTemporaryProjectId(session.projectId))
          .filter((session) => !options.kind || getSessionKind(session) === options.kind)
          .filter((session) => options.includeArchived || !session.archivedAt)
          .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt))
          .map(normalizeChatSessionForHistory);
      });
    },

    async getSession(sessionId) {
      return withStateLock(async () => {
        const state = await readState();
        const session = state.sessions.find((item) => item.id === sessionId);
        return session ? normalizeChatSessionForHistory(session) : undefined;
      });
    },

    async createSession(projectId, options = {}) {
      return withStateLock(async () => {
        const state = await readState();
        const now = new Date().toISOString();
        const session: ChatSession = {
          id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          projectId,
          kind: options.kind ?? 'assistant',
          codexThreadId: null,
          title: options.title ?? '新会话',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          messages: [],
        };
        await writeState({ sessions: [session, ...state.sessions] });
        return session;
      });
    },

    async archiveSession(sessionId) {
      const archivedAt = new Date().toISOString();
      return updateSessionById(sessionId, (session) => ({ ...session, archivedAt, updatedAt: archivedAt }));
    },

    async restoreSession(sessionId) {
      return updateSessionById(sessionId, (session) => ({ ...session, archivedAt: null, updatedAt: new Date().toISOString() }));
    },

    async updateSession(sessionId, input) {
      return updateSessionById(sessionId, (session) => ({
        ...session,
        ...(input.codexThreadId !== undefined ? { codexThreadId: input.codexThreadId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        updatedAt: new Date().toISOString(),
      }));
    },

    async appendMessage(sessionId, message) {
      return updateSessionById(sessionId, (session) => {
        const title = session.messages.length === 0 && message.role === 'user' ? message.content.slice(0, 24) : session.title;
        return {
          ...session,
          title: title || session.title,
          updatedAt: message.createdAt,
          messages: [...session.messages, normalizeChatMessage(message)],
        };
      });
    },

    async updateMessage(sessionId, messageId, message) {
      return updateSessionById(sessionId, (session) => ({
        ...session,
        updatedAt: new Date().toISOString(),
        messages: session.messages.map((currentMessage) =>
          currentMessage.id === messageId ? normalizeChatMessage(message) : currentMessage,
        ),
      }));
    },
  };
}

function isTemporaryProjectId(projectId: string): boolean {
  return projectId.startsWith('temp-');
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    referencedFiles: Array.isArray(message.referencedFiles) ? message.referencedFiles : [],
    referencedSnippets: Array.isArray(message.referencedSnippets) ? message.referencedSnippets : [],
    streamEvents: Array.isArray(message.streamEvents) ? message.streamEvents : [],
  };
}

function normalizeHistoryChatMessage(message: ChatMessage): ChatMessage {
  const normalized = {
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    referencedFiles: Array.isArray(message.referencedFiles) ? message.referencedFiles : [],
    referencedSnippets: Array.isArray(message.referencedSnippets) ? message.referencedSnippets : [],
    streamEvents: Array.isArray(message.streamEvents) ? message.streamEvents : [],
  };

  if (normalized.role !== 'assistant' || normalized.status !== 'running') {
    return normalized;
  }

  const runEnd = findLastRunEndEvent(normalized.streamEvents);
  if (runEnd?.status === 'success') {
    return { ...normalized, status: 'success' };
  }
  if (runEnd?.status === 'error' || runEnd?.status === 'cancelled') {
    return {
      ...normalized,
      status: 'error',
      content: normalized.content || (runEnd.errorMessage ? `运行失败：${runEnd.errorMessage}` : INTERRUPTED_ASSISTANT_MESSAGE),
    };
  }

  return {
    ...normalized,
    status: 'error',
    content: normalized.content || INTERRUPTED_ASSISTANT_MESSAGE,
  };
}

function normalizeStoredChatSession(session: ChatSession): ChatSession {
  return {
    ...session,
    kind: getSessionKind(session),
    messages: session.messages.map(normalizeChatMessage),
  };
}

function normalizeChatSessionForHistory(session: ChatSession): ChatSession {
  return {
    ...session,
    kind: getSessionKind(session),
    messages: session.messages.map(normalizeHistoryChatMessage).filter((message) => !isStaleEmptyAssistantPlaceholder(message)),
  };
}

function getSessionKind(session: Partial<ChatSession>): ChatSessionKind {
  return session.kind === 'image' ? 'image' : 'assistant';
}

function isStaleEmptyAssistantPlaceholder(message: ChatMessage): boolean {
  if ((message.attachments?.length ?? 0) > 0) {
    return false;
  }
  if (message.role !== 'assistant') {
    return false;
  }
  if ((message.streamEvents?.length ?? 0) > 0 || (message.events?.length ?? 0) > 0) {
    return false;
  }
  const content = message.content.trim();
  return content === '' || content === INTERRUPTED_ASSISTANT_MESSAGE;
}

function findLastRunEndEvent(events: ChatMessage['streamEvents']): { status: string; errorMessage?: string | null } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as Partial<{ type: unknown; status: unknown; errorMessage: unknown }>;
    if (event.type !== 'run.end' || typeof event.status !== 'string') {
      continue;
    }
    return {
      status: event.status,
      errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : null,
    };
  }
  return null;
}

function isChatSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const session = value as Partial<ChatSession>;
  return (
    typeof session.id === 'string' &&
    typeof session.projectId === 'string' &&
    typeof session.title === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.updatedAt === 'string' &&
    Array.isArray(session.messages)
  );
}

function timestampFromIso(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
