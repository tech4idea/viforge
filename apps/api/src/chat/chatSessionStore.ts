import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage, ChatSession } from '@viwork/shared';

type ChatSessionState = {
  sessions: ChatSession[];
};

export type ChatSessionStore = {
  listProjectSessions(projectId: string, options?: { includeArchived?: boolean }): Promise<ChatSession[]>;
  createSession(projectId: string): Promise<ChatSession>;
  archiveSession(sessionId: string): Promise<ChatSession | undefined>;
  restoreSession(sessionId: string): Promise<ChatSession | undefined>;
  updateSession(sessionId: string, input: { codexThreadId?: string | null; title?: string }): Promise<ChatSession | undefined>;
  appendMessage(sessionId: string, message: ChatMessage): Promise<ChatSession | undefined>;
  updateMessage(sessionId: string, messageId: string, message: ChatMessage): Promise<ChatSession | undefined>;
};

export function createChatSessionStore(statePath: string): ChatSessionStore {
  async function readState(): Promise<ChatSessionState> {
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<ChatSessionState>;
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isChatSession) : [] };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { sessions: [] };
      }
      throw error;
    }
  }

  async function writeState(state: ChatSessionState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async function updateSessionById(sessionId: string, update: (session: ChatSession) => ChatSession): Promise<ChatSession | undefined> {
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
  }

  return {
    async listProjectSessions(projectId, options = {}) {
      const state = await readState();
      return state.sessions
        .filter((session) => session.projectId === projectId)
        .filter((session) => options.includeArchived || !session.archivedAt)
        .sort((a, b) => timestampFromIso(b.updatedAt) - timestampFromIso(a.updatedAt));
    },

    async createSession(projectId) {
      const state = await readState();
      const now = new Date().toISOString();
      const session: ChatSession = {
        id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        projectId,
        codexThreadId: null,
        title: '新会话',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        messages: [],
      };
      await writeState({ sessions: [session, ...state.sessions] });
      return session;
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

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    referencedFiles: Array.isArray(message.referencedFiles) ? message.referencedFiles : [],
    streamEvents: Array.isArray(message.streamEvents) ? message.streamEvents : [],
  };
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
