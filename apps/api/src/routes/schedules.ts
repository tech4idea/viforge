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
    const task = await scheduleService.executeTask(context.req.param('taskId'));
    if (!task) return context.json({ error: 'Schedule not found' }, 404);
    if (task.status === 'error') return context.json({ error: task.lastError ?? 'Schedule execution failed', task }, 500);
    return context.json(task);
  });

  routes.delete('/schedules/:taskId', async (context) => {
    const result = await scheduleStore.deleteTask(context.req.param('taskId'));
    if (!result.existed) return context.json({ error: 'Schedule not found' }, 404);
    return context.json({ deleted: true });
  });

  return routes;
}
