export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  temporary?: boolean;
  git?: ProjectGitConfig;
};

export type WorkspaceEntry = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  updatedAt?: string;
  mimeType?: string;
};

export type WorkspaceFile = {
  path: string;
  content: string;
};

export type ReferencedFile = {
  path: string;
  label: string;
};

export type ReferencedChatSnippet = {
  id: string;
  messageId: string;
  role: 'user' | 'assistant';
  label: string;
  text: string;
  createdAt: string;
};

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export type RunSource = 'web' | 'schedule' | 'qq' | 'wechat';

export type AgentRun = {
  id: string;
  projectId: string;
  sessionId?: string;
  source: RunSource;
  prompt: string;
  model?: string;
  imageGeneration?: RunImageGenerationOptions;
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachments?: ChatMessageAttachment[];
  events?: RunEvent[];
  referencedFiles: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  streamEvents: StreamEvent[];
  status?: 'idle' | 'running' | 'success' | 'error';
};

export type ChatMessageAttachment = {
  id: string;
  kind: 'reference-image' | 'generated-image';
  name: string;
  path: string;
  projectId: string;
  mimeType: string;
  prompt?: string;
  model?: string;
  aspectRatio?: GeminiImageAspectRatio;
  thinkingLevel?: GeminiImageThinkingLevel;
  createdAt: string;
};

export type ChatSessionKind = 'assistant' | 'image';

export type ChatSessionModelConfig = {
  chatModel?: string;
  imageModel?: string;
  imageAspectRatio?: GeminiImageAspectRatio;
  imageThinkingLevel?: GeminiImageThinkingLevel;
  imageCount?: number;
};

export type ChatSession = {
  id: string;
  projectId: string;
  kind?: ChatSessionKind;
  modelConfig?: ChatSessionModelConfig;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  messages: ChatMessage[];
};

export type GeminiImageModel = 'gemini-3.1-flash-image-preview' | 'gemini-3-pro-image-preview';

export type GeminiImageAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

export type GeminiImageThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ImageGenerationReferenceImage = {
  name: string;
  mimeType: string;
  contentBase64: string;
};

export type ImageGenerationRequest = {
  sessionId?: string;
  prompt: string;
  model?: string;
  aspectRatio: GeminiImageAspectRatio;
  thinkingLevel?: GeminiImageThinkingLevel;
  count: number;
  referenceImages?: ImageGenerationReferenceImage[];
};

export type RunImageGenerationOptions = {
  model?: string;
};

export type ImageGenerationResponse = {
  session: ChatSession;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export type AigcHubModelMetadata = {
  id: string;
  label: string;
  provider?: string;
  capabilities: string[];
};

export type AigcHubModelListResponse = {
  configured: boolean;
  models: AigcHubModelMetadata[];
  error?: string;
};

export type RunEvent =
  | { type: 'run.start'; runId: string }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'text.message'; runId: string; text: string }
  | { type: 'agent.step.start'; runId: string; agentId: string; phase: string; iteration: number; maxIterations?: number }
  | {
    type: 'agent.step.end';
    runId: string;
    agentId: string;
    phase: string;
    iteration: number;
    maxIterations?: number;
    status: Exclude<AgentTraceStatus, 'running' | 'stopped'>;
  }
  | { type: 'agent.review.reject'; runId: string; targetAgentId: string; iteration: number; maxIterations?: number; reasons: string[] }
  | { type: 'agent.workflow.end'; runId: string; status: 'passed' | 'stopped'; outputPath?: string }
  | { type: 'tool.use'; runId: string; name: string; input?: unknown }
  | { type: 'tool.result'; runId: string; name: string; output?: unknown }
  | { type: 'file.changed'; runId: string; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'run.end'; runId: string; status: Exclude<RunStatus, 'pending' | 'running'>; error?: string };

export type StreamRunStatus = 'success' | 'error' | 'cancelled';

export type StreamToolStatus = 'running' | 'succeeded' | 'failed';

export type AgentTraceStatus = 'running' | 'passed' | 'rejected' | 'failed' | 'stopped';

export type AgentTraceEvent =
  | { type: 'agent.step.start'; runId: string; emittedAt: string; agentId: string; phase: string; iteration: number; maxIterations?: number }
  | {
    type: 'agent.step.end';
    runId: string;
    emittedAt: string;
    agentId: string;
    phase: string;
    iteration: number;
    maxIterations?: number;
    status: Exclude<AgentTraceStatus, 'running' | 'stopped'>;
  }
  | { type: 'agent.review.reject'; runId: string; emittedAt: string; targetAgentId: string; iteration: number; maxIterations?: number; reasons: string[] }
  | { type: 'agent.workflow.end'; runId: string; emittedAt: string; status: 'passed' | 'stopped'; outputPath?: string };

export type StreamEvent =
  | { type: 'run.start'; runId: string; emittedAt: string }
  | { type: 'thread.started'; runId: string; emittedAt: string; threadId: string }
  | { type: 'text.delta'; runId: string; emittedAt: string; delta: string; sequence: number }
  | { type: 'thinking.delta'; runId: string; emittedAt: string; delta: string; sequence: number }
  | { type: 'thinking.end'; runId: string; emittedAt: string; text: string; sequence: number }
  | { type: 'tool_use.start'; runId: string; emittedAt: string; toolCallId: string; toolName: string }
  | {
    type: 'tool_use.delta';
    runId: string;
    emittedAt: string;
    toolCallId: string;
    stream: 'input' | 'output';
    delta: string;
    sequence: number;
  }
  | {
    type: 'tool_use.end';
    runId: string;
    emittedAt: string;
    toolCallId: string;
    status: StreamToolStatus;
    outputText: string | null;
    errorMessage: string | null;
  }
  | { type: 'file.changed'; runId: string; emittedAt: string; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'image.generated'; runId: string; emittedAt: string; attachment: ChatMessageAttachment }
  | { type: 'wechat.file_sent'; runId: string; emittedAt: string; path: string; mimeType: string }
  | { type: 'choice.request'; runId: string; emittedAt: string; question: string; options: [string, ...string[]] }
  | { type: 'run.end'; runId: string; emittedAt: string; status: StreamRunStatus; errorMessage: string | null }
  | AgentTraceEvent;

export type TheaterSkill = {
  slug: string;
  title: string;
  description: string;
  prompt: string;
  enabled: boolean;
  scope: 'system' | 'user';
  createdAt: string;
  updatedAt: string;
  source?: 'plaza' | 'agent-config';
  mutable?: boolean;
  location?: string;
};

export type BehaviorRule = {
  id: string;
  label: string;
  content: string;
  enabled: boolean;
  builtIn: boolean;
};

export type WechatStatus = {
  state: 'not_connected' | 'pending' | 'connected';
  connection: {
    displayName: string;
    externalUserId: string;
    connectedAt: string;
  } | null;
  setupSession: WechatSetupSession | null;
  ilink: {
    configured: boolean;
    baseUrl?: string | null;
    accountId?: string | null;
    routeTag?: string | null;
    allowFrom?: string[];
    pollerRunning?: boolean;
    lastPollAt?: string | null;
    pollError?: string | null;
  };
};

export type WechatSetupSession = {
  sessionId: string;
  status: 'qr_ready' | 'connected' | 'cancelled';
  qrUrl: string;
  expiresAt: string;
};

export type ProjectGitConfig = {
  remoteUrl: string;
  accessToken?: string;
  lastSyncAt?: string;
  lastCommitHash?: string;
  branch?: string;
};

export type GlobalGitConfig = {
  accessToken: string;
  defaultBranch?: string;
};

export type GitSyncResult = {
  success: boolean;
  commitHash?: string;
  filesChanged: number;
  message: string;
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
};

export type ProjectGitStatus = {
  initialized: boolean;
  hasRemote: boolean;
  changedFiles: number;
  lastSyncAt?: string;
  lastCommitHash?: string;
  branch?: string;
};
