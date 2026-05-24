import { Hono } from 'hono';
import { z } from 'zod';

import type { RunEvent, StreamEvent } from '@viwork/shared';

import type { RunService } from '../runs/codexRunService';
import type { RunBus } from '../runs/runBus';

const createRunSchema = z.object({
  projectId: z.string().transform((projectId) => projectId.trim()).pipe(z.string().min(1)),
  sessionId: z.string().transform((sessionId) => sessionId.trim()).pipe(z.string().min(1)).optional(),
  codexThreadId: z.string().transform((threadId) => threadId.trim()).pipe(z.string().min(1)).optional(),
  prompt: z.string().transform((prompt) => prompt.trim()).pipe(z.string().min(1)),
  referencedFiles: z.array(
    z.object({
      path: z.string().transform((path) => path.trim()).pipe(z.string().min(1)),
      label: z.string().transform((label) => label.trim()).pipe(z.string().min(1)),
    }),
  ).optional().default([]),
});

export function createRunsRoutes(service: RunService, bus?: RunBus): Hono {
  const routes = new Hono();

  routes.post('/runs', async (context) => {
    const body = await parseJson(context.req.raw);
    const parsed = createRunSchema.safeParse(body);

    if (!parsed.success) {
      return context.json({ error: 'Invalid run' }, 400);
    }

    try {
      const result = await service.createRun({ ...parsed.data, source: 'web' });
      if (bus && result.events) {
        publishLegacyEvents(bus, result.events);
      }
      return context.json(result, 201);
    } catch (error) {
      return handleKnownError(context, error);
    }
  });

  return routes;
}

function publishLegacyEvents(bus: RunBus, events: RunEvent[]): void {
  events.forEach((event, index) => {
    const emittedAt = new Date().toISOString();
    const streamEvent = runEventToStreamEvent(event, emittedAt, index + 1);
    if (streamEvent) bus.publish(streamEvent);
  });
}

function runEventToStreamEvent(event: RunEvent, emittedAt: string, sequence: number): StreamEvent | null {
  switch (event.type) {
    case 'run.start':
      return { type: 'run.start', runId: event.runId, emittedAt };
    case 'text.delta':
      return { type: 'text.delta', runId: event.runId, emittedAt, delta: event.text, sequence };
    case 'tool.use':
      return { type: 'tool_use.start', runId: event.runId, emittedAt, toolCallId: `${event.runId}-tool-${sequence}`, toolName: event.name };
    case 'tool.result':
      return {
        type: 'tool_use.end',
        runId: event.runId,
        emittedAt,
        toolCallId: `${event.runId}-tool-${sequence}`,
        status: 'succeeded',
        outputText: event.output ? JSON.stringify(event.output) : null,
        errorMessage: null,
      };
    case 'file.changed':
      return { type: 'file.changed', runId: event.runId, emittedAt, path: event.path, change: event.change };
    case 'run.end':
      return {
        type: 'run.end',
        runId: event.runId,
        emittedAt,
        status: event.status === 'error' ? 'error' : event.status === 'cancelled' ? 'cancelled' : 'success',
        errorMessage: event.error ?? null,
      };
    case 'text.message':
      return { type: 'text.delta', runId: event.runId, emittedAt, delta: event.text, sequence };
  }
}

function handleKnownError(context: { json: (data: { error: string }, status: 400 | 404) => Response }, error: unknown): Response {
  if (isInvalidWorkspaceError(error)) {
    return context.json({ error: 'Invalid project' }, 400);
  }

  if (isNotFoundError(error)) {
    return context.json({ error: 'Project not found' }, 404);
  }

  throw error;
}

function isInvalidWorkspaceError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Invalid workspace path' || error.message === 'Invalid project id');
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'Project not found' || ('code' in error && error.code === 'ENOENT'));
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
