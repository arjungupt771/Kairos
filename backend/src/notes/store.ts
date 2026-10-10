import fs from 'fs';
import path from 'path';
import { StoredChunk } from './retrieval';

/**
 * File-backed notes store: one JSON file per document (chunks + embeddings), cached in memory.
 * Good for a single student's notes (hundreds of chunks); swap for pgvector/Chroma if it ever grows.
 * Ids become file names, so they are validated strictly (no path traversal).
 */

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

export interface NoteDoc extends Omit<NoteMeta, 'chunks'> {
  chunks: StoredChunk[];
}

export const MAX_DOCS = 30;

/**
 * One store per process. The upload route and the read routes are registered separately (the upload
 * needs a larger body parser), and two stores over the same directory would each keep their own stale
 * cache. Everything that does not pass an explicit store shares this one.
 */
let shared: NotesStore | undefined;
export const defaultNotesStore = (): NotesStore => (shared ??= new NotesStore());
export const resetDefaultNotesStore = (): void => { shared = undefined; };
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isValidDocId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

export const toMeta = (d: NoteDoc): NoteMeta => ({ ...d, chunks: d.chunks.length });

export class NotesStore {
  private docs = new Map<string, NoteDoc>();
  private loaded = false;

  constructor(private readonly dir: string = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'notes')) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { return; }
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as NoteDoc;
        if (isValidDocId(d.id) && Array.isArray(d.chunks) && f === `${d.id}.json`) this.docs.set(d.id, d);
      } catch (e) {
        console.warn(`[notes] skipping unreadable file ${f}`);
      }
    }
  }

  all(): NoteDoc[] { this.load(); return [...this.docs.values()].sort((a, b) => a.createdAt - b.createdAt); }
  list(): NoteMeta[] { return this.all().map(toMeta); }
  get(id: string): NoteDoc | undefined { this.load(); return isValidDocId(id) ? this.docs.get(id) : undefined; }
  count(): number { this.load(); return this.docs.size; }

  save(doc: NoteDoc): void {
    this.load();
    if (!isValidDocId(doc.id)) throw new Error('invalid document id');
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${doc.id}.json`);
    const tmp = `${file}.tmp`;
    // Round embeddings to keep files small; write atomically so a crash never leaves a half-written file
    const slim: NoteDoc = {
      ...doc,
      chunks: doc.chunks.map(c => (c.embedding ? { ...c, embedding: c.embedding.map(x => Math.round(x * 1e5) / 1e5) } : c)),
    };
    fs.writeFileSync(tmp, JSON.stringify(slim));
    fs.renameSync(tmp, file);
    this.docs.set(doc.id, slim);
  }

  delete(id: string): boolean {
    this.load();
    if (!isValidDocId(id) || !this.docs.has(id)) return false;
    try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); } catch { /* already gone */ }
    this.docs.delete(id);
    return true;
  }
}
