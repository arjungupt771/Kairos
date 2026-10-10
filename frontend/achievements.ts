import { FocusSession, QuizAttempt } from './types';
import { longestStreak } from './goals';

/**
 * Achievements are DERIVED from sessions, quiz attempts and the weekly goal, never stored, so they
 * can never disagree with the data and need no sync. Each has a numeric progress so "almost there"
 * is visible. Copy stays neutral: nothing here punishes a missed day.
 */

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  description: string;
  unlocked: boolean;
  /** Capped at target. */
  current: number;
  target: number;
}

export interface AchievementContext {
  sessions: FocusSession[];
  attempts: QuizAttempt[];
  /** Server streak (UTC days); the longer of this and the locally computed longest run is used. */
  currentStreak: number;
  weekSessions: number;
  weekMinutes: number;
  weeklyGoal: number | null;
  /** Rated subject mastery percentages (a subject needs enough quiz answers to be rated). */
  subjectMasteryPcts: number[];
  tz: number;
}

const make = (id: string, icon: string, title: string, description: string, current: number, target: number): Achievement => ({
  id, icon, title, description, unlocked: current >= target, current: Math.min(current, target), target,
});

export function computeAchievements(c: AchievementContext): Achievement[] {
  const seen = new Set<string>();
  const done = c.sessions.filter(s => s.status === 'completed' && !seen.has(s.id) && (seen.add(s.id), true));
  const totalMinutes = done.reduce((a, s) => a + s.targetMinutes, 0);
  const bestStreak = Math.max(c.currentStreak, longestStreak(c.sessions, c.tz));

  const seenA = new Set<string>();
  const attempts = c.attempts.filter(a => !seenA.has(a.id) && (seenA.add(a.id), true));
  const quizPct = (a: QuizAttempt) => Math.round((a.results.filter(r => r.correct).length / a.results.length) * 100);
  // "Ace" needs at least 5 questions: 2 out of 2 proves nothing
  const bestQuiz = Math.max(0, ...attempts.filter(a => a.results.length >= 5).map(quizPct));
  const bestMastery = Math.max(0, ...c.subjectMasteryPcts);

  return [
    make('first_focus', '⭐', 'First focus', 'Complete your first focus session', done.length, 1),
    make('sessions_10', '🎯', '10 sessions', 'Complete 10 focus sessions', done.length, 10),
    make('sessions_50', '🏅', '50 sessions', 'Complete 50 focus sessions', done.length, 50),
    make('sessions_100', '🏆', '100 sessions', 'Complete 100 focus sessions', done.length, 100),
    make('hours_week_5', '⏱', '5 hours this week', 'Focus for 5 hours in one week', c.weekMinutes, 300),
    make('hours_total_25', '📚', '25 hours focused', 'Focus for 25 hours in total', totalMinutes, 1500),
    make('streak_3', '🔥', '3-day streak', 'Study 3 days in a row', bestStreak, 3),
    make('streak_7', '🔥', '7-day streak', 'Study 7 days in a row', bestStreak, 7),
    make('streak_30', '🌋', '30-day streak', 'Study 30 days in a row', bestStreak, 30),
    c.weeklyGoal
      ? make('goal_week', '✅', 'Weekly goal met', `Reach ${c.weeklyGoal} sessions this week`, c.weekSessions, c.weeklyGoal)
      : make('goal_week', '✅', 'Weekly goal met', 'Set a weekly goal, then reach it', 0, 1),
    make('first_quiz', '📝', 'First quiz', 'Finish your first quiz', attempts.length, 1),
    make('quizzes_10', '🧩', '10 quizzes', 'Finish 10 quizzes', attempts.length, 10),
    make('quiz_ace', '🧠', 'Quiz ace', 'Score 80% or more on a quiz of 5+ questions', bestQuiz, 80),
    make('mastery_80', '🎓', 'Subject mastery', 'Reach 80% mastery in a subject (from quizzes)', bestMastery, 80),
  ];
}

/** Locked achievements sorted by how close they are, for a "next up" list. */
export function nextUp(list: Achievement[], n = 3): Achievement[] {
  return list.filter(a => !a.unlocked && a.current > 0)
    .sort((a, b) => b.current / b.target - a.current / a.target)
    .slice(0, n);
}
