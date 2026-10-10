import { FocusSession } from './types';
import { dayStart, fmtDuration } from './progress';
import { localDay } from './analytics';

/**
 * Weekly goal (sessions per week, Monday to Sunday in local time) and its suggestion.
 * The suggestion is RULE-BASED on purpose: a goal that changed between runs would feel arbitrary,
 * and the numbers behind it can be shown. The goal itself is a device-local preference.
 */

const MIN = 60000;
const DAY = 24 * 60 * MIN;
export const MIN_GOAL = 3;
export const MAX_GOAL = 30;
export const DEFAULT_GOAL = 5;

export const clampGoal = (n: number): number => Math.min(MAX_GOAL, Math.max(MIN_GOAL, Math.round(n)));

/** Days since Monday for the local day containing `ms` (Mon = 0 ... Sun = 6). */
const daysSinceMonday = (ms: number, tz: number): number => (new Date(ms - tz * MIN).getUTCDay() + 6) % 7;

export const weekStart = (now: number, tz: number): number => dayStart(now, tz) - daysSinceMonday(now, tz) * DAY;

export interface WeekTotals { start: number; sessions: number; minutes: number; current: boolean }

/** The last `weeks` calendar weeks, oldest first; the last entry is the (partial) current week. */
export function weeklyHistory(sessions: FocusSession[], now: number, tz: number, weeks = 8): WeekTotals[] {
  const thisWeek = weekStart(now, tz);
  const out: WeekTotals[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push({ start: thisWeek - i * 7 * DAY, sessions: 0, minutes: 0, current: i === 0 });
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.status !== 'completed' || s.completedAt === undefined || seen.has(s.id)) continue;
    seen.add(s.id);
    const w = out.find(x => (s.completedAt as number) >= x.start && (s.completedAt as number) < x.start + 7 * DAY);
    if (w) { w.sessions++; w.minutes += s.targetMinutes; }
  }
  return out;
}

export interface GoalProgress {
  done: number;
  target: number;
  pct: number;          // capped at 100
  remaining: number;
  met: boolean;
  /** Days left this week including today. */
  daysLeft: number;
}

export function goalProgress(done: number, target: number, now: number, tz: number): GoalProgress {
  return {
    done, target,
    pct: Math.min(100, Math.round((done / target) * 100)),
    remaining: Math.max(0, target - done),
    met: done >= target,
    daysLeft: 7 - daysSinceMonday(now, tz),
  };
}

export interface GoalSuggestion {
  target: number;
  basis: 'history' | 'default';
  explanation: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * A small step above what you actually did, never a leap:
 *  - looks at the last 4 FULL weeks since you started (the current week is unfinished, and weeks
 *    before your first session say nothing about you)
 *  - fewer than 2 such weeks: a gentle default
 *  - otherwise the median plus about 10% (at least +1), at most 25% above your best recent week
 *  - after quiet weeks (median 0) it restarts at the minimum rather than guilt-tripping
 */
export function suggestWeeklyGoal(history: WeekTotals[]): GoalSuggestion {
  const full = history.filter(w => !w.current);
  const firstActive = full.findIndex(w => w.sessions > 0);
  const considered = (firstActive === -1 ? [] : full.slice(firstActive)).slice(-4);

  if (considered.length < 2) {
    return {
      target: DEFAULT_GOAL, basis: 'default',
      explanation: `You do not have 2 full weeks of history yet, so ${DEFAULT_GOAL} sessions is a gentle starting goal.`,
    };
  }
  const counts = considered.map(w => w.sessions);
  const med = median(counts);
  const best = Math.max(...counts);
  const list = counts.join(', ');

  if (med === 0) {
    return {
      target: MIN_GOAL, basis: 'history',
      explanation: `Your last ${counts.length} full weeks had ${list} sessions. ${MIN_GOAL} is an easy way back in.`,
    };
  }
  const step = Math.max(med + 1, Math.ceil(med * 1.1));
  const target = clampGoal(Math.min(step, Math.ceil(best * 1.25)));
  return {
    target, basis: 'history',
    explanation: `Your last ${counts.length} full weeks had ${list} sessions (typically ${Math.round(med)}). ${target} is a small step up from that.`,
  };
}

/** Longest run of consecutive local days with a completed session. */
export function longestStreak(sessions: FocusSession[], tz: number): number {
  const days = new Set<string>();
  for (const s of sessions) if (s.status === 'completed' && s.completedAt !== undefined) days.add(localDay(s.completedAt, tz));
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    const t = Date.parse(`${d}T00:00:00Z`);
    run = prev !== null && t - prev === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

export { fmtDuration };
