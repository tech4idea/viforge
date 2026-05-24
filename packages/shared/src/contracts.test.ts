import { describe, expect, it } from 'vitest';
import { DEFAULT_SITCOM_FILES, GLOBAL_WORKSPACE_TREE, createDefaultWorkspaceFiles } from './templates';
import type { AgentRun, RunEvent, StreamEvent } from './contracts';

describe('shared contracts', () => {
  it('defines the default sitcom workspace files', () => {
    expect(DEFAULT_SITCOM_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([
      '01 基本设定/项目简介.md',
      '01 基本设定/人物设定.md',
      '02 故事/整季故事线.md',
      '02 故事/01 第一集/单集大纲.md',
      '03 剧本/01 第一集/第一版剧本.md',
      '04 分镜脚本/01 第一集/01 第一分镜/分镜脚本.md',
      '05 视频/01 第一集/01 第一分镜/视频生成提示词.md',
      '06 产物/01 第一集/素材清单.md',
    ]));
    expect(createDefaultWorkspaceFiles('都市轻喜剧')).toContainEqual(
      expect.objectContaining({
        path: '01 基本设定/项目简介.md',
        content: expect.stringContaining('都市轻喜剧'),
      }),
    );
  });

  it('defines the global creation workspace tree', () => {
    expect(GLOBAL_WORKSPACE_TREE).toEqual([
      expect.objectContaining({
        name: 'Agent 配置',
        type: 'directory',
        children: expect.arrayContaining([
          expect.objectContaining({ name: 'AGENTS.md', type: 'file' }),
          expect.objectContaining({
            name: 'skills',
            type: 'directory',
            children: expect.arrayContaining([
              expect.objectContaining({ name: '人物设定技能', type: 'directory' }),
              expect.objectContaining({ name: '视频生成提示词技能', type: 'directory' }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ name: '知识库', type: 'directory' }),
      expect.objectContaining({ name: '模板库', type: 'directory' }),
    ]);
  });

  it('allows the minimal run event sequence', () => {
    const events: RunEvent[] = [
      { type: 'run.start', runId: 'run_1' },
      { type: 'text.delta', runId: 'run_1', text: '开始创作' },
      { type: 'file.changed', runId: 'run_1', path: 'script.md', change: 'modified' },
      { type: 'run.end', runId: 'run_1', status: 'success' },
    ];

    expect(events.at(-1)).toEqual({ type: 'run.end', runId: 'run_1', status: 'success' });
  });

  it('captures referenced files on runs', () => {
    const run: AgentRun = {
      id: 'run_1',
      projectId: 'project_1',
      source: 'web',
      prompt: '改写第一幕',
      referencedFiles: [{ path: 'script.md', label: 'script.md' }],
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(run.referencedFiles[0]).toEqual({ path: 'script.md', label: 'script.md' });
  });

  it('allows streaming text, thinking, tool and terminal events', () => {
    const events: StreamEvent[] = [
      { type: 'run.start', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.000Z' },
      { type: 'thread.started', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.000Z', threadId: 'thread_1' },
      { type: 'thinking.delta', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.001Z', sequence: 1, delta: '分析人物动机' },
      { type: 'tool_use.start', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.002Z', toolCallId: 'tool_1', toolName: 'Read' },
      {
        type: 'tool_use.delta',
        runId: 'run_1',
        emittedAt: '2026-01-01T00:00:00.003Z',
        toolCallId: 'tool_1',
        stream: 'input',
        delta: '{"file_path":"script.md"}',
        sequence: 1,
      },
      {
        type: 'tool_use.end',
        runId: 'run_1',
        emittedAt: '2026-01-01T00:00:00.004Z',
        toolCallId: 'tool_1',
        status: 'succeeded',
        outputText: '第一幕内容',
        errorMessage: null,
      },
      { type: 'text.delta', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.005Z', sequence: 1, delta: '这里是一版对白。' },
      { type: 'run.end', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.006Z', status: 'success', errorMessage: null },
    ];

    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'thread.started',
      'thinking.delta',
      'tool_use.start',
      'tool_use.delta',
      'tool_use.end',
      'text.delta',
      'run.end',
    ]);
  });
});
