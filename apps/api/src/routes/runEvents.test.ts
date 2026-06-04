import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createRunBus } from '../runs/runBus';
import { createRunEventsRoutes } from './runEvents';

describe('run events routes', () => {
  it('streams buffered run events as SSE frames', async () => {
    const bus = createRunBus();
    const app = new Hono().route('/api', createRunEventsRoutes(bus));
    bus.publish({ type: 'run.start', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.000Z' });
    bus.publish({ type: 'run.end', runId: 'run_1', emittedAt: '2026-01-01T00:00:00.001Z', status: 'success', errorMessage: null });

    const response = await app.request('/api/runs/run_1/events');
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('data: {"type":"run.start"');
    expect(body).toContain('data: {"type":"run.end"');
  });
});
