import express, { Express, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { generateJSON, LLMDeps } from '../llm';
import { clean, BadRequest, fail, makeRateLimiter } from '../ai';
import { chunkPages, findSection, parseSectionRef, sectionRefRegex, PageText } from './chunk';
import { embedTexts, embeddingConfig, EMBED_DIMS } from './embeddings';
import { extractPdfPages, MAX_PDF_BYTES, PdfError } from './pdf';
import { hybridSearch, evenSample, withNeighbors, StoredChunk } from './retrieval';
import { NotesStore, NoteDoc, MAX_DOCS, toMeta, isValidDocId, defaultNotesStore } from './store';
import {
  makePassages, sanitizeAskRequest, retrievalQuery, buildAskPrompt, validateAsk, NOT_IN_NOTES,
  sanitizeSummarizeRequest, buildSummaryPrompt, validateSummary, fitToBudget, SummaryOut,
  sanitizeNotesQuizRequest, buildNotesQuizPrompt, validateNotesQuiz,
  sanitizeGapsRequest, buildGapsPrompt, validateGaps, Passage,
} from './tutor';

type Limiter = ReturnType<typeof makeRateLimiter>;
export interface NotesDeps extends LLMDeps { store?: NotesStore; limiter?: Limiter }

const MAX_CHARS = 1_500_000;
const MAX_CHUNKS = 800;
const MAX_JSON_BODY = '14mb'; // a 10 MB PDF is about 13.4 MB as base64

// ─── Upload (registered BEFORE the global 2 MB JSON parser; it brings its own) ─

export function registerNotesUpload(app: Express, deps: NotesDeps = {}) {
  const store = deps.store ?? defaultNotesStore();
  const limiter = deps.limiter ?? makeRateLimiter(Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20);

  app.post('/notes', limiter, express.json({ limit: MAX_JSON_BODY }), async (req: Request, res: Response) => {
    try {
      if (store.count() >= MAX_DOCS) {
        res.status(409).json({ error: 'too_many_docs', detail: `You can keep up to ${MAX_DOCS} documents. Delete one first.` });
        return;
      }
      const b = req.body ?? {};
      const kind = b.kind === 'text' ? 'text' : 'pdf';
      const fileName = clean(b.fileName, 120) || (kind === 'pdf' ? 'notes.pdf' : 'notes.txt');
      const title = clean(b.title, 80) || fileName.replace(/\.[a-z0-9]+$/i, '');
      const subjectId = clean(b.subjectId, 64) || undefined;

      // 1. text
      let pages: PageText[];
      if (kind === 'text') {
        const text = typeof b.text === 'string' ? b.text : '';
        if (text.length > MAX_CHARS) { res.status(413).json({ error: 'too_large', detail: 'That text is too long.' }); return; }
        pages = [{ page: null, text }];
      } else {
        const b64 = typeof b.dataBase64 === 'string' ? b.dataBase64 : '';
        if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new BadRequest('dataBase64 required');
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > MAX_PDF_BYTES) { res.status(413).json({ error: 'too_large', detail: 'PDFs up to 10 MB are supported.' }); return; }
        try {
          pages = await extractPdfPages(buf);
        } catch (e) {
          if (e instanceof PdfError) { res.status(422).json({ error: 'unreadable_pdf', detail: e.message }); return; }
          throw e;
        }
      }

      const charCount = pages.reduce((a, p) => a + p.text.length, 0);
      if (charCount > MAX_CHARS) { res.status(413).json({ error: 'too_large', detail: 'That document is too long.' }); return; }

      // 2. chunks
      const id = uuid();
      const chunks: StoredChunk[] = chunkPages(pages, id);
      if (chunks.length === 0) {
        res.status(422).json({
          error: 'no_text',
          detail: 'No readable text was found. Scanned PDFs (pictures of pages) need OCR, which is not supported yet.',
        });
        return;
      }
      if (chunks.length > MAX_CHUNKS) {
        res.status(413).json({ error: 'too_large', detail: `That document has too many sections (${chunks.length}, max ${MAX_CHUNKS}). Upload fewer pages.` });
        return;
      }

      // 3. embeddings are optional: keyword search works without them
      let embedded = false;
      let note: string | undefined;
      const cfg = embeddingConfig(deps.env ?? process.env);
      if (cfg.configured) {
        try {
          const vecs = await embedTexts(chunks.map(c => c.text), 'RETRIEVAL_DOCUMENT', deps);
          chunks.forEach((c, i) => { c.embedding = vecs[i]; });
          embedded = true;
        } catch (e: any) {
          note = `Saved without semantic search (embeddings failed: ${e?.message ?? 'unknown'}). Keyword search still works.`;
        }
      } else {
        note = 'Saved with keyword search only. Add GEMINI_API_KEY on the server to enable semantic search.';
      }

      const doc: NoteDoc = {
        id, title, fileName, kind, subjectId, pages: pages.length, charCount, createdAt: Date.now(),
        embedded, ...(embedded ? { embeddingModel: `${cfg.model}@${EMBED_DIMS}` } : {}), chunks,
      };
      store.save(doc);
      res.status(201).json({ doc: toMeta(doc), embedded, ...(note ? { note } : {}) });
    } catch (e) { fail(res, e); }
  });
}

// ─── Everything else (small JSON bodies) ──────────────────────────────────────

export function registerNotesRoutes(app: Express, deps: NotesDeps = {}) {
  const store = deps.store ?? defaultNotesStore();
  const limiter = deps.limiter ?? makeRateLimiter(Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20);
  const llm: LLMDeps = { env: deps.env, post: deps.post, timeoutMs: deps.timeoutMs };

  app.get('/notes', (_req, res) => { res.json({ docs: store.list() }); });

  app.delete('/notes/:id', (req, res) => {
    if (!isValidDocId(req.params.id)) { res.status(400).json({ error: 'bad_request', detail: 'invalid id' }); return; }
    res.json({ deleted: store.delete(req.params.id) });
  });

  /** Docs a request applies to: the listed ones, or all of them. */
  const selectDocs = (docIds: string[]): NoteDoc[] => {
    const all = store.all();
    return docIds.length ? all.filter(d => docIds.includes(d.id)) : all;
  };
  const allChunks = (docs: NoteDoc[]): StoredChunk[] => docs.flatMap(d => d.chunks);
  const requireDocs = (docs: NoteDoc[]) => {
    if (docs.length === 0) throw new BadRequest('Upload some notes first');
  };

  async function queryVector(query: string, docs: NoteDoc[]): Promise<number[] | undefined> {
    if (!docs.some(d => d.embedded) || !embeddingConfig(deps.env ?? process.env).configured) return undefined;
    try { return (await embedTexts([query], 'RETRIEVAL_QUERY', deps))[0]; } catch { return undefined; }
  }

  // Q&A / explain, grounded in the notes
  app.post('/ai/notes/ask', limiter, express.json({ limit: '100kb' }), async (req, res) => {
    try {
      const body = sanitizeAskRequest(req.body);
      const docs = selectDocs(body.docIds);
      requireDocs(docs);

      const query = retrievalQuery(body);
      const queryVec = await queryVector(query, docs);
      const hits = hybridSearch({ query, chunks: allChunks(docs), queryVec, topK: 6 });
      const retrieval = queryVec ? 'hybrid' : 'keyword';

      // Nothing matched at all: do not even ask the model (cheaper, and it cannot make something up)
      if (hits.length === 0) {
        res.json({ answerable: false, answer: NOT_IN_NOTES, citations: [], retrieval, source: null });
        return;
      }
      const passages = makePassages(hits.map(h => h.chunk), docs);
      const out = await generateJSON(
        { ...buildAskPrompt(body, passages), temperature: 0.2 },
        { ...llm, validate: raw => validateAsk(raw, passages) },
      );
      res.json({ source: { provider: out.provider, model: out.model }, retrieval, ...(out.json as object) });
    } catch (e) { fail(res, e); }
  });

  // "Summarize Chapter 4": find that section by heading, else the best-matching passages
  app.post('/ai/notes/summarize', limiter, express.json({ limit: '100kb' }), async (req, res) => {
    try {
      const body = sanitizeSummarizeRequest(req.body);
      const docs = selectDocs(body.docIds);
      requireDocs(docs);

      let chunks: StoredChunk[] = [];
      let coverage: 'section' | 'retrieved' = 'retrieved';
      const ref = parseSectionRef(body.query);
      if (ref) {
        for (const d of docs) {
          const sec = findSection(d.chunks, ref);
          if (sec.length) { chunks = sec as StoredChunk[]; coverage = 'section'; break; }
        }
      }
      if (chunks.length === 0) {
        const everything = allChunks(docs);
        if (ref) {
          // The student named a specific section and no heading matched. Summarising "the nearest passages" would
          // answer a different question, so only use passages that actually mention it (e.g. headings in running text).
          const re = sectionRefRegex(ref);
          const mentions = everything.filter(c => re.test(c.text));
          chunks = mentions.length ? withNeighbors(mentions, everything, 1) : [];
        } else {
          const queryVec = await queryVector(body.query, docs);
          const hits = hybridSearch({ query: body.query, chunks: everything, queryVec, topK: 6 });
          chunks = withNeighbors(hits.map(h => h.chunk), everything, 1);
        }
      }
      if (chunks.length === 0) {
        res.json({
          found: false,
          message: ref
            ? `I could not find a heading or any mention of "${ref.key}" in your notes. Try the topic name instead.`
            : `I could not find "${body.query}" in your notes.`,
        });
        return;
      }

      const fit = fitToBudget(chunks);
      const passages = makePassages(fit.chunks, docs);
      const out = await generateJSON(
        { ...buildSummaryPrompt(body, passages), temperature: 0.3 },
        { ...llm, validate: validateSummary },
      );
      const result = out.json as SummaryOut;
      // Nearest-neighbour search always returns something, so the model decides whether it is really about the topic.
      // (A heading match is trusted: the section is known to be there.)
      if (coverage === 'retrieved' && !result.covered) {
        res.json({ found: false, message: `Your notes do not seem to cover "${body.query}".` });
        return;
      }
      const pages = passages.map(p => p.page).filter((p): p is number => p !== null);
      res.json({
        found: true,
        source: { provider: out.provider, model: out.model },
        summary: result.summary,
        keyPoints: result.keyPoints,
        // Computed here, not by the model, so it is always true
        coverage: {
          mode: coverage,
          docTitle: passages[0]?.docTitle ?? '',
          pages: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
          passagesUsed: passages.length,
          passagesAvailable: chunks.length,
          partial: fit.partial,
        },
      });
    } catch (e) { fail(res, e); }
  });

  // "Generate a quiz from this PDF"
  app.post('/ai/notes/quiz', limiter, express.json({ limit: '100kb' }), async (req, res) => {
    try {
      const body = sanitizeNotesQuizRequest(req.body);
      const docs = selectDocs(body.docIds);
      requireDocs(docs);
      const everything = allChunks(docs);

      let picked: StoredChunk[];
      if (body.query) {
        const queryVec = await queryVector(body.query, docs);
        picked = hybridSearch({ query: body.query, chunks: everything, queryVec, topK: 8 }).map(h => h.chunk);
      } else {
        picked = evenSample(everything, 8);
      }
      if (picked.length === 0) { res.status(404).json({ error: 'not_found', detail: 'No matching passages in your notes.' }); return; }

      const passages = makePassages(picked, docs);
      const out = await generateJSON(
        { ...buildNotesQuizPrompt(body, passages), temperature: 0.4, maxTokens: 6144 },
        { ...llm, validate: raw => ({ questions: validateNotesQuiz(raw, passages, body) }) },
      );
      res.json({
        source: { provider: out.provider, model: out.model },
        difficulty: body.difficulty,
        scope: body.taskId ? 'task' : 'document',
        docIds: [...new Set(passages.map(p => p.docId))],
        ...(out.json as object),
      });
    } catch (e) { fail(res, e); }
  });

  // "What important concepts haven't I studied?"
  app.post('/ai/notes/gaps', limiter, express.json({ limit: '200kb' }), async (req, res) => {
    try {
      const body = sanitizeGapsRequest(req.body);
      const docs = selectDocs(body.docIds);
      requireDocs(docs);

      const everything = allChunks(docs);
      const sample = evenSample(everything, 16);
      const passages = makePassages(sample, docs);
      const out = await generateJSON(
        { ...buildGapsPrompt(body, passages), temperature: 0.3, maxTokens: 4096 },
        { ...llm, validate: raw => ({ gaps: validateGaps(raw, passages, body) }) },
      );
      res.json({
        source: { provider: out.provider, model: out.model },
        // Honest scope: this looks at a sample, and "studied" means task progress, not understanding
        basis: { passagesChecked: passages.length, passagesTotal: everything.length },
        ...(out.json as object),
      });
    } catch (e) { fail(res, e); }
  });
}
