import { serve } from '@hono/node-server';

import { createApp } from './app';
import { ensureEmbeddedPostgres } from './desktop/postgresBinary';
import { installFileLogger } from './logger';
import { loadRuntimeConfigIntoEnv } from './runtimeConfigStore';

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST || (process.env.VIFORGE_DESKTOP === '1' ? '127.0.0.1' : undefined);

installFileLogger();

await loadRuntimeConfigIntoEnv();

if (process.env.VIFORGE_DESKTOP === '1' && (process.env.VIFORGE_DATABASE_MODE || 'embedded-postgres') === 'embedded-postgres') {
  process.env.VIFORGE_EMBEDDED_POSTGRES_STATUS = 'starting';
  try {
    await ensureEmbeddedPostgres({ dataRoot: process.env.VIFORGE_DESKTOP_DATA_ROOT });
    process.env.VIFORGE_EMBEDDED_POSTGRES_STATUS = 'ready';
    delete process.env.VIFORGE_EMBEDDED_POSTGRES_ERROR;
  } catch (error) {
    process.env.VIFORGE_EMBEDDED_POSTGRES_STATUS = 'error';
    process.env.VIFORGE_EMBEDDED_POSTGRES_ERROR = error instanceof Error ? error.message : String(error);
    console.error('[desktop] embedded PostgreSQL failed to start', error);
  }
}

const server = serve({
  fetch: createApp().fetch,
  ...(hostname ? { hostname } : {}),
  port,
});

console.info(`[api] listening on ${hostname ?? '0.0.0.0'}:${port}`);

export { server };
