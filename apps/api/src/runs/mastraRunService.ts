import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { Agent } from '@mastra/core/agent';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { TokenLimiterProcessor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type { StreamEvent } from '@viwork/shared';
import { z } from 'zod';

import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, AIGC_HUB_CHAT_MODEL, WORKSPACES_ROOT } from '../env';
import { appendJsonLog } from '../logger';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

type MastraStreamChunk = {
  type: string;
  payload?: Record<string, unknown>;
  object?: unknown;
};

type MastraStreamOutput = {
  fullStream: ReadableStream<MastraStreamChunk> | AsyncIterable<MastraStreamChunk>;
};

type MastraAgentClient = {
  stream(messages: string, options: Record<string, unknown>): Promise<MastraStreamOutput>;
};

type MastraRunOptions = {
  createAgent?: (context: {
    instructions: string;
    tools: ReturnType<typeof createWorkspaceTools>;
  }) => MastraAgentClient;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  memoryDbPath?: string;
};

type ToolState = {
  inputByToolCallId: Map<string, string>;
  outputByToolCallId: Map<string, string>;
  thinkingSequenceById: Map<string, number>;
  startedToolCallIds: Set<string>;
  textSequence: number;
  thinkingSequence: number;
  toolSequence: number;
};

const DEFAULT_MASTRA_MODEL = 'ds/deepseek-v4-pro';
const DEFAULT_MASTRA_BASE_URL = 'https://api.yukeon.top/v1';
const DEFAULT_MEMORY_DB = path.join(WORKSPACES_ROOT, '..', 'mastra-memory.db');

export function createMastraRunService(
  store: WorkspaceStore,
  bus: RunBus,
  options: MastraRunOptions = {},
): RunService {
  return {
    async createRun(input) {
      const project = await store.getProject(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const timestamp = new Date().toISOString();
      const run = {
        id: `run_${randomUUID()}`,
        projectId: input.projectId,
        sessionId: input.sessionId,
        codexThreadId: input.codexThreadId,
        prompt: input.prompt,
        model: input.model,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        source: input.source ?? 'web',
        status: 'running' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      void executeMastraRun({ bus, input, options, runId: run.id, store });

      return { run };
    },
  };
}

async function executeMastraRun({
  bus,
  input,
  options,
  runId,
  store,
}: {
  bus: RunBus;
  input: CreateRunInput;
  options: MastraRunOptions;
  runId: string;
  store: WorkspaceStore;
}): Promise<void> {
  const emittedAt = () => new Date().toISOString();
  const publish = (event: StreamEvent) => {
    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'stream.publish',
      runId,
      projectId: input.projectId,
      event,
    });
    bus.publish(event);
  };

  publish({ type: 'run.start', runId, emittedAt: emittedAt() });
  const threadId = input.sessionId ?? runId;
  publish({ type: 'thread.started', runId, emittedAt: emittedAt(), threadId: `mastra:${threadId}` });

  try {
    const prompt = await buildMastraPrompt(store, input);
    const instructions = await buildMastraInstructions(store);
    const tools = createWorkspaceTools(store, input.projectId, publish, runId, emittedAt);
    const agent = options.createAgent
      ? options.createAgent({ instructions, tools })
      : await createDefaultMastraAgent({ instructions, options: { ...options, model: input.model ?? options.model }, tools });

    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'agent.stream.input',
      runId,
      projectId: input.projectId,
      threadId,
      prompt: textLogValue(prompt),
    });

    const streamed = await agent.stream(prompt, {
      runId,
      maxSteps: 8,
      memory: {
        thread: threadId,
        resource: input.projectId,
      },
    });

    await consumeMastraStream(streamed.fullStream, { emittedAt, publish, runId });
    publish({ type: 'run.end', runId, emittedAt: emittedAt(), status: 'success', errorMessage: null });
  } catch (error) {
    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'execute.error',
      runId,
      projectId: input.projectId,
      error,
    });
    publish({
      type: 'run.end',
      runId,
      emittedAt: emittedAt(),
      status: 'error',
      errorMessage: error instanceof Error ? error.message : 'Mastra run failed',
    });
  }
}

async function createDefaultMastraAgent({
  instructions,
  options,
  tools,
}: {
  instructions: string;
  options: MastraRunOptions;
  tools: ReturnType<typeof createWorkspaceTools>;
}): Promise<MastraAgentClient> {
  const memoryDbPath = options.memoryDbPath ?? DEFAULT_MEMORY_DB;
  await mkdir(path.dirname(memoryDbPath), { recursive: true });
  const storage = new LibSQLStore({ id: 'viwork-mastra-storage', url: `file:${memoryDbPath}` });
  const memory = new Memory({
    storage,
    vector: false,
    options: {
      lastMessages: 12,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: [
          '# viwork project memory',
          '- 用户偏好：',
          '- 项目长期设定：',
          '- 角色与关系：',
          '- 待回收伏笔：',
        ].join('\n'),
      },
    },
  });

  return new Agent({
    id: 'viwork-system-agent',
    name: 'viwork system agent',
    instructions,
    model: buildMastraModelConfig(options),
    tools,
    memory,
    inputProcessors: [new TokenLimiterProcessor({ limit: 100_000, strategy: 'truncate' })],
  }) as MastraAgentClient;
}

function buildMastraModelConfig(options: MastraRunOptions): OpenAICompatibleConfig {
  const rawId = options.model
    || process.env.VIWORK_AIGC_HUB_CHAT_MODEL
    || AIGC_HUB_CHAT_MODEL
    || process.env.VIWORK_MASTRA_MODEL
    || DEFAULT_MASTRA_MODEL;
  const id = rawId.includes('/') ? rawId : `aigc-hub/${rawId}`;
  return {
    id: id as `${string}/${string}`,
    url: options.baseUrl
      || process.env.VIWORK_AIGC_HUB_BASE_URL
      || AIGC_HUB_BASE_URL
      || process.env.VIWORK_MASTRA_BASE_URL
      || process.env.OPENAI_BASE_URL
      || DEFAULT_MASTRA_BASE_URL,
    apiKey: options.apiKey
      || process.env.VIWORK_AIGC_HUB_API_KEY
      || AIGC_HUB_API_KEY
      || process.env.VIWORK_MASTRA_API_KEY
      || process.env.OPENAI_API_KEY
      || process.env.CODEX_API_KEY
      || '',
  };
}

function createWorkspaceTools(
  store: WorkspaceStore,
  projectId: string,
  publish: (event: StreamEvent) => void,
  runId: string,
  emittedAt: () => string,
) {
  return {
    list_workspace_entries: createTool({
      id: 'list_workspace_entries',
      description: 'List files and folders in the current viwork project workspace.',
      inputSchema: z.object({}),
      execute: async () => ({ entries: await store.listWorkspaceEntries(projectId) }),
    }),
    read_workspace_file: createTool({
      id: 'read_workspace_file',
      description: 'Read a UTF-8 text file from the current viwork project workspace.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => store.readWorkspaceFile(projectId, filePath),
    }),
    write_workspace_file: createTool({
      id: 'write_workspace_file',
      description: 'Write a UTF-8 text file inside the current viwork project workspace. Use this only for final accepted story or script artifacts.',
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path: filePath, content }) => {
        const existed = await workspaceFileExists(store, projectId, filePath);
        const written = await store.writeWorkspaceFile(projectId, filePath, content);
        publish({ type: 'file.changed', runId, emittedAt: emittedAt(), path: written.path, change: existed ? 'modified' : 'created' });
        return written;
      },
    }),
    read_global_file: createTool({
      id: 'read_global_file',
      description: 'Read a UTF-8 text file from the global viwork workspace such as knowledge base, templates, or Agent configuration.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: filePath }) => store.readGlobalWorkspaceFile(filePath),
    }),
  };
}

async function workspaceFileExists(store: WorkspaceStore, projectId: string, filePath: string): Promise<boolean> {
  try {
    await store.readWorkspaceFile(projectId, filePath);
    return true;
  } catch {
    return false;
  }
}

async function consumeMastraStream(
  stream: MastraStreamOutput['fullStream'],
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
): Promise<void> {
  const state: ToolState = {
    inputByToolCallId: new Map(),
    outputByToolCallId: new Map(),
    thinkingSequenceById: new Map(),
    startedToolCallIds: new Set(),
    textSequence: 0,
    thinkingSequence: 0,
    toolSequence: 0,
  };
  for await (const chunk of toAsyncIterable(stream)) {
    handleMastraChunk(chunk, state, context);
  }
}

function handleMastraChunk(
  chunk: MastraStreamChunk,
  state: ToolState,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
): void {
  if (chunk.type === 'text-delta') {
    const delta = stringPayload(chunk, 'text');
    if (delta) {
      context.publish({ type: 'text.delta', runId: context.runId, emittedAt: context.emittedAt(), delta, sequence: ++state.textSequence });
    }
    return;
  }

  if (chunk.type === 'reasoning-delta') {
    const delta = stringPayload(chunk, 'text');
    if (delta) {
      const reasoningId = stringPayload(chunk, 'id') || 'default';
      const sequence = state.thinkingSequenceById.get(reasoningId) ?? ++state.thinkingSequence;
      state.thinkingSequenceById.set(reasoningId, sequence);
      context.publish({ type: 'thinking.delta', runId: context.runId, emittedAt: context.emittedAt(), delta, sequence });
    }
    return;
  }

  if (chunk.type === 'reasoning-end') {
    const reasoningId = stringPayload(chunk, 'id') || 'default';
    state.thinkingSequenceById.delete(reasoningId);
    return;
  }

  if (chunk.type === 'tool-call') {
    const toolCallId = stringPayload(chunk, 'toolCallId') || `tool_${state.toolSequence + 1}`;
    const toolName = stringPayload(chunk, 'toolName') || 'tool';
    publishToolStart(toolCallId, toolName, state, context);
    publishToolDelta(toolCallId, 'input', jsonPayload(chunk.payload?.args), state, context);
    return;
  }

  if (chunk.type === 'tool-call-delta') {
    const toolCallId = stringPayload(chunk, 'toolCallId') || `tool_${state.toolSequence + 1}`;
    publishToolDelta(toolCallId, 'input', stringPayload(chunk, 'argsTextDelta'), state, context);
    return;
  }

  if (chunk.type === 'tool-result') {
    const toolCallId = stringPayload(chunk, 'toolCallId') || `tool_${state.toolSequence + 1}`;
    const toolName = stringPayload(chunk, 'toolName') || 'tool';
    publishToolStart(toolCallId, toolName, state, context);
    const output = jsonPayload(chunk.payload?.result);
    publishToolDelta(toolCallId, 'output', output, state, context);
    context.publish({
      type: 'tool_use.end',
      runId: context.runId,
      emittedAt: context.emittedAt(),
      toolCallId,
      status: chunk.payload?.isError ? 'failed' : 'succeeded',
      outputText: output || null,
      errorMessage: chunk.payload?.isError ? output || `${toolName} failed` : null,
    });
  }
}

function publishToolStart(
  toolCallId: string,
  toolName: string,
  state: ToolState,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
): void {
  if (state.startedToolCallIds.has(toolCallId)) return;
  state.startedToolCallIds.add(toolCallId);
  context.publish({ type: 'tool_use.start', runId: context.runId, emittedAt: context.emittedAt(), toolCallId, toolName });
}

function publishToolDelta(
  toolCallId: string,
  stream: 'input' | 'output',
  nextDelta: string,
  state: ToolState,
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
): void {
  if (!nextDelta) return;
  const map = stream === 'input' ? state.inputByToolCallId : state.outputByToolCallId;
  const previous = map.get(toolCallId) ?? '';
  const next = previous + nextDelta;
  map.set(toolCallId, next);
  context.publish({
    type: 'tool_use.delta',
    runId: context.runId,
    emittedAt: context.emittedAt(),
    toolCallId,
    stream,
    delta: nextDelta,
    sequence: ++state.toolSequence,
  });
}

async function* toAsyncIterable(stream: MastraStreamOutput['fullStream']): AsyncIterable<MastraStreamChunk> {
  const maybeAsyncIterable = stream as AsyncIterable<MastraStreamChunk>;
  if (Symbol.asyncIterator in maybeAsyncIterable) {
    yield* maybeAsyncIterable;
    return;
  }
  const reader = (stream as ReadableStream<MastraStreamChunk>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function buildMastraPrompt(store: WorkspaceStore, input: CreateRunInput): Promise<string> {
  const referenceBlocks = await Promise.all((input.referencedFiles ?? []).map(async (file) => {
    try {
      const content = await store.readWorkspaceFile(input.projectId, file.path);
      return `## @${file.label} (${file.path})\n\n${content.content}`;
    } catch {
      return `## @${file.label} (${file.path})\n\n[引用文件读取失败]`;
    }
  }));
  const snippetBlocks = (input.referencedSnippets ?? []).map((snippet, index) => [
    `## 片段 ${index + 1}: ${snippet.label}`,
    `来源：${snippet.role === 'user' ? '用户' : '创作助手'} / ${snippet.createdAt} / messageId=${snippet.messageId}`,
    '',
    snippet.text,
  ].join('\n'));

  return [
    '# 小说改编剧本创作请求',
    input.prompt,
    referenceBlocks.length > 0 ? '# 已引用项目文件' : '',
    ...referenceBlocks,
    snippetBlocks.length > 0 ? '# 已引用聊天片段' : '',
    ...snippetBlocks,
  ].filter(Boolean).join('\n\n');
}

async function buildMastraInstructions(store: WorkspaceStore): Promise<string> {
  const protocol = await readSystemAgentProtocol(store);
  return [
    '你是 viwork 小说改编剧本工作台里的 system agent。你只服务小说改编剧本创作，不执行通用编码任务。',
    '所有文件读写必须通过提供的 viwork workspace tools 完成，不要假设可以直接访问宿主机文件系统。',
    '脑暴请求只正常交流，不审稿、不写入项目文件；正式原著分析、改编方案和剧本创作通过质量闸门后才写入工作区。',
    '回答使用中文。',
    '## viwork 多 agent 工作协议',
    protocol,
  ].join('\n\n');
}

async function readSystemAgentProtocol(store: WorkspaceStore): Promise<string> {
  try {
    return (await store.readGlobalWorkspaceFile('Agent 配置/AGENTS.md')).content;
  } catch {
    return '# viwork system agent\n\n按 brainstorm-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent 的职责完成小说改编剧本创作。';
  }
}

function stringPayload(chunk: MastraStreamChunk, key: string): string {
  const value = chunk.payload?.[key];
  return typeof value === 'string' ? value : '';
}

function jsonPayload(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function textLogValue(text: string, limit = 50_000): { text: string; length: number; truncated: boolean } {
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    length: text.length,
    truncated: text.length > limit,
  };
}

export const __mastraRunServiceTest = {
  createWorkspaceTools,
};
