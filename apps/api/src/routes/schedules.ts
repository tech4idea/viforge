import { Hono } from 'hono';
import type { ScheduleStore } from '../schedules/scheduleStore';
import type { ScheduleService } from '../schedules/scheduleService';

export function createScheduleRoutes(scheduleStore: ScheduleStore, scheduleService: ScheduleService): Hono {
  const routes = new Hono();

  routes.get('/chat-sessions/:sessionId/schedules', async (context) => {
    return context.json(await scheduleStore.listTasks({ sessionId: context.req.param('sessionId') }));
  });

  routes.get('/projects/:projectId/schedules', async (context) => {
    return context.json(await scheduleStore.listTasks({ projectId: context.req.param('projectId') }));
  });

  routes.post('/schedules/:taskId/cancel', async (context) => {
    const task = await scheduleService.pauseTask(context.req.param('taskId'));
    if (!task) return context.json({ error: 'Schedule not found' }, 404);
    return context.json(task);
  });

  routes.post('/schedules/:taskId/resume', async (context) => {
    const task = await scheduleService.resumeTask(context.req.param('taskId'));
    if (!task) return context.json({ error: 'Schedule not found' }, 404);
    return context.json(task);
  });

  routes.post('/schedules/:taskId/run-now', async (context) => {
    const taskId = context.req.param('taskId');
    const current = (await scheduleStore.listTasks()).find((item) => item.id === taskId);
    if (!current) return context.json({ error: 'Schedule not found' }, 404);
    if (current.status !== 'active') return context.json({ error: 'Schedule is not active', task: current }, 409);
    const result = await scheduleService.executeTaskNow(taskId);
    if (!result) return context.json({ error: 'Schedule not found' }, 404);
    if (result.task.status === 'error') return context.json({ error: result.task.lastError ?? 'Schedule execution failed', task: result.task }, 500);
    return context.json(result);
  });

  routes.delete('/schedules/:taskId', async (context) => {
    const result = await scheduleStore.deleteTask(context.req.param('taskId'));
    if (!result.existed) return context.json({ error: 'Schedule not found' }, 404);
    return context.json({ deleted: true });
  });

  return routes;
}
