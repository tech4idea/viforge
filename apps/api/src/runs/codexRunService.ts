import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Codex, type Input, type ThreadEvent, type ThreadItem, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { AgentRun, ReferencedFile, RunEvent, RunSource, StreamEvent } from '@viwork/shared';

import type { WorkspaceStore } from '../storage/workspaceStore';
import type { RunBus } from './runBus';

export type CreateRunInput = {
  projectId: string;
  sessionId?: string;
  codexThreadId?: string;
  prompt: string;
  referencedFiles?: ReferencedFile[];
  source?: RunSource;
};

export type RunService = {
  createRun(input: CreateRunInput): Promise<{ run: AgentRun; events?: RunEvent[] }>;
};

type CodexThread = {
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
};

type CodexRunOptions = {
  codex?: CodexClient;
  codexPathOverride?: string;
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

type ItemState = {
  textByItemId: Map<string, string>;
  thinkingByItemId: Map<string, { sequence: number; text: string }>;
  toolInputByItemId: Map<string, string>;
  toolOutputByItemId: Map<string, string>;
  toolStarted: Set<string>;
  textSequence: number;
  toolSequence: number;
  thinkingSequence: number;
};

export function createCodexRunService(
  store: WorkspaceStore,
  bus: RunBus,
  options: CodexRunOptions = {},
): RunService {
  return {
    async createRun(input) {
      const project = await store.getProject(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const timestamp = new Date().toISOString();
      const run: AgentRun = {
        id: `run_${randomUUID()}`,
        projectId: input.projectId,
        sessionId: input.sessionId,
        codexThreadId: input.codexThreadId,
        prompt: input.prompt,
        referencedFiles: input.referencedFiles ?? [],
        source: input.source ?? 'web',
        status: 'running',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      void executeCodexRun({
        bus,
        codex: options.codex,
        codexPathOverride: options.codexPathOverride,
        input,
        model: options.model,
        reasoningEffort: options.reasoningEffort ?? 'medium',
        run,
        store,
      });

      return { run };
    },
  };
}

async function executeCodexRun({
  bus,
  codex,
  codexPathOverride,
  input,
  model,
  reasoningEffort,
  run,
  store,
}: {
  bus: RunBus;
  codex?: CodexClient;
  codexPathOverride?: string;
  input: CreateRunInput;
  model?: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  run: AgentRun;
  store: WorkspaceStore;
}): Promise<void> {
  const state: ItemState = {
    textByItemId: new Map(),
    thinkingByItemId: new Map(),
    toolInputByItemId: new Map(),
    toolOutputByItemId: new Map(),
    toolStarted: new Set(),
    textSequence: 0,
    toolSequence: 0,
    thinkingSequence: 0,
  };
  const abortController = new AbortController();
  const publish = (event: StreamEvent) => bus.publish(event);
  const emittedAt = () => new Date().toISOString();

  publish({ type: 'run.start', runId: run.id, emittedAt: emittedAt() });

  try {
    const prompt = await buildCodexPrompt(store, input);
    const codexHome = await prepareCodexHome(store, input.sessionId ?? run.id);
    const runtimeCodex = codex ?? new Codex({
      codexPathOverride: codexPathOverride ?? process.env.CODEX_PATH ?? '/opt/homebrew/Cellar/node/23.11.0/bin/codex',
      env: buildCodexEnv(codexHome),
    });
    const threadOptions: ThreadOptions = {
      workingDirectory: store.getProjectRoot(input.projectId),
      additionalDirectories: await getGlobalResourceDirectories(store),
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      ...(model ? { model } : {}),
      modelReasoningEffort: reasoningEffort,
    };
    const thread = input.codexThreadId
      ? runtimeCodex.resumeThread(input.codexThreadId, threadOptions)
      : runtimeCodex.startThread(threadOptions);
    const streamed = await thread.runStreamed(prompt, { signal: abortController.signal });

    for await (const event of streamed.events as AsyncIterable<ThreadEvent>) {
      handleCodexEvent(event, {
        emittedAt,
        publish,
        runId: run.id,
        state,
      });
    }
  } catch (error) {
    publish({
      type: 'run.end',
      runId: run.id,
      emittedAt: emittedAt(),
      status: 'error',
      errorMessage: error instanceof Error ? error.message : 'Codex run failed',
    });
  }
}

async function prepareCodexHome(store: WorkspaceStore, sessionKey: string): Promise<string> {
  await store.listGlobalWorkspaceEntries();
  const globalRoot = store.getGlobalRoot();
  const sourceRoot = path.join(globalRoot, 'Agent 配置');
  const targetRoot = path.join(path.dirname(globalRoot), '.codex-home', sanitizeCodexHomeKey(sessionKey));

  await mkdir(targetRoot, { recursive: true });

  for (const entryName of ['AGENTS.md', 'config.toml']) {
    const source = path.join(sourceRoot, entryName);
    const target = path.join(targetRoot, entryName);
    if (!(await pathExists(source))) {
      continue;
    }
    await writeFile(target, await readFile(source, 'utf8'), 'utf8');
  }

  for (const entryName of ['skills', 'plugins']) {
    const source = path.join(sourceRoot, entryName);
    const target = path.join(targetRoot, entryName);
    if (!(await pathExists(source))) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
  }

  return targetRoot;
}

function sanitizeCodexHomeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `session_${randomUUID()}`;
}

async function getGlobalResourceDirectories(store: WorkspaceStore): Promise<string[]> {
  await store.listGlobalWorkspaceEntries();
  const globalRoot = store.getGlobalRoot();
  const directories = [path.join(globalRoot, '知识库'), path.join(globalRoot, '模板库')];
  const existingDirectories = await Promise.all(
    directories.map(async (directory) => ((await pathExists(directory)) ? directory : null)),
  );
  return existingDirectories.filter((directory): directory is string => directory !== null);
}

export function buildCodexEnv(codexHome: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, CODEX_HOME: codexHome }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  env.CODEX_API_KEY = env.CODEX_API_KEY ?? env.OPENAI_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '';
  return env;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function handleCodexEvent(
  event: ThreadEvent,
  context: {
    emittedAt: () => string;
    publish: (event: StreamEvent) => void;
    runId: string;
    state: ItemState;
  },
): void {
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    handleCodexItem(event.item, event.type === 'item.completed', context);
    return;
  }

  if (event.type === 'thread.started') {
    context.publish({ type: 'thread.started', runId: context.runId, emittedAt: context.emittedAt(), threadId: event.thread_id });
    return;
  }

  if (event.type === 'turn.completed') {
    context.publish({ type: 'run.end', runId: context.runId, emittedAt: context.emittedAt(), status: 'success', errorMessage: null });
    return;
  }

  if (event.type === 'turn.failed') {
    context.publish({
      type: 'run.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      status: 'error',
      errorMessage: event.error.message,
    });
    return;
  }

  if (event.type === 'error') {
    context.publish({
      type: 'run.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      status: 'error',
      errorMessage: event.message,
    });
  }
}

function handleCodexItem(
  item: ThreadItem,
  completed: boolean,
  context: {
    emittedAt: () => string;
    publish: (event: StreamEvent) => void;
    runId: string;
    state: ItemState;
  },
): void {
  if (!item || typeof item !== 'object' || !('type' in item) || !('id' in item)) return;
  const typedItem = item as { id: string; type: string; [key: string]: unknown };

  if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
    publishTextDelta(typedItem.id, typedItem.text, context);
    return;
  }

  if (typedItem.type === 'reasoning' && typeof typedItem.text === 'string') {
    publishThinking(typedItem.id, typedItem.text, completed, context);
    return;
  }

  if (typedItem.type === 'command_execution') {
    const command = typeof typedItem.command === 'string' ? typedItem.command : 'command';
    const output = typeof typedItem.aggregated_output === 'string' ? typedItem.aggregated_output : '';
    const status = typedItem.status === 'failed' ? 'failed' : typedItem.status === 'completed' ? 'succeeded' : 'running';
    publishToolLifecycle(typedItem.id, 'command_execution', command, output, completed, status, context);
    return;
  }

  if (typedItem.type === 'mcp_tool_call') {
    const server = typeof typedItem.server === 'string' ? typedItem.server : 'mcp';
    const tool = typeof typedItem.tool === 'string' ? typedItem.tool : 'tool';
    const input = JSON.stringify(typedItem.arguments ?? {});
    const output = typedItem.error
      ? JSON.stringify(typedItem.error)
      : typedItem.result
        ? JSON.stringify(typedItem.result)
        : '';
    const status = typedItem.status === 'failed' ? 'failed' : typedItem.status === 'completed' ? 'succeeded' : 'running';
    publishToolLifecycle(typedItem.id, `${server}.${tool}`, input, output, completed, status, context);
    return;
  }

  if (typedItem.type === 'web_search') {
    const query = typeof typedItem.query === 'string' ? typedItem.query : '';
    publishToolLifecycle(typedItem.id, 'web_search', query, '', completed, completed ? 'succeeded' : 'running', context);
    return;
  }

  if (typedItem.type === 'file_change' && Array.isArray(typedItem.changes) && completed) {
    for (const change of typedItem.changes) {
      if (!change || typeof change !== 'object') continue;
      const path = 'path' in change && typeof change.path === 'string' ? change.path : '';
      const kind = 'kind' in change && typeof change.kind === 'string' ? change.kind : 'update';
      if (!path) continue;
      context.publish({
        type: 'file.changed',
        runId: context.runId,
        emittedAt: context.emittedAt(),
        path,
        change: kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'modified',
      });
    }
    return;
  }

  if (typedItem.type === 'error' && typeof typedItem.message === 'string') {
    publishToolLifecycle(typedItem.id, 'error', '', typedItem.message, true, 'failed', context);
  }
}

function publishTextDelta(
  itemId: string,
  nextText: string,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  const previous = context.state.textByItemId.get(itemId) ?? '';
  const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
  context.state.textByItemId.set(itemId, nextText);
  if (!delta) return;
  context.publish({
    type: 'text.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    delta,
    sequence: ++context.state.textSequence,
  });
}

function publishThinking(
  itemId: string,
  nextText: string,
  completed: boolean,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  const previous = context.state.thinkingByItemId.get(itemId);
  const sequence = previous?.sequence ?? ++context.state.thinkingSequence;
  const previousText = previous?.text ?? '';
  const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
  context.state.thinkingByItemId.set(itemId, { sequence, text: nextText });
  if (delta) {
    context.publish({ type: 'thinking.delta', runId: context.runId, emittedAt: context.emittedAt(), delta, sequence });
  }
  if (completed) {
    context.publish({ type: 'thinking.end', runId: context.runId, emittedAt: context.emittedAt(), text: nextText, sequence });
  }
}

function publishToolLifecycle(
  itemId: string,
  toolName: string,
  input: string,
  output: string,
  completed: boolean,
  status: 'running' | 'succeeded' | 'failed',
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  if (!context.state.toolStarted.has(itemId)) {
    context.state.toolStarted.add(itemId);
    context.publish({ type: 'tool_use.start', runId: context.runId, emittedAt: context.emittedAt(), toolCallId: itemId, toolName });
  }

  publishToolDelta(itemId, 'input', input, context);
  publishToolDelta(itemId, 'output', output, context);

  if (completed) {
    context.publish({
      type: 'tool_use.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      toolCallId: itemId,
      status,
      outputText: output || null,
      errorMessage: status === 'failed' ? output || `${toolName} failed` : null,
    });
  }
}

function publishToolDelta(
  itemId: string,
  stream: 'input' | 'output',
  nextText: string,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string; state: ItemState },
): void {
  if (!nextText) return;
  const map = stream === 'input' ? context.state.toolInputByItemId : context.state.toolOutputByItemId;
  const previous = map.get(itemId) ?? '';
  const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
  map.set(itemId, nextText);
  if (!delta) return;
  context.publish({
    type: 'tool_use.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    toolCallId: itemId,
    stream,
    delta,
    sequence: ++context.state.toolSequence,
  });
}

async function buildCodexPrompt(store: WorkspaceStore, input: CreateRunInput): Promise<string> {
  const references = input.referencedFiles ?? [];
  const referenceBlocks = await Promise.all(
    references.map(async (file) => {
      try {
        const content = await store.readWorkspaceFile(input.projectId, file.path);
        return `## @${file.label} (${file.path})\n\n${content.content}`;
      } catch {
        return `## @${file.label} (${file.path})\n\n[引用文件读取失败]`;
      }
    }),
  );

  return [
    '# 情景剧创作请求',
    input.prompt,
    '你是情景剧创作工作台里的编剧助手。优先阅读和编辑当前项目工作区内的“01 基本设定、02 故事、03 剧本、04 分镜脚本、05 视频、06 产物”等目录，尤其关注项目简介、人物设定、单集大纲、剧本文档、分镜脚本和视频生成提示词。回答使用中文，聚焦剧情结构、人物动机、对白节奏和可拍摄性。',
    referenceBlocks.length > 0 ? '# 已引用项目文件' : '',
    ...referenceBlocks,
  ].filter(Boolean).join('\n\n');
}
