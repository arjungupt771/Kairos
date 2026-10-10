import assert from 'node:assert/strict';
import { Task, Subject, FocusSession } from './types';
import { computeMastery } from './mastery';
import {
  formatCitation, retrievalLabel, coverageLabel, topicTitle, buildGapTasks, toActiveQuiz, noteMastery, docTopicId, isDocTopic,
} from './notesLogic';
import type { NoteMeta, NotesQuizResponse } from './notesApi';
import { buildAttempt } from './quiz';

const note = (id: string, title: string): NoteMeta => ({
  id, title, fileName: 'f.pdf', kind: 'pdf', pages: 6, chunks: 6, charCount: 100, createdAt: 1, embedded: true,
});
const notes = [note('d1', 'Physics Notes'), note('d2', 'Biology')];
const subjects: Subject[] = [{ id: 's1', title: 'Physics' }];
const mk = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id, subjectId: 's1', chapterId: 'c1', title, status: 'not_started', estimatedMinutes: 50, lamport: 0, deviceId: 'x', deleted: false, ...over,
});

const tests: Record<string, () => void> = {
  'citations and labels read naturally'() {
    assert.equal(formatCitation({ n: 2, docTitle: 'Physics Notes', page: 4 }), '[2] Physics Notes, p.4');
    assert.equal(formatCitation({ n: 1, docTitle: 'Pasted text', page: null }), '[1] Pasted text');
    assert.equal(retrievalLabel('hybrid'), 'semantic + keyword search');
    assert.equal(retrievalLabel('keyword'), 'keyword search only');
  },

  'coverage label states what a summary was based on, including partial coverage'() {
    assert.equal(
      coverageLabel({ mode: 'section', docTitle: 'Physics Notes', pages: [6, 6], passagesUsed: 1, passagesAvailable: 1, partial: false }),
      'Found by its heading · Physics Notes · page 6',
    );
    assert.equal(
      coverageLabel({ mode: 'retrieved', docTitle: 'Physics Notes', pages: [3, 5], passagesUsed: 4, passagesAvailable: 4, partial: false }),
      'Best-matching passages · Physics Notes · pages 3–5',
    );
    const long = coverageLabel({ mode: 'section', docTitle: 'Book', pages: [10, 40], passagesUsed: 12, passagesAvailable: 30, partial: true });
    assert.match(long, /even sample \(12 of 30 passages\), not every line/);
    assert.equal(coverageLabel({ mode: 'retrieved', docTitle: 'Pasted', pages: null, passagesUsed: 1, passagesAvailable: 1, partial: false }), 'Best-matching passages · Pasted');
  },

  'topic titles resolve syllabus tasks, notes documents and unknown ids'() {
    const tasks = [mk('t1', 'Momentum')];
    assert.equal(topicTitle('t1', tasks, notes), 'Momentum');
    assert.equal(topicTitle(docTopicId('d1'), tasks, notes), 'Physics Notes');
    assert.equal(topicTitle('doc:gone', tasks, notes), 'Your notes');
    assert.equal(topicTitle('nope', tasks, notes), 'Topic');
    assert.equal(isDocTopic('doc:d1'), true);
    assert.equal(isDocTopic('t1'), false);
  },

  'gap payload: progress from sessions, mastery only when rated, deleted tasks excluded, capped at 40'() {
    const tasks = [mk('t1', 'Momentum'), mk('t2', 'Waves', { status: 'done' }), mk('t3', 'Gone', { deleted: true })];
    const sess: FocusSession[] = [{ id: 's', studentId: 'x', taskId: 't1', targetMinutes: 25, startedAt: 1, completedAt: 2, status: 'completed', synced: true }];
    const rated = computeMastery([{
      id: 'a', studentId: 'x', subjectId: 's1', difficulty: 'easy', startedAt: 1, completedAt: 2, synced: true,
      results: [...Array(4).fill({ taskId: 't1', correct: true }), { taskId: 't1', correct: false }, ...Array(2).fill({ taskId: 't2', correct: true })],
    }]);
    const out = buildGapTasks(tasks, subjects, sess, rated);
    assert.deepEqual(out.map(t => t.id), ['t1', 't2']);
    assert.deepEqual(out[0], { id: 't1', title: 'Momentum', subject: 'Physics', status: 'not_started', progressPct: 50, masteryPct: 80 });
    assert.equal(out[1].progressPct, 100);
    assert.equal(out[1].masteryPct, null, '2 questions is not enough to rate, so no mastery is claimed');
    assert.equal(buildGapTasks(Array.from({ length: 60 }, (_, i) => mk(`t${i}`, `T${i}`)), subjects, [], new Map()).length, 40);
  },

  'a notes quiz becomes a normal quiz that records results against the document'() {
    const res: NotesQuizResponse = {
      source: { provider: 'gemini', model: 'm' }, difficulty: 'hard', scope: 'document', docIds: ['d1'],
      questions: [
        { taskId: 'doc:d1', question: 'Q1 about momentum in the notes?', options: ['a', 'b', 'c', 'd'], correctIndex: 1, explanation: '', evidence: 'Momentum is the product of mass and velocity', source: { docTitle: 'Physics Notes', page: 4, chunkId: 'd1:3' } },
        { taskId: 'doc:d1', question: 'Q2 about work in the notes?', options: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: '', evidence: 'Work is force times distance', source: { docTitle: 'Physics Notes', page: 5, chunkId: 'd1:4' } },
      ],
    };
    const quiz = toActiveQuiz(res, { id: 'q1', now: 10, label: 'Notes: Physics Notes', subjectId: 's1' });
    assert.deepEqual(quiz.answers, [null, null]);
    assert.equal(quiz.difficulty, 'hard');
    assert.equal(quiz.questions[0].source?.page, 4);
    assert.equal(buildAttempt(quiz, 'x', 99), null, 'unanswered quizzes are not recorded');
    const attempt = buildAttempt({ ...quiz, answers: [1, 0] }, 'x', 99)!;
    assert.deepEqual(attempt.results, [{ taskId: 'doc:d1', correct: true }, { taskId: 'doc:d1', correct: false }]);
  },

  'note mastery lists only documents that have quiz results'() {
    const m = computeMastery([{
      id: 'a', studentId: 'x', subjectId: 's1', difficulty: 'easy', startedAt: 1, completedAt: 2, synced: true,
      results: [...Array(3).fill({ taskId: 'doc:d1', correct: true }), ...Array(2).fill({ taskId: 'doc:d1', correct: false })],
    }]);
    const out = noteMastery(m, notes);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].note.title, out[0].mastery.pct, out[0].mastery.level], ['Physics Notes', 60, 'ok']);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
