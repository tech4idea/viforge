import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
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
        XDG_CACHE_HOME: '/tmp/codex-home/.cache',
        UV_CACHE_DIR: '/tmp/codex-home/.cache/uv',
        PIP_CACHE_DIR: '/tmp/codex-home/.cache/pip',
        NPM_CONFIG_CACHE: '/tmp/codex-home/.cache/npm',
        npm_config_cache: '/tmp/codex-home/.cache/npm',
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
    await store.writeGlobalWorkspaceFile('Agent 配置/config.toml', '[viwork]\nmax_revision_rounds = 7\n');
    await store.writeGlobalWorkspaceFile('Agent 配置/auth.json', '{"OPENAI_API_KEY":"test"}\n');
    await store.writeGlobalWorkspaceFile('Agent 配置/installation_id', 'installation-1\n');
    await store.createGlobalWorkspaceFolder('Agent 配置/skills/gemini-api-dev');
    await store.writeGlobalWorkspaceFile(
      'Agent 配置/skills/gemini-api-dev/SKILL.md',
      [
        '---',
        'name: gemini-api-dev',
        'description: Use this skill for Gemini API application development.',
        '---',
        '',
        '# gemini-api-dev',
      ].join('\n'),
    );
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
      referencedSnippets: [{
        id: 'snippet-1',
        messageId: 'message-1',
        role: 'assistant',
        label: '创作助手片段',
        text: '商场失物招领处',
        createdAt: '2026-05-18T00:00:00.000Z',
      }],
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(capturedThreadOptions).toMatchObject({
      workingDirectory: store.getProjectRoot(project.id),
      additionalDirectories: [
        path.join(root, '_global', '知识库'),
        path.join(root, '_global', '模板库'),
      ],
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      modelReasoningEffort: 'medium',
    });
    await expect(readFile(path.join(root, '.codex-home', run.id, 'AGENTS.md'), 'utf8')).resolves.toEqual(
      expect.stringContaining('viwork system agent'),
    );
    const storySkill = await readFile(path.join(root, '.codex-home', run.id, 'skills', 'story-agent', 'SKILL.md'), 'utf8');
    expect(storySkill).toContain('name: "story-agent"');
    expect(storySkill).toContain('# story-agent');
    const geminiSkill = await readFile(path.join(root, '.codex-home', run.id, 'skills', 'gemini-api-dev', 'SKILL.md'), 'utf8');
    expect(geminiSkill).toContain('name: gemini-api-dev');
    await expect(readFile(path.join(root, '.codex-home', run.id, 'auth.json'), 'utf8')).resolves.toBe('{"OPENAI_API_KEY":"test"}\n');
    await expect(readFile(path.join(root, '.codex-home', run.id, 'installation_id'), 'utf8')).resolves.toBe('installation-1\n');
    expect(capturedInput).toEqual(expect.stringContaining('# 情景剧创作请求'));
    expect(capturedInput).toEqual(expect.stringContaining('当前全局返工上限：7 轮'));
    expect(capturedInput).toEqual(expect.stringContaining('"maxIterations":7'));
    expect(capturedInput).toEqual(expect.stringContaining('脑暴请求只使用 brainstorm-agent 正常交流'));
    expect(capturedInput).toEqual(expect.stringContaining('不调用 reviewer-agent，不输出轮次，不进入返工闭环'));
    expect(capturedInput).toEqual(expect.stringContaining('不要只宣布“路由完成”或“准备调用某 agent”'));
    expect(capturedInput).toEqual(expect.stringContaining('不要调用 update_plan'));
    expect(capturedInput).toEqual(expect.stringContaining('必须在同一次回复里直接给出对应 agent 的实质内容'));
    expect(capturedInput).toEqual(expect.stringContaining('# 当前附加可用 Skills'));
    expect(capturedInput).toEqual(expect.stringContaining('gemini-api-dev: Use this skill for Gemini API application development.'));
    expect(capturedInput).toEqual(expect.stringContaining('# 已引用聊天片段'));
    expect(capturedInput).toEqual(expect.stringContaining('商场失物招领处'));
    expect(run.status).toBe('running');
    expect(events.map((event) => event.type)).toEqual([
      'run.start',
      'thread.started',
      'thinking.delta',
      'agent.step.start',
      'text.delta',
      'tool_use.start',
      'tool_use.delta',
      'tool_use.delta',
      'tool_use.end',
      'file.changed',
      'run.end',
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.step.start', agentId: 'story-agent', phase: '故事创作', iteration: 1, maxIterations: 5 }),
    ]));
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

    await expect(readFile(globalConfigPath, 'utf8')).resolves.toEqual(`${sourceConfig}\n[viwork]\nmax_revision_rounds = 5\n`);
    await expect(readFile(externalConfigPath, 'utf8')).resolves.toEqual(`${sourceConfig}\n[viwork]\nmax_revision_rounds = 5\n`);
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

  it('publishes interrupted Codex stream errors without rewriting the CLI message', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            throw new Error('Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)');
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
      prompt: '讨论新的情景剧设定选题',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'error',
      errorMessage: 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)',
    });
  });

  it('publishes the raw exec failure instead of an earlier generic stream error', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: interruptedThenFailedEvents() };
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
      prompt: '讨论新的情景剧设定选题',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events.filter((event) => event.type === 'run.end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'error',
      errorMessage: 'Codex Exec exited with code 1: failed to load skill skills/story-agent/SKILL.md: missing YAML frontmatter delimited by ---',
    });
  });

  it('surfaces the upstream turn.failed reason when the CLI stderr is just the "Reading ... from stdin..." boilerplate', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: turnFailedWith401ThenGenericExecError() };
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
      prompt: '重新把世界观设定捋一下',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events.filter((event) => event.type === 'run.end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'error',
      errorMessage: 'unexpected status 401 Unauthorized: Invalid or disabled API key, url: https://api.yukeon.top/v1/responses',
    });
  });

  it('treats a final response failure after a successful tool call as completed work', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: successfulToolThenFinalResponseFailedEvents() };
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
      prompt: '把设定里的标题改短',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use.end', status: 'succeeded' }),
      expect.objectContaining({ type: 'text.delta', delta: expect.stringContaining('Codex CLI 最终回复失败') }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'success',
      errorMessage: null,
    });
  });

  it('recovers final response failures when a failed tool is followed by a successful retry', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: failedToolThenSuccessfulRetryThenFinalResponseFailedEvents() };
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
      prompt: '先尝试一种方式，失败后换一种方式修改文件',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use.end', toolCallId: 'cmd_failed', status: 'failed' }),
      expect.objectContaining({ type: 'tool_use.end', toolCallId: 'cmd_retry', status: 'succeeded' }),
      expect.objectContaining({ type: 'text.delta', delta: expect.stringContaining('Codex CLI 最终回复失败') }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'success',
      errorMessage: null,
    });
  });

  it('does not recover final response failures after a failed command', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: failedToolThenFinalResponseFailedEvents() };
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
      prompt: '执行一个会失败的修改',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use.end', status: 'failed' }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'error',
      errorMessage: expect.stringContaining('missing.md: No such file or directory'),
    });
  });

  it('does not recover final response failures when a patch command exits zero but skips the patch', async () => {
    const project = await store.createProject({ name: 'Codex Writers' });
    const codex = {
      startThread() {
        return {
          id: 'thread_1',
          async runStreamed() {
            return { events: skippedPatchThenFinalResponseFailedEvents() };
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
      prompt: '应用一个会跳过的补丁',
    });
    const events = await collectUntilEnd(bus, run.id);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use.end', status: 'failed' }),
    ]));
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      status: 'error',
      errorMessage: expect.stringContaining("can't find file to patch"),
    });
  });

  it('embeds the viwork system agent protocol directly in the Codex prompt', async () => {
    const project = await store.createProject({ name: 'Protocol Writers' });
    await store.writeGlobalWorkspaceFile(
      'Agent 配置/AGENTS.md',
      [
        '# viwork system agent',
        '',
        '## 默认流程',
        '1. 脑暴只走 brainstorm-agent。',
        '2. 写故事走 story-agent。',
        '3. 写剧本走 screenwriter-agent。',
        '4. 审稿走 reviewer-agent。',
      ].join('\n'),
    );
    await store.writeGlobalWorkspaceFile('Agent 配置/config.toml', '[viwork]\nmax_revision_rounds = 3\n');
    await store.createGlobalWorkspaceFolder('Agent 配置/skills/story-agent');
    await store.writeGlobalWorkspaceFile(
      'Agent 配置/skills/story-agent/SKILL.md',
      ['---', 'name: story-agent', 'description: 写故事', '---', '', '# story-agent'].join('\n'),
    );

    let capturedInput: Input | null = null;
    const codex = {
      startThread() {
        return {
          id: 'thread_proto',
          async runStreamed(input: Input) {
            capturedInput = input;
            return { events: fakeCodexEvents() };
          },
          async run() { throw new Error('not used'); },
        };
      },
      resumeThread() { throw new Error('not used'); },
    };
    const { run } = await createCodexRunService(store, bus, { codex, reasoningEffort: 'medium' }).createRun({
      projectId: project.id,
      prompt: '写一段校园情景剧。',
    });
    await collectUntilEnd(bus, run.id);
    expect(run.status).toBe('running');
    expect(capturedInput).toBeTruthy();
    const input = capturedInput as unknown as string;
    // The AGENTS.md content is embedded verbatim so the agent has the protocol even
    // if Codex cannot or will not read $CODEX_HOME/AGENTS.md.
    expect(input).toContain('## viwork 多 agent 工作协议（直接来自 _global/Agent 配置/AGENTS.md）');
    expect(input).toContain('脑暴只走 brainstorm-agent。');
    expect(input).toContain('## viwork 调用约束');
    expect(input).toContain('当前全局返工上限：3 轮');
    expect(input).toContain('"maxIterations":3');
  });

  it('sanitizes the Codex HOME config.toml and disables bundled + user skills', async () => {
    const project = await store.createProject({ name: 'Isolation Writers' });
    await store.writeGlobalWorkspaceFile(
      'Agent 配置/config.toml',
      [
        'model_provider = "custom"',
        'model = "ds/test-model"',
        'model_reasoning_effort = "high"',
        'disable_response_storage = true',
        '',
        '[model_providers.custom]',
        'name = "custom"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'base_url = "https://example.invalid/v1"',
        '',
        '[projects."/home/wbo/project/inferxgate"]',
        'trust_level = "trusted"',
        '',
        '[projects."/home/wbo/project/viwork"]',
        'trust_level = "trusted"',
        '',
        '[tui.model_availability_nux]',
        '"gpt-5.5" = 4',
        '',
        '[viwork]',
        'max_revision_rounds = 4',
        '',
      ].join('\n'),
    );
    await store.writeGlobalWorkspaceFile('Agent 配置/AGENTS.md', '# viwork system agent\n');
    await store.createGlobalWorkspaceFolder('Agent 配置/skills/story-agent');
    await store.writeGlobalWorkspaceFile(
      'Agent 配置/skills/story-agent/SKILL.md',
      ['---', 'name: story-agent', 'description: 写故事', '---', '', '# story-agent'].join('\n'),
    );

    const codex = {
      startThread() {
        return {
          id: 'thread_iso',
          async runStreamed() { return { events: fakeCodexEvents() }; },
          async run() { throw new Error('not used'); },
        };
      },
      resumeThread() { throw new Error('not used'); },
    };
    const { run } = await createCodexRunService(store, bus, { codex, reasoningEffort: 'medium' }).createRun({
      projectId: project.id,
      prompt: '脑暴一个校园情景剧',
    });
    await collectUntilEnd(bus, run.id);

    const codexHome = path.join(root, '.codex-home', run.id);
    const configToml = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    // expose the actual generated config for debugging when running locally
    if (process.env['VIWORK_DEBUG_CODEX_CONFIG']) {
      // eslint-disable-next-line no-console
      console.log('--- viwork generated config.toml ---\n' + configToml);
    }
    expect(configToml).toContain('model_provider = "custom"');
    expect(configToml).toContain('model = "ds/test-model"');
    expect(configToml).toContain('[model_providers.custom]');
    expect(configToml).toContain('base_url = "https://example.invalid/v1"');
    expect(configToml).toContain('[viwork]');
    expect(configToml).toContain('max_revision_rounds = 4');
    // unrelated developer-machine entries must NOT leak into a viwork session
    expect(configToml).not.toContain('[projects."/home/wbo/project/inferxgate"]');
    expect(configToml).not.toContain('[tui.model_availability_nux]');
    // Codex bundled skills must be disabled so the system skills (imagegen, openai-docs,
    // plugin-creator, skill-creator, skill-installer) do not pollute the prompt.
    expect(configToml).toContain('[skills.bundled]');
    expect(configToml).toContain('enabled = false');
    // Any user-level Codex skills present on the host should be explicitly disabled.
    let disabledAnyUserSkill = false;
    for (const root of [path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.agents', 'skills')]) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          expect(configToml).toContain(`name = ${JSON.stringify(entry.name)}`);
          disabledAnyUserSkill = true;
        }
      }
    }
    if (disabledAnyUserSkill) {
      expect(configToml).toContain('[[skills.config]]');
    }
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
  yield {
    type: 'item.updated',
    item: {
      id: 'msg_1',
      type: 'agent_message',
      text: '第一句\n```json\n{"type":"agent.step.start","agentId":"story-agent","phase":"故事创作","iteration":1,"maxIterations":5}\n```',
    },
  };
  yield {
    type: 'item.updated',
    item: {
      id: 'msg_1',
      type: 'agent_message',
      text: '第一句\n```json\n{"type":"agent.step.start","agentId":"story-agent","phase":"故事创作","iteration":1,"maxIterations":5}\n```',
    },
  };
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

async function* interruptedThenFailedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)' };
  throw new Error('Codex Exec exited with code 1: failed to load skill skills/story-agent/SKILL.md: missing YAML frontmatter delimited by ---');
}

async function* turnFailedWith401ThenGenericExecError(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'turn.started' };
  yield { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized: Invalid or disabled API key, url: https://api.yukeon.top/v1/responses)' };
  yield { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Invalid or disabled API key, url: https://api.yukeon.top/v1/responses' } };
  throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n');
}

async function* successfulToolThenFinalResponseFailedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_1',
      type: 'command_execution',
      command: 'sed -i s/old/new/ setting.md',
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    },
  };
  yield { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)' };
  yield { type: 'turn.failed', error: { message: 'stream disconnected before completion: response.failed event received' } };
  throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n');
}

async function* failedToolThenFinalResponseFailedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_1',
      type: 'command_execution',
      command: 'sed -i s/old/new/ missing.md',
      aggregated_output: 'missing.md: No such file or directory',
      exit_code: 2,
      status: 'completed',
    },
  };
  yield { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)' };
  throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n');
}

async function* failedToolThenSuccessfulRetryThenFinalResponseFailedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_failed',
      type: 'command_execution',
      command: 'apply_patch < bad.patch',
      aggregated_output: "can't find file to patch at input line 3\nSkipping patch.\n",
      exit_code: 1,
      status: 'completed',
    },
  };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_retry',
      type: 'command_execution',
      command: 'perl -0pi -e s/old/new/ setting.md',
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    },
  };
  yield { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)' };
  yield { type: 'turn.failed', error: { message: 'stream disconnected before completion: response.failed event received' } };
  throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n');
}

async function* skippedPatchThenFinalResponseFailedEvents(): AsyncGenerator<ThreadEvent> {
  yield { type: 'thread.started', thread_id: 'thread_1' };
  yield { type: 'turn.started' };
  yield {
    type: 'item.completed',
    item: {
      id: 'cmd_1',
      type: 'command_execution',
      command: 'patch -p0 < change.patch',
      aggregated_output: "can't find file to patch at input line 3\nSkipping patch.\n1 out of 1 hunk ignored\n",
      exit_code: 0,
      status: 'completed',
    },
  };
  yield { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: response.failed event received)' };
  throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...\n');
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
