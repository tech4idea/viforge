import { describe, expect, it } from 'vitest';

import { createRunBus } from './runBus';
import { createQueuedRunService } from './queuedRunService';
import type { RunService } from './runService';

describe('queued run service', () => {
  it('serializes runs that target the same chat session', async () => {
    const bus = createRunBus();
    const started: string[] = [];
    const inner: RunService = {
      async createRun(input) {
        const runId = input.runId ?? 'missing-run-id';
        started.push(runId);
        bus.publish({ type: 'run.start', runId, emittedAt: new Date().toISOString() });
        return {
          run: {
            id: runId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            source: input.source ?? 'web',
            referencedFiles: input.referencedFiles ?? [],
            referencedSnippets: input.referencedSnippets ?? [],
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    };

    const service = createQueuedRunService(inner, bus);
    const first = await service.createRun({ runId: 'run_1', projectId: 'project_1', sessionId: 'session_1', prompt: 'first' });
    const second = await service.createRun({ runId: 'run_2', projectId: 'project_1', sessionId: 'session_1', prompt: 'second' });

    expect(first.run.status).toBe('running');
    expect(second.run.status).toBe('pending');
    expect(started).toEqual(['run_1']);

    bus.publish({ type: 'run.end', runId: 'run_1', emittedAt: new Date().toISOString(), status: 'success', errorMessage: null });
    await waitFor(() => started.includes('run_2'));

    expect(started).toEqual(['run_1', 'run_2']);
  });

  it('allows different sessions to run concurrently', async () => {
    const bus = createRunBus();
    const started: string[] = [];
    const inner: RunService = {
      async createRun(input) {
        const runId = input.runId ?? 'missing-run-id';
        started.push(runId);
        bus.publish({ type: 'run.start', runId, emittedAt: new Date().toISOString() });
        return {
          run: {
            id: runId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            source: input.source ?? 'web',
            referencedFiles: [],
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    };

    const service = createQueuedRunService(inner, bus);
    const first = await service.createRun({ runId: 'run_1', projectId: 'project_1', sessionId: 'session_1', prompt: 'first' });
    const second = await service.createRun({ runId: 'run_2', projectId: 'project_1', sessionId: 'session_2', prompt: 'second' });

    expect(first.run.status).toBe('running');
    expect(second.run.status).toBe('running');
    expect(started).toEqual(['run_1', 'run_2']);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for predicate');
}
