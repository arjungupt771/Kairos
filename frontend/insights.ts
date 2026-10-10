import { Task, FocusSession, Chapter, Subject, StudentRewards } from './types';
import type { LearnedProfile } from './analytics';
import type { TopicMastery } from './mastery';

/**
 * Pure derivations for the Home dashboard and task↔focus integration.
 *
 * Nothing here is stored or synced. Everything is computed from data that the
 * sync protocol already converges (immutable, id-deduplicated sessions and
 * Lamport-merged tasks), so two devices always derive identical numbers.
 */

export const DEFAULT_ESTIMATE_MIN = 60;
export const DAILY_GOAL_MIN = 60;
export const PLAN_BLOCK_MIN = 25;
/** Score boost for the subject the student completes least often (only once a profile is ready). */
export const WEAK_SUBJECT_BOOST = 10;
export const MAX_BLOCK_MIN = 60;
/** Focus time alone never reports a task as finished; "done" is a deliberate action. */
export const AUTO_PROGRESS_CAP = 0.9;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ─── Task progress (derived from sessions) ────────────────────────────────────

/** Completed focus minutes spent on a task. Dedupes by session id defensively. */
export function taskFocusMinutes(sessions: FocusSession[], taskId: string): number {
  const seen = new Set<string>();
  let total = 0;
  for (const s of sessions) {
    if (s.taskId !== taskId || s.status !== 'completed' || seen.has(s.id)) continue;
    seen.add(s.id);
    total += s.targetMinutes;
  }
  return total;
}

export function taskEstimate(task: Task): number {
  return task.estimatedMinutes && task.estimatedMinutes > 0 ? task.estimatedMinutes : DEFAULT_ESTIMATE_MIN;
}

/** 0..1. Done = 1. Otherwise focus time / estimate, capped below 1. */
export function taskProgress(task: Task, sessions: FocusSession[]): number {
  if (task.status === 'done') return 1;
  const ratio = taskFocusMinutes(sessions, task.id) / taskEstimate(task);
  return Math.min(AUTO_PROGRESS_CAP, ratio);
}

export function chapterProgress(tasks: Task[], sessions: FocusSession[], chapterId: string): number {
  const ts = tasks.filter(t => t.chapterId === chapterId && !t.deleted);
  if (ts.length === 0) return 0;
  return ts.reduce((acc, t) => acc + taskProgress(t, sessions), 0) / ts.length;
}

export function subjectProgress(
  tasks: Task[], sessions: FocusSession[], subjectId: string, chapters: Chapter[],
): number {
  const chaps = chapters.filter(c => c.subjectId === subjectId);
  if (chaps.length === 0) return 0;
  return chaps.reduce((acc, c) => acc + chapterProgress(tasks, sessions, c.id), 0) / chaps.length;
}

// ─── Today / streak ───────────────────────────────────────────────────────────

/**
 * rewards.todayFocusMinutes only resets when the next session is applied, so a
 * stale `todayDate` must read as 0 rather than yesterday's total.
 */
export function focusMinutesToday(rewards: StudentRewards, now: number): number {
  return rewards.todayDate === utcDay(now) ? rewards.todayFocusMinutes : 0;
}

export interface StreakInfo {
  days: number;
  /** Streak is alive but today has no completed session yet. */
  atRisk: boolean;
}

/** A streak whose last day is older than yesterday is already broken, whatever the stored value says. */
export function effectiveStreak(rewards: StudentRewards, now: number): StreakInfo {
  const today = utcDay(now);
  const yesterday = utcDay(now - 24 * 60 * 60 * 1000);
  if (rewards.lastStreakDate === today) return { days: rewards.streak, atRisk: false };
  if (rewards.lastStreakDate === yesterday) return { days: rewards.streak, atRisk: rewards.streak > 0 };
  return { days: 0, atRisk: false };
}

export function sessionsToday(sessions: FocusSession[], now: number) {
  const today = utcDay(now);
  const seen = new Set<string>();
  let completed = 0;
  let failed = 0;
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (s.status === 'completed' && s.completedAt && utcDay(s.completedAt) === today) completed++;
    if (s.status === 'failed' && utcDay(s.startedAt) === today) failed++;
  }
  return { completed, failed };
}

// ─── Recommendation ───────────────────────────────────────────────────────────

export interface RankedTask {
  task: Task;
  subjectTitle: string;
  chapterTitle: string;
  progress: number;
  suggestedMinutes: number;
  reason: string;
  score: number;
}

/**
 * Rule-based ranking (no model involved): finish what you've started, then
 * favour the subject that has had the least focus time in the last 7 days.
 * Syllabus order breaks ties. When a ready `profile` is passed (see analytics.ts),
 * the weakest subject gets a boost and block length follows the duration the student
 * actually completes most often. Without enough history nothing changes.
 */
export function rankTasks(
  tasks: Task[], sessions: FocusSession[], chapters: Chapter[], subjects: Subject[], now: number,
  profile?: LearnedProfile, mastery?: Map<string, TopicMastery>,
): RankedTask[] {
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const weekMinutesBySubject = new Map<string, number>();
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (s.status !== 'completed' || !s.taskId || !s.completedAt || now - s.completedAt > WEEK_MS) continue;
    const t = taskById.get(s.taskId);
    if (!t) continue;
    weekMinutesBySubject.set(t.subjectId, (weekMinutesBySubject.get(t.subjectId) ?? 0) + s.targetMinutes);
  }
  const maxWeek = Math.max(0, ...Array.from(weekMinutesBySubject.values()));

  const ranked: RankedTask[] = [];
  tasks.forEach((task, index) => {
    if (task.deleted || task.status === 'done') return;

    const progress = taskProgress(task, sessions);
    const started = task.status === 'in_progress' || progress > 0;
    const weekMin = weekMinutesBySubject.get(task.subjectId) ?? 0;
    const neglect = maxWeek > 0 ? 1 - weekMin / maxWeek : 0.5;

    const weak = !!profile?.ready && !!profile.weakSubjectId && profile.weakSubjectId === task.subjectId;
    const topic = mastery?.get(task.id);
    // A weak quiz result is a strong revision signal; unknown/insufficient data has no effect.
    const masteryBoost = topic?.level === 'weak' ? 60 + (50 - (topic.pct ?? 0)) / 5 : 0;
    const score = (started ? 40 + progress * 20 : 0) + neglect * 30 + (weak ? WEAK_SUBJECT_BOOST : 0) + masteryBoost - index * 0.01;

    const subjectTitle = subjects.find(s => s.id === task.subjectId)?.title ?? '';
    const chapterTitle = chapters.find(c => c.id === task.chapterId)?.title ?? '';

    let reason: string;
    if (topic?.level === 'weak') reason = `You scored ${topic.pct}% on this topic. Revise it before moving on.`;
    else if (started) reason = `You're ${Math.round(progress * 100)}% in. Finish what you started.`;
    else if (weak) reason = `You complete fewer ${subjectTitle} sessions than other subjects.`;
    else if (maxWeek > 0 && neglect >= 0.99) reason = `No ${subjectTitle} focus in the last 7 days.`;
    else if (maxWeek > 0 && neglect > 0.5) reason = `${subjectTitle} has had the least focus this week.`;
    else reason = 'Next up in your syllabus.';

    const remaining = Math.max(0, taskEstimate(task) - taskFocusMinutes(sessions, task.id));
    const rounded = Math.round(remaining / 5) * 5;
    const preferred = profile?.ready && profile.bestDurationMinutes
      ? Math.min(MAX_BLOCK_MIN, profile.bestDurationMinutes)
      : PLAN_BLOCK_MIN;
    const suggestedMinutes = Math.min(preferred, Math.max(10, rounded));

    ranked.push({ task, subjectTitle, chapterTitle, progress, suggestedMinutes, reason, score });
  });

  return ranked.sort((a, b) => b.score - a.score);
}

export interface PlanBlock {
  task: Task;
  subjectTitle: string;
  minutes: number;
}

/** Fill the remaining daily goal with one block per top-ranked task (max 4). */
export function buildTodayPlan(ranked: RankedTask[], goalMin: number, doneMin: number): PlanBlock[] {
  let remaining = Math.max(0, goalMin - doneMin);
  if (remaining <= 0) return [];
  const out: PlanBlock[] = [];
  for (const r of ranked) {
    if (out.length >= 4 || remaining <= 0) break;
    const minutes = Math.min(r.suggestedMinutes, remaining);
    out.push({ task: r.task, subjectTitle: r.subjectTitle, minutes });
    remaining -= minutes;
  }
  return out;
}
