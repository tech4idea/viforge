import { Hono } from 'hono';
import type { StreamEvent } from '@viwork/shared';

import type { RunBus } from '../runs/runBus';

const HEARTBEAT_MS = 15_000;

export function createRunEventsRoutes(bus: RunBus): Hono {
  const routes = new Hono();

  routes.get('/runs/:runId/events', (context) => {
    const runId = context.req.param('runId');
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };

        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };

        write('retry: 2000\n\n');
        write(`: connected run=${runId}\n\n`);
        heartbeat = setInterval(() => write(':ping\n\n'), HEARTBEAT_MS);

        unsubscribe = bus.subscribe(runId, (event) => {
          write(formatSseFrame(event));
          if (event.type === 'run.end') close();
        });

        const signal = context.req.raw.signal;
        if (signal.aborted) {
          close();
        } else {
          signal.addEventListener('abort', close, { once: true });
        }
      },
      cancel() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  return routes;
}

function formatSseFrame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
