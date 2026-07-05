import { describe, expect, it } from 'vitest';

import { computeNextRunAt } from './scheduleTime';
import type { ScheduledTask } from '@viwork/shared';

describe('scheduleTime', () => {
  it('computes next run time for recurring schedules without parsing user text', () => {
    const task = {
      schedule: { frequency: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
    } as ScheduledTask;

    expect(computeNextRunAt(task, new Date('2026-07-05T02:00:00.000Z'))).toBe('2026-07-06T01:00:00.000Z');
  });
});
