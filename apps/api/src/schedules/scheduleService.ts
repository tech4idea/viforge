import type { ChatSessionStore } from '../chat/chatSessionStore';
import type { WechatIlinkClient } from '../wechat/wechatIlinkClient';
import type { WechatStore } from '../wechat/wechatStore';
import type { ScheduleStore } from './scheduleStore';
import { computeNextRunAt } from './scheduleTime';
import type { ScheduledTask } from '@viwork/shared';

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
  pauseTask(taskId: string): Promise<ScheduledTask | undefined>;
  resumeTask(taskId: string): Promise<ScheduledTask | undefined>;
  runDueNow(): Promise<void>;
  start(): void;
  stop(): void;
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

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const dueTasks = await scheduleStore.listTasks({ dueAt: new Date(), statuses: ['active'] });
      for (const task of dueTasks) {
        await executeTask(task.id);
      }
    } catch (error) {
      console.error('[schedule] tick failed', error);
    } finally {
      running = false;
    }
  }

  async function executeTask(taskId: string, options: { force?: boolean } = {}): Promise<ScheduledTask | undefined> {
    const current = (await scheduleStore.listTasks()).find((task) => task.id === taskId);
    if (!current || (!options.force && current.status !== 'active')) return current;

    try {
      const status = await wechatStore.getStatus();
      if (status.state !== 'connected' || !status.connection) {
        throw new Error('WeChat is not connected');
      }

      const contextToken = await wechatStore.getIlinkContextToken(status.connection.externalUserId) ?? '';
      await ilinkClient.sendText({ to: status.connection.externalUserId, text: current.action.message, contextToken });
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

      await chatSessionStore.appendMessage(current.sessionId, {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: `定时任务已执行，并已发送微信消息：${current.action.message}`,
        createdAt: now.toISOString(),
        attachments: [],
        referencedFiles: [],
        referencedSnippets: [],
        streamEvents: [],
        status: 'success',
        events: [],
      });
      return updated;
    } catch (error) {
      return await scheduleStore.updateTask(taskId, (task) => ({
        ...task,
        status: 'error',
        lastError: error instanceof Error ? error.message : 'Schedule execution failed',
      }));
    }
  }

  return {
    async createTask({ projectId, sessionId, title, sourcePrompt, schedule, action, nextRunAt }) {
      const session = await chatSessionStore.getSession(sessionId);
      if (!session || session.projectId !== projectId) throw new Error('Chat session not found');

      const task = await scheduleStore.createTask({
        projectId,
        sessionId,
        title: title?.trim() || buildTaskTitle(schedule.frequency, action.message),
        sourcePrompt,
        status: 'active',
        schedule,
        action,
        nextRunAt,
      });

      const reply = `已创建定时任务「${task.title}」，下次执行时间：${formatDateTime(task.nextRunAt)}。执行时会向已绑定微信发送：${task.action.message}`;
      return { task, reply };
    },

    executeTask: (taskId) => executeTask(taskId, { force: true }),

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
  };
}

function buildTaskTitle(frequency: ScheduledTask['schedule']['frequency'], message: string): string {
  const prefix = frequency === 'once' ? '一次提醒' : frequency === 'weekly' ? '每周提醒' : frequency === 'daily' ? '每日提醒' : '循环提醒';
  return `${prefix}: ${message.slice(0, 24)}`;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
