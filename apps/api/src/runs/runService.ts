import type { AgentRun, ReferencedChatSnippet, ReferencedFile, RunEvent, RunSource } from '@viwork/shared';

export type CreateRunInput = {
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
  prompt: string;
  model?: string;
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  source?: RunSource;
};

export type RunService = {
  createRun(input: CreateRunInput): Promise<{ run: AgentRun; events?: RunEvent[] }>;
};
