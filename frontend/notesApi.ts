import { call, AiResult } from './aiClient';
import type { QuizQuestion } from './quiz';

/** Client for the notes / RAG endpoints. Keys and embeddings live on the server. */

export interface NoteMeta {
  id: string;
  title: string;
  fileName: string;
  kind: 'pdf' | 'text';
  subjectId?: string;
  pages: number;
  chunks: number;
  charCount: number;
  createdAt: number;
  embedded: boolean;
  embeddingModel?: string;
}

export interface Citation { n: number; docTitle: string; page: number | null; quote: string; chunkId: string }
type Source = { provider: 'gemini' | 'groq'; model: string };

export interface AskResponse {
  answerable: boolean;
  answer: string;
  citations: Citation[];
  retrieval: 'hybrid' | 'keyword';
  source: Source | null;
}

export interface Coverage {
  mode: 'section' | 'retrieved';
  docTitle: string;
  pages: [number, number] | null;
  passagesUsed: number;
  passagesAvailable: number;
  partial: boolean;
}

export type SummarizeResponse =
  | { found: false; message: string }
  | { found: true; source: Source; summary: string; keyPoints: string[]; coverage: Coverage };

export interface NotesQuizQuestion extends QuizQuestion {
  evidence: string;
  source: { docTitle: string; page: number | null; chunkId: string };
}
export interface NotesQuizResponse {
  source: Source;
  difficulty: 'easy' | 'medium' | 'hard';
  scope: 'task' | 'document';
  docIds: string[];
  questions: NotesQuizQuestion[];
}

export interface Gap { concept: string; why: string; page: number | null; docTitle: string; chunkId: string; relatedTaskId: string | null }
export interface GapsResponse {
  source: Source;
  basis: { passagesChecked: number; passagesTotal: number };
  gaps: Gap[];
}

export interface GapTaskPayload {
  id: string; title: string; subject: string; status: string; progressPct: number; masteryPct: number | null;
}

export interface UploadResponse { doc: NoteMeta; embedded: boolean; note?: string }

export const listNotes = () => call<{ docs: NoteMeta[] }>('/notes');
export const deleteNote = (id: string) => call<{ deleted: boolean }>(`/notes/${encodeURIComponent(id)}`, undefined, 15000, 'DELETE');

// Uploads can take a while: the server extracts text and embeds every chunk before answering
export const uploadNote = (body: {
  kind: 'pdf' | 'text'; fileName: string; title: string; subjectId?: string; dataBase64?: string; text?: string;
}) => call<UploadResponse>('/notes', body, 180000);

export const askNotes = (b: { question: string; style: 'answer' | 'explain'; docIds: string[]; previousQuestion?: string }) =>
  call<AskResponse>('/ai/notes/ask', b);
export const summarizeNotes = (b: { query: string; docIds: string[] }) => call<SummarizeResponse>('/ai/notes/summarize', b, 60000);
export const quizFromNotes = (b: { docIds: string[]; difficulty: 'easy' | 'medium' | 'hard'; count: number; query?: string }) =>
  call<NotesQuizResponse>('/ai/notes/quiz', b, 60000);
export const notesGaps = (b: { docIds: string[]; tasks: GapTaskPayload[] }) => call<GapsResponse>('/ai/notes/gaps', b, 60000);

// ─── Picking a file (web only for now; on native, pasting text works everywhere) ──

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type PickedFile =
  | { name: string; kind: 'pdf'; base64: string }
  | { name: string; kind: 'text'; text: string }
  | { error: string };

/** A browser (react-native-web included). React Native proper has no DOM file input. */
export function canPickFiles(): boolean {
  const g = globalThis as any;
  return typeof g.document !== 'undefined' && g.navigator?.product !== 'ReactNative';
}

export function pickFile(): Promise<PickedFile | null> {
  const doc = (globalThis as any).document;
  if (!canPickFiles() || !doc) return Promise.resolve(null);
  return new Promise(resolve => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > MAX_UPLOAD_BYTES) return resolve({ error: 'That file is larger than 10 MB.' });
      const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      const reader = new (globalThis as any).FileReader();
      reader.onerror = () => resolve({ error: 'Could not read that file.' });
      if (isPdf) {
        reader.onload = () => {
          const s = String(reader.result);
          resolve({ name: f.name, kind: 'pdf', base64: s.slice(s.indexOf(',') + 1) });
        };
        reader.readAsDataURL(f);
      } else {
        reader.onload = () => resolve({ name: f.name, kind: 'text', text: String(reader.result) });
        reader.readAsText(f);
      }
    };
    input.click();
  });
}

export type { AiResult };
