import type {
  AigcHubModelListResponse,
  AigcHubModelMetadata,
  AgentRun,
  AgentTraceEvent,
  BehaviorRule,
  ChatMessage,
  ChatMessageAttachment,
  ChatSession,
  GeminiImageAspectRatio,
  GeminiImageModel,
  GeminiImageThinkingLevel,
  ImageGenerationReferenceImage,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProductProfile,
  Project,
  ReferencedChatSnippet,
  ReferencedFile,
  RunEvent,
  StreamEvent,
  TheaterSkill,
  WechatSetupSession,
  WechatStatus,
  ChatSessionModelConfig,
  WorkspaceEntry,
  WorkspaceFile,
} from '@viwork/shared';

export type {
  AigcHubModelListResponse,
  AigcHubModelMetadata,
  AgentRun,
  AgentTraceEvent,
  BehaviorRule,
  ChatMessage,
  ChatMessageAttachment,
  ChatSession,
  GeminiImageAspectRatio,
  GeminiImageModel,
  GeminiImageThinkingLevel,
  ImageGenerationReferenceImage,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProductProfile,
  Project,
  ReferencedChatSnippet,
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
  getProductProfile(): Promise<ProductProfile>;
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
  deleteProject(projectId: string): Promise<{ deleted: true }>;
  getProject(projectId: string): Promise<Project>;
  updateProject(projectId: string, input: UpdateProjectInput): Promise<Project>;
  listWorkspaceEntries(projectId: string): Promise<WorkspaceEntry[]>;
  readWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFile>;
  writeWorkspaceFile(projectId: string, path: string, content: string): Promise<WorkspaceFile>;
  createFolder(projectId: string, path: string): Promise<WorkspaceEntry>;
  createFile(projectId: string, path: string, content: string): Promise<WorkspaceFile>;
  createAsset(projectId: string, input: CreateAssetInput): Promise<WorkspaceEntry>;
  moveEntry(projectId: string, sourcePath: string, targetPath: string): Promise<WorkspaceEntry>;
  deleteEntry(projectId: string, path: string): Promise<{ deleted: true }>;
  listChatSessions(projectId: string, options?: { includeArchived?: boolean; kind?: ChatSession['kind'] }): Promise<ChatSession[]>;
  listTemporaryChatSessions(options?: { includeArchived?: boolean; kind?: ChatSession['kind'] }): Promise<ChatSession[]>;
  createChatSession(projectId: string, input?: { kind?: ChatSession['kind']; title?: string }): Promise<ChatSession>;
  createTemporaryChatSession(input?: { kind?: ChatSession['kind']; title?: string }): Promise<ChatSession>;
  updateChatSession(sessionId: string, input: { title?: string; modelConfig?: ChatSessionModelConfig }): Promise<ChatSession>;
  archiveChatSession(sessionId: string): Promise<ChatSession>;
  restoreChatSession(sessionId: string): Promise<ChatSession>;
  deleteChatSession(sessionId: string): Promise<{ deleted: true }>;
  appendChatMessage(sessionId: string, message: ChatMessage): Promise<ChatSession>;
  updateChatMessage(sessionId: string, messageId: string, message: ChatMessage): Promise<ChatSession>;
  listAigcHubModels(): Promise<AigcHubModelListResponse>;
  createImageGeneration(input: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  createRun(input: CreateRunInput): Promise<CreateRunResponse>;
  cancelRun(runId: string): Promise<void>;
  streamRunEvents(runId: string, handlers: StreamRunHandlers): () => void;
  listSkills(): Promise<TheaterSkill[]>;
  createSkill(input: CreateSkillInput): Promise<TheaterSkill>;
  updateSkill(slug: string, input: { enabled: boolean }): Promise<TheaterSkill>;
  getBehaviorRules(): Promise<BehaviorRule[]>;
  saveBehaviorRules(rules: BehaviorRule[]): Promise<BehaviorRule[]>;
  getWechatStatus(): Promise<WechatStatus>;
  createWechatSetupSession(): Promise<WechatSetupSession>;
  completeWechatSetupSession(sessionId: string, input: { displayName: string; externalUserId: string }): Promise<WechatStatus>;
  disconnectWechat(): Promise<{ disconnected: boolean }>;
  sendWechatNotify(status: 'success' | 'error'): Promise<{ sent: boolean; reason?: string }>;
};


export type CreateProjectInput = {
  name: string;
  description?: string;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
};

export type CreateRunInput = {
  projectId: string;
  sessionId?: string;
  prompt: string;
  model?: string;
  imageGeneration?: {
    model?: string;
    aspectRatio?: GeminiImageAspectRatio;
    thinkingLevel?: GeminiImageThinkingLevel;
    count?: number;
  };
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
};

export type CreateRunResponse = {
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

export function resolveApiUrl(path: string): string {
  return `${trimTrailingSlashes(defaultBaseUrl)}${path}`;
}

export const apiClient = createApiClient();

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetcher = options.fetch ?? fetch;
  const baseUrl = trimTrailingSlashes(options.baseUrl ?? defaultBaseUrl);

  return {
    getProductProfile: () => request<ProductProfile>(fetcher, baseUrl, '/api/product-profile'),
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
    deleteProject: (projectId) =>
      request<{ deleted: true }>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}`, {
        method: 'DELETE',
      }),
    getProject: (projectId) => request<Project>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}`),
    updateProject: (projectId, input) =>
      request<Project>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
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
        withQuery(`/api/projects/${encodePathSegment(projectId)}/chat-sessions`, {
          includeArchived: options.includeArchived ? 'true' : undefined,
          kind: options.kind,
        }),
      ),
    listTemporaryChatSessions: (options = {}) =>
      request<ChatSession[]>(
        fetcher,
        baseUrl,
        withQuery('/api/temporary-chat-sessions', {
          includeArchived: options.includeArchived ? 'true' : undefined,
          kind: options.kind,
        }),
      ),
    createChatSession: (projectId, input = {}) =>
      request<ChatSession>(fetcher, baseUrl, `/api/projects/${encodePathSegment(projectId)}/chat-sessions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createTemporaryChatSession: (input = {}) =>
      request<ChatSession>(fetcher, baseUrl, '/api/temporary-chat-sessions', {
        method: 'POST',
        body: JSON.stringify(input),
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
    deleteChatSession: (sessionId) =>
      request<{ deleted: true }>(fetcher, baseUrl, `/api/chat-sessions/${encodePathSegment(sessionId)}`, {
        method: 'DELETE',
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
    listAigcHubModels: () => request<AigcHubModelListResponse>(fetcher, baseUrl, '/api/aigc-hub/models'),
    createImageGeneration: (input) =>
      request<ImageGenerationResponse>(fetcher, baseUrl, '/api/image-generations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createRun: (input) =>
      request<CreateRunResponse>(fetcher, baseUrl, '/api/runs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    cancelRun: (runId) =>
      request(fetcher, baseUrl, `/api/runs/${encodePathSegment(runId)}/cancel`, { method: 'POST' }).then(() => {}),
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
    getBehaviorRules: () =>
      request<{ rules: BehaviorRule[] }>(fetcher, baseUrl, '/api/behavior-rules').then((res) => res.rules),
    saveBehaviorRules: (rules) =>
      request<{ rules: BehaviorRule[] }>(fetcher, baseUrl, '/api/behavior-rules', {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      }).then((res) => res.rules),
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
    disconnectWechat: () =>
      request<{ disconnected: boolean }>(fetcher, baseUrl, '/api/wechat/connection', {
        method: 'DELETE',
      }),
    sendWechatNotify: (status) =>
      request<{ sent: boolean }>(fetcher, baseUrl, '/api/wechat/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
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

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) {
      params.set(key, value);
    }
  });
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
