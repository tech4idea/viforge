import type { AgentRun, ReferencedChatSnippet, ReferencedFile, RunEvent, RunImageGenerationOptions, RunSource } from '@viforge/shared';

export type WechatSendContext = {
  sendText(input: { text: string }): Promise<void>;
  sendFile(input: { bytes: Buffer; name: string; mimeType: string }): Promise<void>;
};

export type CreateRunInput = {
  runId?: string;
  inputSnapshotId?: string;
  projectId: string;
  sessionId?: string;
  prompt: string;
  model?: string;
  imageGeneration?: RunImageGenerationOptions;
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  source?: RunSource;
  traceId?: string;
  wechat?: WechatSendContext;
};

export type RunService = {
  createRun(input: CreateRunInput): Promise<{ run: AgentRun; events?: RunEvent[] }>;
};
