import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@viwork/shared';
import type { ThreadOptions, TurnOptions, Input, ThreadEvent } from '@openai/codex-sdk';

import { createWorkspaceStore, type WorkspaceStore } from '../storage/workspaceStore';
import { buildCodexEnv, createCodexRunService, resolveCodexPathOverride } from './codexRunService';
import { createRunBus, type RunBus } from './runBus';

let root: string;
let store: WorkspaceStore;
let bus: RunBus;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-codex-run-service-'));
  store = createWorkspaceStore(root);
  bus = createRunBus();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('codex run service', () => {
  it('maps the available proxy token into CODEX_API_KEY for the Codex CLI', () => {
    const previousCodexApiKey = process.env.CODEX_API_KEY;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      delete process.env.CODEX_API_KEY;
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = 'sk-proxy-token';

      expect(buildCodexEnv('/tmp/codex-home')).toMatchObject({
        CODEX_HOME: '/tmp/codex-home',
        CODEX_API_KEY: 'sk-proxy-token',
      });
    } finally {
      restoreEnv('CODEX_API_KEY', previousCodexApiKey);
      restoreEnv('OPENAI_API_KEY', previousOpenAiApiKey);
      restoreEnv('ANTHROPIC_AUTH_TOKEN', previousAnthropicAuthToken);
    }
  });

  it('resolves the Codex CLI from CODEX_PATH or PATH', async () => {
    const previousCodexPath = process.env.CODEX_PATH;
    const previousPath = process.env.PATH;
    const binPath = path.join(root, 'bin');
    const codexPath = path.join(binPath, 'codex');

    try {
      await mkdir(binPath, { recursive: true });
      await writeFile(codexPath, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
      await chmod(codexPath, 0o755);

      process.env.CODEX_PATH = '/custom/codex';
      await expect(resolveCodexPathOverride()).resolves.toBe('/custom/codex');

      delete process.env.CODEX_PATH;
      process.env.PATH = binPath;
      await expect(resolveCodexPathOverride()).resolves.toBe(codexPath);
    } finally {
      restoreEnv('CODEX_PATH', previousCodexPath);
      restoreEnv('PATH', previousPath);
    }
  });

  it('starts a run and publishes streamed text, reasoning, command, and terminal events', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    await store.writeGlobalWorkspaceFile('Agent 配置/auth.json', '{"OPENAI_API_KEY":"test"}\n');
    await store.writeGlobalWorkspaceFile('Agent 配置/installation_id', 'installation-1\n');
    let capturedThreadOptions: ThreadOptions | null = null;
    let capturedInput: Input | null = null;
    const codex = {
      startThread(options?: ThreadOptions) {
        capturedThreadOptions = options ?? {};
        return {
          id: 'thread_1',
          async runStreamed(input: Input, _turnOptions?: TurnOptions) {
            capturedInput = input;
            return { events: fakeCodexEvents() };
          },
          async run() {
            throw new Error('not used');
          },
        };
      },
      resumeThread() {
        throw new Error('not used');
      },
    };

    const { run } = await createCodexRunService(store, bus, { codex, reasoningEffort: 'medium' }).createRun({
      projectId: project.id,
      prompt: '补写一段对白',
      referencedFiles: [{ path: 'script.md', label: 'script.md' }],
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(capturedThreadOptions).toMatchObject({
      workingDirectory: store.getProjectRoot(project.id),
      additionalDirectories: [
        path.join(root, '_global', '知识库'),
        path.join(root, '_global', '模板库'),
      ],
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      modelReasoningEffort: 'medium',
    });
    await expect(readFile(path.join(root, '.codex-home', run.id, 'AGENTS.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('情景剧创作'),
    );
    await expect(readFile(path.join(root, '.codex-home', run.id, 'skills', '人物设定技能', 'SKILL.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('人物设定技能'),
    );
    await expect(readFile(path.join(root, '.codex-home', run.id, 'auth.json'), 'utf8')).resolves.toBe('{"OPENAI_API_KEY":"test"}\n');
    await expect(readFile(path.join(root, '.codex-home', run.id, 'installation_id'), 'utf8')).resolves.toBe('installation-1\n');
    expect(capturedInput).toEqual(expect.stringContaining('# 情景剧创作请求'));
    expect(run.status).toBe('running');
    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'thread.started',
      'thinking.delta',
      'text.delta',
      'tool_use.start',
      'tool_use.delta',
      'tool_use.delta',
      'tool_use.end',
      'file.changed',
      'run.end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', status: 'success' });
  });

  it('keeps global Agent config immutable when Codex mutates the runtime config', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const sourceConfig = 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n';
    await store.writeGlobalWorkspaceFile('Agent 配置/config.toml', sourceConfig);
    const externalConfigPath = path.join(root, 'external-config.toml');
    const globalConfigPath = path.join(root, '_global', 'Agent 配置', 'config.toml');
    await writeFile(externalConfigPath, sourceConfig, 'utf8');
    await rm(globalConfigPath);
    await symlink(externalConfigPath, globalConfigPath);
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            const [runHomeName] = await readdir(path.join(root, '.codex-home'));
            await writeFile(
              path.join(root, '.codex-home', runHomeName, 'config.toml'),
              `${sourceConfig}\n[projects."/runtime"]\ntrust_level = "trusted"\n`,
              'utf8',
            );
            return { events: fakeCodexEvents() };
          },
          async run() {
            throw new Error('not used');
          },
        };
      },
      resumeThread() {
        throw new Error('not used');
      },
    };

    const { run } = await createCodexRunService(store, bus, { codex, reasoningEffort: 'medium' }).createRun({
      projectId: project.id,
      prompt: '补写一段对白',
    });
    await collectUntilEnd(bus, run.id);

    await expect(readFile(globalConfigPath, 'utf8')).resolves.toEqual(sourceConfig);
    await expect(readFile(externalConfigPath, 'utf8')).resolves.toEqual(sourceConfig);
    await expect(readFile(path.join(root, '.codex-home', run.id, 'config.toml'), 'utf8')).resolves.toContain('[projects."/runtime"]');
  });

  it('resumes the existing Codex thread and reuses the session CODEX_HOME for follow-up turns', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    await store.writeGlobalWorkspaceFile('Agent 配置/config.toml', 'model_provider = "OpenAI"\n');
    let resumedThreadId: string | null = null;
    const codex = {
      startThread() {
        throw new Error('not used');
      },
      resumeThread(id: string, options?: ThreadOptions) {
        resumedThreadId = id;
        expect(options?.workingDirectory).toBe(store.getProjectRoot(project.id));
        return {
          id,
          async runStreamed() {
            return { events: fakeCodexEvents('thread_existing') };
          },
          async run() {
            throw new Error('not used');
          },
        };
      },
    };

    const { run } = await createCodexRunService(store, bus, { codex, reasoningEffort: 'medium' }).createRun({
      projectId: project.id,
      sessionId: 'session-ui-1',
      codexThreadId: 'thread_existing',
      prompt: '继续上一轮',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(resumedThreadId).toBe('thread_existing');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.started', threadId: 'thread_existing' }),
    ]));
    await expect(readFile(path.join(root, '.codex-home', 'session-ui-1', 'config.toml'), 'utf8')).resolves.toContain('model_provider');
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function* fakeCodexEvents(threadId = 'thread_1'): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: threadId };
  yield { type: 'turn.started' };
  yield { type: 'item.updated', item: { id: 'reason_1', type: 'reasoning', text: '分析人物动机' } };
  yield { type: 'item.updated', item: { id: 'msg_1', type: 'agent_message', text: '第一句' } };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_1',
      type: 'command_execution',
      command: 'sed -n 1,40p script.md',
      aggregated_output: '剧本内容',
      exit_code: 0,
      status: 'completed',
    },
  };
  yield {
    type: 'item.completed',
    item: {
      id: 'patch_1',
      type: 'file_change',
      changes: [{ path: 'script.md', kind: 'update' }],
      status: 'completed',
    },
  };
  yield {
    type: 'turn.completed',
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 1,
    },
  };
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
