import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'node:path';

import { workspaceStore } from './storage/workspaceStore';
import { createChatSessionStore } from './chat/chatSessionStore';
import { createCodexRunService } from './runs/codexRunService';
import { runBus } from './runs/runBus';
import { createChatSessionRoutes } from './routes/chatSessions';
import { createProjectsRoutes } from './routes/projects';
import { createRunEventsRoutes } from './routes/runEvents';
import { createRunsRoutes } from './routes/runs';
import { createSkillsRoutes } from './routes/skills';
import { createWechatRoutes } from './routes/wechat';
import { createSkillStore } from './skills/skillStore';
import { createWechatStore } from './wechat/wechatStore';
import { WORKSPACES_ROOT } from './env';

export function createApp(): Hono {
  const app = new Hono();

  app.use('/api/*', cors());
  app.route('/api', createProjectsRoutes(workspaceStore));
  app.route('/api', createChatSessionRoutes(createChatSessionStore(path.join(WORKSPACES_ROOT, '..', 'chat-sessions.json'))));
  app.route('/api', createRunsRoutes(createCodexRunService(workspaceStore, runBus), runBus));
  app.route('/api', createRunEventsRoutes(runBus));
  app.route('/api', createSkillsRoutes(createSkillStore(path.join(WORKSPACES_ROOT, '..', 'skills'))));
  app.route('/api', createWechatRoutes(createWechatStore(path.join(WORKSPACES_ROOT, '..', 'wechat.json'), workspaceStore)));

  return app;
}
