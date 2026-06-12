import type { StreamEvent } from '@viwork/shared';

type Subscriber = (event: StreamEvent) => void;

const MAX_BUFFERED_EVENTS = 2048;
const DROP_AFTER_END_MS = 60_000;

type RunBuffer = {
  events: StreamEvent[];
  dropTimer: ReturnType<typeof setTimeout> | null;
};

export type RunBus = {
  publish(event: StreamEvent): void;
  subscribe(runId: string, subscriber: Subscriber): () => void;
  getAbortSignal(runId: string): AbortSignal;
  abortRun(runId: string): void;
};

class InMemoryRunBus implements RunBus {
  private readonly buffers = new Map<string, RunBuffer>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly abortControllers = new Map<string, AbortController>();

  publish(event: StreamEvent): void {
    const buffer = this.bufferFor(event.runId);
    if (buffer.events.length >= MAX_BUFFERED_EVENTS) {
      buffer.events.shift();
    }
    buffer.events.push(event);

    for (const subscriber of this.subscribers.get(event.runId) ?? []) {
      subscriber(event);
    }

    if (event.type === 'run.end') {
      this.abortControllers.delete(event.runId);
      if (buffer.dropTimer) clearTimeout(buffer.dropTimer);
      buffer.dropTimer = setTimeout(() => {
        this.buffers.delete(event.runId);
      }, DROP_AFTER_END_MS);
      buffer.dropTimer.unref?.();
    }
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    for (const event of this.buffers.get(runId)?.events ?? []) {
      subscriber(event);
    }

    const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
    runSubscribers.add(subscriber);
    this.subscribers.set(runId, runSubscribers);

    return () => {
      runSubscribers.delete(subscriber);
      if (runSubscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  getAbortSignal(runId: string): AbortSignal {
    let controller = this.abortControllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.abortControllers.set(runId, controller);
    }
    return controller.signal;
  }

  abortRun(runId: string): void {
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(runId);
    }
  }

  private bufferFor(runId: string): RunBuffer {
    const existing = this.buffers.get(runId);
    if (existing) return existing;

    const created: RunBuffer = { events: [], dropTimer: null };
    this.buffers.set(runId, created);
    return created;
  }
}

export function createRunBus(): RunBus {
  return new InMemoryRunBus();
}

export const runBus = createRunBus();
