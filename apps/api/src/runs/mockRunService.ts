import { createHash } from 'node:crypto';

import type { AgentRun, ReferencedChatSnippet, ReferencedFile, RunEvent, RunSource } from '@viwork/shared';

import type { WorkspaceStore } from '../storage/workspaceStore';

export type CreateRunInput = {
  runId?: string;
  inputSnapshotId?: string;
  projectId: string;
  sessionId?: string;
  prompt: string;
  model?: string;
  referencedFiles?: ReferencedFile[];
  referencedSnippets?: ReferencedChatSnippet[];
  source?: RunSource;
  traceId?: string;
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
      const runId = input.runId ?? createDeterministicRunId(input.projectId, input.prompt, source);
      const timestamp = createDeterministicTimestamp(runId);
      const run: AgentRun = {
        id: runId,
        inputSnapshotId: input.inputSnapshotId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        prompt: input.prompt,
        model: input.model,
        source,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        status: 'success',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const outputPath = '02 改编方案/01 第一集/单集改编方案.md';
      const outputContent = `# 01 第一集单集改编方案\n\n## 原著范围\n\n${input.prompt}\n\n## 戏剧任务\n\n这是一次模拟 adaptation-planner-agent 产出的单集改编方案。\n${
        run.referencedFiles.length > 0
          ? `\nReferenced files:\n${run.referencedFiles.map((file) => `- ${file.label} (${file.path})`).join('\n')}\n`
          : ''
      }`;

      await store.writeWorkspaceFile(input.projectId, outputPath, outputContent);

      const events: RunEvent[] = [
        { type: 'run.start', runId: run.id },
        { type: 'agent.step.start', runId: run.id, agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5 },
        {
          type: 'text.delta',
          runId: run.id,
          text:
            run.referencedFiles.length > 0
              ? `Received prompt: ${input.prompt}\n\n参考文件：${run.referencedFiles.map((file) => file.label).join('、')}`
              : `Received prompt: ${input.prompt}`,
        },
        { type: 'agent.step.end', runId: run.id, agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5, status: 'passed' },
        { type: 'agent.step.start', runId: run.id, agentId: 'reviewer-agent', phase: '方案审稿', iteration: 1, maxIterations: 5 },
        { type: 'agent.step.end', runId: run.id, agentId: 'reviewer-agent', phase: '方案审稿', iteration: 1, maxIterations: 5, status: 'passed' },
        {
          type: 'tool.use',
          runId: run.id,
          name: 'writeWorkspaceFile',
          input: { path: outputPath, referencedFiles: run.referencedFiles },
        },
        {
          type: 'tool.input',
          runId: run.id,
          name: 'writeWorkspaceFile',
          inputText: JSON.stringify({ path: outputPath, content: '[content omitted for artifact summary]' }),
        },
        { type: 'file.changed', runId: run.id, path: outputPath, change: 'created' },
        { type: 'agent.workflow.end', runId: run.id, status: 'passed', outputPath },
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
