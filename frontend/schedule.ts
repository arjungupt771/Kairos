import { FocusSession } from './types';
import { RankedTask, PLAN_BLOCK_MIN, taskFocusMinutes, taskEstimate } from './insights';
import { LearnedProfile, localDay } from './analytics';
import type { TopicMastery } from './mastery';

/**
 * Study-plan scheduling. The LLM (or the rule-based fallback) decides WHICH tasks, in
 * what ORDER and for how LONG. Everything about clock time is deterministic and lives here.
 *
 * A plan stores only its blocks. Whether a block is done or missed is derived from
 * sessions, exactly like task progress, so it can never disagree with the real data.
 */

export const BREAK_MIN = 5;
export const MIN_BLOCK_MIN = 10;
export const DAY_END_HOUR = 22; // plan nothing after 10 PM local time
const MIN_MS = 60000;

export type PlanSource = 'gemini' | 'groq' | 'rules';

export interface ScheduledBlock {
  id: string;
  taskId: string;
  startAt: number;
  minutes: number;
  reason: string;
}

export interface StudyPlan {
  id: string;
  createdAt: number;
  mode: 'plan' | 'reschedule';
  source: PlanSource;
  model?: string;
  summary: string;
  blocks: ScheduledBlock[];
}

export interface BlockItem { taskId: string; minutes: number; reason: string }

// ─── Time window ──────────────────────────────────────────────────────────────

/** Epoch ms of today's `endHour`:00 in the user's local time. */
export function windowEnd(now: number, tz: number, endHour = DAY_END_HOUR): number {
  const d = new Date(now - tz * MIN_MS);
  d.setUTCHours(endHour, 0, 0, 0);
  return d.getTime() + tz * MIN_MS;
}

export const roundUpTo5Min = (ms: number): number => Math.ceil(ms / (5 * MIN_MS)) * 5 * MIN_MS;

export function availableMinutes(now: number, endMs: number): number {
  return Math.max(0, Math.floor((endMs - roundUpTo5Min(now)) / MIN_MS));
}

/** Place items back to back (with breaks) starting at the next 5-minute mark; trim or drop what does not fit. */
export function layoutBlocks(items: BlockItem[], now: number, endMs: number, idPrefix: string): ScheduledBlock[] {
  const out: ScheduledBlock[] = [];
  let cursor = roundUpTo5Min(now);
  for (const it of items) {
    const room = Math.floor((endMs - cursor) / MIN_MS);
    const minutes = Math.min(it.minutes, Math.floor(room / 5) * 5);
    if (minutes < MIN_BLOCK_MIN) break;
    out.push({ id: `${idPrefix}-${out.length}`, taskId: it.taskId, startAt: cursor, minutes, reason: it.reason });
    cursor += (minutes + BREAK_MIN) * MIN_MS;
  }
  return out;
}

// ─── Block status (derived) ───────────────────────────────────────────────────

export type BlockStatus = 'done' | 'missed' | 'now' | 'upcoming';

/**
 * done   : a completed session on that task since the plan was made (each session counts once)
 * missed : the student ended a session on that task early, or the block's time has passed
 * now    : the block's time has started and nothing has happened yet
 */
export function blockStatuses(plan: StudyPlan, sessions: FocusSession[], now: number) {
  const used = new Set<string>();
  const blocks = [...plan.blocks].sort((a, b) => a.startAt - b.startAt);

  return blocks.map(block => {
    const completed = sessions.find(s =>
      !used.has(s.id) && s.status === 'completed' && s.taskId === block.taskId && (s.completedAt ?? 0) >= plan.createdAt);
    if (completed) { used.add(completed.id); return { block, status: 'done' as BlockStatus }; }

    const endedEarly = sessions.find(s =>
      !used.has(s.id) && s.status === 'failed' && s.taskId === block.taskId && s.startedAt >= plan.createdAt);
    if (endedEarly) { used.add(endedEarly.id); return { block, status: 'missed' as BlockStatus }; }

    if (now > block.startAt + block.minutes * MIN_MS) return { block, status: 'missed' as BlockStatus };
    return { block, status: (now >= block.startAt ? 'now' : 'upcoming') as BlockStatus };
  });
}

export const missedTaskIds = (statuses: { block: ScheduledBlock; status: BlockStatus }[]): string[] =>
  [...new Set(statuses.filter(s => s.status === 'missed').map(s => s.block.taskId))];

/** Only today's plan is shown; yesterday's is stale. */
export const isPlanFromToday = (plan: StudyPlan, now: number, tz: number): boolean =>
  localDay(plan.createdAt, tz) === localDay(now, tz);

// ─── Rule-based fallback ──────────────────────────────────────────────────────

/**
 * Used when no LLM is reachable. Missed tasks go first (they are already ranked by
 * progress/neglect), then the remaining ranked tasks, until the daily goal is covered.
 */
export function ruleBasedItems(
  ranked: RankedTask[], goalRemainingMin: number, availableMin: number, missed: string[],
): BlockItem[] {
  const missedSet = new Set(missed);
  const ordered = [...ranked.filter(r => missedSet.has(r.task.id)), ...ranked.filter(r => !missedSet.has(r.task.id))];
  const target = Math.max(goalRemainingMin, PLAN_BLOCK_MIN); // at least one block, even if the goal is met
  const items: BlockItem[] = [];
  let planned = 0;
  let budget = availableMin;
  for (const r of ordered) {
    if (items.length >= 4 || planned >= target || budget < MIN_BLOCK_MIN) break;
    const minutes = Math.min(r.suggestedMinutes, Math.floor(budget / 5) * 5);
    if (minutes < MIN_BLOCK_MIN) break;
    items.push({
      taskId: r.task.id, minutes,
      reason: missedSet.has(r.task.id) ? 'Missed earlier today. Try again.' : r.reason,
    });
    planned += minutes;
    budget -= minutes + BREAK_MIN;
  }
  return items;
}

// ─── Request for the backend ──────────────────────────────────────────────────

export function buildScheduleRequest(args: {
  mode: 'plan' | 'reschedule';
  now: number; tz: number;
  ranked: RankedTask[];
  sessions: FocusSession[];
  goalRemainingMin: number;
  availableMin: number;
  missed: string[];
  profile: LearnedProfile;
  mastery?: Map<string, TopicMastery>;
}) {
  const { now, tz, ranked, sessions, profile } = args;
  const local = new Date(now - tz * MIN_MS);
  const localTime = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  return {
    mode: args.mode,
    localTime,
    availableMinutes: args.availableMin,
    goalRemainingMinutes: args.goalRemainingMin,
    tasks: ranked.slice(0, 15).map(r => ({
      id: r.task.id,
      title: r.task.title,
      subject: r.subjectTitle,
      chapter: r.chapterTitle,
      status: r.task.status === 'in_progress' || r.progress > 0 ? 'in_progress' : 'not_started',
      progressPct: Math.round(r.progress * 100),
      remainingMinutes: Math.max(0, taskEstimate(r.task) - taskFocusMinutes(sessions, r.task.id)),
      mastery: args.mastery?.get(r.task.id)?.level === 'unknown' ? undefined : args.mastery?.get(r.task.id)
        ? { pct: args.mastery.get(r.task.id)!.pct, questions: args.mastery.get(r.task.id)!.questions, level: args.mastery.get(r.task.id)!.level }
        : undefined,
    })),
    missedTaskIds: args.missed,
    profile: {
      bestBlock: profile.bestBlock?.label,
      bestLengthMinutes: profile.bestDurationMinutes,
      weakSubject: profile.weakSubjectTitle,
      sample: profile.sample,
    },
  };
}
