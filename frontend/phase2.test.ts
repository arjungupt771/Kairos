import assert from 'node:assert/strict';
import { Task, FocusSession, Chapter, Subject } from './types';
import {
  blockLabel, localHour, computeStats, ruleFindings, learnProfile, LearnedProfile,
} from './analytics';
import { rankTasks } from './insights';
import {
  windowEnd, availableMinutes, layoutBlocks, blockStatuses, missedTaskIds, ruleBasedItems,
  isPlanFromToday, buildScheduleRequest, StudyPlan, BREAK_MIN,
} from './schedule';

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const IST = -330; // Date#getTimezoneOffset() for India
const NOW = Date.UTC(2026, 9, 7, 13, 30); // 19:00 IST, 7 Oct 2026

const subjects: Subject[] = [{ id: 's1', title: 'Math' }, { id: 's2', title: 'Science' }];
const chapters: Chapter[] = [{ id: 'c1', subjectId: 's1', title: 'Algebra' }, { id: 'c2', subjectId: 's2', title: 'Physics' }];
const mkTask = (id: string, subjectId: string, chapterId: string, over: Partial<Task> = {}): Task => ({
  id, subjectId, chapterId, title: id, status: 'not_started', estimatedMinutes: 60,
  lamport: 0, deviceId: 'seed', deleted: false, ...over,
});
const tasks = [mkTask('t1', 's1', 'c1', { title: 'Linear equations' }), mkTask('t2', 's2', 'c2', { title: "Newton's laws" })];

let n = 0;
const sess = (taskId: string | undefined, startedAt: number, minutes: number, ok: boolean, reason: 'give_up' | 'app_switch' = 'give_up'): FocusSession => ({
  id: `s${n++}`, studentId: 'x', taskId, targetMinutes: minutes, startedAt, status: ok ? 'completed' : 'failed',
  completedAt: ok ? startedAt + minutes * MIN : undefined, failReason: ok ? undefined : reason, synced: true,
});

/**
 * Hand-built history (all within the last 7 days):
 *   evening  18:30 IST, Math,    25 min: 4 sessions, all completed          -> 100%
 *   morning   9:30 IST, Science, 45 min: 4 sessions, 1 completed, 3 early   ->  25%
 */
function history(): FocusSession[] {
  const out: FocusSession[] = [];
  for (let d = 0; d < 4; d++) out.push(sess('t1', Date.UTC(2026, 9, 7 - d, 13, 0), 25, true));
  out.push(sess('t2', Date.UTC(2026, 9, 6, 4, 0), 45, true));
  out.push(sess('t2', Date.UTC(2026, 9, 5, 4, 0), 45, false, 'app_switch'));
  out.push(sess('t2', Date.UTC(2026, 9, 4, 4, 0), 45, false, 'app_switch'));
  out.push(sess('t2', Date.UTC(2026, 9, 3, 4, 0), 45, false, 'app_switch'));
  return out;
}
const stats = (s: FocusSession[] = history()) => computeStats(s, tasks, subjects, chapters, NOW, IST);

const tests: Record<string, () => void> = {
  // ── time helpers ──────────────────────────────────────────────────────────
  'block labels read naturally across AM/PM boundaries'() {
    assert.equal(blockLabel(18), '6–8 PM');
    assert.equal(blockLabel(8), '8–10 AM');
    assert.equal(blockLabel(10), '10 AM–12 PM');
    assert.equal(blockLabel(22), '10 PM–12 AM');
    assert.equal(blockLabel(0), '12–2 AM');
  },
  'local hour respects the timezone offset (UTC 13:00 is 18:30 IST)'() {
    assert.equal(localHour(Date.UTC(2026, 9, 7, 13, 0), IST), 18);
    assert.equal(localHour(Date.UTC(2026, 9, 7, 13, 0), 0), 13);
  },

  // ── stats ─────────────────────────────────────────────────────────────────
  'stats: totals, completion rate, minutes and active days'() {
    const s = stats();
    assert.equal(s.totalSessions, 8);
    assert.equal(s.completed, 5);
    assert.equal(s.endedEarly, 3);
    assert.equal(s.completionPct, 63); // 5/8
    assert.equal(s.focusMinutes, 4 * 25 + 45);
    assert.equal(s.activeDaysLast7, 4); // Oct 7, 6 (Math + Science, same local day), 5, 4
    assert.deepEqual(s.endReasons, { giveUp: 0, appSwitch: 3 });
  },
  'stats: time blocks use LOCAL start hour'() {
    const s = stats();
    assert.deepEqual(s.byTimeBlock.map(b => [b.label, b.sessions, b.completionPct]), [['8–10 AM', 4, 25], ['6–8 PM', 4, 100]]);
  },
  'stats: sessions outside the window and duplicate ids are ignored'() {
    const old = sess('t1', NOW - 40 * DAY, 25, true);
    const h = history();
    const s = stats([...h, old, h[0]]);
    assert.equal(s.totalSessions, 8);
  },
  'stats: shortVsLong needs 3+ sessions on both sides'() {
    assert.equal(stats().shortVsLong?.shortCompletionPct, 100);
    assert.equal(stats().shortVsLong?.longCompletionPct, 25);
    assert.equal(stats(history().slice(0, 6)).shortVsLong, null); // only 2 long sessions left
  },
  'stats: per-subject completion only counts task-linked sessions'() {
    const free = sess(undefined, Date.UTC(2026, 9, 7, 13, 0), 25, true);
    const s = stats([...history(), free]);
    assert.equal(s.totalSessions, 9);
    assert.deepEqual(s.subjects.map(x => [x.id, x.sessions, x.completionPct]), [['s1', 4, 100], ['s2', 4, 25]]);
  },

  // ── findings ──────────────────────────────────────────────────────────────
  'findings: below the minimum sample no pattern is claimed'() {
    const f = ruleFindings(stats(history().slice(0, 5)));
    assert.deepEqual(f.map(x => x.kind), ['data', 'consistency']);
    assert.match(f[0].text, /Only 5 sessions/);
  },
  'findings: time, duration, subject and early-ending patterns with exact numbers'() {
    const text = ruleFindings(stats()).map(f => f.text);
    assert.ok(text.includes('You complete 100% of sessions started between 6–8 PM, versus 25% between 8–10 AM.'), text.join('|'));
    assert.ok(text.includes('Sessions of 35 minutes or less are completed more often (100% vs 25% for longer ones).'));
    assert.ok(text.includes('Science has your lowest completion rate (25% of 4 sessions), while Math is at 100%.'));
    assert.ok(text.includes('3 of 3 early endings came from switching away from the app.'));
    assert.ok(text.includes('You completed a session on 4 of the last 7 days.'));
  },
  'findings: no claim when the gap is under 15 points'() {
    const s: FocusSession[] = [];
    for (let i = 0; i < 4; i++) s.push(sess('t1', Date.UTC(2026, 9, 7 - i, 13, 0), 25, i !== 0));       // evening 75%
    for (let i = 0; i < 4; i++) s.push(sess('t1', Date.UTC(2026, 9, 7 - i, 4, 0), 25, i !== 0));        // morning 75%
    const kinds = ruleFindings(stats(s)).map(f => f.kind);
    assert.ok(!kinds.includes('time') && !kinds.includes('duration') && !kinds.includes('subject'));
  },
  'findings: never says "failed"'() {
    assert.ok(ruleFindings(stats()).every(f => !/fail/i.test(f.text)));
  },

  // ── learned profile + adaptive ranking ────────────────────────────────────
  'profile: not ready before the minimum sample'() {
    const p = learnProfile(stats(history().slice(0, 5)));
    assert.equal(p.ready, false);
    assert.equal(p.weakSubjectId, undefined);
  },
  'profile: learns best time block, best duration and weakest subject'() {
    const p = learnProfile(stats());
    assert.equal(p.ready, true);
    assert.equal(p.bestBlock?.label, '6–8 PM');
    assert.equal(p.bestDurationMinutes, 25);
    assert.equal(p.weakSubjectId, 's2');
    assert.equal(p.weakSubjectTitle, 'Science');
  },
  'ranking: weak subject is boosted only when the profile is ready'() {
    const ts = [mkTask('a', 's1', 'c1'), mkTask('b', 's2', 'c2')];
    const base: LearnedProfile = { sample: 20, ready: true, weakSubjectId: 's2', weakSubjectTitle: 'Science' };
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW)[0].task.id, 'a');                       // syllabus order
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW, { ...base, ready: false })[0].task.id, 'a');
    const r = rankTasks(ts, [], chapters, subjects, NOW, base);
    assert.equal(r[0].task.id, 'b');
    assert.match(r[0].reason, /fewer Science sessions/);
  },
  'ranking: suggested block length follows the learned duration (capped at 60)'() {
    const ts = [mkTask('a', 's1', 'c1')];
    const p = (m: number): LearnedProfile => ({ sample: 20, ready: true, bestDurationMinutes: m });
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW)[0].suggestedMinutes, 25);
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW, p(45))[0].suggestedMinutes, 45);
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW, p(90))[0].suggestedMinutes, 60);
    assert.equal(rankTasks(ts, [], chapters, subjects, NOW, { ...p(45), ready: false })[0].suggestedMinutes, 25);
  },

  // ── scheduling ────────────────────────────────────────────────────────────
  'window: today 10 PM local, and available minutes from the next 5-min mark'() {
    const end = windowEnd(NOW, IST);
    assert.equal(end, Date.UTC(2026, 9, 7, 16, 30)); // 22:00 IST
    assert.equal(availableMinutes(NOW, end), 180);   // 19:00 -> 22:00
    assert.equal(availableMinutes(end + MIN, end), 0);
  },
  'layout: blocks start on a 5-min mark, are separated by breaks, trimmed to the window'() {
    const now = NOW + 2 * MIN; // 19:02 -> starts 19:05
    const end = windowEnd(NOW, IST);
    const b = layoutBlocks([
      { taskId: 't1', minutes: 25, reason: '' }, { taskId: 't2', minutes: 25, reason: '' },
    ], now, end, 'p');
    assert.equal(b[0].startAt, NOW + 5 * MIN);
    assert.equal(b[1].startAt, b[0].startAt + (25 + BREAK_MIN) * MIN);
    // only 22 minutes left: second block must shrink to 20, third is dropped (< 10 after trimming)
    const tight = layoutBlocks([
      { taskId: 't1', minutes: 25, reason: '' }, { taskId: 't2', minutes: 25, reason: '' }, { taskId: 't1', minutes: 25, reason: '' },
    ], end - 60 * MIN, end, 'p');
    assert.deepEqual(tight.map(x => x.minutes), [25, 25]);
    const tiny = layoutBlocks([{ taskId: 't1', minutes: 25, reason: '' }], end - 8 * MIN, end, 'p');
    assert.deepEqual(tiny, []);
  },

  'status: completed session marks a block done and is consumed only once'() {
    const created = NOW - 60 * MIN;
    const plan: StudyPlan = {
      id: 'p', createdAt: created, mode: 'plan', source: 'rules', summary: '',
      blocks: [
        { id: 'b0', taskId: 't1', startAt: NOW - 30 * MIN, minutes: 25, reason: '' },
        { id: 'b1', taskId: 't1', startAt: NOW + 10 * MIN, minutes: 25, reason: '' },
      ],
    };
    const one = sess('t1', NOW - 30 * MIN, 25, true);
    const st = blockStatuses(plan, [one], NOW);
    assert.deepEqual(st.map(s => s.status), ['done', 'upcoming']); // one session cannot satisfy two blocks
  },
  'status: a session from before the plan was made does not count'() {
    const plan: StudyPlan = {
      id: 'p', createdAt: NOW, mode: 'plan', source: 'rules', summary: '',
      blocks: [{ id: 'b0', taskId: 't1', startAt: NOW + 5 * MIN, minutes: 25, reason: '' }],
    };
    const before = sess('t1', NOW - 60 * MIN, 25, true);
    assert.equal(blockStatuses(plan, [before], NOW)[0].status, 'upcoming');
  },
  'status: ended-early session or elapsed time means missed; a block in progress is "now"'() {
    const plan: StudyPlan = {
      id: 'p', createdAt: NOW - 120 * MIN, mode: 'plan', source: 'rules', summary: '',
      blocks: [
        { id: 'b0', taskId: 't1', startAt: NOW - 100 * MIN, minutes: 25, reason: '' },  // time passed, nothing done
        { id: 'b1', taskId: 't2', startAt: NOW - 5 * MIN, minutes: 25, reason: '' },    // running now
        { id: 'b2', taskId: 't2', startAt: NOW + 60 * MIN, minutes: 25, reason: '' },   // later, but gave up already
      ],
    };
    const gaveUp = sess('t2', NOW - 4 * MIN, 25, false);
    const st = blockStatuses(plan, [gaveUp], NOW);
    assert.deepEqual(st.map(s => s.status), ['missed', 'missed', 'upcoming']);
    // b1 consumed the early ending, so b2 is not also marked missed
    assert.deepEqual(missedTaskIds(st), ['t1', 't2']);
  },
  'status: retrying after giving up completes the block'() {
    const plan: StudyPlan = {
      id: 'p', createdAt: NOW - 60 * MIN, mode: 'plan', source: 'rules', summary: '',
      blocks: [{ id: 'b0', taskId: 't1', startAt: NOW - 30 * MIN, minutes: 25, reason: '' }],
    };
    const s = [sess('t1', NOW - 29 * MIN, 25, false), sess('t1', NOW - 20 * MIN, 25, true)];
    assert.equal(blockStatuses(plan, s, NOW)[0].status, 'done');
  },
  'plan from an earlier local day is stale'() {
    const plan = { createdAt: NOW - DAY } as StudyPlan;
    assert.equal(isPlanFromToday(plan, NOW, IST), false);
    assert.equal(isPlanFromToday({ createdAt: NOW - 2 * 60 * MIN } as StudyPlan, NOW, IST), true);
  },

  // ── fallback + request ────────────────────────────────────────────────────
  'fallback plan: missed tasks first, respects goal and available time'() {
    const ts = [mkTask('a', 's1', 'c1'), mkTask('b', 's2', 'c2'), mkTask('c', 's1', 'c1')];
    const ranked = rankTasks(ts, [], chapters, subjects, NOW);
    const items = ruleBasedItems(ranked, 60, 180, ['c']);
    assert.equal(items[0].taskId, 'c');
    assert.match(items[0].reason, /Missed earlier/);
    assert.equal(items.reduce((a, i) => a + i.minutes, 0) >= 60, true);
    assert.ok(ruleBasedItems(ranked, 60, 8, []).length === 0);            // not enough time for a block
    assert.equal(ruleBasedItems(ranked, 0, 180, []).length, 1);            // goal met: one optional block
    assert.deepEqual(ruleBasedItems([], 60, 180, []), []);
  },
  'schedule request: compact, includes profile and remaining minutes'() {
    const ranked = rankTasks(tasks, [], chapters, subjects, NOW);
    const mastery = new Map([['t1', { taskId: 't1', pct: 20, correct: 1, questions: 5, attempts: 1, level: 'weak' as const }]]);
    const req = buildScheduleRequest({
      mode: 'reschedule', now: NOW, tz: IST, ranked, sessions: [], goalRemainingMin: 40, availableMin: 150,
      missed: ['t1'], profile: learnProfile(stats()), mastery,
    });
    assert.equal(req.localTime, '19:00');
    assert.equal(req.tasks.length, 2);
    assert.equal(req.tasks[0].remainingMinutes, 60);
    assert.deepEqual(req.missedTaskIds, ['t1']);
    assert.equal(req.profile.weakSubject, 'Science');
    assert.equal(req.profile.bestBlock, '6–8 PM');
    assert.deepEqual(req.tasks[0].mastery, { pct: 20, questions: 5, level: 'weak' });
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
