import type { ScheduledTask } from '@viwork/shared';

export function computeNextRunAt(task: ScheduledTask, from = new Date()): string | null {
  const frequency = task.schedule.frequency;
  if (frequency === 'once') return null;

  if (frequency === 'minutes') {
    const interval = Math.max(1, task.schedule.intervalMinutes ?? 1);
    return new Date(from.getTime() + interval * 60_000).toISOString();
  }

  const [hour, minute] = parseTimeOfDay(task.schedule.timeOfDay ?? '09:00');
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  if (frequency === 'hourly') {
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(minute, 0, 0);
    if (candidate <= from) candidate.setHours(candidate.getHours() + 1);
    return candidate.toISOString();
  }

  if (frequency === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (frequency === 'weekly') {
    const targetDay = task.schedule.dayOfWeek ?? 1;
    const currentDay = next.getDay();
    let days = (targetDay - currentDay + 7) % 7;
    if (days === 0 && next <= from) days = 7;
    next.setDate(next.getDate() + days);
    return next.toISOString();
  }

  return null;
}

function parseTimeOfDay(time: string): [number, number] {
  const [hour, minute] = time.split(':').map(Number);
  return [hour || 0, minute || 0];
}
