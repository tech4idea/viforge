import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@viwork/shared';

import { createRunBus } from './runBus';

describe('run bus', () => {
  it('replays buffered events to late subscribers and streams new events', () => {
    const bus = createRunBus();
    const start: StreamEvent = { type: 'run.start', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.000Z' };
    const text: StreamEvent = {
      type: 'text.delta',
      runId: 'run_1',
      emittedAt: '2026-01-01T00:00:00.001Z',
      delta: '第一句',
      sequence: 1,
    };

    bus.publish(start);

    const received: StreamEvent[] = [];
    const unsubscribe = bus.subscribe('run_1', (event) => received.push(event));
    bus.publish(text);
    unsubscribe();

    expect(received).toEqual([start, text]);
  });
});
