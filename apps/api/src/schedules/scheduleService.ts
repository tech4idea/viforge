import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { RunBus } from '../runs/runBus';
import type { RunService } from '../runs/runService';
import type { WechatIlinkClient } from '../wechat/wechatIlinkClient';
import type { WechatStore } from '../wechat/wechatStore';
import { createWechatSendContext } from '../wechat/wechatStore';
import type { ScheduleStore } from './scheduleStore';
import { computeNextRunAt } from './scheduleTime';
import type { AgentRun, ChatMessage, ScheduledTask, StreamEvent } from '@viwork/shared';

export type ScheduleRunNowResult = {
  task: ScheduledTask;
  run?: AgentRun;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
};

export type ScheduleService = {
  createTask(input: {
    projectId: string;
    sessionId: string;
    title?: string;
    sourcePrompt: string;
    schedule: ScheduledTask['schedule'];
    action: ScheduledTask['action'];
    nextRunAt: string;
  }): Promise<{ task: ScheduledTask; reply: string }>;
  executeTask(taskId: string): Promise<ScheduledTask | undefined>;
  executeTaskNow(taskId: string): Promise<ScheduleRunNowResult | undefined>;
  pauseTask(taskId: string): Promise<ScheduledTask | undefined>;
  resumeTask(taskId: string): Promise<ScheduledTask | undefined>;
  runDueNow(): Promise<void>;
  start(): void;
  stop(): void;
  setRunService(runService: RunService, runBus: RunBus): void;
};

const TICK_MS = 15_000;

export function createScheduleService(input: {
  scheduleStore: ScheduleStore;
  chatSessionStore: ChatSessionStore;
  wechatStore: WechatStore;
  ilinkClient: WechatIlinkClient;
}): ScheduleService {
  const { scheduleStore, chatSessionStore, wechatStore, ilinkClient } = input;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let runService: RunService | null = null;
  let runBus: RunBus | null = null;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const dueTasks = await scheduleStore.listTasks({ dueAt: new Date(), statuses: ['active'] });
      for (const task of dueTasks) {
        await executeDueTask(task.id);
      }
    } catch (error) {
      console.error('[schedule] tick failed', error);
    } finally {
      running = false;
    }
  }

  async function executeTask(taskId: string, options: { force?: boolean } = {}): Promise<ScheduledTask | undefined> {
    const current = (await scheduleStore.listTasks()).find((task) => task.id === taskId);
    if (!current) return undefined;
    if (current.status !== 'active') return current;
    if (!options.force) return current;

    try {
      const status = await wechatStore.getStatus();
      if (status.state !== 'connected' || !status.connection) {
        throw new Error('WeChat is not connected');
      }

      const runResult = await executeTaskAsChatMessage(current, {
        chatSessionStore,
        runService,
        runBus,
        wechatStore,
        ilinkClient,
        model: resolveScheduleChatModel(),
      });
      const now = new Date();
      const nextRunAt = computeNextRunAt(current, now);
      const nextRunPatch = nextRunAt ? { nextRunAt } : {};
      const updated = await scheduleStore.updateTask(taskId, (task) => ({
        ...task,
        status: nextRunAt ? 'active' : 'completed',
        ...nextRunPatch,
        lastRunAt: now.toISOString(),
        lastError: undefined,
      }));

      await chatSessionStore.appendMessage(current.sessionId, runResult.message);
      return updated;
    } catch (error) {
      return await scheduleStore.updateTask(taskId, (task) => ({
        ...task,
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Schedule execution failed',
      }));
    }
  }

  async function executeDueTask(taskId: string): Promise<ScheduledTask | undefined> {
    const current = (await scheduleStore.listTasks()).find((task) => task.id === taskId);
    if (!current || current.status !== 'active') return current;
    if (Date.parse(current.nextRunAt) > Date.now()) return current;
    return executeTask(taskId, { force: true });
  }

  async function executeTaskNow(taskId: string): Promise<ScheduleRunNowResult | undefined> {
    const current = (await scheduleStore.listTasks()).find((task) => task.id === taskId);
    if (!current) return undefined;
    if (current.status !== 'active') return { task: current };

    const status = await wechatStore.getStatus();
    if (status.state !== 'connected' || !status.connection) {
      const task = await scheduleStore.updateTask(taskId, (item) => ({
        ...item,
        status: 'error',
        lastError: 'WeChat is not connected',
      }));
      return task ? { task } : undefined;
    }

    try {
      const started = await startTaskAsStreamingChatRun(current, {
        chatSessionStore,
        runService,
        runBus,
        wechatStore,
        ilinkClient,
        model: resolveScheduleChatModel(),
      });

      void finalizeStreamingTaskRun(current, started.assistantMessage.id, started.run.id, {
        chatSessionStore,
        scheduleStore,
        runBus: runBus!,
      });

      return { task: current, ...started };
    } catch (error) {
      const task = await scheduleStore.updateTask(taskId, (item) => ({
        ...item,
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Schedule execution failed',
      }));
      return task ? { task } : undefined;
    }
  }

  return {
    async createTask({ projectId, sessionId, title, sourcePrompt, schedule, action, nextRunAt }) {
      const session = await chatSessionStore.getSession(sessionId);
      if (!session || session.projectId !== projectId) throw new Error('Chat session not found');

      const task = await scheduleStore.createTask({
        projectId,
        sessionId,
        title: title?.trim() || buildTaskTitle(schedule.frequency, getActionPrompt(action)),
        sourcePrompt,
        status: 'active',
        schedule,
        action,
        nextRunAt,
      });

      const reply = `已创建定时任务「${task.title}」，下次执行时间：${formatDateTime(task.nextRunAt)}。执行时会按任务要求实时生成内容并发送到已绑定微信。`;
      return { task, reply };
    },

    executeTask: (taskId) => executeTask(taskId, { force: true }),

    executeTaskNow,

    pauseTask(taskId) {
      return scheduleStore.updateTask(taskId, (task) => ({ ...task, status: 'paused' }));
    },

    resumeTask(taskId) {
      return scheduleStore.updateTask(taskId, (task) => ({ ...task, status: 'active', lastError: undefined }));
    },

    runDueNow: tick,

    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), TICK_MS);
      void tick();
      console.info('[schedule] scheduler started');
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.info('[schedule] scheduler stopped');
    },

    setRunService(service, bus) {
      runService = service;
      runBus = bus;
    },
  };
}

async function executeTaskAsChatMessage(task: ScheduledTask, context: {
  chatSessionStore: ChatSessionStore;
  runService: RunService | null;
  runBus: RunBus | null;
  wechatStore: WechatStore;
  ilinkClient: WechatIlinkClient;
  model?: string;
}): Promise<{ message: ChatMessage }> {
  const prompt = getActionPrompt(task.action);
  if (!context.runService || !context.runBus) {
    throw new Error('Schedule run service is not configured');
  }

  const userMessage = createScheduleUserMessage(buildScheduleUserMessage(task, prompt));
  await context.chatSessionStore.appendMessage(task.sessionId, userMessage);
  const userMessageContent = userMessage.content;

  const { run } = await context.runService.createRun({
    projectId: task.projectId,
    sessionId: task.sessionId,
    prompt: userMessageContent,
    model: context.model,
    source: 'schedule',
    wechat: createWechatSendContext({ wechatStore: context.wechatStore, ilinkClient: context.ilinkClient }),
  });

  const collected = await collectRunText(context.runBus, run.id);
  return { message: createScheduleAssistantMessage(collected.text, collected.events, collected.status) };
}

async function startTaskAsStreamingChatRun(task: ScheduledTask, context: {
  chatSessionStore: ChatSessionStore;
  runService: RunService | null;
  runBus: RunBus | null;
  wechatStore: WechatStore;
  ilinkClient: WechatIlinkClient;
  model?: string;
}): Promise<{ run: AgentRun; userMessage: ChatMessage; assistantMessage: ChatMessage }> {
  const prompt = getActionPrompt(task.action);
  if (!context.runService || !context.runBus) {
    throw new Error('Schedule run service is not configured');
  }

  const userMessageContent = buildScheduleUserMessage(task, prompt);
  const userMessage = createScheduleUserMessage(userMessageContent);
  const assistantMessage = createScheduleAssistantMessage('', [], 'success');
  assistantMessage.status = 'running';

  await context.chatSessionStore.appendMessage(task.sessionId, userMessage);
  await context.chatSessionStore.appendMessage(task.sessionId, assistantMessage);

  const { run } = await context.runService.createRun({
    projectId: task.projectId,
    sessionId: task.sessionId,
    prompt: userMessageContent,
    model: context.model,
    source: 'schedule',
    wechat: createWechatSendContext({ wechatStore: context.wechatStore, ilinkClient: context.ilinkClient }),
  });

  await context.chatSessionStore.updateMessage(task.sessionId, assistantMessage.id, { ...assistantMessage, runId: run.id });

  return { run, userMessage, assistantMessage: { ...assistantMessage, runId: run.id } };
}

async function finalizeStreamingTaskRun(task: ScheduledTask, assistantMessageId: string, runId: string, context: {
  chatSessionStore: ChatSessionStore;
  scheduleStore: ScheduleStore;
  runBus: RunBus;
}): Promise<void> {
  const collected = await collectRunText(context.runBus, runId);
  const assistantMessage = createScheduleAssistantMessage(collected.text, collected.events, collected.status);
  await context.chatSessionStore.updateMessage(task.sessionId, assistantMessageId, {
    ...assistantMessage,
    id: assistantMessageId,
    runId,
  });

  if (collected.status === 'error') {
    await context.scheduleStore.updateTask(task.id, (current) => ({
      ...current,
      status: 'error',
      lastError: collected.text,
    }));
    return;
  }

  const now = new Date();
  const nextRunAt = computeNextRunAt(task, now);
  const nextRunPatch = nextRunAt ? { nextRunAt } : {};
  await context.scheduleStore.updateTask(task.id, (current) => ({
    ...current,
    status: nextRunAt ? 'active' : 'completed',
    ...nextRunPatch,
    lastRunAt: now.toISOString(),
    lastError: undefined,
  }));
}

function resolveScheduleChatModel(): string | undefined {
  return process.env.VIWORK_WECHAT_CHAT_MODEL
    || process.env.VIWORK_AIGC_HUB_WECHAT_MODEL
    || 'minimax/minimax-m2.7';
}

function buildTaskTitle(frequency: ScheduledTask['schedule']['frequency'], prompt: string): string {
  const prefix = frequency === 'once' ? '一次提醒' : frequency === 'weekly' ? '每周提醒' : frequency === 'daily' ? '每日提醒' : '循环提醒';
  return `${prefix}: ${prompt.slice(0, 24)}`;
}

function getActionPrompt(action: ScheduledTask['action']): string {
  return action.prompt || action.message || '生成定时任务提醒内容';
}

function buildScheduleUserMessage(task: ScheduledTask, prompt: string): string {
  return [
    '这是一个定时任务执行请求。请按普通会话消息处理，但它来自系统定时触发。',
    '请根据当前会话上下文和项目资料，实时生成本次要发送到微信的内容，并调用 send_wechat_message 工具发送。',
    '发送完成后，在会话里简短说明本次定时任务已执行以及发送内容概要。',
    `任务标题：${task.title}`,
    `创建依据：${task.sourcePrompt}`,
    `本次生成要求：${prompt}`,
  ].join('\n');
}

function createScheduleUserMessage(content: string): ChatMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    attachments: [],
    referencedFiles: [],
    referencedSnippets: [],
    streamEvents: [],
    status: 'success',
    events: [],
  };
}

function createScheduleAssistantMessage(content: string, events: StreamEvent[], status: 'success' | 'error'): ChatMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
    attachments: [],
    referencedFiles: [],
    referencedSnippets: [],
    streamEvents: events,
    status,
    events: [],
  };
}

async function collectRunText(runBus: RunBus, runId: string): Promise<{ text: string; events: StreamEvent[]; status: 'success' | 'error' }> {
  return await new Promise((resolve) => {
    const parts: string[] = [];
    const events: StreamEvent[] = [];
    let done = false;
    const finish = (result: { text: string; status: 'success' | 'error' }) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timeout);
      resolve({ text: result.text.trim() || '定时任务已触发，但未生成有效内容。', events, status: result.status });
    };
    const unsubscribe = runBus.subscribe(runId, (event) => {
      events.push(event);
      if (event.type === 'text.delta') parts.push(event.delta);
      if (event.type === 'run.end') {
        if (event.status === 'error') {
          finish({ text: `定时任务内容生成失败：${event.errorMessage ?? '未知错误'}`, status: 'error' });
        } else {
          finish({ text: parts.join(''), status: 'success' });
        }
      }
    });
    const timeout = setTimeout(() => finish({ text: parts.join('') || '定时任务内容仍在生成中，请稍后查看工作台。', status: 'success' }), 5 * 60_000);
    timeout.unref?.();
  });
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
