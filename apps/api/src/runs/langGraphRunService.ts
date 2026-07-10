import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveProductProfile, type ProductProfile, type Project, type RunArtifact, type StreamEvent, type WorkspaceEntry } from '@viforge/shared';
import { z } from 'zod';

import { LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, PRODUCT_PROFILE } from '../env';
import { buildAigcHubHeaders } from '../aigcHubHeaders';
import { appendJsonLog } from '../logger';
import type { WorkspaceStore } from '../storage/workspaceStore';
import type { BehaviorRule } from '../storage/behaviorRulesStore';
import { createBehaviorRulesStore } from '../storage/behaviorRulesStore';
import type { GitService } from '../storage/gitService';
import type { GitConfigStore } from '../storage/gitConfigStore';
import { createPlaywriterService, type PlaywriterService } from '../browser/playwriterService';
import type { EvalRunExecutorInput, EvalRunExecutorResult, HarnessStore } from '../harness/harnessStore';
import { isPhoenixTracingEnabled, withPhoenixSpan } from '../observability/phoenix';
import type { ScheduleService } from '../schedules/scheduleService';

import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

import { createAgentRegistry, createTool, createWorkspaceTools, type AgentRegistry, type LangGraphAgentClient, type LangGraphAgentInput, type LangGraphStreamChunk, type LangGraphStreamOutput, type LangGraphToolset } from './langGraphAgents';
import { getPromptText } from './langfusePromptStore';

type LangGraphRunOptions = {
  createAgent?: (context: {
    instructions: string;
    tools: ReturnType<typeof createWorkspaceTools>;
  }) => LangGraphAgentClient;
  createAgentRegistry?: (
    tools: ReturnType<typeof createWorkspaceTools>,
    context: { model?: string; baseUrl?: string; apiKey?: string; connectionString?: string; traceId?: string; productProfile?: ProductProfile; layerConfig?: NonNullable<EvalRunExecutorInput['resolvedAgentConfig']>['layerConfig'] },
  ) => Promise<AgentRegistry>;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  connectionString?: string;
  productProfile?: ProductProfile;
  gitService?: GitService;
  gitConfigStore?: GitConfigStore;
  browserService?: PlaywriterService;
  harnessStore?: HarnessStore;
  scheduleService?: ScheduleService;
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

type IsolatedWorkspaceStoreOptions = {
  workspaceRoot: string;
  productProfile: ProductProfile;
  delegate: WorkspaceStore;
};

const SPECIALIST_AGENT_LABELS: Record<string, string> = {
  'brainstorm-agent': '脑暴',
  'character-agent': '人物设定',
  'continuity-agent': '连续性检查',
  'story-agent': '故事创作',
  'source-analyst-agent': '原著分析',
  'adaptation-planner-agent': '改编方案',
  'screenwriter-agent': '编剧',
  'outline-agent': '学习大纲',
  'knowledge-search-agent': '知识点搜索',
  'knowledge-organizer-agent': '知识点整理',
  'reviewer-agent': '审稿',
};

const EVAL_PROJECT_ID = 'eval-project';

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
      const runId = input.runId ?? `run_${randomUUID()}`;
      const traceId = input.traceId ?? runId;
      const run = {
        id: runId,
        inputSnapshotId: input.inputSnapshotId,
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

export function createLangGraphEvalRunExecutor(
  store: WorkspaceStore,
  options: LangGraphRunOptions = {},
): (input: EvalRunExecutorInput) => Promise<EvalRunExecutorResult> {
  return async (input) => {
    const productProfile = input.agentSpec.productId
      ? resolveEvalProductProfile(input.agentSpec.productId, options.productProfile)
      : options.productProfile ?? PRODUCT_PROFILE;
    const isolatedStore = createIsolatedWorkspaceStore({
      workspaceRoot: input.workspaceRoot,
      productProfile,
      delegate: store,
    });
    const runId = input.evalRunId;
    const traceId = `eval:${input.evalRunId}`;
    const startedAt = new Date();
    const toolEvents: StreamEvent[] = [];
    const publish = (event: StreamEvent) => {
      toolEvents.push(event);
      input.onEvent?.(event);
    };
    const emittedAt = () => new Date().toISOString();
    const prompt = buildEvalRunPrompt(input);
    const evalModel = resolveEvalModel(input, options.model);
    const evalLayerConfig = buildEvalLayerConfigWithPromptBlocks(input);
    const runInput: CreateRunInput = {
      runId,
      projectId: EVAL_PROJECT_ID,
      prompt: stringifyAgentInput(prompt),
      source: 'eval',
      traceId,
      referencedSnippets: input.fixture.referencedSnippets,
    };
    const registryOptions = {
      ...options,
      model: evalModel,
      traceId,
      productProfile,
      layerConfig: evalLayerConfig,
    };
    const tools = createWorkspaceTools(isolatedStore, runInput.projectId, publish, runId, emittedAt, {
      traceId,
      gitService: options.gitService,
      gitConfigStore: options.gitConfigStore,
      browserService: options.browserService ?? createPlaywriterService(),
      memoryFixture: input.runMode === 'repro' ? input.fixture.memoryFixture : undefined,
      mockMemoryWrites: true,
      knowledgeFixture: input.runMode === 'repro' ? input.fixture.knowledgeFixture : undefined,
    });
    const registry = options.createAgentRegistry
      ? await options.createAgentRegistry(tools, registryOptions)
      : options.createAgent
        ? null
        : await createAgentRegistry(isolatedStore, registryOptions, tools);

    let outputMessage = '';
    if (options.createAgent) {
      const instructions = buildSystemInstructions(productProfile, evalLayerConfig);
      const singleAgentTools = registry
        ? { ...tools, delegate_to_specialist_agent: createSpecialistDelegationTool({ registry, publish, emittedAt, runId, threadId: runId, input: runInput, productId: productProfile.id }) }
        : tools;
      const agent = options.createAgent({ instructions, tools: singleAgentTools });
      const streamed = await agent.stream(prompt, {
        runId,
        traceId,
        source: 'eval',
        productId: productProfile.id,
        maxSteps: 25,
        memory: { thread: runId, resource: runInput.projectId },
      });
      outputMessage = await consumeLangGraphStreamAndAccumulate(streamed.fullStream, { emittedAt, publish, runId });
    } else {
      outputMessage = await executeMultiAgentWorkflow({
        registry: registry!,
        store: isolatedStore,
        input: runInput,
        productProfile,
        prompt: stringifyAgentInput(prompt),
        publish,
        emittedAt,
        runId,
        threadId: runId,
        options,
      });
    }

    toolEvents.push({ type: 'run.end', runId, emittedAt: emittedAt(), status: 'success', errorMessage: null });
    return {
      executionMode: 'langgraph_isolated',
      status: 'passed',
      outputMessage: outputMessage || `LangGraph isolated EvalRun completed in ${Date.now() - startedAt.getTime()}ms with model ${evalModel ?? 'runtime default'}.`,
      toolEvents,
    };
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
    void options.harnessStore?.recordRunArtifactEvent({
      runId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      inputSnapshotId: input.inputSnapshotId,
      traceId: input.traceId,
      model: input.model,
      modelParams: resolveRunModelParams(input.model),
      prompt: input.prompt,
      referencedFiles: input.referencedFiles,
      referencedSnippets: input.referencedSnippets,
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
      browserService: options.browserService ?? createPlaywriterService(),
    });
    const runTools = input.sessionId && options.scheduleService && input.source !== 'schedule'
      ? { ...tools, create_scheduled_task: createScheduledTaskTool({ scheduleService: options.scheduleService, projectId: input.projectId, sessionId: input.sessionId }) }
      : tools;
    // Create agent registry from skills
    const registryOptions = {
      ...options,
      model: input.model ?? options.model,
      traceId: input.traceId,
      productProfile,
    };
    const registry = options.createAgentRegistry
      ? await options.createAgentRegistry(runTools, registryOptions)
      : options.createAgent
        ? null
        : await createAgentRegistry(store, registryOptions, runTools);

    // Build the combined prompt with references.
    const prompt = buildLangGraphPrompt(input, productProfile);

    // Run the multi-agent workflow
    let assistantText = '';
    if (options.createAgent) {
      // Backward compat: single agent mode
      const instructions = buildSystemInstructions(productProfile);
      const singleAgentTools = registry
        ? { ...runTools, delegate_to_specialist_agent: createSpecialistDelegationTool({ registry, publish, emittedAt, runId, threadId, input, productId: productProfile.id }) }
        : runTools;
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
  }
}

function resolveRunModelParams(model: string | undefined): RunArtifact['modelParams'] {
  return {
    model,
    temperature: undefined,
    maxSteps: 25,
    source: model ? 'run_input' : 'runtime_default',
  };
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
    browserService: options.browserService ?? createPlaywriterService(),
  });
  const scheduleTools: LangGraphToolset = input.sessionId && options.scheduleService && input.source !== 'schedule'
    ? { create_scheduled_task: createScheduledTaskTool({ scheduleService: options.scheduleService, projectId: input.projectId, sessionId: input.sessionId }) } as LangGraphToolset
    : {} as LangGraphToolset;
  const orchestrationTools: LangGraphToolset = {
    ...baseTools,
    ...scheduleTools,
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
      '将明确需要专业创作能力的子任务交给一个 viforge specialist agent。',
      '普通问候、解释、简单修改、文件读写和一般对话不要使用此工具，由主 agent 直接完成。',
      '只有在任务明确属于脑暴、人物设定、连续性检查、原著分析、改编方案、故事/剧本创作、学习大纲、知识点搜索、知识点整理或审稿复盘时才委派。',
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
        'outline-agent',
        'knowledge-search-agent',
        'knowledge-organizer-agent',
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

function createScheduledTaskTool({
  scheduleService,
  projectId,
  sessionId,
}: {
  scheduleService: ScheduleService;
  projectId: string;
  sessionId: string;
}) {
  return createTool({
    id: 'create_scheduled_task',
    description: [
      '创建绑定当前会话的定时任务。',
      '仅当用户明确要求在未来某个时间、周期性、每天、每周、每隔一段时间执行提醒或通知时调用。',
      '本工具只负责创建任务，不会立即发送微信消息；任务到期后会启动一次 schedule 来源的 agent run。',
      '当前 MVP 的任务动作是在执行时实时生成一条微信消息，并由执行 run 调用 send_wechat_message 发送给已绑定微信。',
      '不要在创建任务时提前写死将来要发送的正文。',
      '如果用户没有给出可执行时间或实时生成内容的要求，先追问，不要创建任务。',
    ].join('\n'),
    inputSchema: z.object({
      title: z.string().min(1).optional().describe('任务标题，简短描述该提醒任务'),
      sourcePrompt: z.string().min(1).describe('用户原始请求或你归纳的创建依据'),
      nextRunAt: z.string().datetime().describe('下一次执行时间，ISO 8601 格式，如 2026-07-06T01:00:00.000Z（即北京时间 09:00，注意当前时区为 Asia/Shanghai，UTC 需减 8 小时）'),
      schedule: z.object({
        frequency: z.enum(['once', 'minutes', 'hourly', 'daily', 'weekly']).describe('执行频率'),
        intervalMinutes: z.number().int().min(1).optional().describe('frequency=minutes 时的间隔分钟数'),
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('daily/weekly/hourly 使用的 HH:mm 时间（本地时区，如 "09:00" 表示上午 9 点）'),
        dayOfWeek: z.number().int().min(0).max(6).optional().describe('frequency=weekly 时使用，0=周日，1=周一'),
        timezone: z.string().min(1).default('Asia/Shanghai').describe('时区，IANA 时区名，默认 Asia/Shanghai；用户说"北京时间/上海时间"时填 Asia/Shanghai，其它地区按实际填写，如 America/New_York'),
      }),
      messagePrompt: z.string().min(1).describe('任务执行时用于实时生成微信消息的要求，不是最终固定正文。例如："根据今天会话进展总结一个写作提醒"'),
    }),
    execute: async ({ title, sourcePrompt, nextRunAt, schedule, messagePrompt }) => {
      const result = await scheduleService.createTask({
        projectId,
        sessionId,
        title,
        sourcePrompt,
        schedule,
        action: { type: 'wechat_message', prompt: messagePrompt },
        nextRunAt,
      });
      return result;
    },
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
    'viforge.run_id': runId,
    'viforge.trace_id': input.traceId,
    'viforge.project_id': input.projectId,
    'viforge.session_id': input.sessionId,
    'viforge.product_id': productId,
    'viforge.source': input.source ?? 'web',
    'viforge.agent_id': agent.id ?? 'agent',
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
    'viforge.run_id': runId,
    'viforge.trace_id': input.traceId,
    'viforge.project_id': input.projectId,
    'viforge.session_id': input.sessionId,
    'viforge.product_id': productId,
    'viforge.source': input.source ?? 'web',
    'viforge.agent_id': agent.id ?? 'agent',
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
    case 'outline-agent': return registry.outline;
    case 'knowledge-search-agent': return registry.knowledgeSearch;
    case 'knowledge-organizer-agent': return registry.knowledgeOrganizer;
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

function buildSystemInstructions(productProfile: ProductProfile, layerConfig?: NonNullable<EvalRunExecutorInput['resolvedAgentConfig']>['layerConfig']): string {
  if (layerConfig?.systemAgent.instructionOverride?.trim()) {
    return layerConfig.systemAgent.instructionOverride.trim();
  }
  const protocol = readSystemAgentProtocol(productProfile);
  return [
    ...productProfile.mastra.systemIntro,
    '## viforge 多 agent 工作协议',
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

  const apiKey = process.env.VIFORGE_AIGC_HUB_API_KEY || process.env.AIGC_HUB_API_KEY || '';
  if (!apiKey) {
    appendJsonLog('api-runs.jsonl', { scope: 'choice-detect', stage: 'skip.unconfigured', runId });
    return;
  }

  try {
    const baseUrl = process.env.VIFORGE_AIGC_HUB_BASE_URL || process.env.AIGC_HUB_BASE_URL || 'https://api.yukeon.top/v1';
    const model = 'minimax/minimax-m2.7';
    const headers = buildAigcHubHeaders({ apiKey, contentType: 'application/json' });

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
    '当用户明确要求创建定时任务、提醒、每天/每周/每隔一段时间向微信发送消息时，使用 create_scheduled_task 工具创建绑定当前会话的任务。',
    '调用 create_scheduled_task 前必须确认有明确的 nextRunAt、频率和执行时内容生成要求；缺少时间或生成要求时先追问。',
    '创建定时任务后，用简短文字告诉用户任务标题、下次执行时间和执行时会实时生成微信内容。',
    'send_wechat_message 只用于当前 run 立即发送微信文本，不用于创建未来或周期性发送任务。',
    '当用户要求访问网页、读取当前浏览器页面、用已登录网页查资料、搜索知识点或整理在线资料时，使用 browser_status、browser_navigate、browser_snapshot 和 browser_evaluate。',
    '当用户明确要求把项目工作区文件上传到网页时，先确认目标页面和操作，再使用 browser_upload_file 选择文件；上传后的提交、发布或修改远端数据仍需用户确认。',
    '如果用户需要启用浏览器访问，或 browser_status/browser_navigate 提示 Playwriter 未安装、relay 不可达、没有授权标签页，调用 browser_use_install 给出安装和连接指引。',
    '浏览器工具基于 Playwriter，连接用户授权的真实浏览器标签页。优先用 browser_snapshot 获取页面文字和 aria-ref，再用 browser_evaluate 做必要点击、输入、等待或结构化提取。',
    '涉及登录、提交、购买、删除、发布、授权、付款或修改远端数据的浏览器操作，必须先向用户说明将执行的动作并等待确认。',
    '如果 Playwriter 未连接，直接告诉用户需要安装/启用 Playwriter 扩展并授权标签页；非桌面部署还需要启动 playwriter serve。不要假装已访问网页。',
    '系统只自动保留最近几轮短期对话；语义检索和长期记忆更新由你按任务需要主动调用工具。',
    '当当前上下文不足以确认早期设定、用户偏好、角色关系、伏笔、已否决方案或审稿标准时，调用 recall_project_memory。',
    '当需要查看或合并结构化项目长期记忆时，调用 read_project_memory；写回完整 Markdown 时调用 update_project_memory。',
    '当本轮产生了未来仍有复用价值的稳定事实、偏好、角色规则、连续性约束、已否决方向或质量标准时，调用 remember_project_memory 写入精选语义记忆。',
    '不要把一次性过程、临时推理、工具流水账、未经确认的猜测或整段对话写入长期记忆。',
    '只有当任务明确需要专业判断或专业产物时，才使用 delegate_to_specialist_agent 委派给 specialist agent。',
    '可委派的 specialist agent：brainstorm-agent、character-agent、continuity-agent、story-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、outline-agent、knowledge-search-agent、knowledge-organizer-agent、reviewer-agent；如果对应 skill 未安装，工具会返回未找到。',
    '委派时只拆出必要的子任务，并把当前上下文、已读取文件摘要、用户目标和期望输出传给 specialist。',
    '收到 specialist 结果后，由你继续综合、解释、决定是否写入文件，并向用户给出最终答复。',
    '如果用户只是要求”帮我改一句/润色一段/解释这个文件/打个招呼”，不要委派。',
    '在情景剧故事创作中，如果人物动机、角色关系或角色行为边界不清，先委派 character-agent；如果涉及多集历史、固定设定或上一集状态，先委派 continuity-agent。',
    '如果用户明确要求”脑暴方向/完善人物/检查连续性/做原著分析/制定改编方案/写正式故事或剧本/严格审稿/生成学习大纲/搜索知识点/整理资料”，再委派给对应 specialist。',
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

function buildEvalRunPrompt(input: EvalRunExecutorInput): LangGraphAgentInput {
  const messages = input.fixture.inputMessages;
  if (messages.length === 0) return '请继续。';
  if (messages.length === 1) return messages[0]?.content || '请继续。';
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function stringifyAgentInput(input: LangGraphAgentInput): string {
  if (typeof input === 'string') return input;
  return input.map((message) => `${message.role}: ${message.content}`).join('\n\n');
}

function buildEvalLayerConfigWithPromptBlocks(input: EvalRunExecutorInput): NonNullable<EvalRunExecutorInput['resolvedAgentConfig']>['layerConfig'] | undefined {
  const layerConfig = input.resolvedAgentConfig?.layerConfig;
  if (!layerConfig) return undefined;
  const behaviorRules = (input.resolvedAgentConfig?.promptBlocks ?? [])
    .filter((block) => input.agentSpec.promptBlockRefs.includes(block.ref) && block.content?.trim())
    .map((block) => `### ${block.ref}\n${block.content!.trim()}`);
  if (behaviorRules.length === 0) return layerConfig;

  const behaviorSection = ['## Agent 行为规则', ...behaviorRules].join('\n\n');
  if (input.agentSpec.agentId === 'system') {
    return {
      ...layerConfig,
      systemAgent: {
        ...layerConfig.systemAgent,
        instructionOverride: appendInstructionSection(layerConfig.systemAgent.instructionOverride, behaviorSection),
      },
    };
  }

  return {
    ...layerConfig,
    specialists: layerConfig.specialists.map((specialist) => specialist.agentId === input.agentSpec.agentId
      ? { ...specialist, instructionOverride: appendInstructionSection(specialist.instructionOverride, behaviorSection) }
      : specialist),
  };
}

function appendInstructionSection(base: string | undefined, section: string): string {
  return [base?.trim(), section.trim()].filter(Boolean).join('\n\n');
}

function formatResolvedEvalConfig(input: EvalRunExecutorInput): string {
  const config = input.resolvedAgentConfig;
  const layer = config?.layerConfig;
  const specialists = layer?.specialists
    .filter((specialist) => specialist.defaultEnabled)
    .map((specialist) => `- ${specialist.agentId}: skill=${specialist.skillRef ?? 'none'}, tools=${(specialist.allowedTools ?? []).join(',') || 'default'}, prompts=${specialist.promptBlockRefs.join(',') || 'none'}`)
    .join('\n') || '- none';
  const manifest = config?.workspaceManifest;
  const manifestArtifacts = manifest
    ? Object.entries(manifest.artifactTypes).map(([artifactType, artifact]) => `- ${artifactType}: ${artifact.canonicalPath}; sections=${artifact.requiredSections.join(',') || 'none'}`).join('\n')
    : '- none';
  return [
    `agentSpec: ${input.agentSpec.id} (${input.agentSpec.productId}/${input.agentSpec.agentId} v${input.agentSpec.version})`,
    `modelPolicyRef: ${config?.modelPolicyRef ?? input.agentSpec.modelPolicyRef ?? 'runtime-default'}`,
    `toolPolicyRef: ${config?.toolPolicyRef ?? input.agentSpec.toolPolicyRef ?? 'runtime-default'}`,
    `memoryPolicy: ${config?.memoryPolicy ? `${config.memoryPolicy.id}@${config.memoryPolicy.version}` : 'none'}`,
    `retrievalPolicy: ${config?.retrievalPolicy ? `${config.retrievalPolicy.id}@${config.retrievalPolicy.version}` : 'none'}`,
    `promptBlocks: ${(config?.promptBlockRefs ?? input.agentSpec.promptBlockRefs).join(',') || 'none'}`,
    `skillRefs: ${(config?.skillRefs ?? input.agentSpec.skillRefs).map((skill) => `${skill.skillId}${skill.version ? `@${skill.version}` : ''}${skill.contentHash ? `#${skill.contentHash}` : ''}`).join(',') || 'none'}`,
    '',
    'systemAgent:',
    `- ${layer?.systemAgent.agentId ?? 'system'}: tools=${layer?.systemAgent.allowedTools.join(',') || 'default'}, prompts=${layer?.systemAgent.promptBlockRefs.join(',') || 'none'}`,
    '',
    'specialists:',
    specialists,
    '',
    'workspaceManifest:',
    manifest ? `product=${manifest.productId}, template=${manifest.templateVersion}, requiredDirectories=${manifest.requiredDirectories.join(',') || 'none'}` : 'none',
    manifestArtifacts,
  ].join('\n');
}

function resolveEvalProductProfile(productId: string, fallback?: ProductProfile): ProductProfile {
  try {
    return resolveProductProfile(productId);
  } catch {
    return fallback ?? PRODUCT_PROFILE;
  }
}

function resolveEvalModel(input: EvalRunExecutorInput, fallback?: string): string | undefined {
  if (input.modelParams?.model) return input.modelParams.model;
  if (input.model) return input.model;
  const modelPolicy = input.resolvedAgentConfig?.modelPolicyRef ?? input.agentSpec.modelPolicyRef ?? input.resolvedAgentConfig?.agentSpec?.modelPolicyRef;
  if (modelPolicy && !modelPolicy.includes('@')) return modelPolicy;
  return fallback;
}

function createIsolatedWorkspaceStore({ workspaceRoot, productProfile, delegate }: IsolatedWorkspaceStoreOptions): WorkspaceStore {
  const now = new Date().toISOString();
  const project: Project = {
    id: EVAL_PROJECT_ID,
    productId: productProfile.id,
    name: 'Agent Harness Eval Workspace',
    description: 'Isolated workspace for Agent Harness EvalRun.',
    createdAt: now,
    updatedAt: now,
    temporary: true,
  };

  function assertProject(id: string): void {
    if (id !== EVAL_PROJECT_ID) throw new Error('EvalRun isolated workspace only exposes the fixture project');
  }

  function safePath(filePath: string): { relativePath: string; absolutePath: string } {
    if (path.isAbsolute(filePath)) throw new Error('Invalid workspace path');
    const relativePath = normalizeEvalWorkspacePath(filePath);
    if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Invalid workspace path');
    }
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    const relativeToRoot = path.relative(workspaceRoot, absolutePath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) throw new Error('Invalid workspace path');
    return { relativePath, absolutePath };
  }

  return {
    async createProject() { throw new Error('EvalRun isolated workspace cannot create projects'); },
    async createTemporaryProject() { return project; },
    async deleteProject(id) { assertProject(id); throw new Error('EvalRun isolated workspace cannot delete projects'); },
    async listProjects() { return [project]; },
    async getProject(id) { return id === EVAL_PROJECT_ID ? project : undefined; },
    async updateProject(id) { assertProject(id); return project; },
    async updateProjectGitConfig(id) { assertProject(id); return project; },
    getProjectRoot(id) { assertProject(id); return workspaceRoot; },
    getGlobalRoot: () => delegate.getGlobalRoot(),
    async getProjectProductProfile(id) { assertProject(id); return productProfile; },
    listGlobalWorkspaceEntries: () => delegate.listGlobalWorkspaceEntries(),
    readGlobalWorkspaceFile: (filePath) => delegate.readGlobalWorkspaceFile(filePath),
    readGlobalWorkspaceFileBytes: (filePath) => delegate.readGlobalWorkspaceFileBytes(filePath),
    async writeGlobalWorkspaceFile() { throw new Error('EvalRun isolated workspace cannot write global workspace files'); },
    async createGlobalWorkspaceFolder() { throw new Error('EvalRun isolated workspace cannot create global workspace folders'); },
    async createGlobalWorkspaceFile() { throw new Error('EvalRun isolated workspace cannot create global workspace files'); },
    async createGlobalWorkspaceAsset() { throw new Error('EvalRun isolated workspace cannot create global workspace assets'); },
    async moveGlobalWorkspaceEntry() { throw new Error('EvalRun isolated workspace cannot move global workspace entries'); },
    async deleteGlobalWorkspaceEntry() { throw new Error('EvalRun isolated workspace cannot delete global workspace entries'); },
    async listWorkspaceEntries(id, options) {
      assertProject(id);
      if (options?.query) return listEvalEntriesSearch(workspaceRoot, options.query);
      return listEvalEntriesShallow(workspaceRoot, options?.path, safePath);
    },
    async readWorkspaceFile(id, filePath) {
      assertProject(id);
      const { relativePath, absolutePath } = safePath(filePath);
      return { path: relativePath, content: await readFile(absolutePath, 'utf8') };
    },
    async readWorkspaceFileBytes(id, filePath) {
      assertProject(id);
      const { relativePath, absolutePath } = safePath(filePath);
      return { path: relativePath, bytes: await readFile(absolutePath), mimeType: inferEvalMimeType(relativePath) };
    },
    async writeWorkspaceFile(id, filePath, content) {
      assertProject(id);
      const { relativePath, absolutePath } = safePath(filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
      return { path: relativePath, content };
    },
    async createWorkspaceFolder(id, folderPath) {
      assertProject(id);
      const { relativePath, absolutePath } = safePath(folderPath);
      await mkdir(absolutePath, { recursive: true });
      return { path: relativePath, name: path.posix.basename(relativePath), type: 'directory' };
    },
    async createWorkspaceFile(id, filePath, content) { return this.writeWorkspaceFile(id, filePath, content); },
    async createWorkspaceAsset(id, filePath, bytes, mimeType) {
      assertProject(id);
      const { relativePath, absolutePath } = safePath(filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes);
      const fileStat = await stat(absolutePath);
      return { path: relativePath, name: path.posix.basename(relativePath), type: 'file', size: fileStat.size, updatedAt: fileStat.mtime.toISOString(), mimeType: mimeType ?? inferEvalMimeType(relativePath) };
    },
    async moveWorkspaceEntry(id, sourcePath, targetPath) {
      assertProject(id);
      const source = safePath(sourcePath);
      const target = safePath(targetPath);
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
      const movedStat = await stat(target.absolutePath);
      return {
        path: target.relativePath,
        name: path.posix.basename(target.relativePath),
        type: movedStat.isDirectory() ? 'directory' : 'file',
        ...(movedStat.isFile() ? { size: movedStat.size, updatedAt: movedStat.mtime.toISOString(), mimeType: inferEvalMimeType(target.relativePath) } : {}),
      };
    },
    async deleteWorkspaceEntry(id, entryPath) {
      assertProject(id);
      const { absolutePath } = safePath(entryPath);
      await rm(absolutePath, { recursive: true, force: false });
      return { deleted: true };
    },
  };
}

async function listEvalEntriesShallow(
  root: string,
  subPath: string | undefined,
  safePath: (filePath: string) => { absolutePath: string },
): Promise<WorkspaceEntry[]> {
  const targetDir = subPath ? safePath(subPath).absolutePath : root;
  const entries: WorkspaceEntry[] = [];
  const directoryEntries = await readdir(targetDir, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (targetDir === root && entry.name === 'project.json') continue;
    if (entry.name === '.git') continue;
    const absolutePath = path.join(targetDir, entry.name);
    const relativePath = normalizeEvalWorkspacePath(path.relative(root, absolutePath));
    if (entry.isDirectory()) {
      entries.push({ path: relativePath, name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      const fileStat = await stat(absolutePath);
      entries.push({ path: relativePath, name: entry.name, type: 'file', size: fileStat.size, updatedAt: fileStat.mtime.toISOString(), mimeType: inferEvalMimeType(relativePath) });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function listEvalEntriesSearch(root: string, query: string): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  const normalizedQuery = query.toLowerCase();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeEvalWorkspacePath(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && (entry.name.toLowerCase().includes(normalizedQuery) || relativePath.toLowerCase().includes(normalizedQuery))) {
        const fileStat = await stat(absolutePath);
        entries.push({ path: relativePath, name: entry.name, type: 'file', size: fileStat.size, updatedAt: fileStat.mtime.toISOString(), mimeType: inferEvalMimeType(relativePath) });
      }
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeEvalWorkspacePath(filePath: string): string {
  return path.normalize(filePath).replaceAll(path.sep, '/');
}

function inferEvalMimeType(filePath: string): string {
  if (/\.md$/i.test(filePath)) return 'text/markdown; charset=utf-8';
  if (/\.txt$/i.test(filePath)) return 'text/plain; charset=utf-8';
  if (/\.toml$/i.test(filePath)) return 'text/plain; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json; charset=utf-8';
  if (/\.csv$/i.test(filePath)) return 'text/csv; charset=utf-8';
  if (/\.ya?ml$/i.test(filePath)) return 'application/yaml; charset=utf-8';
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (/\.gif$/i.test(filePath)) return 'image/gif';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  return 'application/octet-stream';
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
