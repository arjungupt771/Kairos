import { Task, Chapter, Subject, QuizAttempt, QuizDifficulty } from './types';

/** Quiz scoping, scoring and attempt building. Pure and testable. */

export const MAX_TOPICS_PER_QUIZ = 20;

export interface QuizScope {
  subjectId: string;
  chapterId?: string;
  taskId?: string;
}

export interface ResolvedScope {
  subjectTitle: string;
  chapterTitle: string;
  label: string;
  topics: { id: string; title: string; chapter: string }[];
  count: number;
}

/** Turn "subject / chapter / topic" into the list of topics a quiz should cover. */
export function resolveScope(scope: QuizScope, tasks: Task[], chapters: Chapter[], subjects: Subject[]): ResolvedScope | null {
  const subject = subjects.find(s => s.id === scope.subjectId);
  if (!subject) return null;
  const chapterTitle = (id: string) => chapters.find(c => c.id === id)?.title ?? '';

  let pool = tasks.filter(t => !t.deleted && t.subjectId === scope.subjectId);
  if (scope.chapterId) pool = pool.filter(t => t.chapterId === scope.chapterId);
  if (scope.taskId) pool = pool.filter(t => t.id === scope.taskId);
  if (pool.length === 0) return null;

  const topics = pool.slice(0, MAX_TOPICS_PER_QUIZ).map(t => ({ id: t.id, title: t.title, chapter: chapterTitle(t.chapterId) }));
  const label = scope.taskId
    ? topics[0].title
    : scope.chapterId ? chapterTitle(scope.chapterId) : subject.title;
  return {
    subjectTitle: subject.title,
    chapterTitle: scope.chapterId ? chapterTitle(scope.chapterId) : '',
    label,
    topics,
    // one topic: 5 questions; several: about 2 per topic so each gets a fair sample, capped at 10
    count: topics.length === 1 ? 5 : Math.min(10, Math.max(5, topics.length * 2)),
  };
}

export interface QuizQuestion {
  taskId: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  /** Notes quizzes: the exact line of the student's notes the question was written from, and where it is. */
  evidence?: string;
  source?: { docTitle: string; page: number | null; chunkId: string };
}

export interface ActiveQuiz {
  id: string;
  scope: QuizScope;
  label: string;
  difficulty: QuizDifficulty;
  questions: QuizQuestion[];
  /** Selected option per question; null = not answered yet. */
  answers: (number | null)[];
  startedAt: number;
  provider?: string;
  model?: string;
}

export interface TopicScore { taskId: string; correct: number; total: number }

export function scoreQuiz(quiz: Pick<ActiveQuiz, 'questions' | 'answers'>) {
  const byTopic = new Map<string, TopicScore>();
  let correct = 0;
  quiz.questions.forEach((q, i) => {
    const ok = quiz.answers[i] === q.correctIndex;
    if (ok) correct++;
    const e = byTopic.get(q.taskId) ?? { taskId: q.taskId, correct: 0, total: 0 };
    e.total++;
    if (ok) e.correct++;
    byTopic.set(q.taskId, e);
  });
  return { correct, total: quiz.questions.length, byTopic: Array.from(byTopic.values()) };
}

export const isQuizComplete = (quiz: Pick<ActiveQuiz, 'answers'>): boolean => quiz.answers.every(a => a !== null);

/** Only a fully answered quiz becomes an attempt; unanswered questions never count as results. */
export function buildAttempt(quiz: ActiveQuiz, studentId: string, completedAt: number): QuizAttempt | null {
  if (!isQuizComplete(quiz) || quiz.questions.length === 0) return null;
  return {
    id: quiz.id,
    studentId,
    subjectId: quiz.scope.subjectId,
    chapterId: quiz.scope.chapterId,
    taskId: quiz.scope.taskId,
    difficulty: quiz.difficulty,
    startedAt: quiz.startedAt,
    completedAt,
    results: quiz.questions.map((q, i) => ({ taskId: q.taskId, correct: quiz.answers[i] === q.correctIndex })),
    provider: quiz.provider,
    model: quiz.model,
    synced: false,
  };
}
