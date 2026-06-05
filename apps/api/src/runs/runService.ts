import type { AgentRun, ReferencedChatSnippet, ReferencedFile, RunEvent, RunImageGenerationOptions, RunSource } from '@viwork/shared';
import type { WechatIlinkClient } from '../wechat/wechatIlinkClient';

export type WechatSendContext = {
  ilinkClient: WechatIlinkClient;
  userId: string;
  contextToken: string;
};

export type CreateRunInput = {
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
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
