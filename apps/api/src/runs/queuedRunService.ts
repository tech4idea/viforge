import { randomUUID } from 'node:crypto';

import type { AgentRun, StreamEvent } from '@viforge/shared';

import { appendJsonLog } from '../logger';
import type { RunBus } from './runBus';
import type { CreateRunInput, RunService } from './runService';

type QueuedRun = {
  input: CreateRunInput & { runId: string };
  run: AgentRun;
  queuedAt: number;
};

export function createQueuedRunService(inner: RunService, bus: RunBus): RunService {
  const runningKeys = new Set<string>();
  const queues = new Map<string, QueuedRun[]>();

  async function startQueuedRun(key: string, item: QueuedRun): Promise<void> {
    runningKeys.add(key);
    appendJsonLog('api-runs.jsonl', {
      scope: 'queued-run',
      stage: 'dequeued.start',
      runId: item.input.runId,
      projectId: item.input.projectId,
      sessionId: item.input.sessionId ?? null,
      key,
      queuedMs: Date.now() - item.queuedAt,
    });
    try {
      await inner.createRun(item.input);
      await waitForRunEnd(bus, item.input.runId);
    } catch (error) {
      bus.publish({
        type: 'run.end',
        runId: item.input.runId,
        emittedAt: new Date().toISOString(),
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Run failed',
      });
    } finally {
      appendJsonLog('api-runs.jsonl', {
        scope: 'queued-run',
        stage: 'run.released',
        runId: item.input.runId,
        projectId: item.input.projectId,
        sessionId: item.input.sessionId ?? null,
        key,
      });
      runningKeys.delete(key);
      const queue = queues.get(key) ?? [];
      const next = queue.shift();
      if (queue.length === 0) {
        queues.delete(key);
      }
      if (next) {
        void startQueuedRun(key, next);
      }
    }
  }

  return {
    async createRun(input) {
      const runId = input.runId ?? `run_${randomUUID()}`;
      const queuedInput = { ...input, runId };
      const key = input.sessionId ? `session:${input.sessionId}` : `run:${runId}`;
      const now = new Date().toISOString();
      const pendingRun: AgentRun = {
        id: runId,
        inputSnapshotId: input.inputSnapshotId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        prompt: input.prompt,
        model: input.model,
        imageGeneration: input.imageGeneration,
        referencedFiles: input.referencedFiles ?? [],
        referencedSnippets: input.referencedSnippets ?? [],
        source: input.source ?? 'web',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };

      if (runningKeys.has(key) || (queues.get(key)?.length ?? 0) > 0) {
        const queue = queues.get(key) ?? [];
        queue.push({ input: queuedInput, run: pendingRun, queuedAt: Date.now() });
        queues.set(key, queue);
        appendJsonLog('api-runs.jsonl', {
          scope: 'queued-run',
          stage: 'queued',
          runId,
          projectId: input.projectId,
          sessionId: input.sessionId ?? null,
          key,
          queueDepth: queue.length,
        });
        return { run: pendingRun };
      }

      runningKeys.add(key);
      appendJsonLog('api-runs.jsonl', {
        scope: 'queued-run',
        stage: 'immediate.start',
        runId,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        key,
      });
      try {
        const result = await inner.createRun(queuedInput);
        void waitForRunEnd(bus, runId).finally(() => {
          appendJsonLog('api-runs.jsonl', {
            scope: 'queued-run',
            stage: 'run.released',
            runId,
            projectId: input.projectId,
            sessionId: input.sessionId ?? null,
            key,
          });
          runningKeys.delete(key);
          const queue = queues.get(key) ?? [];
          const next = queue.shift();
          if (queue.length === 0) {
            queues.delete(key);
          }
          if (next) {
            void startQueuedRun(key, next);
          }
        });
        return result;
      } catch (error) {
        runningKeys.delete(key);
        throw error;
      }
    },
  };
}

function waitForRunEnd(bus: RunBus, runId: string): Promise<void> {
  if (bus.getEvents(runId).some((event) => event.type === 'run.end')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      unsubscribe?.();
      resolve();
    };
    const handleEvent = (event: StreamEvent) => {
      if (event.type === 'run.end') {
        finish();
      }
    };
    unsubscribe = bus.subscribe(runId, handleEvent);
  });
}
