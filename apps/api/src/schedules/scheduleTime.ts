import type { ScheduledTask } from '@viwork/shared';

export function computeNextRunAt(task: ScheduledTask, from = new Date()): string | null {
  const frequency = task.schedule.frequency;
  const timezone = task.schedule.timezone || 'Asia/Shanghai';
  if (frequency === 'once') return null;

  if (frequency === 'minutes') {
    const interval = Math.max(1, task.schedule.intervalMinutes ?? 1);
    return new Date(from.getTime() + interval * 60_000).toISOString();
  }

  const [hour, minute] = parseTimeOfDay(task.schedule.timeOfDay ?? '09:00');
  const localNow = getZonedParts(from, timezone);

  if (frequency === 'hourly') {
    let local = { ...localNow, minute, second: 0 };
    let candidate = zonedDateTimeToUtc(local, timezone);
    if (candidate <= from) {
      local = addLocalHours(local, 1);
      candidate = zonedDateTimeToUtc(local, timezone);
    }
    return candidate.toISOString();
  }

  if (frequency === 'daily') {
    let local = { ...localNow, hour, minute, second: 0 };
    let candidate = zonedDateTimeToUtc(local, timezone);
    if (candidate <= from) {
      local = addLocalDays(local, 1);
      candidate = zonedDateTimeToUtc(local, timezone);
    }
    return candidate.toISOString();
  }

  if (frequency === 'weekly') {
    const targetDay = task.schedule.dayOfWeek ?? 1;
    const currentDay = localNow.weekday;
    let days = (targetDay - currentDay + 7) % 7;
    let local = addLocalDays({ ...localNow, hour, minute, second: 0 }, days);
    let candidate = zonedDateTimeToUtc(local, timezone);
    if (days === 0 && candidate <= from) {
      local = addLocalDays(local, 7);
      candidate = zonedDateTimeToUtc(local, timezone);
    }
    return candidate.toISOString();
  }

  return null;
}

function parseTimeOfDay(time: string): [number, number] {
  const [hour, minute] = time.split(':').map(Number);
  return [hour || 0, minute || 0];
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
    weekday: WEEKDAY_INDEX[value('weekday')] ?? 0,
  };
}

function zonedDateTimeToUtc(local: ZonedParts, timeZone: string): Date {
  let candidate = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = getZonedParts(candidate, timeZone);
    const desiredMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, 0);
    const delta = desiredMs - actualMs;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  return candidate;
}

function addLocalDays(local: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute, local.second, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

function addLocalHours(local: ZonedParts, hours: number): ZonedParts {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour + hours, local.minute, local.second, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}
