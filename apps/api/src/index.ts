import { serve } from '@hono/node-server';

import { createApp } from './app';

const port = Number(process.env.PORT ?? 3001);

serve({
  fetch: createApp().fetch,
  port,
});
