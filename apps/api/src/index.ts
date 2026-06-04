import { serve } from '@hono/node-server';

import { createApp } from './app';
import { installFileLogger } from './logger';

const port = Number(process.env.PORT ?? 3001);

installFileLogger();

serve({
  fetch: createApp().fetch,
  port,
});

console.info(`[api] listening on ${port}`);
