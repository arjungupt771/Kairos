import assert from 'node:assert/strict';
import { Task, FocusSession, Chapter, Subject, StudentRewards } from './types';
import {
  taskFocusMinutes, taskProgress, chapterProgress, subjectProgress,
  focusMinutesToday, effectiveStreak, sessionsToday, rankTasks, buildTodayPlan,
} from './insights';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const subjects: Subject[] = [{ id: 's1', title: 'Math' }, { id: 's2', title: 'Science' }];
const chapters: Chapter[] = [
  { id: 'c1', subjectId: 's1', title: 'Algebra' },
  { id: 'c2', subjectId: 's2', title: 'Physics' },
];
const mk = (id: string, subjectId: string, chapterId: string, over: Partial<Task> = {}): Task => ({
  id, subjectId, chapterId, title: id, status: 'not_started', estimatedMinutes: 50,
  lamport: 0, deviceId: 'seed', deleted: false, ...over,
});
const sess = (id: string, taskId: string | undefined, over: Partial<FocusSession> = {}): FocusSession => ({
  id, studentId: 'x', taskId, targetMinutes: 25, startedAt: NOW - 1000, completedAt: NOW,
  status: 'completed', synced: true, ...over,
});
const rewards = (over: Partial<StudentRewards> = {}): StudentRewards => ({
  studentId: 'x', coins: 0, streak: 0, lastStreakDate: '', todayFocusMinutes: 0,
  todayDate: '2026-10-07', ...over,
});

const tests: Record<string, () => void> = {
  'focus minutes only count completed sessions for that task'() {
    const s = [sess('a', 't1'), sess('b', 't1', { status: 'failed' }), sess('c', 't2'), sess('d', undefined)];
    assert.equal(taskFocusMinutes(s, 't1'), 25);
  },

  'duplicate session ids are not double counted (two devices, same session)'() {
    assert.equal(taskFocusMinutes([sess('a', 't1'), sess('a', 't1')], 't1'), 25);
  },

  'progress = focus / estimate, so 25 of 50 minutes is 50%'() {
    assert.equal(taskProgress(mk('t1', 's1', 'c1'), [sess('a', 't1')]), 0.5);
  },

  'focus time alone is capped below 100%; only done reaches 100%'() {
    const t = mk('t1', 's1', 'c1');
    const lots = [sess('a', 't1'), sess('b', 't1'), sess('c', 't1')];
    assert.equal(taskProgress(t, lots), 0.9);
    assert.equal(taskProgress({ ...t, status: 'done' }, []), 1);
  },

  'missing estimate falls back to the default (old cached tasks)'() {
    const t = mk('t1', 's1', 'c1', { estimatedMinutes: undefined });
    assert.ok(Math.abs(taskProgress(t, [sess('a', 't1')]) - 25 / 60) < 1e-9);
  },

  'chapter and subject progress average task progress and skip deleted tasks'() {
    const tasks = [mk('t1', 's1', 'c1', { status: 'done' }), mk('t2', 's1', 'c1'), mk('t3', 's1', 'c1', { deleted: true })];
    assert.equal(chapterProgress(tasks, [], 'c1'), 0.5);
    assert.equal(subjectProgress(tasks, [], 's1', chapters), 0.5);  // only c1 belongs to s1
    const twoChapters: Chapter[] = [...chapters, { id: 'c3', subjectId: 's1', title: 'Empty' }];
    assert.equal(subjectProgress(tasks, [], 's1', twoChapters), 0.25); // c1 = 0.5, empty c3 = 0
  },

  'stale todayDate reads as zero focus minutes'() {
    const r = rewards({ todayDate: '2026-10-06', todayFocusMinutes: 90 });
    assert.equal(focusMinutesToday(r, NOW), 0);
    assert.equal(focusMinutesToday(rewards({ todayFocusMinutes: 40 }), NOW), 40);
  },

  'streak: alive today, at risk yesterday, broken before that'() {
    assert.deepEqual(effectiveStreak(rewards({ streak: 4, lastStreakDate: '2026-10-07' }), NOW), { days: 4, atRisk: false });
    assert.deepEqual(effectiveStreak(rewards({ streak: 4, lastStreakDate: '2026-10-06' }), NOW), { days: 4, atRisk: true });
    assert.deepEqual(effectiveStreak(rewards({ streak: 4, lastStreakDate: '2026-10-05' }), NOW), { days: 0, atRisk: false });
  },

  'sessionsToday counts completed by completion day and failed by start day'() {
    const s = [
      sess('a', 't1'),
      sess('b', 't1', { completedAt: NOW - 2 * DAY, startedAt: NOW - 2 * DAY }),
      sess('c', 't1', { status: 'failed', completedAt: undefined }),
    ];
    assert.deepEqual(sessionsToday(s, NOW), { completed: 1, failed: 1 });
  },

  'ranking: started tasks beat untouched tasks'() {
    const tasks = [mk('t1', 's1', 'c1'), mk('t2', 's2', 'c2', { status: 'in_progress' })];
    const r = rankTasks(tasks, [], chapters, subjects, NOW);
    assert.equal(r[0].task.id, 't2');
    assert.match(r[0].reason, /Finish what you started/);
  },

  'ranking: a weak quiz topic is prioritized and explains why'() {
    const tasks = [mk('t1', 's1', 'c1'), mk('t2', 's2', 'c2')];
    const mastery = new Map([['t2', { taskId: 't2', pct: 20, correct: 1, questions: 5, attempts: 1, level: 'weak' as const }]]);
    const r = rankTasks(tasks, [], chapters, subjects, NOW, undefined, mastery);
    assert.equal(r[0].task.id, 't2');
    assert.match(r[0].reason, /scored 20%/);
  },

  'ranking: among untouched tasks the neglected subject wins'() {
    const tasks = [mk('t1', 's1', 'c1'), mk('t2', 's2', 'c2'), mk('t0', 's1', 'c1', { status: 'done' })];
    // 50 min of Math this week (on the done task t0), none on Science
    const s = [sess('a', 't0'), sess('b', 't0')];
    const r = rankTasks(tasks, s, chapters, subjects, NOW);
    assert.equal(r[0].task.id, 't2');
    assert.match(r[0].reason, /Science/);
  },

  'ranking: sessions older than 7 days do not count as recent focus'() {
    const tasks = [mk('t1', 's1', 'c1'), mk('t2', 's2', 'c2'), mk('t0', 's1', 'c1', { status: 'done' })];
    const old = [sess('a', 't0', { completedAt: NOW - 8 * DAY })];
    const r = rankTasks(tasks, old, chapters, subjects, NOW);
    assert.equal(r[0].task.id, 't1'); // no recent signal: syllabus order decides
    assert.match(r[0].reason, /Next up/);
  },

  'ranking excludes done and deleted tasks; empty syllabus gives empty list'() {
    const tasks = [mk('t1', 's1', 'c1', { status: 'done' }), mk('t2', 's1', 'c1', { deleted: true })];
    assert.deepEqual(rankTasks(tasks, [], chapters, subjects, NOW), []);
    assert.deepEqual(rankTasks([], [], chapters, subjects, NOW), []);
  },

  'suggested minutes: between 10 and 25, shrinking as the task nears its estimate'() {
    const t = mk('t1', 's1', 'c1', { estimatedMinutes: 50 });
    assert.equal(rankTasks([t], [], chapters, subjects, NOW)[0].suggestedMinutes, 25);
    const near = [sess('a', 't1')]; // 25 of 50 done, 25 left
    assert.equal(rankTasks([t], near, chapters, subjects, NOW)[0].suggestedMinutes, 25);
    const nearer = [sess('a', 't1', { targetMinutes: 45 })]; // 5 left, floors at 10
    assert.equal(rankTasks([t], nearer, chapters, subjects, NOW)[0].suggestedMinutes, 10);
  },

  'today plan: fills the remaining goal, empty once the goal is met'() {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map(id => mk(id, 's1', 'c1'));
    const ranked = rankTasks(tasks, [], chapters, subjects, NOW);
    assert.equal(buildTodayPlan(ranked, 60, 0).length, 3);   // ceil(60/25)
    assert.equal(buildTodayPlan(ranked, 60, 35).length, 1);  // 25 left
    assert.equal(buildTodayPlan(ranked, 60, 60).length, 0);
    assert.equal(buildTodayPlan(ranked, 600, 0).length, 4);  // capped
    assert.equal(buildTodayPlan([], 60, 0).length, 0);
    assert.equal(buildTodayPlan(ranked, 60, 45).reduce((sum, b) => sum + b.minutes, 0), 15);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
