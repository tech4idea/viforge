import type {
  AgentRun,
  ChatMessage,
  ChatSession,
  Project,
  ReferencedFile,
  RunEvent,
  StreamEvent,
  TheaterSkill,
  WechatSetupSession,
  WechatStatus,
  WorkspaceEntry,
  WorkspaceFile,
} from '@viwork/shared';

export type {
  AgentRun,
  ChatMessage,
  ChatSession,
  Project,
  ReferencedFile,
  RunEvent,
  StreamEvent,
  TheaterSkill,
  WechatSetupSession,
  WechatStatus,
  WorkspaceEntry,
  WorkspaceFile,
} from '@viwork/shared';

export type ApiClient = {
  listGlobalWorkspaceEntries(): Promise<WorkspaceEntry[]>;
  readGlobalWorkspaceFile(path: string): Promise<WorkspaceFile>;
  writeGlobalWorkspaceFile(path: string, content: string): Promise<WorkspaceFile>;
  createGlobalFolder(path: string): Promise<WorkspaceEntry>;
  createGlobalFile(path: string, content: string): Promise<WorkspaceFile>;
  createGlobalAsset(input: CreateAssetInput): Promise<WorkspaceEntry>;
  moveGlobalEntry(sourcePath: string, targetPath: string): Promise<WorkspaceEntry>;
  deleteGlobalEntry(path: string): Promise<{ deleted: true }>;
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  listWorkspaceEntries(projectId: string): Promise<WorkspaceEntry[]>;
  readWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFile>;
  writeWorkspaceFile(projectId: string, path: string, content: string): Promise<WorkspaceFile>;
  createFolder(projectId: string, path: string): Promise<WorkspaceEntry>;
  createFile(projectId: string, path: string, content: string): Promise<WorkspaceFile>;
  createAsset(projectId: string, input: CreateAssetInput): Promise<WorkspaceEntry>;
  moveEntry(projectId: string, sourcePath: string, targetPath: string): Promise<WorkspaceEntry>;
  deleteEntry(projectId: string, path: string): Promise<{ deleted: true }>;
  listChatSessions(projectId: string, options?: { includeArchived?: boolean }): Promise<ChatSession[]>;
  createChatSession(projectId: string): Promise<ChatSession>;
  updateChatSession(sessionId: string, input: { codexThreadId?: string | null; title?: string }): Promise<ChatSession>;
  archiveChatSession(sessionId: string): Promise<ChatSession>;
  restoreChatSession(sessionId: string): Promise<ChatSession>;
  appendChatMessage(sessionId: string, message: ChatMessage): Promise<ChatSession>;
  updateChatMessage(sessionId: string, messageId: string, message: ChatMessage): Promise<ChatSession>;
  createMockRun(input: CreateMockRunInput): Promise<CreateMockRunResponse>;
  streamRunEvents(runId: string, handlers: StreamRunHandlers): () => void;
  listSkills(): Promise<TheaterSkill[]>;
  createSkill(input: CreateSkillInput): Promise<TheaterSkill>;
  updateSkill(slug: string, input: { enabled: boolean }): Promise<TheaterSkill>;
  getWechatStatus(): Promise<WechatStatus>;
  createWechatSetupSession(): Promise<WechatSetupSession>;
  completeWechatSetupSession(sessionId: string, input: { displayName: string; externalUserId: string }): Promise<WechatStatus>;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
};

export type CreateMockRunInput = {
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
  prompt: string;
  referencedFiles?: ReferencedFile[];
};

export type CreateMockRunResponse = {
  run: AgentRun;
  events?: RunEvent[];
};

export type StreamRunHandlers = {
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Error) => void;
};

export type CreateAssetInput = {
  path: string;
  contentBase64: string;
  mimeType?: string;
};

export type CreateSkillInput = {
  title: string;
  description: string;
  prompt: string;
};

type ApiClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
};

type ImportMetaWithViteEnv = ImportMeta & {
  env?: {
    VITE_API_BASE_URL?: string;
  };
};

const defaultBaseUrl = (import.meta as ImportMetaWithViteEnv).env?.VITE_API_BASE_URL ?? '';

export const apiClient = createApiClient();

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetcher = options.fetch ?? fetch;
  const baseUrl = trimTrailingSlashes(options.baseUrl ?? defaultBaseUrl);

  return {
    listGlobalWorkspaceEntries: () => request<WorkspaceEntry[]>(fetcher, baseUrl, '/api/global/files'),
    readGlobalWorkspaceFile: (path) =>
      request<WorkspaceFile>(fetcher, baseUrl, `/api/global/files/${encodeWorkspacePath(path)}`),
    writeGlobalWorkspaceFile: (path, content) =>
      request<WorkspaceFile>(fetcher, baseUrl, `/api/global/files/${encodeWorkspacePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    createGlobalFolder: (path) =>
      request<WorkspaceEntry>(fetcher, baseUrl, '/api/global/folders', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    createGlobalFile: (path, content) =>
      request<WorkspaceFile>(fetcher, baseUrl, '/api/global/files', {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      }),
    createGlobalAsset: (input) =>
      request<WorkspaceEntry>(fetcher, baseUrl, '/api/global/assets', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    moveGlobalEntry: (sourcePath, targetPath) =>
      request<WorkspaceEntry>(fetcher, baseUrl, `/api/global/files/${encodeWorkspacePath(sourcePath)}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ targetPath }),
      }),
    deleteGlobalEntry: (path) =>
      request<{ deleted: true }>(fetcher, baseUrl, `/api/global/files/${encodeWorkspacePath(path)}`, {
        method: 'DELETE',
      }),
    listProjects: () => request<Project[]>(fetcher, baseUrl, '/api/projects'),
    createProject: (input) =>
      request<Project>(fetcher, baseUrl, '/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getProject: (projectId) => request<Project>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}`),
    listWorkspaceEntries: (projectId) =>
      request<WorkspaceEntry[]>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files`),
    readWorkspaceFile: (projectId, path) =>
      request<WorkspaceFile>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files/${encodeWorkspacePath(path)}`),
    writeWorkspaceFile: (projectId, path, content) =>
      request<WorkspaceFile>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files/${encodeWorkspacePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    createFolder: (projectId, path) =>
      request<WorkspaceEntry>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/folders`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),
    createFile: (projectId, path, content) =>
      request<WorkspaceFile>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      }),
    createAsset: (projectId, input) =>
      request<WorkspaceEntry>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/assets`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    moveEntry: (projectId, sourcePath, targetPath) =>
      request<WorkspaceEntry>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files/${encodeWorkspacePath(sourcePath)}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ targetPath }),
      }),
    deleteEntry: (projectId, path) =>
      request<{ deleted: true }>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/files/${encodeWorkspacePath(path)}`, {
        method: 'DELETE',
      }),
    listChatSessions: (projectId, options = {}) =>
      request<ChatSession[]>(
        fetcher,
        baseUrl,
        `/api/projects/${encodePathSegment(projectId)}/chat-sessions${options.includeArchived ? '?includeArchived=true' : ''}`,
      ),
    createChatSession: (projectId) =>
      request<ChatSession>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/chat-sessions`, {
        method: 'POST',
      }),
    updateChatSession: (sessionId, input) =>
      request<ChatSession>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    archiveChatSession: (sessionId) =>
      request<ChatSession>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}/archive`, {
        method: 'POST',
      }),
    restoreChatSession: (sessionId) =>
      request<ChatSession>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}/restore`, {
        method: 'POST',
      }),
    appendChatMessage: (sessionId, message) =>
      request<ChatSession>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify(message),
      }),
    updateChatMessage: (sessionId, messageId, message) =>
      request<ChatSession>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}/messages/${encodePathSegment(messageId)}`, {
        method: 'PUT',
        body: JSON.stringify(message),
      }),
    createMockRun: (input) =>
      request<CreateMockRunResponse>(fetcher, baseUrl, '/api/runs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    streamRunEvents: (runId, handlers) => {
      const source = new EventSource(`${baseUrl}/api/runs/${encodePathSegment(runId)}/events`);
      let closedAfterTerminalEvent = false;
      source.onmessage = (event) => {
        try {
          const streamEvent = JSON.parse(event.data) as StreamEvent;
          handlers.onEvent(streamEvent);
          if (streamEvent.type === 'run.end') {
            closedAfterTerminalEvent = true;
            source.close();
          }
        } catch (error) {
          handlers.onError?.(error instanceof Error ? error : new Error('Invalid stream event'));
        }
      };
      source.onerror = () => {
        if (closedAfterTerminalEvent) {
          source.close();
          return;
        }
        handlers.onError?.(new Error('Run event stream interrupted'));
        source.close();
      };
      return () => source.close();
    },
    listSkills: () => request<TheaterSkill[]>(fetcher, baseUrl, '/api/skills'),
    createSkill: (input) =>
      request<TheaterSkill>(fetcher, baseUrl, '/api/skills', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateSkill: (slug, input) =>
      request<TheaterSkill>(fetcher, baseUrl, `/api/skills/${encodePathSegment(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    getWechatStatus: () => request<WechatStatus>(fetcher, baseUrl, '/api/wechat/status'),
    createWechatSetupSession: () =>
      request<WechatSetupSession>(fetcher, baseUrl, '/api/wechat/setup-sessions', {
        method: 'POST',
      }),
    completeWechatSetupSession: (sessionId, input) =>
      request<WechatStatus>(fetcher, baseUrl, `/api/wechat/setup-sessions/${encodePathSegment(sessionId)}/complete`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  };
}

async function request<T>(fetcher: typeof fetch, baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetcher(`${baseUrl}${path}`, {
    ...init,
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with status ${response.status}`;

  try {
    const body = (await response.json()) as unknown;

    if (isErrorResponse(body)) {
      return body.error;
    }
  } catch {
    // Use fallback below.
  }

  return fallback;
}

function isErrorResponse(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string';
}

function encodeWorkspacePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodePathSegment)
    .join('/');
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
