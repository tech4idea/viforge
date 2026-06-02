import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@viwork/shared';

import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { createMastraRunService, __mastraRunServiceTest } from './mastraRunService';
import { createRunBus, type RunBus } from './runBus';

let root: string;
let store: WorkspaceStore;
let bus: RunBus;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-mastra-run-service-'));
  store = createWorkspaceStore(root);
  bus = createRunBus();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mastra run service', () => {
  it('streams text, tool lifecycle events, and workspace file changes through RunBus', async () => {
    const project = await store.createProject({ name: 'Mastra Writers' });
    await store.writeGlobalWorkspaceFile('Agent 配置/AGENTS.md', '# viwork system agent\n');
    let capturedPrompt = '';
    let capturedThread: unknown = null;
    let writeTool: ReturnType<typeof __mastraRunServiceTest.createWorkspaceTools>['write_workspace_file'] | null = null;

    const { run } = await createMastraRunService(store, bus, {
      createAgent({ tools }) {
        writeTool = tools.write_workspace_file;
        return {
          async stream(prompt, options) {
            capturedPrompt = prompt;
            capturedThread = options.memory;
            const toolResult = await tools.write_workspace_file.execute?.({
              path: '02 改编方案/第1集/单集改编方案.md',
              content: '# 单集改编方案\n\n第一集聚焦原著开端的人物选择。',
            }, {} as never);
            return {
              fullStream: asyncGenerator([
                { type: 'text-delta', payload: { text: '已完成改编方案初稿。' } },
                {
                  type: 'tool-call',
                  payload: {
                    toolCallId: 'tool_1',
                    toolName: 'write_workspace_file',
                    args: { path: '02 改编方案/第1集/单集改编方案.md' },
                  },
                },
                {
                  type: 'tool-result',
                  payload: { toolCallId: 'tool_1', toolName: 'write_workspace_file', result: toolResult },
                },
              ]),
            };
          },
        };
      },
    }).createRun({
      projectId: project.id,
      sessionId: 'session-1',
      prompt: '把原著第一章改编成第一集方案',
      referencedSnippets: [{
        id: 'snippet-1',
        messageId: 'message-1',
        role: 'assistant',
        label: '脑暴片段',
        text: '第一章、人物选择、结尾钩子',
        createdAt: '2026-06-02T00:00:00.000Z',
      }],
    });

    const events = await collectUntilEnd(bus, run.id);

    expect(writeTool).toBeTruthy();
    expect(capturedPrompt).toContain('# 小说改编剧本创作请求');
    expect(capturedPrompt).toContain('第一章、人物选择、结尾钩子');
    expect(capturedThread).toEqual({ thread: 'session-1', resource: project.id });
    await expect(store.readWorkspaceFile(project.id, '02 改编方案/第1集/单集改编方案.md')).resolves.toMatchObject({
      content: expect.stringContaining('第一集聚焦原著开端的人物选择'),
    });
    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'thread.started',
      'file.changed',
      'text.delta',
      'tool_use.start',
      'tool_use.delta',
      'tool_use.delta',
      'tool_use.end',
      'run.end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', status: 'success' });
  });
});

async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function collectUntilEnd(bus: RunBus, runId: string): Promise<StreamEvent[]> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    let unsubscribe: (() => void) | null = null;
    unsubscribe = bus.subscribe(runId, (event) => {
      events.push(event);
      if (event.type === 'run.end') {
        unsubscribe?.();
        resolve(events);
      }
    });
  });
}
