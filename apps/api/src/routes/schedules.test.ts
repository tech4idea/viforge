import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatSessionStore } from '../chat/chatSessionStore';
import { createWechatStore } from '../wechat/wechatStore';
import { createScheduleService } from '../schedules/scheduleService';
import { createScheduleStore } from '../schedules/scheduleStore';
import { createRunBus } from '../runs/runBus';
import { createScheduleRoutes } from './schedules';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'viwork-schedules-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('schedule routes', () => {
  it('executes due tasks through the bound chat session and lets the agent send WeChat', async () => {
      const chatStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
      const scheduleStore = createScheduleStore(path.join(root, 'scheduled-tasks.json'));
      const bus = createRunBus();
      const wechatStore = createWechatStore(path.join(root, 'wechat.json'));
      const setup = await wechatStore.createSetupSession();
      await wechatStore.completeSetupSession(setup.sessionId, { displayName: '编剧微信', externalUserId: 'writer-openid' });
      await wechatStore.setIlinkContextToken('writer-openid', 'context-token');
      const scheduleService = createScheduleService({
        scheduleStore,
        chatSessionStore: chatStore,
        wechatStore,
        ilinkClient: { sendText: vi.fn() } as any,
      });
      let capturedPrompt = '';
      let capturedWechat: unknown = null;
      scheduleService.setRunService({
        async createRun(input) {
          capturedPrompt = input.prompt;
          capturedWechat = input.wechat;
          const run = {
            id: 'run-schedule-generated',
            projectId: input.projectId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            referencedFiles: [],
            referencedSnippets: [],
            source: 'schedule' as const,
            status: 'running' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          setTimeout(() => {
            bus.publish({ type: 'text.delta', runId: run.id, emittedAt: new Date().toISOString(), delta: '定时任务已执行，已通过微信发送第一集大纲提醒。', sequence: 1 });
            bus.publish({ type: 'run.end', runId: run.id, emittedAt: new Date().toISOString(), status: 'success', errorMessage: null });
          }, 0);
          return { run };
        },
      }, bus);
      const session = await chatStore.createSession('project-1');
      const { task } = await scheduleService.createTask({
        projectId: 'project-1',
        sessionId: session.id,
        sourcePrompt: '1分钟后微信提醒我检查第一集大纲',
        nextRunAt: new Date(Date.now() - 1_000).toISOString(),
        schedule: { frequency: 'once', timezone: 'Asia/Shanghai' },
        action: { type: 'wechat_message', prompt: '根据会话进展生成检查第一集大纲的提醒' },
      });

      expect(task.status).toBe('active');
      await scheduleService.runDueNow();

      expect(capturedPrompt).toContain('系统定时触发');
      expect(capturedPrompt).toContain('调用 send_wechat_message 工具发送');
      expect(capturedWechat).toMatchObject({
        sendText: expect.any(Function),
        sendFile: expect.any(Function),
      });
      expect(capturedWechat).not.toHaveProperty('userId');
      expect(capturedWechat).not.toHaveProperty('contextToken');
      const tasks = await scheduleStore.listTasks({ sessionId: session.id });
      expect(tasks[0]?.status).toBe('completed');
      const messages = (await chatStore.getSession(session.id))?.messages ?? [];
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[1]?.content).toContain('已通过微信发送');
  });

  it('runs, pauses, resumes, and deletes tasks through the board actions API', async () => {
    const chatStore = createChatSessionStore(path.join(root, 'chat-sessions.json'));
    const scheduleStore = createScheduleStore(path.join(root, 'scheduled-tasks.json'));
    const wechatStore = createWechatStore(path.join(root, 'wechat.json'));
    const bus = createRunBus();
    const setup = await wechatStore.createSetupSession();
    await wechatStore.completeSetupSession(setup.sessionId, { displayName: '编剧微信', externalUserId: 'writer-openid' });
    await wechatStore.setIlinkContextToken('writer-openid', 'context-token');
    const scheduleService = createScheduleService({
      scheduleStore,
      chatSessionStore: chatStore,
      wechatStore,
      ilinkClient: { sendText: vi.fn() } as any,
    });
    scheduleService.setRunService({
      async createRun(input) {
        const run = {
          id: 'run-board-action',
          projectId: input.projectId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          referencedFiles: [],
          referencedSnippets: [],
          source: 'schedule' as const,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setTimeout(() => {
          bus.publish({ type: 'text.delta', runId: run.id, emittedAt: new Date().toISOString(), delta: '看板动作验证完成', sequence: 1 });
          bus.publish({ type: 'run.end', runId: run.id, emittedAt: new Date().toISOString(), status: 'success', errorMessage: null });
        }, 0);
        return { run };
      },
    }, bus);
    const app = new Hono().route('/api', createScheduleRoutes(scheduleStore, scheduleService));
    const session = await chatStore.createSession('project-1');
    const { task } = await scheduleService.createTask({
      projectId: 'project-1',
      sessionId: session.id,
      sourcePrompt: 'board action test',
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      schedule: { frequency: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
      action: { type: 'wechat_message', prompt: '看板动作验证' },
    });

    const runNow = await app.request(`/api/schedules/${task.id}/run-now`, { method: 'POST' });
    expect(runNow.status).toBe(200);

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
