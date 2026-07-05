import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import type { RunEvent, StreamEvent } from '@viwork/shared';

import { appendJsonLog } from '../logger';
import { traceIdFromRequest } from '../aigcHubHeaders';
import type { RunService } from '../runs/runService';
import type { RunBus } from '../runs/runBus';
import type { HarnessStore } from '../harness/harnessStore';
import type { WechatIlinkClient } from '../wechat/wechatIlinkClient';
import { createWechatSendContext, type WechatStore } from '../wechat/wechatStore';

const createRunSchema = z.object({
  projectId: z.string().transform((projectId) => projectId.trim()).pipe(z.string().min(1)),
  sessionId: z.string().transform((sessionId) => sessionId.trim()).pipe(z.string().min(1)).optional(),
  prompt: z.string().transform((prompt) => prompt.trim()).pipe(z.string().min(1)),
  model: z.string().transform((model) => model.trim()).pipe(z.string().min(1)).optional(),
  imageGeneration: z.object({
    model: z.string().transform((model) => model.trim()).pipe(z.string().min(1)).optional(),
  }).optional(),
  referencedFiles: z.array(
    z.object({
      path: z.string().transform((path) => path.trim()).pipe(z.string().min(1)),
      label: z.string().transform((label) => label.trim()).pipe(z.string().min(1)),
    }),
  ).optional().default([]),
  referencedSnippets: z.array(
    z.object({
      id: z.string().transform((id) => id.trim()).pipe(z.string().min(1)),
      messageId: z.string().transform((messageId) => messageId.trim()).pipe(z.string().min(1)),
      role: z.enum(['user', 'assistant']),
      label: z.string().transform((label) => label.trim()).pipe(z.string().min(1)),
      text: z.string().transform((text) => text.trim()).pipe(z.string().min(1)),
      createdAt: z.string().transform((createdAt) => createdAt.trim()).pipe(z.string().min(1)),
    }),
  ).optional().default([]),
});

export function createRunsRoutes(
  service: RunService,
  bus?: RunBus,
  harnessStore?: HarnessStore,
  wechat?: { store: WechatStore; ilinkClient: WechatIlinkClient },
): Hono {
  const routes = new Hono();

  routes.post('/runs', async (context) => {
    const requestId = `runs_req_${randomUUID()}`;
    const traceId = traceIdFromRequest(context.req.raw);
    const body = await parseJson(context.req.raw);
    appendJsonLog('api-runs.jsonl', {
      scope: 'runs.route',
      stage: 'request.received',
      requestId,
      method: context.req.method,
      path: context.req.path,
      body,
    });
    const parsed = createRunSchema.safeParse(body);

    if (!parsed.success) {
      appendJsonLog('api-runs.jsonl', {
        scope: 'runs.route',
        stage: 'request.invalid',
        requestId,
        issues: parsed.error.issues,
      });
      return context.json({ error: 'Invalid run' }, 400);
    }

    try {
      const runId = `run_${randomUUID()}`;
      const snapshot = harnessStore
        ? await harnessStore.createRunInputSnapshot({
            runId,
            projectId: parsed.data.projectId,
            sessionId: parsed.data.sessionId,
            prompt: parsed.data.prompt,
            referencedFiles: parsed.data.referencedFiles,
            referencedSnippets: parsed.data.referencedSnippets,
          })
        : undefined;
      const result = await service.createRun({
        ...parsed.data,
        runId,
        inputSnapshotId: snapshot?.id,
        source: 'web',
        traceId,
        wechat: wechat
          ? createWechatSendContext({ wechatStore: wechat.store, ilinkClient: wechat.ilinkClient })
          : undefined,
      });
      appendJsonLog('api-runs.jsonl', {
        scope: 'runs.route',
        stage: 'response.created',
        requestId,
        runId: result.run.id,
        sessionId: result.run.sessionId ?? null,
        projectId: result.run.projectId,
        response: result,
      });
      if (bus && result.events) {
        publishLegacyEvents(bus, result.events);
      }
      if (harnessStore && result.events) {
        for (const [index, event] of result.events.entries()) {
          const streamEvent = runEventToStreamEvent(event, new Date().toISOString(), index + 1);
          if (streamEvent) {
            await harnessStore.recordRunArtifactEvent({
              runId: result.run.id,
              projectId: result.run.projectId,
              sessionId: result.run.sessionId,
              inputSnapshotId: result.run.inputSnapshotId,
              traceId,
              model: result.run.model,
              modelParams: {
                model: result.run.model,
                maxSteps: 1,
                source: result.run.model ? 'run_input' : 'runtime_default',
              },
              prompt: result.run.prompt,
              referencedFiles: result.run.referencedFiles,
              referencedSnippets: result.run.referencedSnippets,
              event: streamEvent,
            });
          }
        }
      }
      context.header('traceid', traceId);
      return context.json(result, 201);
    } catch (error) {
      appendJsonLog('api-runs.jsonl', {
        scope: 'runs.route',
        stage: 'request.failed',
        requestId,
        error,
      });
      return handleKnownError(context, error);
    }
  });

  routes.post('/runs/:runId/cancel', (context) => {
    const runId = context.req.param('runId');
    if (!bus) return context.json({ error: 'Run bus not available' }, 500);
    bus.abortRun(runId);
    return context.json({ cancelled: true });
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
      return { type: 'tool_use.start', runId: event.runId, emittedAt, toolCallId: legacyToolCallId(event.runId, event.name), toolName: event.name };
    case 'tool.input':
      return { type: 'tool_use.delta', runId: event.runId, emittedAt, toolCallId: legacyToolCallId(event.runId, event.name), stream: 'input', delta: event.inputText, sequence };
    case 'tool.result':
      return {
        type: 'tool_use.end',
        runId: event.runId,
        emittedAt,
        toolCallId: legacyToolCallId(event.runId, event.name),
        status: 'succeeded',
        outputText: event.output ? JSON.stringify(event.output) : null,
        errorMessage: null,
      };
    case 'file.changed':
      return { type: 'file.changed', runId: event.runId, emittedAt, path: event.path, change: event.change };
    case 'memory.read':
      return { ...event, emittedAt };
    case 'memory.write':
      return { ...event, emittedAt };
    case 'memory.recall':
      return { ...event, emittedAt };
    case 'knowledge.retrieve':
      return { ...event, emittedAt };
    case 'agent.step.start':
      return { ...event, emittedAt };
    case 'agent.step.end':
      return { ...event, emittedAt };
    case 'agent.review.reject':
      return { ...event, emittedAt };
    case 'agent.workflow.end':
      return { ...event, emittedAt };
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

function legacyToolCallId(runId: string, toolName: string): string {
  return `${runId}-tool-${toolName}`;
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
