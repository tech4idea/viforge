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
  process.env.VIWORK_EMBEDDED_POSTGRES_STATUS = 'starting';
  void ensureEmbeddedPostgres({ dataRoot: process.env.VIWORK_DESKTOP_DATA_ROOT })
    .then(() => {
      process.env.VIWORK_EMBEDDED_POSTGRES_STATUS = 'ready';
      delete process.env.VIWORK_EMBEDDED_POSTGRES_ERROR;
    })
    .catch((error) => {
      process.env.VIWORK_EMBEDDED_POSTGRES_STATUS = 'error';
      process.env.VIWORK_EMBEDDED_POSTGRES_ERROR = error instanceof Error ? error.message : String(error);
      console.error('[desktop] embedded PostgreSQL failed to start', error);
    });
}

const server = serve({
  fetch: createApp().fetch,
  ...(hostname ? { hostname } : {}),
  port,
});

console.info(`[api] listening on ${hostname ?? '0.0.0.0'}:${port}`);

export { server };
