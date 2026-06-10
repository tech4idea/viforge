import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage, ChatSession, ChatSessionKind, ChatSessionModelConfig, StreamEvent } from '@viwork/shared';

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
  deleteSession(sessionId: string): Promise<{ deleted: true; existed: boolean }>;
  updateSession(sessionId: string, input: { title?: string; modelConfig?: ChatSessionModelConfig }): Promise<ChatSession | undefined>;
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
          modelConfig: {},
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

    async deleteSession(sessionId) {
      return withStateLock(async () => {
        const state = await readState();
        const existed = state.sessions.some((session) => session.id === sessionId);
        if (!existed) {
          return { deleted: true, existed: false };
        }
        const sessions = state.sessions.filter((session) => session.id !== sessionId);
        await writeState({ sessions });
        return { deleted: true, existed: true };
      });
    },

    async updateSession(sessionId, input) {
      return updateSessionById(sessionId, (session) => ({
        ...session,
        ...(input.modelConfig !== undefined ? { modelConfig: normalizeModelConfig({ ...session.modelConfig, ...input.modelConfig }) } : {}),
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

const MAX_STREAM_EVENTS = 100;
const TOOL_OUTPUT_EVENT_SIZE_LIMIT = 2000;
const STREAM_EVENT_TYPES_TO_KEEP = new Set(['text.delta', 'tool_use.start', 'tool_use.end', 'tool_use.delta', 'file.changed', 'image.generated', 'run.end']);

function truncateStreamEvents(events: unknown[]): unknown[] {
  if (!Array.isArray(events) || events.length <= MAX_STREAM_EVENTS) {
    return Array.isArray(events) ? events : [];
  }
  // Keep first 20 (initial context) + last 80 (recent events) = 100 total
  const first = events.slice(0, 20);
  const last = events.slice(-80);
  return [...first, ...last];
}

function sanitizeStreamEventData(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event;
  const e = event as Record<string, unknown>;

  if (e.type === 'tool_use.delta' && e.stream === 'output' && typeof e.delta === 'string' && e.delta.length > TOOL_OUTPUT_EVENT_SIZE_LIMIT) {
    return { ...e, delta: '[工具输出数据已省略]' };
  }

  if (e.type === 'tool_use.end' && typeof e.outputText === 'string' && e.outputText.length > TOOL_OUTPUT_EVENT_SIZE_LIMIT) {
    return { ...e, outputText: '[工具输出数据已省略]' };
  }

  return event;
}

function sanitizeStreamEvents(events: unknown[]): unknown[] {
  return events.map(sanitizeStreamEventData);
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    referencedFiles: Array.isArray(message.referencedFiles) ? message.referencedFiles : [],
    referencedSnippets: Array.isArray(message.referencedSnippets) ? message.referencedSnippets : [],
    streamEvents: sanitizeStreamEvents(truncateStreamEvents(message.streamEvents)) as StreamEvent[],
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
    modelConfig: normalizeModelConfig(session.modelConfig),
    messages: session.messages.map(normalizeChatMessage),
  };
}

function normalizeChatSessionForHistory(session: ChatSession): ChatSession {
  return {
    ...session,
    kind: getSessionKind(session),
    modelConfig: normalizeModelConfig(session.modelConfig),
    messages: session.messages.map(normalizeHistoryChatMessage).filter((message) => !isStaleEmptyAssistantPlaceholder(message)),
  };
}

function normalizeModelConfig(config: unknown): ChatSessionModelConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const raw = config as Partial<Record<keyof ChatSessionModelConfig, unknown>>;
  return {
    ...(typeof raw.chatModel === 'string' && raw.chatModel.trim() ? { chatModel: raw.chatModel.trim() } : {}),
    ...(typeof raw.imageModel === 'string' && raw.imageModel.trim() ? { imageModel: raw.imageModel.trim() } : {}),
    ...(isImageAspectRatio(raw.imageAspectRatio) ? { imageAspectRatio: raw.imageAspectRatio } : {}),
    ...(isImageThinkingLevel(raw.imageThinkingLevel) ? { imageThinkingLevel: raw.imageThinkingLevel } : {}),
    ...(typeof raw.imageCount === 'number' && Number.isInteger(raw.imageCount) && raw.imageCount >= 1 && raw.imageCount <= 4 ? { imageCount: raw.imageCount } : {}),
  };
}

function isImageAspectRatio(value: unknown): value is ChatSessionModelConfig['imageAspectRatio'] {
  return value === '1:1' || value === '3:4' || value === '4:3' || value === '9:16' || value === '16:9';
}

function isImageThinkingLevel(value: unknown): value is ChatSessionModelConfig['imageThinkingLevel'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high';
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
