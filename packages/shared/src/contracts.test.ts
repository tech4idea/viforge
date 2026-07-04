import { describe, expect, it } from 'vitest';
import { PRODUCT_PROFILES, createDefaultWorkspaceFilesForProfile, resolveProductProfile } from './productProfiles';
import { DEFAULT_SITCOM_FILES, GLOBAL_WORKSPACE_TREE, createDefaultWorkspaceFiles } from './templates';
import type { AgentRun, RunEvent, StreamEvent } from './contracts';

describe('shared contracts', () => {
  it('defines the default novel adaptation workspace files', () => {
    expect(DEFAULT_SITCOM_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([
      '01 原著资料/项目简介.md',
      '01 原著资料/原著梗概.md',
      '01 原著资料/人物关系.md',
      '02 改编方案/全季改编方案.md',
      '02 改编方案/01 第一集/单集改编方案.md',
      '03 剧本/01 第一集/剧本.md',
    ]));
    expect(DEFAULT_SITCOM_FILES.map((file) => file.path)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('04 分镜脚本'),
      expect.stringContaining('05 视频'),
      expect.stringContaining('06 产物'),
    ]));
    expect(createDefaultWorkspaceFiles('长夜')).toContainEqual(
      expect.objectContaining({
        path: '01 原著资料/项目简介.md',
        content: expect.stringContaining('长夜'),
      }),
    );
  });

  it('defines the global creation workspace tree', () => {
    expect(GLOBAL_WORKSPACE_TREE).toEqual([
      expect.objectContaining({
        name: 'Agent 配置',
        type: 'directory',
        children: [
          expect.objectContaining({ name: 'config.toml', type: 'file' }),
        ],
      }),
      expect.objectContaining({ name: '知识库', type: 'directory' }),
      expect.objectContaining({ name: '模板库', type: 'directory' }),
    ]);
  });

  it('defines selectable product profiles for workspace initialization and UI labels', () => {
    for (const profile of Object.values(PRODUCT_PROFILES)) {
      expect(profile.defaultProjectName).toEqual(expect.any(String));
      expect(profile.workspaceSections.global.title).toBeTruthy();
      expect(profile.workspaceSections.project.title).toBeTruthy();
      expect(profile.defaultAgentSkillNames).toEqual(expect.arrayContaining(['brainstorm-agent', 'reviewer-agent']));
      expect(profile.agentLabels['reviewer-agent']).toBeTruthy();
      expect(profile.artifactPaths.script).toBeTruthy();
      expect(createDefaultWorkspaceFilesForProfile(profile, '长夜')).toContainEqual(
        expect.objectContaining({
          path: profile.projectFiles[0]?.path,
          content: expect.stringContaining('长夜'),
        }),
      );
    }

    expect(resolveProductProfile('sitcom')).toMatchObject({ id: 'sitcom', documentTitle: 'viwork 情景剧创作工作台' });
    expect(resolveProductProfile('sitcom').defaultAgentSkillNames).toEqual(expect.arrayContaining([
      'character-agent',
      'continuity-agent',
      'story-agent',
    ]));
    expect(resolveProductProfile('study')).toMatchObject({ id: 'study', documentTitle: 'viwork 日常学习工作台' });
    expect(resolveProductProfile('study').defaultAgentSkillNames).toEqual(expect.arrayContaining([
      'outline-agent',
      'knowledge-search-agent',
      'knowledge-organizer-agent',
    ]));
    expect(resolveProductProfile('unknown')).toMatchObject({ id: 'novel-adaptation' });
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
      referencedSnippets: [{
        id: 'snippet-1',
        messageId: 'message-1',
        role: 'assistant',
        label: '创作助手 片段',
        text: '商场失物招领处',
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(run.referencedFiles[0]).toEqual({ path: 'script.md', label: 'script.md' });
    expect(run.referencedSnippets?.[0].text).toBe('商场失物招领处');
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
      { type: 'agent.step.start', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.005Z', agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5 },
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
      'agent.step.start',
      'run.end',
    ]);
  });
});
