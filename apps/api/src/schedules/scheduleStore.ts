import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ScheduledTask } from '@viwork/shared';

type ScheduleState = {
  tasks: ScheduledTask[];
};

export type ScheduleStore = {
  listTasks(input?: { sessionId?: string; projectId?: string; dueAt?: Date; statuses?: ScheduledTask['status'][] }): Promise<ScheduledTask[]>;
  createTask(input: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<ScheduledTask>;
  updateTask(taskId: string, update: (task: ScheduledTask) => ScheduledTask): Promise<ScheduledTask | undefined>;
  deleteTask(taskId: string): Promise<{ deleted: true; existed: boolean }>;
};

export function createScheduleStore(statePath: string): ScheduleStore {
  let queue: Promise<unknown> = Promise.resolve();

  function withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readState(): Promise<ScheduleState> {
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<ScheduleState>;
      return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isScheduledTask) : [] };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { tasks: [] };
      throw error;
    }
  }

  async function writeState(state: ScheduleState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tempPath, statePath);
  }

  return {
    async listTasks(input = {}) {
      return withLock(async () => {
        const state = await readState();
        return state.tasks
          .filter((task) => !input.sessionId || task.sessionId === input.sessionId)
          .filter((task) => !input.projectId || task.projectId === input.projectId)
          .filter((task) => !input.statuses || input.statuses.includes(task.status))
          .filter((task) => !input.dueAt || Date.parse(task.nextRunAt) <= input.dueAt.getTime())
          .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
      });
    },

    async createTask(input) {
      return withLock(async () => {
        const state = await readState();
        const now = new Date().toISOString();
        const task: ScheduledTask = { ...input, id: `schedule-${randomUUID()}`, createdAt: now, updatedAt: now };
        await writeState({ tasks: [task, ...state.tasks] });
        return task;
      });
    },

    async updateTask(taskId, update) {
      return withLock(async () => {
        const state = await readState();
        let updated: ScheduledTask | undefined;
        const tasks = state.tasks.map((task) => {
          if (task.id !== taskId) return task;
          updated = { ...update(task), updatedAt: new Date().toISOString() };
          return updated;
        });
        if (!updated) return undefined;
        await writeState({ tasks });
        return updated;
      });
    },

    async deleteTask(taskId) {
      return withLock(async () => {
        const state = await readState();
        const existed = state.tasks.some((task) => task.id === taskId);
        if (!existed) return { deleted: true, existed: false };
        await writeState({ tasks: state.tasks.filter((task) => task.id !== taskId) });
        return { deleted: true, existed: true };
      });
    },
  };
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<ScheduledTask>;
  const action = task.action as Partial<ScheduledTask['action']> | undefined;
  return typeof task.id === 'string'
    && typeof task.projectId === 'string'
    && typeof task.sessionId === 'string'
    && typeof task.nextRunAt === 'string'
    && action?.type === 'wechat_message'
    && (typeof action.prompt === 'string' || typeof action.message === 'string');
}
