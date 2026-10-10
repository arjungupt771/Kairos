import assert from 'node:assert/strict';
import { Task, Chapter, Subject, QuizAttempt, AppState, FocusSession, SyncResponse } from './types';
import {
  computeMastery, levelFor, subjectMastery, weakTopics, revisionAdvice, MIN_QUESTIONS_FOR_RATING,
} from './mastery';
import { resolveScope, scoreQuiz, buildAttempt, isQuizComplete, ActiveQuiz } from './quiz';
import { reconcileSync } from './sync';

const subjects: Subject[] = [{ id: 's1', title: 'Math' }, { id: 's2', title: 'Physics' }];
const chapters: Chapter[] = [
  { id: 'c1', subjectId: 's1', title: 'Algebra' },
  { id: 'c2', subjectId: 's2', title: 'Mechanics' },
  { id: 'c3', subjectId: 's2', title: 'Waves' },
];
const mk = (id: string, subjectId: string, chapterId: string, title: string, over: Partial<Task> = {}): Task => ({
  id, subjectId, chapterId, title, status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false, ...over,
});
const tasks = [
  mk('alg', 's1', 'c1', 'Linear equations'),
  mk('newton', 's2', 'c2', "Newton's Laws"),
  mk('work', 's2', 'c2', 'Work & Energy'),
  mk('mom', 's2', 'c2', 'Momentum'),
  mk('wave', 's2', 'c3', 'Wave motion'),
];

let n = 0;
const attempt = (at: number, rows: [string, boolean][], over: Partial<QuizAttempt> = {}): QuizAttempt => ({
  id: `qa${n++}`, studentId: 'x', subjectId: 's2', difficulty: 'medium', startedAt: at - 1000, completedAt: at,
  results: rows.map(([taskId, correct]) => ({ taskId, correct })), synced: true, ...over,
});
const rep = (taskId: string, correct: number, wrong: number): [string, boolean][] =>
  [...Array(correct).fill([taskId, true]), ...Array(wrong).fill([taskId, false])];

// One chapter quiz: Newton 5/6, Work 5/7, Momentum 2/5
const chapterQuiz = attempt(1000, [...rep('newton', 5, 1), ...rep('work', 5, 2), ...rep('mom', 2, 3)]);

const tests: Record<string, () => void> = {
  // ── mastery ────────────────────────────────────────────────────────────────
  'levels: 80 strong, 50 to 79 ok, below 50 weak, and unknown below the minimum question count'() {
    assert.equal(levelFor(80, 5), 'strong');
    assert.equal(levelFor(79, 5), 'ok');
    assert.equal(levelFor(50, 5), 'ok');
    assert.equal(levelFor(49, 5), 'weak');
    assert.equal(levelFor(100, MIN_QUESTIONS_FOR_RATING - 1), 'unknown');
    assert.equal(levelFor(null, 0), 'unknown');
  },

  'a chapter quiz yields per-topic mastery (83 / 71 / 40)'() {
    const m = computeMastery([chapterQuiz]);
    assert.deepEqual(['newton', 'work', 'mom'].map(id => [m.get(id)!.pct, m.get(id)!.level]),
      [[83, 'strong'], [71, 'ok'], [40, 'weak']]);
    assert.equal(m.get('mom')!.questions, 5);
  },

  'too few questions: a percentage exists but no rating is given'() {
    const m = computeMastery([attempt(1, rep('newton', 3, 0))]);
    assert.equal(m.get('newton')!.pct, 100);
    assert.equal(m.get('newton')!.level, 'unknown');
  },

  'only the most recent 3 attempts count, so mastery follows improvement'() {
    const old = attempt(100, rep('mom', 0, 5));
    const recent = [200, 300, 400].map(t => attempt(t, rep('mom', 5, 0)));
    const m = computeMastery([old, ...recent]);
    assert.equal(m.get('mom')!.pct, 100);
    assert.equal(m.get('mom')!.attempts, 3);
    assert.equal(m.get('mom')!.questions, 15);
  },

  'the same attempt id from two devices is counted once'() {
    const m = computeMastery([chapterQuiz, { ...chapterQuiz }]);
    assert.equal(m.get('mom')!.questions, 5);
  },

  'subject mastery is weighted by questions and null without enough data'() {
    const m = computeMastery([chapterQuiz]);
    assert.deepEqual(subjectMastery(m, tasks, 's2'), { pct: 67, questions: 18 }); // 12 / 18
    assert.equal(subjectMastery(m, tasks, 's1'), null);
    assert.equal(subjectMastery(computeMastery([attempt(1, rep('newton', 2, 1))]), tasks, 's2'), null);
  },

  'weak topics: only rated-weak, weakest first, deleted tasks excluded'() {
    const rows = [...rep('mom', 1, 4), ...rep('wave', 0, 5), ...rep('newton', 5, 0)];
    const m = computeMastery([attempt(1, rows)]);
    assert.deepEqual(weakTopics(m, tasks).map(w => w.task.id), ['wave', 'mom']);
    const gone = tasks.map(t => (t.id === 'wave' ? { ...t, deleted: true } : t));
    assert.deepEqual(weakTopics(m, gone).map(w => w.task.id), ['mom']);
  },

  'revision advice: weak topic in an earlier chapter of the same subject comes first'() {
    const m = computeMastery([chapterQuiz]);
    const a = revisionAdvice({ mastery: m, tasks, chapters, next: tasks.find(t => t.id === 'wave') });
    assert.equal(a!.task.id, 'mom');
    assert.equal(a!.message, 'Revise Momentum (40%) before starting Wave motion.');
  },

  'revision advice: unrelated subject or a later chapter does not claim an order'() {
    const m = computeMastery([chapterQuiz]);
    const other = revisionAdvice({ mastery: m, tasks, chapters, next: tasks.find(t => t.id === 'alg') });
    assert.equal(other!.message, 'Your weakest topic is Momentum (40%). Worth a revision session.');

    const lateWeak = computeMastery([attempt(1, rep('wave', 0, 5))]);
    const a = revisionAdvice({ mastery: lateWeak, tasks, chapters, next: tasks.find(t => t.id === 'newton') });
    assert.match(a!.message, /^Your weakest topic is Wave motion/);
  },

  'revision advice: nothing weak means no advice'() {
    const m = computeMastery([attempt(1, rep('newton', 5, 0))]);
    assert.equal(revisionAdvice({ mastery: m, tasks, chapters }), null);
    assert.equal(revisionAdvice({ mastery: new Map(), tasks, chapters }), null);
  },

  // ── quiz scope / scoring ───────────────────────────────────────────────────
  'scope: topic, chapter and subject resolve to the right topics and question counts'() {
    const t = resolveScope({ subjectId: 's2', chapterId: 'c2', taskId: 'mom' }, tasks, chapters, subjects)!;
    assert.deepEqual(t.topics.map(x => x.id), ['mom']);
    assert.equal(t.count, 5);
    assert.equal(t.label, 'Momentum');
    const c = resolveScope({ subjectId: 's2', chapterId: 'c2' }, tasks, chapters, subjects)!;
    assert.deepEqual(c.topics.map(x => x.id), ['newton', 'work', 'mom']);
    assert.equal(c.count, 6);
    assert.equal(c.chapterTitle, 'Mechanics');
    const s = resolveScope({ subjectId: 's2' }, tasks, chapters, subjects)!;
    assert.equal(s.topics.length, 4);
    assert.equal(s.count, 8);
    assert.equal(s.label, 'Physics');
  },

  'scope: unknown subject, empty chapter and deleted tasks give null / are excluded'() {
    assert.equal(resolveScope({ subjectId: 'nope' }, tasks, chapters, subjects), null);
    assert.equal(resolveScope({ subjectId: 's1', chapterId: 'c3' }, tasks, chapters, subjects), null);
    const gone = tasks.map(t => (t.id === 'mom' ? { ...t, deleted: true } : t));
    assert.deepEqual(resolveScope({ subjectId: 's2', chapterId: 'c2' }, gone, chapters, subjects)!.topics.map(x => x.id), ['newton', 'work']);
  },

  'scoring and attempt building: per-topic results, incomplete quizzes never become attempts'() {
    const quiz: ActiveQuiz = {
      id: 'q1', scope: { subjectId: 's2', chapterId: 'c2' }, label: 'Mechanics', difficulty: 'hard',
      startedAt: 10, provider: 'gemini', model: 'm',
      questions: [
        { taskId: 'newton', question: 'q1', options: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: '' },
        { taskId: 'newton', question: 'q2', options: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: '' },
        { taskId: 'mom', question: 'q3', options: ['a', 'b', 'c', 'd'], correctIndex: 3, explanation: '' },
      ],
      answers: [2, 1, null],
    };
    assert.equal(isQuizComplete(quiz), false);
    assert.equal(buildAttempt(quiz, 'x', 99), null);

    const done = { ...quiz, answers: [2, 1, 3] };
    const s = scoreQuiz(done);
    assert.equal(s.correct, 2);
    assert.deepEqual(s.byTopic, [{ taskId: 'newton', correct: 1, total: 2 }, { taskId: 'mom', correct: 1, total: 1 }]);
    const a = buildAttempt(done, 'x', 99)!;
    assert.deepEqual(a.results, [{ taskId: 'newton', correct: true }, { taskId: 'newton', correct: false }, { taskId: 'mom', correct: true }]);
    assert.equal(a.id, 'q1');
    assert.equal(a.chapterId, 'c2');
    assert.equal(a.taskId, undefined);
    assert.equal(a.synced, false);
  },

  // ── sync reconcile (race fix) ──────────────────────────────────────────────
  'reconcileSync keeps sessions, attempts and task edits created while the request was in flight'() {
    const sess = (id: string): FocusSession => ({ id, studentId: 'x', targetMinutes: 25, startedAt: 1, completedAt: 2, status: 'completed', synced: false });
    const base: AppState = {
      deviceId: 'D1', lamport: 5, sessions: [], tasks: [mk('t1', 's1', 'c1', 'Old title')], subjects, chapters,
      rewards: { studentId: 'x', coins: 0, streak: 0, lastStreakDate: '', todayFocusMinutes: 0, todayDate: '' },
      pendingTaskOps: [], pendingSessions: [], quizAttempts: [], pendingQuizAttempts: [],
    };
    const A = sess('A'), QA = attempt(5, rep('mom', 1, 0), { synced: false });
    const edit1 = { ...tasks[0], id: 't1', title: 'Edited before sync', lamport: 6, deviceId: 'D1' };
    const snapshot: AppState = { ...base, sessions: [A], pendingSessions: [A], quizAttempts: [QA], pendingQuizAttempts: [QA], tasks: [edit1], pendingTaskOps: [{ type: 'upsert', task: edit1 }] };

    // ...while the request was in flight the user finished session B, a quiz QB, and edited the task again
    const B = sess('B'), QB = attempt(9, rep('mom', 1, 0), { synced: false });
    const edit2 = { ...edit1, title: 'Edited during sync', lamport: 7 };
    const current: AppState = {
      ...snapshot, sessions: [A, B], pendingSessions: [A, B], quizAttempts: [QA, QB], pendingQuizAttempts: [QA, QB],
      tasks: [edit2], pendingTaskOps: [{ type: 'upsert', task: edit1 }, { type: 'upsert', task: edit2 }],
    };
    const response: SyncResponse = {
      rewards: { studentId: 'x', coins: 50, streak: 1, lastStreakDate: '2026-10-08', todayFocusMinutes: 25, todayDate: '2026-10-08' },
      tasks: [edit1], sessions: [{ ...A, synced: true }], quizAttempts: [{ ...QA, synced: true }],
      serverLamport: 10, newlyConfirmedSessions: ['A'],
    };

    const out = reconcileSync(current, snapshot, response);
    assert.deepEqual(out.sessions.map(s => [s.id, s.synced]).sort(), [['A', true], ['B', false]]);
    assert.deepEqual(out.pendingSessions.map(s => s.id), ['B']);                       // B still has to be pushed
    assert.deepEqual(out.quizAttempts.map(a => [a.id === QA.id, a.synced]).sort(), [[false, false], [true, true]]);
    assert.deepEqual(out.pendingQuizAttempts.map(a => a.id), [QB.id]);
    assert.equal(out.tasks[0].title, 'Edited during sync');                           // newer local edit beats the server copy
    assert.deepEqual(out.pendingTaskOps.map(o => o.task.lamport), [7]);               // only the unpushed op remains
    assert.equal(out.rewards.coins, 100);                                              // server 50 + optimistic 50 for B
    assert.equal(out.lamport, 11);
  },

  'reconcileSync with nothing in flight clears pending and adopts the server state'() {
    const A: FocusSession = { id: 'A', studentId: 'x', targetMinutes: 25, startedAt: 1, completedAt: 2, status: 'completed', synced: false };
    const st: AppState = {
      deviceId: 'D1', lamport: 1, sessions: [A], tasks: [], subjects, chapters,
      rewards: { studentId: 'x', coins: 50, streak: 1, lastStreakDate: '', todayFocusMinutes: 25, todayDate: '' },
      pendingTaskOps: [], pendingSessions: [A], quizAttempts: [], pendingQuizAttempts: [],
    };
    const out = reconcileSync(st, st, {
      rewards: { ...st.rewards, coins: 50 }, tasks: [], sessions: [{ ...A, synced: true }], quizAttempts: [], serverLamport: 3, newlyConfirmedSessions: ['A'],
    });
    assert.deepEqual(out.pendingSessions, []);
    assert.equal(out.rewards.coins, 50);
    assert.equal(out.sessions[0].synced, true);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
