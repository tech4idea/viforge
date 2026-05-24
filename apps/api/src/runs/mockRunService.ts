import { createHash } from 'node:crypto';

import type { AgentRun, ReferencedFile, RunEvent, RunSource } from '@viwork/shared';

import type { WorkspaceStore } from '../storage/workspaceStore';

export type CreateRunInput = {
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
  prompt: string;
  referencedFiles?: ReferencedFile[];
  source?: RunSource;
};

export type MockRunService = {
  createRun(input: CreateRunInput): Promise<{ run: AgentRun; events: RunEvent[] }>;
};

export function createMockRunService(store: WorkspaceStore): MockRunService {
  return {
    async createRun(input) {
      const project = await store.getProject(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const source = input.source ?? 'web';
      const runId = createDeterministicRunId(input.projectId, input.prompt, source);
      const timestamp = createDeterministicTimestamp(runId);
      const run: AgentRun = {
        id: runId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        codexThreadId: input.codexThreadId,
        prompt: input.prompt,
        source,
        referencedFiles: input.referencedFiles ?? [],
        status: 'success',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const outputPath = `06 产物/01 第一集/${run.id}.md`;
      const outputContent = `# Mock Agent Run\n\nPrompt: ${input.prompt}\n${
        run.referencedFiles.length > 0
          ? `\nReferenced files:\n${run.referencedFiles.map((file) => `- ${file.label} (${file.path})`).join('\n')}\n`
          : ''
      }`;

      await store.writeWorkspaceFile(input.projectId, outputPath, outputContent);

      const events: RunEvent[] = [
        { type: 'run.start', runId: run.id },
        {
          type: 'text.delta',
          runId: run.id,
          text:
            run.referencedFiles.length > 0
              ? `Received prompt: ${input.prompt}\n\n参考文件：${run.referencedFiles.map((file) => file.label).join('、')}`
              : `Received prompt: ${input.prompt}`,
        },
        {
          type: 'tool.use',
          runId: run.id,
          name: 'writeWorkspaceFile',
          input: { path: outputPath, referencedFiles: run.referencedFiles },
        },
        { type: 'file.changed', runId: run.id, path: outputPath, change: 'created' },
        { type: 'run.end', runId: run.id, status: 'success' },
      ];

      return { run, events };
    },
  };
}

function createDeterministicRunId(projectId: string, prompt: string, source: RunSource): string {
  return `run_${createHash('sha256').update(JSON.stringify({ projectId, prompt, source })).digest('hex').slice(0, 16)}`;
}

function createDeterministicTimestamp(runId: string): string {
  const offset = Number.parseInt(runId.slice(-8), 16) % 86_400_000;
  return new Date(Date.UTC(2026, 0, 1) + offset).toISOString();
}
