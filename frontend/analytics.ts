import { Task, FocusSession, Chapter, Subject } from './types';
import { taskProgress } from './insights';

/**
 * Performance statistics, rule-based findings and the "learned profile".
 *
 * Everything is derived from sessions + tasks, so it works offline and is the
 * fallback when no LLM is reachable. The LLM only rephrases these numbers
 * (the backend rejects any number that is not in the statistics).
 *
 * Honesty rules baked in here:
 *  - nothing is claimed below MIN_TOTAL_SESSIONS total sessions
 *  - a bucket needs MIN_BUCKET_SESSIONS sessions to be compared at all
 *  - a "best vs worst" claim needs a gap of at least MIN_GAP_PCT points
 *  These are correlations in the student's own history, never causes.
 */

export const MIN_TOTAL_SESSIONS = 8;
export const MIN_BUCKET_SESSIONS = 3;
export const MIN_GAP_PCT = 15;
export const SHORT_SESSION_MAX_MIN = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimeBlockStat { label: string; startHour: number; sessions: number; completed: number; completionPct: number }
export interface DurationStat { minutes: number; sessions: number; completed: number; completionPct: number }
export interface SubjectStat {
  id: string; title: string; sessions: number; completed: number;
  completionPct: number | null; focusMinutes: number; progressPct: number;
}

export interface PerformanceStats {
  windowDays: number;
  totalSessions: number;
  completed: number;
  endedEarly: number;
  completionPct: number | null;
  focusMinutes: number;
  avgCompletedMinutes: number | null;
  activeDaysLast7: number;
  byTimeBlock: TimeBlockStat[];
  byDuration: DurationStat[];
  shortVsLong: null | {
    thresholdMinutes: number;
    shortSessions: number; shortCompletionPct: number;
    longSessions: number; longCompletionPct: number;
  };
  subjects: SubjectStat[];
  endReasons: { giveUp: number; appSwitch: number };
}

// ─── Time helpers (tzOffsetMin = Date#getTimezoneOffset(): minutes behind UTC) ─

export const localHour = (ms: number, tz: number): number => new Date(ms - tz * 60000).getUTCHours();
export const localDay = (ms: number, tz: number): string => new Date(ms - tz * 60000).toISOString().slice(0, 10);

const h12 = (h: number) => (h % 12 === 0 ? 12 : h % 12);
const mer = (h: number) => (h % 24 < 12 ? 'AM' : 'PM');

/** "6–8 PM", "10 AM–12 PM" */
export function blockLabel(startHour: number): string {
  const end = (startHour + 2) % 24;
  return mer(startHour) === mer(end)
    ? `${h12(startHour)}–${h12(end)} ${mer(end)}`
    : `${h12(startHour)} ${mer(startHour)}–${h12(end)} ${mer(end)}`;
}

const pctOf = (num: number, den: number): number => Math.round((num / den) * 100);

// ─── Statistics ───────────────────────────────────────────────────────────────

export function computeStats(
  sessions: FocusSession[], tasks: Task[], subjects: Subject[], chapters: Chapter[],
  now: number, tz: number, windowDays = 30,
): PerformanceStats {
  const from = now - windowDays * DAY_MS;
  const seen = new Set<string>();
  const inWindow = sessions.filter(s => {
    if (seen.has(s.id) || s.startedAt < from || s.startedAt > now + DAY_MS) return false;
    seen.add(s.id);
    return true;
  });

  const done = inWindow.filter(s => s.status === 'completed');
  const early = inWindow.filter(s => s.status === 'failed');
  const taskById = new Map(tasks.map(t => [t.id, t]));

  // time of day (2h blocks by session start)
  const blocks = new Map<number, { sessions: number; completed: number }>();
  for (const s of inWindow) {
    const start = Math.floor(localHour(s.startedAt, tz) / 2) * 2;
    const b = blocks.get(start) ?? { sessions: 0, completed: 0 };
    b.sessions++; if (s.status === 'completed') b.completed++;
    blocks.set(start, b);
  }
  const byTimeBlock = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([startHour, b]) => ({
    label: blockLabel(startHour), startHour, sessions: b.sessions, completed: b.completed,
    completionPct: pctOf(b.completed, b.sessions),
  }));

  // duration
  const durs = new Map<number, { sessions: number; completed: number }>();
  for (const s of inWindow) {
    const d = durs.get(s.targetMinutes) ?? { sessions: 0, completed: 0 };
    d.sessions++; if (s.status === 'completed') d.completed++;
    durs.set(s.targetMinutes, d);
  }
  const byDuration = [...durs.entries()].sort((a, b) => a[0] - b[0]).map(([minutes, d]) => ({
    minutes, sessions: d.sessions, completed: d.completed, completionPct: pctOf(d.completed, d.sessions),
  }));

  const short = inWindow.filter(s => s.targetMinutes <= SHORT_SESSION_MAX_MIN);
  const long = inWindow.filter(s => s.targetMinutes > SHORT_SESSION_MAX_MIN);
  const shortVsLong = short.length >= MIN_BUCKET_SESSIONS && long.length >= MIN_BUCKET_SESSIONS
    ? {
        thresholdMinutes: SHORT_SESSION_MAX_MIN,
        shortSessions: short.length,
        shortCompletionPct: pctOf(short.filter(s => s.status === 'completed').length, short.length),
        longSessions: long.length,
        longCompletionPct: pctOf(long.filter(s => s.status === 'completed').length, long.length),
      }
    : null;

  // subjects (only sessions linked to a task can be attributed)
  const subjectStats: SubjectStat[] = subjects.map(sub => {
    const mine = inWindow.filter(s => s.taskId && taskById.get(s.taskId)?.subjectId === sub.id);
    const completed = mine.filter(s => s.status === 'completed');
    const subChapters = chapters.filter(c => c.subjectId === sub.id);
    const subTasks = tasks.filter(t => !t.deleted && subChapters.some(c => c.id === t.chapterId));
    const progress = subTasks.length
      ? subTasks.reduce((acc, t) => acc + taskProgress(t, sessions), 0) / subTasks.length
      : 0;
    return {
      id: sub.id, title: sub.title, sessions: mine.length, completed: completed.length,
      completionPct: mine.length ? pctOf(completed.length, mine.length) : null,
      focusMinutes: completed.reduce((a, s) => a + s.targetMinutes, 0),
      progressPct: Math.round(progress * 100),
    };
  });

  // consistency: distinct local days with a completed session, last 7 days
  const days = new Set(
    done.filter(s => (s.completedAt ?? 0) >= now - 7 * DAY_MS).map(s => localDay(s.completedAt ?? s.startedAt, tz)),
  );

  return {
    windowDays,
    totalSessions: inWindow.length,
    completed: done.length,
    endedEarly: early.length,
    completionPct: inWindow.length ? pctOf(done.length, inWindow.length) : null,
    focusMinutes: done.reduce((a, s) => a + s.targetMinutes, 0),
    avgCompletedMinutes: done.length ? Math.round(done.reduce((a, s) => a + s.targetMinutes, 0) / done.length) : null,
    activeDaysLast7: days.size,
    byTimeBlock, byDuration, shortVsLong,
    subjects: subjectStats,
    endReasons: {
      giveUp: early.filter(s => s.failReason === 'give_up').length,
      appSwitch: early.filter(s => s.failReason === 'app_switch').length,
    },
  };
}

// ─── Pattern detection (shared by findings and the learned profile) ──────────

function spread<T extends { sessions: number; completionPct: number | null }>(items: T[]) {
  const ok = items.filter(i => i.sessions >= MIN_BUCKET_SESSIONS && i.completionPct !== null) as (T & { completionPct: number })[];
  if (ok.length < 2) return null;
  const sorted = [...ok].sort((a, b) => b.completionPct - a.completionPct || b.sessions - a.sessions);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return best.completionPct - worst.completionPct >= MIN_GAP_PCT ? { best, worst } : null;
}

export const bestTimeBlock = (st: PerformanceStats) => spread(st.byTimeBlock);
export const bestDuration = (st: PerformanceStats) => spread(st.byDuration);
export const weakestSubject = (st: PerformanceStats) => spread(st.subjects);

// ─── Rule-based findings (also the offline / no-key fallback) ─────────────────

export interface Finding { kind: 'data' | 'time' | 'duration' | 'subject' | 'consistency' | 'ended_early'; text: string }

export function ruleFindings(st: PerformanceStats): Finding[] {
  const out: Finding[] = [];

  if (st.totalSessions < MIN_TOTAL_SESSIONS) {
    out.push({
      kind: 'data',
      text: `Only ${st.totalSessions} sessions so far. Patterns start to show after about ${MIN_TOTAL_SESSIONS}.`,
    });
  } else {
    const t = bestTimeBlock(st);
    if (t) {
      out.push({
        kind: 'time',
        text: `You complete ${t.best.completionPct}% of sessions started between ${t.best.label}, versus ${t.worst.completionPct}% between ${t.worst.label}.`,
      });
    }

    const sl = st.shortVsLong;
    if (sl && Math.abs(sl.shortCompletionPct - sl.longCompletionPct) >= MIN_GAP_PCT) {
      out.push({
        kind: 'duration',
        text: sl.shortCompletionPct > sl.longCompletionPct
          ? `Sessions of ${sl.thresholdMinutes} minutes or less are completed more often (${sl.shortCompletionPct}% vs ${sl.longCompletionPct}% for longer ones).`
          : `Longer sessions (over ${sl.thresholdMinutes} minutes) are completed more often (${sl.longCompletionPct}% vs ${sl.shortCompletionPct}% for shorter ones).`,
      });
    }

    const w = weakestSubject(st);
    if (w) {
      out.push({
        kind: 'subject',
        text: `${w.worst.title} has your lowest completion rate (${w.worst.completionPct}% of ${w.worst.sessions} sessions), while ${w.best.title} is at ${w.best.completionPct}%.`,
      });
    }

    const { giveUp, appSwitch } = st.endReasons;
    const early = giveUp + appSwitch;
    if (early >= MIN_BUCKET_SESSIONS) {
      if (appSwitch / early >= 0.6) {
        out.push({ kind: 'ended_early', text: `${appSwitch} of ${early} early endings came from switching away from the app.` });
      } else if (giveUp / early >= 0.6) {
        out.push({ kind: 'ended_early', text: `${giveUp} of ${early} early endings were you giving up mid-session.` });
      }
    }
  }

  out.push({
    kind: 'consistency',
    text: `You completed a session on ${st.activeDaysLast7} of the last 7 days.`,
  });
  return out;
}

// ─── Learned profile (adaptive recommendations) ───────────────────────────────

export interface LearnedProfile {
  sample: number;
  /** Enough history to adapt recommendations. */
  ready: boolean;
  bestBlock?: { startHour: number; label: string; completionPct: number };
  bestDurationMinutes?: number;
  weakSubjectId?: string;
  weakSubjectTitle?: string;
}

export function learnProfile(st: PerformanceStats): LearnedProfile {
  const base: LearnedProfile = { sample: st.totalSessions, ready: st.totalSessions >= MIN_TOTAL_SESSIONS };
  if (!base.ready) return base;

  const t = bestTimeBlock(st);
  const d = bestDuration(st);
  const w = weakestSubject(st);
  return {
    ...base,
    bestBlock: t ? { startHour: t.best.startHour, label: t.best.label, completionPct: t.best.completionPct } : undefined,
    bestDurationMinutes: d ? d.best.minutes : undefined,
    weakSubjectId: w ? w.worst.id : undefined,
    weakSubjectTitle: w ? w.worst.title : undefined,
  };
}
