import { Task, Chapter, QuizAttempt } from './types';

/**
 * Topic mastery and weak-topic detection, derived from quiz attempts (never stored).
 * A "topic" is a task. Every quiz question is tagged with the topic it tests, so a chapter quiz
 * still produces per-topic results.
 *
 * Honesty rules: a rating needs MIN_QUESTIONS_FOR_RATING answered questions (one 5-question quiz
 * is only 20% granular), and only the most recent attempts count so mastery follows improvement.
 */

export const MIN_QUESTIONS_FOR_RATING = 5;
export const RECENT_ATTEMPTS = 3;
export const STRONG_PCT = 80;
export const WEAK_BELOW_PCT = 50;

export type MasteryLevel = 'strong' | 'ok' | 'weak' | 'unknown';

export interface TopicMastery {
  taskId: string;
  /** Percent correct over the counted attempts; null when there are no answers at all. */
  pct: number | null;
  correct: number;
  questions: number;
  attempts: number;
  level: MasteryLevel;
}

export const levelEmoji: Record<MasteryLevel, string> = { strong: '🟢', ok: '🟡', weak: '🔴', unknown: '⚪' };

export function levelFor(pct: number | null, questions: number): MasteryLevel {
  if (pct === null || questions < MIN_QUESTIONS_FOR_RATING) return 'unknown';
  if (pct >= STRONG_PCT) return 'strong';
  if (pct < WEAK_BELOW_PCT) return 'weak';
  return 'ok';
}

export function computeMastery(attempts: QuizAttempt[]): Map<string, TopicMastery> {
  // taskId -> one entry per attempt that contained the topic
  const perTopic = new Map<string, { at: number; correct: number; total: number }[]>();
  const seen = new Set<string>();
  for (const a of attempts) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const inAttempt = new Map<string, { correct: number; total: number }>();
    for (const r of a.results) {
      const e = inAttempt.get(r.taskId) ?? { correct: 0, total: 0 };
      e.total++;
      if (r.correct) e.correct++;
      inAttempt.set(r.taskId, e);
    }
    for (const [taskId, e] of inAttempt) {
      const list = perTopic.get(taskId) ?? [];
      list.push({ at: a.completedAt, ...e });
      perTopic.set(taskId, list);
    }
  }

  const out = new Map<string, TopicMastery>();
  for (const [taskId, list] of perTopic) {
    const recent = list.sort((x, y) => y.at - x.at).slice(0, RECENT_ATTEMPTS);
    const correct = recent.reduce((s, e) => s + e.correct, 0);
    const questions = recent.reduce((s, e) => s + e.total, 0);
    const pct = questions > 0 ? Math.round((correct / questions) * 100) : null;
    out.set(taskId, { taskId, pct, correct, questions, attempts: recent.length, level: levelFor(pct, questions) });
  }
  return out;
}

/** Weighted by number of questions. Null until there is enough data to say anything. */
export function subjectMastery(
  mastery: Map<string, TopicMastery>, tasks: Task[], subjectId: string,
): { pct: number; questions: number } | null {
  let correct = 0;
  let questions = 0;
  for (const t of tasks) {
    if (t.deleted || t.subjectId !== subjectId) continue;
    const m = mastery.get(t.id);
    if (!m) continue;
    correct += m.correct;
    questions += m.questions;
  }
  return questions >= MIN_QUESTIONS_FOR_RATING ? { pct: Math.round((correct / questions) * 100), questions } : null;
}

export function weakTopics(mastery: Map<string, TopicMastery>, tasks: Task[]): { task: Task; mastery: TopicMastery }[] {
  const out: { task: Task; mastery: TopicMastery }[] = [];
  for (const t of tasks) {
    if (t.deleted) continue;
    const m = mastery.get(t.id);
    if (m && m.level === 'weak') out.push({ task: t, mastery: m });
  }
  return out.sort((a, b) => (a.mastery.pct ?? 0) - (b.mastery.pct ?? 0) || b.mastery.questions - a.mastery.questions);
}

export interface RevisionAdvice {
  task: Task;
  mastery: TopicMastery;
  message: string;
}

/**
 * "Revise Momentum before starting the next chapter."
 * If a weak topic sits in the same subject at or before the next task's chapter, it should be
 * revised first. Otherwise the overall weakest topic is mentioned without implying an order.
 */
export function revisionAdvice(args: {
  mastery: Map<string, TopicMastery>;
  tasks: Task[];
  chapters: Chapter[];
  next?: Task;
}): RevisionAdvice | null {
  const weak = weakTopics(args.mastery, args.tasks);
  if (weak.length === 0) return null;
  const pct = (m: TopicMastery) => m.pct ?? 0;

  if (args.next) {
    const next = args.next;
    const order = (chapterId: string) => args.chapters.findIndex(c => c.id === chapterId);
    const before = weak.find(w =>
      w.task.id !== next.id && w.task.subjectId === next.subjectId && order(w.task.chapterId) <= order(next.chapterId));
    if (before) {
      return { ...before, message: `Revise ${before.task.title} (${pct(before.mastery)}%) before starting ${next.title}.` };
    }
  }
  const w = weak[0];
  return { ...w, message: `Your weakest topic is ${w.task.title} (${pct(w.mastery)}%). Worth a revision session.` };
}
