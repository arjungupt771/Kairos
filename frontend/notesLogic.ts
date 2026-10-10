import { Task, Subject, FocusSession } from './types';
import { taskProgress } from './insights';
import { TopicMastery } from './mastery';
import { ActiveQuiz } from './quiz';
import type { NoteMeta, Coverage, GapTaskPayload, NotesQuizResponse, Citation } from './notesApi';

/** Pure helpers for the notes tutor (labels, request payloads, quiz conversion). */

export const docTopicId = (docId: string): string => `doc:${docId}`;
export const isDocTopic = (id: string): boolean => id.startsWith('doc:');

export function formatCitation(c: Pick<Citation, 'n' | 'docTitle' | 'page'>): string {
  return `[${c.n}] ${c.docTitle}${c.page ? `, p.${c.page}` : ''}`;
}

export const retrievalLabel = (mode: 'hybrid' | 'keyword'): string =>
  mode === 'hybrid' ? 'semantic + keyword search' : 'keyword search only';

const pageLabel = (pages: [number, number] | null): string =>
  !pages ? '' : pages[0] === pages[1] ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[1]}`;

/** Says exactly what a summary was based on, including when it is only a sample of a long section. */
export function coverageLabel(c: Coverage): string {
  const parts = [c.mode === 'section' ? 'Found by its heading' : 'Best-matching passages', c.docTitle, pageLabel(c.pages)].filter(Boolean);
  let label = parts.join(' · ');
  if (c.partial) {
    label += `. This section is long, so it summarises an even sample (${c.passagesUsed} of ${c.passagesAvailable} passages), not every line.`;
  }
  return label;
}

export function topicTitle(id: string, tasks: Task[], notes: NoteMeta[]): string {
  if (isDocTopic(id)) return notes.find(n => docTopicId(n.id) === id)?.title ?? 'Your notes';
  return tasks.find(t => t.id === id)?.title ?? 'Topic';
}

/** What the gap analysis needs to know about the student's syllabus progress. */
export function buildGapTasks(
  tasks: Task[], subjects: Subject[], sessions: FocusSession[], mastery: Map<string, TopicMastery>,
): GapTaskPayload[] {
  return tasks
    .filter(t => !t.deleted)
    .slice(0, 40)
    .map(t => {
      const m = mastery.get(t.id);
      return {
        id: t.id,
        title: t.title,
        subject: subjects.find(s => s.id === t.subjectId)?.title ?? '',
        status: t.status,
        progressPct: Math.round(taskProgress(t, sessions) * 100),
        // Only a rated topic counts as mastery information
        masteryPct: m && m.level !== 'unknown' ? m.pct : null,
      };
    });
}

/** Turn the server's notes quiz into the same quiz object the Learn tab already plays and records. */
export function toActiveQuiz(
  res: NotesQuizResponse, args: { id: string; now: number; label: string; subjectId: string },
): ActiveQuiz {
  return {
    id: args.id,
    scope: { subjectId: args.subjectId },
    label: args.label,
    difficulty: res.difficulty,
    questions: res.questions,
    answers: res.questions.map(() => null),
    startedAt: args.now,
    provider: res.source.provider,
    model: res.source.model,
  };
}

/** Notes that have quiz results, with their mastery (shown in Insights next to syllabus topics). */
export function noteMastery(mastery: Map<string, TopicMastery>, notes: NoteMeta[]): { note: NoteMeta; mastery: TopicMastery }[] {
  const out: { note: NoteMeta; mastery: TopicMastery }[] = [];
  for (const n of notes) {
    const m = mastery.get(docTopicId(n.id));
    if (m) out.push({ note: n, mastery: m });
  }
  return out;
}
