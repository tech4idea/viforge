import { serve } from '@hono/node-server';

import { createApp } from './app';
import { ensureEmbeddedPostgres } from './desktop/postgresBinary';
import { installFileLogger } from './logger';
import { loadRuntimeConfigIntoEnv } from './runtimeConfigStore';

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST || (process.env.VIWORK_DESKTOP === '1' ? '127.0.0.1' : undefined);

installFileLogger();

await loadRuntimeConfigIntoEnv();

if (process.env.VIWORK_DESKTOP === '1' && (process.env.VIWORK_DATABASE_MODE || 'embedded-postgres') === 'embedded-postgres') {
  await ensureEmbeddedPostgres({ dataRoot: process.env.VIWORK_DESKTOP_DATA_ROOT });
}

const server = serve({
  fetch: createApp().fetch,
  ...(hostname ? { hostname } : {}),
  port,
});

console.info(`[api] listening on ${hostname ?? '0.0.0.0'}:${port}`);

export { server };
