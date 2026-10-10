import { Task, FocusSession, Subject, Chapter } from './types';
import { localHour, localDay, blockLabel } from './analytics';
import { subjectProgress } from './insights';

/**
 * Weekly / monthly study analytics. Pure and derived from sessions + tasks, like everything else,
 * so every device shows the same numbers. Periods are ROLLING windows ("last 7 days" vs the 7 days
 * before) so a comparison made on a Wednesday is not a half week against a full one.
 */

const MIN = 60000;
const DAY = 24 * 60 * MIN;
export const MIN_SESSIONS_FOR_PRODUCTIVE_TIME = 3;

export type Period = 'week' | 'month';
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30 };

/** Epoch ms of local midnight for the day containing `ms`. tz = Date#getTimezoneOffset(). */
export const dayStart = (ms: number, tz: number): number => Math.floor((ms - tz * MIN) / DAY) * DAY + tz * MIN;

export function fmtDuration(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** "+25%", "-10%", "new" (nothing before), "–" (nothing in either). Never divides by zero. */
export function deltaLabel(current: number, previous: number): string {
  if (current === 0 && previous === 0) return '–';
  if (previous === 0) return 'new';
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct === 0 ? '0%' : `${pct > 0 ? '+' : ''}${pct}%`;
}

export interface Bucket { label: string; start: number; minutes: number; sessions: number }

export interface SubjectBreakdown {
  id: string; title: string; minutes: number; sessions: number; progressPct: number;
}

export interface PeriodStats {
  period: Period;
  days: number;
  from: number;
  to: number; // exclusive
  focusMinutes: number;
  sessions: number;          // completed
  endedEarly: number;
  completionPct: number | null;
  activeDays: number;
  buckets: Bucket[];
  subjects: SubjectBreakdown[];
  freeFocusMinutes: number;  // sessions not linked to any task
  mostProductive: null | { label: string; minutes: number; sharePct: number };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function window(now: number, tz: number, period: Period, back: number) {
  const days = PERIOD_DAYS[period];
  const to = dayStart(now, tz) + DAY - back * days * DAY;
  return { days, from: to - days * DAY, to };
}

export function periodStats(
  sessions: FocusSession[], tasks: Task[], subjects: Subject[], chapters: Chapter[],
  now: number, tz: number, period: Period, back = 0,
): PeriodStats {
  const { days, from, to } = window(now, tz, period, back);
  const seen = new Set<string>();
  const unique = sessions.filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));

  const done = unique.filter(s => s.status === 'completed' && s.completedAt !== undefined && s.completedAt >= from && s.completedAt < to);
  const early = unique.filter(s => s.status === 'failed' && s.startedAt >= from && s.startedAt < to);
  const taskById = new Map(tasks.map(t => [t.id, t]));

  // bars: one per day for a week; one per 5 days for a month
  const size = period === 'week' ? 1 : 5;
  const buckets: Bucket[] = [];
  for (let i = 0; i < days / size; i++) {
    const start = from + i * size * DAY;
    const inBucket = done.filter(s => (s.completedAt as number) >= start && (s.completedAt as number) < start + size * DAY);
    const d = new Date(start - tz * MIN);
    buckets.push({
      label: period === 'week' ? WEEKDAYS[d.getUTCDay()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
      start,
      minutes: inBucket.reduce((a, s) => a + s.targetMinutes, 0),
      sessions: inBucket.length,
    });
  }

  const bySubject = new Map<string, { minutes: number; sessions: number }>();
  let free = 0;
  for (const s of done) {
    const sub = s.taskId ? taskById.get(s.taskId)?.subjectId : undefined;
    if (!sub) { free += s.targetMinutes; continue; }
    const e = bySubject.get(sub) ?? { minutes: 0, sessions: 0 };
    e.minutes += s.targetMinutes; e.sessions++;
    bySubject.set(sub, e);
  }
  const subjectRows: SubjectBreakdown[] = subjects.map(sub => ({
    id: sub.id, title: sub.title,
    minutes: bySubject.get(sub.id)?.minutes ?? 0,
    sessions: bySubject.get(sub.id)?.sessions ?? 0,
    progressPct: Math.round(subjectProgress(tasks, sessions, sub.id, chapters) * 100),
  })).sort((a, b) => b.minutes - a.minutes);

  // Most focus minutes in a 2-hour block (by start time). Needs a few sessions before it says anything.
  let mostProductive: PeriodStats['mostProductive'] = null;
  if (done.length >= MIN_SESSIONS_FOR_PRODUCTIVE_TIME) {
    const blocks = new Map<number, { minutes: number; sessions: number }>();
    for (const s of done) {
      const b = Math.floor(localHour(s.startedAt, tz) / 2) * 2;
      const e = blocks.get(b) ?? { minutes: 0, sessions: 0 };
      e.minutes += s.targetMinutes; e.sessions++;
      blocks.set(b, e);
    }
    const total = done.reduce((a, s) => a + s.targetMinutes, 0);
    const [hour, top] = [...blocks.entries()].sort((a, b) => b[1].minutes - a[1].minutes || b[1].sessions - a[1].sessions || a[0] - b[0])[0];
    mostProductive = { label: blockLabel(hour), minutes: top.minutes, sharePct: Math.round((top.minutes / total) * 100) };
  }

  const activeDays = new Set(done.map(s => localDay(s.completedAt as number, tz))).size;
  return {
    period, days, from, to,
    focusMinutes: done.reduce((a, s) => a + s.targetMinutes, 0),
    sessions: done.length,
    endedEarly: early.length,
    completionPct: done.length + early.length > 0 ? Math.round((done.length / (done.length + early.length)) * 100) : null,
    activeDays, buckets,
    subjects: subjectRows,
    freeFocusMinutes: free,
    mostProductive,
  };
}
