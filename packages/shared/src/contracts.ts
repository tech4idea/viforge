export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  temporary?: boolean;
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

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export type RunSource = 'web' | 'schedule' | 'qq' | 'wechat';

export type AgentRun = {
  id: string;
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
  source: RunSource;
  prompt: string;
  referencedFiles: ReferencedFile[];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  events?: RunEvent[];
  referencedFiles: ReferencedFile[];
  streamEvents: StreamEvent[];
  status?: 'idle' | 'running' | 'success' | 'error';
};

export type ChatSession = {
  id: string;
  projectId: string;
  codexThreadId?: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  messages: ChatMessage[];
};

export type RunEvent =
  | { type: 'run.start'; runId: string }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'text.message'; runId: string; text: string }
  | { type: 'tool.use'; runId: string; name: string; input?: unknown }
  | { type: 'tool.result'; runId: string; name: string; output?: unknown }
  | { type: 'file.changed'; runId: string; path: string; change: 'created' | 'modified' | 'deleted' }
  | { type: 'run.end'; runId: string; status: Exclude<RunStatus, 'pending' | 'running'>; error?: string };

export type StreamRunStatus = 'success' | 'error' | 'cancelled';

export type StreamToolStatus = 'running' | 'succeeded' | 'failed';

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
  | { type: 'run.end'; runId: string; emittedAt: string; status: StreamRunStatus; errorMessage: string | null };

export type TheaterSkill = {
  slug: string;
  title: string;
  description: string;
  prompt: string;
  enabled: boolean;
  scope: 'system' | 'user';
  createdAt: string;
  updatedAt: string;
};

export type WechatStatus = {
  state: 'not_connected' | 'pending' | 'connected';
  connection: {
    displayName: string;
    externalUserId: string;
    connectedAt: string;
  } | null;
  setupSession: WechatSetupSession | null;
};

export type WechatSetupSession = {
  sessionId: string;
  status: 'qr_ready' | 'connected' | 'cancelled';
  qrUrl: string;
  expiresAt: string;
};
