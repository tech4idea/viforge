import { Hono } from 'hono';
import { cors } from 'hono/cors';
import path from 'node:path';

import { workspaceStore } from './storage/workspaceStore';
import { createChatSessionStore } from './chat/chatSessionStore';
import { createMastraRunService } from './runs/mastraRunService';
import { runBus } from './runs/runBus';
import { createAigcHubRoutes } from './routes/aigcHub';
import { createChatSessionRoutes } from './routes/chatSessions';
import { createImageGenerationRoutes } from './routes/imageGenerations';
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
  const chatSessionStore = createChatSessionStore(path.join(WORKSPACES_ROOT, '..', 'chat-sessions.json'));

  app.use('/api/*', cors());
  app.onError((error, context) => {
    console.error('[api] request failed', { method: context.req.method, path: context.req.path }, error);
    return context.json({ error: 'Internal server error' }, 500);
  });

  app.route('/api', createProjectsRoutes(workspaceStore));
  app.route('/api', createAigcHubRoutes());
  app.route('/api', createChatSessionRoutes(chatSessionStore, workspaceStore));
  app.route('/api', createImageGenerationRoutes(chatSessionStore, workspaceStore));
  app.route('/api', createRunsRoutes(createMastraRunService(workspaceStore, runBus), runBus));
  app.route('/api', createRunEventsRoutes(runBus));
  app.route('/api', createSkillsRoutes(createSkillStore({
    agentConfigSkillsRoot: path.join(WORKSPACES_ROOT, '_global', 'Agent 配置', 'skills'),
  })));
  app.route('/api', createWechatRoutes(createWechatStore(path.join(WORKSPACES_ROOT, '..', 'wechat.json'), workspaceStore)));

  return app;
}
