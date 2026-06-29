import { randomUUID } from 'node:crypto';

import type { ProductProfile, StreamEvent } from '@viwork/shared';
import { z } from 'zod';

import { AIGC_HUB_API_KEY, AIGC_HUB_BASE_URL, LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, PRODUCT_PROFILE } from '../env';
import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { appendJsonLog } from '../logger';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { BehaviorRule } from '../storage/behaviorRulesStore';
import { createBehaviorRulesStore } from '../storage/behaviorRulesStore';
import type { GitService } from '../storage/gitService';
import type { GitConfigStore } from '../storage/gitConfigStore';
import { flushPhoenixTracing, isPhoenixTracingEnabled, withPhoenixSpan } from '../observability/phoenix';

import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

import { createAgentRegistry, createTool, createWorkspaceTools, type AgentRegistry, type LangGraphAgentClient, type LangGraphStreamChunk, type LangGraphStreamOutput, type LangGraphToolset } from './langGraphAgents';
import { getPromptText } from './langfusePromptStore';

type LangGraphRunOptions = {
  createAgent?: (context: {
    instructions: string;
    tools: ReturnType<typeof createWorkspaceTools>;
  }) => LangGraphAgentClient;
  createAgentRegistry?: (
    tools: ReturnType<typeof createWorkspaceTools>,
    context: { model?: string; baseUrl?: string; apiKey?: string; connectionString?: string; traceId?: string; productProfile?: ProductProfile },
  ) => Promise<AgentRegistry>;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  connectionString?: string;
  productProfile?: ProductProfile;
  gitService?: GitService;
  gitConfigStore?: GitConfigStore;
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
  'story-agent': '故事创作',
  'source-analyst-agent': '原著分析',
  'adaptation-planner-agent': '改编方案',
  'screenwriter-agent': '编剧',
  'reviewer-agent': '审稿',
};

export function createLangGraphRunService(
  store: WorkspaceStore,
  bus: RunBus,
  options: LangGraphRunOptions = {},
): RunService {
  if (LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY && LANGFUSE_BASE_URL) {
    appendJsonLog('api.log', { scope: 'langgraph-run', stage: 'observability.enabled', provider: 'langfuse' });
  }
  if (isPhoenixTracingEnabled()) {
    appendJsonLog('api.log', { scope: 'langgraph-run', stage: 'observability.enabled', provider: 'phoenix' });
  }

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

      void executeLangGraphRun({ bus, input: { ...input, traceId }, options, runId: run.id, store });

      return { run };
    },
  };
}

async function executeLangGraphRun({
  bus,
  input,
  options,
  runId,
  store,
}: {
  bus: RunBus;
  input: CreateRunInput;
  options: LangGraphRunOptions;
  runId: string;
  store: WorkspaceStore;
}): Promise<void> {
  const emittedAt = () => new Date().toISOString();
  const publish = (event: StreamEvent) => {
    appendJsonLog('api-runs.jsonl', {
      scope: 'langgraph-run',
      stage: 'stream.publish',
      runId,
      projectId: input.projectId,
      event,
    });
    bus.publish(event);
  };

  publish({ type: 'run.start', runId, emittedAt: emittedAt() });
  const threadId = input.sessionId ?? runId;
  publish({ type: 'thread.started', runId, emittedAt: emittedAt(), threadId: `langgraph:${threadId}` });
  const signal = bus.getAbortSignal(runId);

  try {
    const productProfile = options.productProfile ?? await store.getProjectProductProfile(input.projectId) ?? PRODUCT_PROFILE;

    // Build tools
    const tools = createWorkspaceTools(store, input.projectId, publish, runId, emittedAt, {
      imageGeneration: input.imageGeneration,
      traceId: input.traceId,
      wechat: input.wechat,
      gitService: options.gitService,
      gitConfigStore: options.gitConfigStore,
    });
    // Create agent registry from skills
    const registryOptions = {
      ...options,
      model: input.model ?? options.model,
      traceId: input.traceId,
      productProfile,
    };
    const registry = options.createAgentRegistry
      ? await options.createAgentRegistry(tools, registryOptions)
      : options.createAgent
        ? null
        : await createAgentRegistry(store, registryOptions, tools);

    // Build the combined prompt with references.
    const prompt = buildLangGraphPrompt(input, productProfile);

    // Run the multi-agent workflow
    let assistantText = '';
    if (options.createAgent) {
      // Backward compat: single agent mode
      const instructions = buildSystemInstructions(productProfile);
      const singleAgentTools = registry
        ? { ...tools, delegate_to_specialist_agent: createSpecialistDelegationTool({ registry, publish, emittedAt, runId, threadId, input, productId: productProfile.id }) }
        : tools;
      const agent = options.createAgent({ instructions, tools: singleAgentTools });

      appendJsonLog('api-runs.jsonl', {
        scope: 'langgraph-run',
        stage: 'agent.stream.input',
        runId,
        projectId: input.projectId,
        threadId,
        prompt: textLogValue(prompt),
      });

      const streamed = await agent.stream(prompt, {
        runId,
        traceId: input.traceId,
        source: input.source ?? 'web',
        productId: productProfile.id,
        maxSteps: 25,
        memory: { thread: threadId, resource: input.projectId },
      });
      assistantText = await consumeLangGraphStreamAndAccumulate(streamed.fullStream, { emittedAt, publish, runId }, signal);
    } else {
      assistantText = await executeMultiAgentWorkflow({
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
        signal,
      });
    }

    if (signal.aborted) {
      publish({ type: 'run.end', runId, emittedAt: emittedAt(), status: 'cancelled', errorMessage: null });
    } else {
      await detectChoiceRequest(assistantText, publish, runId, emittedAt);
      publish({ type: 'run.end', runId, emittedAt: emittedAt(), status: 'success', errorMessage: null });
    }
    void flushPhoenixTracing();
  } catch (error) {
    const modelNotFound = isModelNotFoundError(error);
    
    appendJsonLog('api-runs.jsonl', {
      scope: 'langgraph-run',
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
    void flushPhoenixTracing();
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
  options,
  signal,
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
  options: LangGraphRunOptions;
  signal?: AbortSignal;
}): Promise<string> {
  const baseTools = createWorkspaceTools(store, input.projectId, publish, runId, emittedAt, {
    imageGeneration: input.imageGeneration,
    traceId: input.traceId,
    wechat: input.wechat,
    gitService: options.gitService,
    gitConfigStore: options.gitConfigStore,
  });
  const orchestrationTools: LangGraphToolset = {
    ...baseTools,
    delegate_to_specialist_agent: createSpecialistDelegationTool({
      registry,
      publish,
      emittedAt,
      runId,
      threadId,
      input,
      productId: productProfile.id,
    }),
  };
  const systemInstructions = buildSystemInstructions(productProfile);
  const behaviorRulesStore = createBehaviorRulesStore(store);
  const behaviorRules = await behaviorRulesStore.getRules();
  const mainInstructions = await buildMainAgentInstructions(systemInstructions, behaviorRules);
  const mainAgent = await registry.systemAgent(mainInstructions, orchestrationTools);

  appendJsonLog('api-runs.jsonl', {
    scope: 'langgraph-run',
    stage: 'main-agent.stream.input',
    runId,
    projectId: input.projectId,
    threadId,
    prompt: textLogValue(prompt),
  });

  return runAgentStream(mainAgent, prompt, publish, emittedAt, runId, threadId, input, productProfile.id, 40, threadId, signal);
}

function createSpecialistDelegationTool({
  registry,
  publish,
  emittedAt,
  runId,
  threadId,
  input,
  productId,
}: {
  registry: AgentRegistry;
  publish: (event: StreamEvent) => void;
  emittedAt: () => string;
  runId: string;
  threadId: string;
  input: CreateRunInput;
  productId: string;
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
        'story-agent',
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
      productId,
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
  productId,
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
  productId: string;
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
      scope: 'langgraph-run',
      stage: 'specialist.generate.input',
      runId,
      agentId,
      prompt: textLogValue(specialistPrompt),
    });

    const generatePromise = runAgentGenerate(agent, specialistPrompt, input, productId, runId, memoryThread, 10);

    const timeoutMs = 180_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`specialist agent 超时（${timeoutMs / 1000}s），已终止等待`)), timeoutMs);
    });

    const result = await Promise.race([generatePromise, timeoutPromise]);
    output = result.text;

    appendJsonLog('api-runs.jsonl', {
      scope: 'langgraph-run',
      stage: 'specialist.generate.output',
      runId,
      agentId,
      output: textLogValue(output),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJsonLog('api-runs.jsonl', {
      scope: 'langgraph-run',
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
  agent: LangGraphAgentClient,
  prompt: string,
  publish: (event: StreamEvent) => void,
  emittedAt: () => string,
  runId: string,
  threadId: string,
  input: CreateRunInput,
  productId: string,
  maxSteps: number,
  memoryThread = `${threadId}-${agent.id ?? 'agent'}`,
  signal?: AbortSignal,
): Promise<string> {
  return withPhoenixSpan(`langgraph.${agent.id ?? 'agent'}.stream`, {
    'viwork.run_id': runId,
    'viwork.trace_id': input.traceId,
    'viwork.project_id': input.projectId,
    'viwork.session_id': input.sessionId,
    'viwork.product_id': productId,
    'viwork.source': input.source ?? 'web',
    'viwork.agent_id': agent.id ?? 'agent',
    'langgraph.thread_id': memoryThread,
    'input.value': JSON.stringify(textLogValue(prompt)),
  }, async (span) => {
    const streamed = await agent.stream(prompt, {
      runId,
      traceId: input.traceId,
      source: input.source ?? 'web',
      productId,
      maxSteps,
      memory: { thread: memoryThread, resource: input.projectId },
    });

    const text = await consumeLangGraphStreamAndAccumulate(streamed.fullStream, { emittedAt, publish, runId }, signal);
    span.setAttribute('output.value', JSON.stringify(textLogValue(text)));
    return text;
  });
}

async function runAgentGenerate(
  agent: LangGraphAgentClient,
  prompt: string,
  input: CreateRunInput,
  productId: string,
  runId: string,
  memoryThread: string,
  maxSteps: number,
): Promise<{ text: string }> {
  return withPhoenixSpan(`langgraph.${agent.id ?? 'agent'}.generate`, {
    'viwork.run_id': runId,
    'viwork.trace_id': input.traceId,
    'viwork.project_id': input.projectId,
    'viwork.session_id': input.sessionId,
    'viwork.product_id': productId,
    'viwork.source': input.source ?? 'web',
    'viwork.agent_id': agent.id ?? 'agent',
    'langgraph.thread_id': memoryThread,
    'input.value': JSON.stringify(textLogValue(prompt)),
  }, async (span) => {
    const result = await agent.generate(prompt, {
      runId,
      traceId: input.traceId,
      source: input.source ?? 'web',
      productId,
      maxSteps,
      memory: { thread: memoryThread, resource: input.projectId },
    });
    span.setAttribute('output.value', JSON.stringify(textLogValue(result.text)));
    return result;
  });
}

function getSpecialistAgent(registry: AgentRegistry, agentId: string): LangGraphAgentClient | null {
  switch (agentId) {
    case 'brainstorm-agent': return registry.brainstorm;
    case 'character-agent': return registry.character;
    case 'continuity-agent': return registry.continuity;
    case 'story-agent': return registry.story;
    case 'source-analyst-agent': return registry.sourceAnalyst;
    case 'adaptation-planner-agent': return registry.adaptationPlanner;
    case 'screenwriter-agent': return registry.screenwriter;
    case 'reviewer-agent': return registry.reviewer;
    default: return null;
  }
}

export async function accumulateStreamText(stream: LangGraphStreamOutput['fullStream']): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of toAsyncIterable(stream)) {
    if (chunk.type === 'text-delta' && chunk.payload && typeof chunk.payload.text === 'string') {
      parts.push(chunk.payload.text);
    }
  }
  return parts.join('');
}

async function consumeLangGraphStreamAndAccumulate(
  stream: LangGraphStreamOutput['fullStream'],
  context: { emittedAt: () => string; publish: (event: StreamEvent) => void; runId: string },
  signal?: AbortSignal,
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
    if (signal?.aborted) break;
    handleLangGraphChunk(chunk, state, context);
    if (chunk.type === 'text-delta' && chunk.payload && typeof chunk.payload.text === 'string') {
      textParts.push(chunk.payload.text);
    }
  }
  return textParts.join('');
}

// --- Stream consuming (same as before, exported for backward compat) ---

async function consumeLangGraphStream(
  stream: LangGraphStreamOutput['fullStream'],
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
    handleLangGraphChunk(chunk, state, context);
  }
}

function handleLangGraphChunk(
  chunk: LangGraphStreamChunk,
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

async function* toAsyncIterable(stream: LangGraphStreamOutput['fullStream']): AsyncIterable<LangGraphStreamChunk> {
  const maybeAsyncIterable = stream as AsyncIterable<LangGraphStreamChunk>;
  if (Symbol.asyncIterator in maybeAsyncIterable) {
    yield* maybeAsyncIterable;
    return;
  }
  const reader = (stream as ReadableStream<LangGraphStreamChunk>).getReader();
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

function buildLangGraphPrompt(input: CreateRunInput, productProfile: ProductProfile): string {
  const referenceBlocks = (input.referencedFiles ?? []).map((file) =>
    `## @${file.label}\n路径：${file.path}\n（使用 read_workspace_file 工具读取内容）`,
  );
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

function buildSystemInstructions(productProfile: ProductProfile): string {
  const protocol = readSystemAgentProtocol(productProfile);
  return [
    ...productProfile.mastra.systemIntro,
    '## viwork 多 agent 工作协议',
    protocol,
  ].join('\n\n');
}

const CHOICE_DETECTION_SYSTEM_PROMPT = [
  '你是一个结构分析器。分析给定的助手回复，判断其中是否包含需要用户做出选择或确认的选项。',
  '以下情况判定为需要选择（hasChoice: true）：',
  '- 明确列出了 2~4 个可供选择的方案、选项或行动',
  '- 要求用户确认后才能继续（如"确认后我再生成"、"回复OK或生成我再调工具"）',
  '- 给出了 2~4 个可选的回复关键词让用户选择（如"回复A或B"）',
  '以下情况不算（hasChoice: false）：',
  '- 普通的开放式问答、解释说明、单一建议、已完成的操作性回复',
  '- 只是询问用户意见但没有给出具体可选项',
  '严格输出 JSON，不要输出其他内容。',
  '格式: {"hasChoice": boolean, "question": string, "options": [string, ...]}',
  'options 最多 4 个。hasChoice 为 false 时 question 和 options 可以省略。',
  '对于确认类选择，question 用助手的确认问题，options 为用户可选的回复关键词。',
].join('\n');

async function detectChoiceRequest(
  assistantText: string,
  publish: (event: StreamEvent) => void,
  runId: string,
  emittedAt: () => string,
): Promise<void> {
  if (!assistantText.trim()) {
    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.empty', runId });
    return;
  }

  if (!AIGC_HUB_API_KEY) {
    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.unconfigured', runId });
    return;
  }

  try {
    const baseUrl = AIGC_HUB_BASE_URL || 'https://api.yukeon.top/v1';
    const model = 'minimax/minimax-m2.7';
    const headers = buildAigcHubHeaders({ apiKey: AIGC_HUB_API_KEY, contentType: 'application/json' });

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: CHOICE_DETECTION_SYSTEM_PROMPT },
          { role: 'user', content: assistantText.slice(-8000) },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.http-error', runId, status: response.status });
      return;
    }

    const body = await response.json() as Record<string, unknown>;
    if (body.error) {
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.api-error', runId, error: body.error, model });
      return;
    }
    const choices = body.choices as Array<{ message?: { content?: string; reasoning_content?: string } & Record<string, unknown> }> | undefined;
    const raw = choices?.[0]?.message?.content?.trim();
    if (!raw) {
      const msg = choices?.[0]?.message;
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.empty-response', runId, messageKeys: msg ? Object.keys(msg) : null, reasoningLength: msg?.reasoning_content?.length ?? 0, reasoningPreview: msg?.reasoning_content?.slice(0, 200) });
      return;
    }

    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'llm-response', runId, raw });

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.no-json', runId, raw: cleaned });
      return;
    }

    let parsed: { hasChoice?: boolean; question?: string; options?: string[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.parse-error', runId, json: jsonMatch[0], error: parseError instanceof Error ? parseError.message : String(parseError) });
      return;
    }
    if (!parsed.hasChoice || !parsed.question || !Array.isArray(parsed.options) || parsed.options.length < 1) {
      appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.no-choice', runId, parsed });
      return;
    }

    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'published', runId, question: parsed.question, options: parsed.options });

    publish({
      type: 'choice.request',
      runId,
      emittedAt: emittedAt(),
      question: parsed.question,
      options: parsed.options.slice(0, 4) as [string, ...string[]],
    });
  } catch (error) {
    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'error', runId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function buildMainAgentInstructions(systemInstructions: string, behaviorRules: BehaviorRule[]): Promise<string> {
  const base = [
    systemInstructions,
    '## 主 agent 调度原则',
    '你是默认工作的主 agent，目标是提供自然的创作协作体验。',
    '普通问候、解释问题、读取资料、轻量修改、整理已有内容、保存用户明确指定的小改动，都由你直接完成。',
    '不要先做固定流程分类，不要因为用户提到剧本、方案或故事就自动启动完整流水线。',
    '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时，使用 generate_project_image 工具生成图片并保存到项目工作区。',
    '调用 generate_project_image 时只填写 prompt、aspectRatio、count；不要尝试填写或猜测模型名，图片模型由系统配置自动注入。',
    '如果用户只是要人物视觉描述、绘图提示词或图片生成建议，不要调用 generate_project_image，直接输出文本。',
    '系统只自动保留最近几轮短期对话；语义检索和长期记忆更新由你按任务需要主动调用工具。',
    '当当前上下文不足以确认早期设定、用户偏好、角色关系、伏笔、已否决方案或审稿标准时，调用 recall_project_memory。',
    '当需要查看或合并结构化项目长期记忆时，调用 read_project_memory；写回完整 Markdown 时调用 update_project_memory。',
    '当本轮产生了未来仍有复用价值的稳定事实、偏好、角色规则、连续性约束、已否决方向或质量标准时，调用 remember_project_memory 写入精选语义记忆。',
    '不要把一次性过程、临时推理、工具流水账、未经确认的猜测或整段对话写入长期记忆。',
    '只有当任务明确需要专业判断或专业产物时，才使用 delegate_to_specialist_agent 委派给 specialist agent。',
    '可委派的 specialist agent：brainstorm-agent、character-agent、continuity-agent、story-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent；如果对应 skill 未安装，工具会返回未找到。',
    '委派时只拆出必要的子任务，并把当前上下文、已读取文件摘要、用户目标和期望输出传给 specialist。',
    '收到 specialist 结果后，由你继续综合、解释、决定是否写入文件，并向用户给出最终答复。',
    '如果用户只是要求”帮我改一句/润色一段/解释这个文件/打个招呼”，不要委派。',
    '在情景剧故事创作中，如果人物动机、角色关系或角色行为边界不清，先委派 character-agent；如果涉及多集历史、固定设定或上一集状态，先委派 continuity-agent。',
    '如果用户明确要求”脑暴方向/完善人物/检查连续性/做原著分析/制定改编方案/写正式故事或剧本/严格审稿”，再委派给对应 specialist。',
  ];

  const localBase = base.join('\n\n');
  const resolved = await getPromptText('system-agent-instructions', localBase);

  const sections = [resolved];
  for (const rule of behaviorRules) {
    if (rule.enabled && rule.content.trim()) {
      sections.push(`## ${rule.label}\n\n${rule.content}`);
    }
  }

  return sections.join('\n\n');
}

function readSystemAgentProtocol(productProfile: ProductProfile): string {
  return productProfile.mastra.fallbackProtocol;
}

function stringPayload(chunk: LangGraphStreamChunk, key: string): string {
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

export const __langGraphRunServiceTest = {
  createWorkspaceTools,
};
