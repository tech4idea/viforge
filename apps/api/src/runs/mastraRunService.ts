import { randomUUID } from 'node:crypto';

import { createTool } from '@mastra/core/tools';
import type { ProductProfile, StreamEvent } from '@viwork/shared';
import { z } from 'zod';

import { PRODUCT_PROFILE } from '../env';
import { appendJsonLog } from '../logger';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { BehaviorRule } from '../storage/behaviorRulesStore';
import { createBehaviorRulesStore } from '../storage/behaviorRulesStore';

import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

import { createAgentRegistry, createWorkspaceTools, type AgentRegistry, type MastraAgentClient, type MastraStreamChunk, type MastraStreamOutput, type MastraToolset } from './mastraAgents';

type MastraRunOptions = {
  createAgent?: (context: {
    instructions: string;
    tools: ReturnType<typeof createWorkspaceTools>;
  }) => MastraAgentClient;
  createAgentRegistry?: (
    tools: ReturnType<typeof createWorkspaceTools>,
    context: { model?: string; baseUrl?: string; apiKey?: string; connectionString?: string; qdrantUrl?: string; traceId?: string },
  ) => Promise<AgentRegistry>;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  connectionString?: string;
  qdrantUrl?: string;
  productProfile?: ProductProfile;
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

const SPECIALIST_AGENT_LABELS: Record<string, string> = {
  'brainstorm-agent': '脑暴',
  'character-agent': '人物设定',
  'continuity-agent': '连续性检查',
  'source-analyst-agent': '原著分析',
  'adaptation-planner-agent': '改编方案',
  'screenwriter-agent': '编剧',
  'reviewer-agent': '审稿',
};

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
      const runId = `run_${randomUUID()}`;
      const traceId = input.traceId ?? runId;
      const run = {
        id: runId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        codexThreadId: input.codexThreadId,
        prompt: input.prompt,
        model: input.model,
        imageGeneration: input.imageGeneration,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        source: input.source ?? 'web',
        status: 'running' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      void executeMastraRun({ bus, input: { ...input, traceId }, options, runId: run.id, store });

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
    const productProfile = options.productProfile ?? PRODUCT_PROFILE;

    // Build tools
    const tools = createWorkspaceTools(store, input.projectId, publish, runId, emittedAt, {
      imageGeneration: input.imageGeneration,
      traceId: input.traceId,
      wechat: input.wechat,
    });
    // Create agent registry from skills
    const registryOptions = {
      ...options,
      model: input.model ?? options.model,
      traceId: input.traceId,
    };
    const registry = options.createAgent
      ? null
      : options.createAgentRegistry
        ? await options.createAgentRegistry(tools, registryOptions)
        : await createAgentRegistry(store, registryOptions, tools);

    // Build the combined prompt with references
    const prompt = await buildMastraPrompt(store, input, productProfile);

    // Run the multi-agent workflow
    if (options.createAgent) {
      // Backward compat: single agent mode
      const instructions = await buildSystemInstructions(store, productProfile);
      const agent = options.createAgent({ instructions, tools });

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
        maxSteps: 25,
        memory: { thread: threadId, resource: input.projectId },
      });
      await consumeMastraStream(streamed.fullStream, { emittedAt, publish, runId });
    } else {
      await executeMultiAgentWorkflow({
        registry: registry!,
        store,
        input,
        productProfile,
        prompt,
        publish,
        emittedAt,
        runId,
        threadId,
        options,
      });
    }

    publish({ type: 'run.end', runId, emittedAt: emittedAt(), status: 'success', errorMessage: null });
  } catch (error) {
    const modelNotFound = isModelNotFoundError(error);
    
    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'execute.error',
      runId,
      projectId: input.projectId,
      error,
      modelNotFound,
    });

    const errorMessage = modelNotFound
      ? `模型 ${input.model || '当前'} 不可用，请更换模型或联系管理员。网关返回：模型未找到。`
      : (error instanceof Error ? error.message : 'Run failed');

    publish({
      type: 'run.end',
      runId,
      emittedAt: emittedAt(),
      status: 'error',
      errorMessage,
    });
  }
}

async function executeMultiAgentWorkflow({
  registry,
  store,
  input,
  productProfile,
  prompt,
  publish,
  emittedAt,
  runId,
  threadId,
}: {
  registry: AgentRegistry;
  store: WorkspaceStore;
  input: CreateRunInput;
  productProfile: ProductProfile;
  prompt: string;
  publish: (event: StreamEvent) => void;
  emittedAt: () => string;
  runId: string;
  threadId: string;
  options: MastraRunOptions;
}): Promise<void> {
  const baseTools = createWorkspaceTools(store, input.projectId, publish, runId, emittedAt, {
    imageGeneration: input.imageGeneration,
    traceId: input.traceId,
    wechat: input.wechat,
  });
  const orchestrationTools: MastraToolset = {
    ...baseTools,
    delegate_to_specialist_agent: createSpecialistDelegationTool({
      registry,
      publish,
      emittedAt,
      runId,
      threadId,
      input,
    }),
  };
  const systemInstructions = await buildSystemInstructions(store, productProfile);
  const behaviorRulesStore = createBehaviorRulesStore(store);
  const behaviorRules = await behaviorRulesStore.getRules();
  const mainAgent = registry.systemAgent(buildMainAgentInstructions(systemInstructions, behaviorRules), orchestrationTools);

  appendJsonLog('api-runs.jsonl', {
    scope: 'mastra-run',
    stage: 'main-agent.stream.input',
    runId,
    projectId: input.projectId,
    threadId,
    prompt: textLogValue(prompt),
  });

  await runAgentStream(mainAgent, prompt, publish, emittedAt, runId, threadId, input, 40, threadId);
}

function createSpecialistDelegationTool({
  registry,
  publish,
  emittedAt,
  runId,
  threadId,
  input,
}: {
  registry: AgentRegistry;
  publish: (event: StreamEvent) => void;
  emittedAt: () => string;
  runId: string;
  threadId: string;
  input: CreateRunInput;
}) {
  return createTool({
    id: 'delegate_to_specialist_agent',
    description: [
      '将明确需要专业创作能力的子任务交给一个 viwork specialist agent。',
      '普通问候、解释、简单修改、文件读写和一般对话不要使用此工具，由主 agent 直接完成。',
      '只有在任务明确属于脑暴、人物设定、连续性检查、原著分析、改编方案、故事/剧本创作或审稿时才委派。',
    ].join('\n'),
    inputSchema: z.object({
      agentId: z.enum([
        'brainstorm-agent',
        'character-agent',
        'continuity-agent',
        'source-analyst-agent',
        'adaptation-planner-agent',
        'screenwriter-agent',
        'reviewer-agent',
      ]),
      task: z.string().min(1),
      context: z.string().default(''),
    }),
    execute: async ({ agentId, task, context }) => runSpecialistAgent({
      registry,
      agentId,
      task,
      context: context ?? '',
      publish,
      emittedAt,
      runId,
      threadId,
      input,
    }),
  });
}

async function runSpecialistAgent({
  registry,
  agentId,
  task,
  context,
  publish,
  emittedAt,
  runId,
  threadId,
  input,
}: {
  registry: AgentRegistry;
  agentId: string;
  task: string;
  context: string;
  publish: (event: StreamEvent) => void;
  emittedAt: () => string;
  runId: string;
  threadId: string;
  input: CreateRunInput;
}): Promise<{ agentId: string; output: string; summary: string }> {
  const agent = getSpecialistAgent(registry, agentId);
  if (!agent) {
    return { agentId, output: `未找到 specialist agent：${agentId}`, summary: '' };
  }

  const phase = SPECIALIST_AGENT_LABELS[agentId] ?? agentId;
  publish({
    type: 'agent.step.start',
    runId,
    emittedAt: emittedAt(),
    agentId,
    phase,
    iteration: 1,
    maxIterations: 1,
  } as StreamEvent);

  const specialistPrompt = [
    '# Specialist 子任务',
    task,
    context ? '# 主 agent 提供的上下文' : '',
    context,
    '# 输出要求',
    '只完成该子任务。需要写入正式产物时使用 workspace tools；否则直接返回可供主 agent 综合的结果。',
  ].filter(Boolean).join('\n\n');

  let output: string;
  try {
    const memoryThread = `${threadId}-${agentId}`;
    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'specialist.generate.input',
      runId,
      agentId,
      prompt: textLogValue(specialistPrompt),
    });

    const generatePromise = agent.generate(specialistPrompt, {
      runId,
      maxSteps: 10,
      memory: { thread: memoryThread, resource: input.projectId },
    });

    const timeoutMs = 180_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`specialist agent 超时（${timeoutMs / 1000}s），已终止等待`)), timeoutMs);
    });

    const result = await Promise.race([generatePromise, timeoutPromise]);
    output = result.text;

    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'specialist.generate.output',
      runId,
      agentId,
      output: textLogValue(output),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJsonLog('api-runs.jsonl', {
      scope: 'mastra-run',
      stage: 'specialist.generate.error',
      runId,
      agentId,
      error: message,
    });
    publish({
      type: 'agent.step.end',
      runId,
      emittedAt: emittedAt(),
      agentId,
      phase,
      iteration: 1,
      maxIterations: 1,
      status: 'failed',
    } as StreamEvent);
    return { agentId, output: `[${phase}] 执行异常：${message}`, summary: `[${phase}] 失败：${message}` };
  }

  publish({
    type: 'agent.step.end',
    runId,
    emittedAt: emittedAt(),
    agentId,
    phase,
    iteration: 1,
    maxIterations: 1,
    status: 'passed',
  } as StreamEvent);

  const summary = buildSpecialistSummary(agentId, phase, task, output);
  return { agentId, output, summary };
}

function buildSpecialistSummary(agentId: string, phase: string, task: string, output: string): string {
  const truncatedOutput = output.length > 500 ? `${output.slice(0, 500)}...` : output;
  return `[${phase}(${agentId})] 任务：${task.slice(0, 100)}\n结果摘要：${truncatedOutput}`;
}

async function runAgentStream(
  agent: MastraAgentClient,
  prompt: string,
  publish: (event: StreamEvent) => void,
  emittedAt: () => string,
  runId: string,
  threadId: string,
  input: CreateRunInput,
  maxSteps: number,
  memoryThread = `${threadId}-${agent.id ?? 'agent'}`,
): Promise<string> {
  const streamed = await agent.stream(prompt, {
    runId,
    maxSteps,
    memory: { thread: memoryThread, resource: input.projectId },
  });

  // Use consumeMastraStream for real-time event publishing + accumulate text for context chaining
  const text = await consumeMastraStreamAndAccumulate(streamed.fullStream, { emittedAt, publish, runId });

  return text;
}

function getSpecialistAgent(registry: AgentRegistry, agentId: string): MastraAgentClient | null {
  switch (agentId) {
    case 'brainstorm-agent': return registry.brainstorm;
    case 'character-agent': return registry.character;
    case 'continuity-agent': return registry.continuity;
    case 'source-analyst-agent': return registry.sourceAnalyst;
    case 'adaptation-planner-agent': return registry.adaptationPlanner;
    case 'screenwriter-agent': return registry.screenwriter;
    case 'reviewer-agent': return registry.reviewer;
    default: return null;
  }
}

export async function accumulateStreamText(stream: MastraStreamOutput['fullStream']): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of toAsyncIterable(stream)) {
    if (chunk.type === 'text-delta' && chunk.payload && typeof chunk.payload.text === 'string') {
      parts.push(chunk.payload.text);
    }
  }
  return parts.join('');
}

async function consumeMastraStreamAndAccumulate(
  stream: MastraStreamOutput['fullStream'],
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
): Promise<string> {
  const state: ToolState = {
    inputByToolCallId: new Map(),
    outputByToolCallId: new Map(),
    thinkingSequenceById: new Map(),
    startedToolCallIds: new Set(),
    textSequence: 0,
    thinkingSequence: 0,
    toolSequence: 0,
  };
  const textParts: string[] = [];
  for await (const chunk of toAsyncIterable(stream)) {
    handleMastraChunk(chunk, state, context);
    if (chunk.type === 'text-delta' && chunk.payload && typeof chunk.payload.text === 'string') {
      textParts.push(chunk.payload.text);
    }
  }
  return textParts.join('');
}

// --- Stream consuming (same as before, exported for backward compat) ---

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
    } as StreamEvent);
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

async function buildMastraPrompt(store: WorkspaceStore, input: CreateRunInput, productProfile: ProductProfile): Promise<string> {
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
    productProfile.mastra.requestTitle ?? '# 创作请求',
    input.prompt,
    referenceBlocks.length > 0 ? '# 已引用项目文件' : '',
    ...referenceBlocks,
    snippetBlocks.length > 0 ? '# 已引用聊天片段' : '',
    ...snippetBlocks,
  ].filter(Boolean).join('\n\n');
}

async function buildSystemInstructions(store: WorkspaceStore, productProfile: ProductProfile): Promise<string> {
  const protocol = await readSystemAgentProtocol(store, productProfile);
  return [
    ...productProfile.mastra.systemIntro,
    '## viwork 多 agent 工作协议',
    protocol,
  ].join('\n\n');
}

function buildMainAgentInstructions(systemInstructions: string, behaviorRules: BehaviorRule[]): string {
  const base = [
    systemInstructions,
    '## 主 agent 调度原则',
    '你是默认工作的主 agent，目标是提供接近 Codex 编程工具的自然协作体验。',
    '普通问候、解释问题、读取资料、轻量修改、整理已有内容、保存用户明确指定的小改动，都由你直接完成。',
    '不要先做固定流程分类，不要因为用户提到剧本、方案或故事就自动启动完整流水线。',
    '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时，使用 generate_project_image 工具生成图片并保存到项目工作区。',
    '调用 generate_project_image 时只填写 prompt、aspectRatio、count；不要尝试填写或猜测模型名，图片模型由系统配置自动注入。',
    '如果用户只是要人物视觉描述、绘图提示词或图片生成建议，不要调用 generate_project_image，直接输出文本。',
    '只有当任务明确需要专业判断或专业产物时，才使用 delegate_to_specialist_agent 委派给 specialist agent。',
    '可委派的 specialist agent：brainstorm-agent、character-agent、continuity-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent；如果对应 skill 未安装，工具会返回未找到。',
    '委派时只拆出必要的子任务，并把当前上下文、已读取文件摘要、用户目标和期望输出传给 specialist。',
    '收到 specialist 结果后，由你继续综合、解释、决定是否写入文件，并向用户给出最终答复。',
    '每次 specialist 返回的结果中包含 summary 字段，请将关键信息记录到项目记忆中（专家协作摘要部分），方便后续对话引用。',
    '如果用户只是要求”帮我改一句/润色一段/解释这个文件/打个招呼”，不要委派。',
    '在情景剧故事创作中，如果人物动机、角色关系或角色行为边界不清，先委派 character-agent；如果涉及多集历史、固定设定或上一集状态，先委派 continuity-agent。',
    '如果用户明确要求”脑暴方向/完善人物/检查连续性/做原著分析/制定改编方案/写正式故事或剧本/严格审稿”，再委派给对应 specialist。',
  ];

  for (const rule of behaviorRules) {
    if (rule.enabled && rule.content.trim()) {
      base.push(`## ${rule.label}\n\n${rule.content}`);
    }
  }

  return base.join('\n\n');
}

async function readSystemAgentProtocol(store: WorkspaceStore, productProfile: ProductProfile): Promise<string> {
  try {
    return (await store.readGlobalWorkspaceFile('Agent 配置/AGENTS.md')).content;
  } catch {
    return productProfile.mastra.fallbackProtocol;
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

function isModelNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  if (err.statusCode === 404) return true;
  if (typeof err.responseBody === 'string' && err.responseBody.includes('model_not_found')) return true;
  const data = err.data as Record<string, unknown> | undefined;
  if (data?.error && typeof data.error === 'object') {
    const errObj = data.error as Record<string, unknown>;
    if (errObj.code === 'model_not_found') return true;
  }
  return false;
}

export const __mastraRunServiceTest = {
  createWorkspaceTools,
};
