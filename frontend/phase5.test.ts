import assert from 'node:assert/strict';
import { Task, FocusSession, Subject, Chapter, QuizAttempt } from './types';
import { periodStats, deltaLabel, fmtDuration, dayStart } from './progress';
import {
  weekStart, weeklyHistory, goalProgress, suggestWeeklyGoal, longestStreak, WeekTotals, MIN_GOAL, DEFAULT_GOAL,
} from './goals';
import { computeAchievements, nextUp, AchievementContext } from './achievements';

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const IST = -330;
// Local clock time in IST on Oct (7 + d) 2026 -> epoch ms. NOW is Wednesday 7 Oct 2026, 19:00 IST.
const at = (d: number, hh: number, mm = 0) => Date.UTC(2026, 9, 7 + d, hh, mm) - 330 * MIN;
const NOW = at(0, 19);

const subjects: Subject[] = [{ id: 's1', title: 'Math' }, { id: 's2', title: 'Science' }];
const chapters: Chapter[] = [{ id: 'c1', subjectId: 's1', title: 'Algebra' }, { id: 'c2', subjectId: 's2', title: 'Physics' }];
const mk = (id: string, subjectId: string, chapterId: string): Task => ({
  id, subjectId, chapterId, title: id, status: 'not_started', estimatedMinutes: 100, lamport: 0, deviceId: 'x', deleted: false,
});
const tasks = [mk('t1', 's1', 'c1'), mk('t2', 's2', 'c2')];

let n = 0;
const done = (start: number, minutes: number, taskId?: string): FocusSession => ({
  id: `s${n++}`, studentId: 'x', taskId, targetMinutes: minutes, startedAt: start, completedAt: start + minutes * MIN, status: 'completed', synced: true,
});
const early = (start: number, taskId?: string): FocusSession => ({
  id: `s${n++}`, studentId: 'x', taskId, targetMinutes: 25, startedAt: start, status: 'failed', failReason: 'give_up', synced: true,
});

// current 7 days = Thu 1 Oct .. Wed 7 Oct (local); previous 7 days = Thu 24 Sep .. Wed 30 Sep
const sessions: FocusSession[] = [
  done(at(0, 18), 25, 't1'), done(at(0, 17), 25, 't2'), done(at(-1, 18, 30), 25, 't1'),
  done(at(-2, 9), 45, 't2'), early(at(-2, 18), 't1'), done(at(-5, 18), 25, 't1'), done(at(-3, 10), 15),
  done(at(-10, 18), 25, 't1'), done(at(-11, 18), 25, 't1'), early(at(-12, 18), 't1'),
];

const tests: Record<string, () => void> = {
  // ── formatting ──────────────────────────────────────────────────────────────
  'duration and delta labels never divide by zero and read naturally'() {
    assert.deepEqual([fmtDuration(0), fmtDuration(45), fmtDuration(60), fmtDuration(85), fmtDuration(125)], ['0m', '45m', '1h', '1h 25m', '2h 5m']);
    assert.deepEqual([deltaLabel(0, 0), deltaLabel(5, 0), deltaLabel(150, 100), deltaLabel(50, 100), deltaLabel(100, 100)], ['–', 'new', '+50%', '-50%', '0%']);
  },

  // ── weekly analytics ────────────────────────────────────────────────────────
  'week: totals, completion, active days and daily bars (local days)'() {
    const w = periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'week');
    assert.deepEqual([w.focusMinutes, w.sessions, w.endedEarly, w.completionPct, w.activeDays], [160, 6, 1, 86, 5]);
    assert.deepEqual(w.buckets.map(b => b.label), ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
    assert.deepEqual(w.buckets.map(b => b.minutes), [0, 25, 0, 15, 45, 25, 50]);
    assert.equal(w.buckets.reduce((a, b) => a + b.minutes, 0), w.focusMinutes);
  },

  'week: subject minutes, free focus and overall subject progress'() {
    const w = periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'week');
    assert.deepEqual(w.subjects.map(s => [s.title, s.minutes, s.sessions]), [['Math', 75, 3], ['Science', 70, 2]]);
    assert.equal(w.freeFocusMinutes, 15);
    assert.equal(w.subjects[0].progressPct, 0 + Math.round((Math.min(0.9, (75 + 50) / 100)) * 100)); // t1: 125 min of 100 -> capped 90%
  },

  'week: most focus minutes in a 2-hour block, only once there are enough sessions'() {
    const w = periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'week');
    assert.deepEqual(w.mostProductive, { label: '6–8 PM', minutes: 75, sharePct: 47 });
    const few = periodStats(sessions.slice(0, 2), tasks, subjects, chapters, NOW, IST, 'week');
    assert.equal(few.mostProductive, null);
  },

  'week: the previous window is the 7 days before, so comparisons are like for like'() {
    const prev = periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'week', 1);
    assert.deepEqual([prev.focusMinutes, prev.sessions, prev.endedEarly, prev.completionPct], [50, 2, 1, 67]);
    assert.equal(prev.to, periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'week').from);
    assert.equal(deltaLabel(160, prev.focusMinutes), '+220%');
  },

  'month: 30 days in six 5-day bars that add up to the total'() {
    const m = periodStats(sessions, tasks, subjects, chapters, NOW, IST, 'month');
    assert.equal(m.buckets.length, 6);
    assert.deepEqual([m.buckets[0].label, m.buckets[5].label], ['Sep 8', 'Oct 3']);   // 30 days ending Wed 7 Oct start on Tue 8 Sep
    assert.deepEqual(m.buckets.map(b => b.minutes), [0, 0, 0, 50, 25, 135]);
    assert.equal(m.focusMinutes, 210);
    assert.equal(m.buckets.reduce((a, b) => a + b.minutes, 0), m.focusMinutes);
  },

  'analytics ignore duplicate session ids and an empty history is all zeros'() {
    const dup = periodStats([...sessions, sessions[0]], tasks, subjects, chapters, NOW, IST, 'week');
    assert.equal(dup.sessions, 6);
    const none = periodStats([], tasks, subjects, chapters, NOW, IST, 'week');
    assert.deepEqual([none.focusMinutes, none.sessions, none.completionPct, none.activeDays, none.mostProductive], [0, 0, null, 0, null]);
  },

  // ── calendar week ───────────────────────────────────────────────────────────
  'week starts on Monday in local time, including across the Sunday/Monday midnight'() {
    assert.equal(weekStart(NOW, IST), at(-2, 0));                                // Wed -> Mon 5 Oct 00:00 IST
    assert.equal(weekStart(at(4, 23, 30), IST), at(-2, 0));                      // Sun 11 Oct 23:30 IST: still that week
    assert.equal(weekStart(at(5, 0, 10), IST), at(5, 0));                        // Mon 12 Oct 00:10 IST: a new week
    assert.equal(weekStart(at(-2, 0), IST), at(-2, 0));                          // exactly Monday midnight
    assert.equal(dayStart(NOW, IST), at(0, 0));
  },

  'weekly history: calendar weeks, current one last and flagged, counts only completed sessions'() {
    const h = weeklyHistory(sessions, NOW, IST, 3);
    assert.deepEqual(h.map(w => w.current), [false, false, true]);
    assert.equal(h[2].start, at(-2, 0));
    // current week (Mon 5 Oct onwards): Wed 25 + 25, Tue 25, Mon 45 = 4 sessions, 120 min
    assert.deepEqual([h[2].sessions, h[2].minutes], [4, 120]);
    // previous week (Mon 28 Sep .. Sun 4 Oct): Fri 2 Oct, Sun 4 Oct (free focus) + Sep 28? none -> 2 sessions
    assert.deepEqual([h[1].sessions, h[1].minutes], [2, 40]);
  },

  'goal progress: percent capped at 100, remaining, and days left this week'() {
    assert.deepEqual(goalProgress(7, 10, NOW, IST), { done: 7, target: 10, pct: 70, remaining: 3, met: false, daysLeft: 5 });
    assert.deepEqual(goalProgress(12, 10, NOW, IST), { done: 12, target: 10, pct: 100, remaining: 0, met: true, daysLeft: 5 });
    assert.equal(goalProgress(0, 5, at(4, 20), IST).daysLeft, 1); // Sunday
  },

  // ── goal suggestion ─────────────────────────────────────────────────────────
  'suggestion: not enough history gives a gentle default and says why'() {
    const w = (s: number[]): WeekTotals[] => s.map((sessions, i) => ({ start: i, sessions, minutes: sessions * 25, current: i === s.length - 1 }));
    for (const h of [w([0, 0, 0, 0, 3]), w([6, 4]), w([0, 0, 8, 2])]) {
      const g = suggestWeeklyGoal(h);
      assert.deepEqual([g.target, g.basis], [DEFAULT_GOAL, 'default']);
      assert.match(g.explanation, /2 full weeks/);
    }
  },

  'suggestion: a small step above your typical week, never a leap'() {
    const w = (s: number[]): WeekTotals[] => s.map((sessions, i) => ({ start: i, sessions, minutes: 0, current: i === s.length - 1 }));
    const a = suggestWeeklyGoal(w([4, 6, 5, 5, 1]));       // current week (1) is ignored; median 5
    assert.equal(a.target, 6);
    assert.match(a.explanation, /4, 6, 5, 5/);
    assert.equal(suggestWeeklyGoal(w([2, 2, 2, 2, 0])).target, 3);
    assert.equal(suggestWeeklyGoal(w([10, 10, 10, 10, 0])).target, 11);
    assert.equal(suggestWeeklyGoal(w([0, 0, 0, 6, 6, 6, 6, 2])).target, 7);   // weeks before the first session are not counted
    assert.equal(suggestWeeklyGoal(w([4, 4, 4, 20, 0])).target, 5);           // one huge week does not drag the goal up (a mean would give 8)
    assert.equal(suggestWeeklyGoal(w([1, 1, 1, 12, 0])).target, 3);           // small typical weeks are floored at the minimum goal
    assert.equal(suggestWeeklyGoal(w([40, 40, 0])).target, 30);               // clamped
  },

  'suggestion: after quiet weeks it restarts at the minimum'() {
    const w = [0, 5, 0, 0, 1].map((sessions, i, a) => ({ start: i, sessions, minutes: 0, current: i === a.length - 1 }));
    const g = suggestWeeklyGoal(w);
    assert.equal(g.target, MIN_GOAL);
    assert.match(g.explanation, /easy way back/);
  },

  // ── streaks ─────────────────────────────────────────────────────────────────
  'longest streak counts consecutive LOCAL days and ignores failures and duplicates'() {
    const s = [at(-9, 18), at(-8, 18), at(-7, 18), at(-5, 18), at(-4, 18)].map(t => done(t, 25));
    assert.equal(longestStreak([...s, early(at(-6, 18)), s[0]], IST), 3);
    assert.equal(longestStreak([], IST), 0);
    // 23:30 IST and 00:30 IST next day are consecutive local days but the SAME UTC day
    const edge = [done(at(-3, 23, 30), 25), done(at(-2, 0, 30), 25)];
    assert.equal(longestStreak(edge, IST), 2);
    assert.equal(longestStreak(edge, 0), 1);
  },

  // ── achievements ────────────────────────────────────────────────────────────
  'achievements: progress is capped, unlocks at the threshold, and none are unlocked from nothing'() {
    const base: AchievementContext = { sessions: [], attempts: [], currentStreak: 0, weekSessions: 0, weekMinutes: 0, weeklyGoal: null, subjectMasteryPcts: [], tz: IST };
    const empty = computeAchievements(base);
    assert.equal(empty.length, 14);
    assert.ok(empty.every(a => !a.unlocked && a.current === 0));
    assert.equal(new Set(empty.map(a => a.id)).size, 14);

    const ten = Array.from({ length: 10 }, (_, i) => done(at(-i, 18), 25));
    const a = Object.fromEntries(computeAchievements({ ...base, sessions: ten, weekMinutes: 150 }).map(x => [x.id, x]));
    assert.deepEqual([a.first_focus.unlocked, a.sessions_10.unlocked, a.sessions_50.unlocked], [true, true, false]);
    assert.deepEqual([a.hours_week_5.unlocked, a.hours_week_5.current], [false, 150]);
    assert.deepEqual([a.streak_7.unlocked, a.streak_30.unlocked], [true, false]);          // 10 consecutive local days
    assert.equal(a.first_focus.current, 1);                                                 // capped at the target
    assert.equal(computeAchievements({ ...base, weekMinutes: 400 }).find(x => x.id === 'hours_week_5')!.unlocked, true);
  },

  'achievements: the longer of the server streak and the local streak is used'() {
    const base: AchievementContext = { sessions: [], attempts: [], currentStreak: 8, weekSessions: 0, weekMinutes: 0, weeklyGoal: null, subjectMasteryPcts: [], tz: IST };
    assert.equal(computeAchievements(base).find(x => x.id === 'streak_7')!.unlocked, true);
  },

  'achievements: weekly goal, quizzes (5+ questions to count as ace) and subject mastery'() {
    const att = (id: string, correct: number, wrong: number): QuizAttempt => ({
      id, studentId: 'x', subjectId: 's1', difficulty: 'easy', startedAt: 1, completedAt: 2, synced: true,
      results: [...Array(correct).fill({ taskId: 't1', correct: true }), ...Array(wrong).fill({ taskId: 't1', correct: false })],
    });
    const base: AchievementContext = { sessions: [], attempts: [], currentStreak: 0, weekSessions: 12, weekMinutes: 0, weeklyGoal: 10, subjectMasteryPcts: [61, 85], tz: IST };
    const get = (c: Partial<AchievementContext>) => Object.fromEntries(computeAchievements({ ...base, ...c }).map(x => [x.id, x]));

    const g = get({});
    assert.deepEqual([g.goal_week.unlocked, g.goal_week.current, g.goal_week.target], [true, 10, 10]);
    assert.equal(g.mastery_80.unlocked, true);
    assert.equal(g.first_quiz.unlocked, false);

    const noGoal = get({ weeklyGoal: null });
    assert.deepEqual([noGoal.goal_week.unlocked, noGoal.goal_week.description], [false, 'Set a weekly goal, then reach it']);
    assert.equal(get({ subjectMasteryPcts: [61] }).mastery_80.unlocked, false);

    const tiny = get({ attempts: [att('a', 2, 0)] });                       // 2 out of 2 is not an "ace"
    assert.deepEqual([tiny.first_quiz.unlocked, tiny.quiz_ace.unlocked, tiny.quiz_ace.current], [true, false, 0]);
    const ace = get({ attempts: [att('b', 4, 1)] });                        // 4 of 5 = 80%
    assert.deepEqual([ace.quiz_ace.unlocked, ace.quiz_ace.current], [true, 80]);
    const close = get({ attempts: [att('c', 3, 2)] });                      // 60%: progress is visible
    assert.deepEqual([close.quiz_ace.unlocked, close.quiz_ace.current], [false, 60]);
    assert.equal(get({ attempts: [att('d', 5, 0), att('d', 5, 0)] }).quizzes_10.current, 1);   // duplicate attempt id counted once
  },

  'next up: closest locked achievements first, and only ones with some progress'() {
    const base: AchievementContext = { sessions: [], attempts: [], currentStreak: 0, weekSessions: 0, weekMinutes: 270, weeklyGoal: null, subjectMasteryPcts: [], tz: IST };
    const ten = Array.from({ length: 7 }, (_, i) => done(at(-i, 18), 25));
    const next = nextUp(computeAchievements({ ...base, sessions: ten }), 3);
    assert.ok(next.every(a => !a.unlocked && a.current > 0));
    assert.equal(next[0].id, 'hours_week_5');                                 // 270 / 300 = 90%
    assert.ok(next.length <= 3);
    assert.deepEqual(nextUp(computeAchievements({ ...base, weekMinutes: 0 })), []);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 6).join('\n       ')}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
