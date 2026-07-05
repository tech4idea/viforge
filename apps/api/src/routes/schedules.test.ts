import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatSessionStore } from '../chat/chatSessionStore';
import { createWechatStore } from '../wechat/wechatStore';
import { createScheduleService } from '../schedules/scheduleService';
import { createScheduleStore } from '../schedules/scheduleStore';
import { createScheduleRoutes } from './schedules';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-schedules-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('schedule routes', () => {
  it('executes due tasks by sending a WeChat message and completing one-off tasks', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-05T02:00:00.000Z'));
      const sent: Array<{ to: string; text: string }> = [];
      const chatStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
      const scheduleStore = createScheduleStore(path.join(root, 'scheduled-tasks.json'));
      const wechatStore = createWechatStore(path.join(root, 'wechat.json'));
      const setup = await wechatStore.createSetupSession();
      await wechatStore.completeSetupSession(setup.sessionId, { displayName: '编剧微信', externalUserId: 'writer-openid' });
      const scheduleService = createScheduleService({
        scheduleStore,
        chatSessionStore: chatStore,
        wechatStore,
        ilinkClient: {
          sendText: async (input: { to: string; text: string }) => { sent.push({ to: input.to, text: input.text }); },
        } as any,
      });
      const session = await chatStore.createSession('project-1');
      const { task } = await scheduleService.createTask({
        projectId: 'project-1',
        sessionId: session.id,
        sourcePrompt: '1分钟后微信提醒我检查第一集大纲',
        nextRunAt: '2026-07-05T02:01:00.000Z',
        schedule: { frequency: 'once', timezone: 'Asia/Shanghai' },
        action: { type: 'wechat_message', message: '检查第一集大纲' },
      });

      expect(task.status).toBe('active');
      vi.setSystemTime(new Date('2026-07-05T02:01:01.000Z'));
      await scheduleService.runDueNow();

      expect(sent).toEqual([{ to: 'writer-openid', text: '检查第一集大纲' }]);
      const tasks = await scheduleStore.listTasks({ sessionId: session.id });
      expect(tasks[0]?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs, pauses, resumes, and deletes tasks through the board actions API', async () => {
    const sent: string[] = [];
    const chatStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
    const scheduleStore = createScheduleStore(path.join(root, 'scheduled-tasks.json'));
    const wechatStore = createWechatStore(path.join(root, 'wechat.json'));
    const setup = await wechatStore.createSetupSession();
    await wechatStore.completeSetupSession(setup.sessionId, { displayName: '编剧微信', externalUserId: 'writer-openid' });
    const scheduleService = createScheduleService({
      scheduleStore,
      chatSessionStore: chatStore,
      wechatStore,
      ilinkClient: { sendText: async (input: { text: string }) => { sent.push(input.text); } } as any,
    });
    const app = new Hono().route('/api', createScheduleRoutes(scheduleStore, scheduleService));
    const session = await chatStore.createSession('project-1');
    const { task } = await scheduleService.createTask({
      projectId: 'project-1',
      sessionId: session.id,
      sourcePrompt: 'board action test',
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      schedule: { frequency: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
      action: { type: 'wechat_message', message: '看板动作验证' },
    });

    const runNow = await app.request(`/api/schedules/${task.id}/run-now`, { method: 'POST' });
    expect(runNow.status).toBe(200);
    expect(sent).toEqual(['看板动作验证']);

    const pause = await app.request(`/api/schedules/${task.id}/cancel`, { method: 'POST' });
    expect(pause.status).toBe(200);
    expect((await pause.json() as { status: string }).status).toBe('paused');

    const resume = await app.request(`/api/schedules/${task.id}/resume`, { method: 'POST' });
    expect(resume.status).toBe(200);
    expect((await resume.json() as { status: string }).status).toBe('active');

    const deleted = await app.request(`/api/schedules/${task.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await scheduleStore.listTasks({ sessionId: session.id })).toEqual([]);
  });
});
