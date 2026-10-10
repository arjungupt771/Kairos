import { Chunk } from './chunk';

/**
 * Hybrid retrieval: BM25 keyword ranking always works (no API needed); vector ranking is added when
 * embeddings exist; the two rankings are merged with reciprocal rank fusion (RRF). Keyword search
 * keeps exact terms ("Chapter 4", a formula, a name) from being lost to fuzzy semantic matching.
 */

export interface StoredChunk extends Chunk {
  /** L2-normalised, so cosine similarity is a dot product. */
  embedding?: number[];
}

const STOP = new Set(('a an and are as at be but by for from has have he her his i in is it its of on or she that the their them then there these they this to was we were what when where which who why will with you your do does did not no can could should would about into over than so if how').split(' '));

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (let t of raw) {
    if (STOP.has(t) || t.length < 2) continue;
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1); // crude plural stripping
    out.push(t);
  }
  return out;
}

export function bm25Rank(query: string, chunks: StoredChunk[], k1 = 1.5, b = 0.75): { id: string; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0 || chunks.length === 0) return [];

  const docs = chunks.map(c => {
    const toks = tokenize(c.text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: c.id, len: toks.length, tf };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;
  const N = docs.length;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter(d => d.tf.has(t)).length);

  const scored = docs.map(d => {
    let score = 0;
    for (const t of q) {
      const f = d.tf.get(t) ?? 0;
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    return { id: d.id, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b2) => b2.score - a.score);
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm === 0 ? v.slice() : v.map(x => x / norm);
}

export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function vectorRank(queryVec: number[], chunks: StoredChunk[]): { id: string; score: number }[] {
  return chunks
    .filter(c => c.embedding && c.embedding.length === queryVec.length)
    .map(c => ({ id: c.id, score: dot(queryVec, c.embedding as number[]) }))
    .sort((a, b) => b.score - a.score);
}

export function rrf(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankings) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

export interface SearchHit { chunk: StoredChunk; score: number; via: ('keyword' | 'vector')[] }

export function hybridSearch(args: {
  query: string; chunks: StoredChunk[]; queryVec?: number[]; topK: number; candidates?: number;
}): SearchHit[] {
  const { query, chunks, queryVec, topK } = args;
  const cand = args.candidates ?? 30;
  const byId = new Map(chunks.map(c => [c.id, c]));

  const kw = bm25Rank(query, chunks).slice(0, cand);
  const vec = queryVec ? vectorRank(queryVec, chunks).slice(0, cand) : [];
  const fused = rrf([kw.map(x => x.id), vec.map(x => x.id)]);
  const kwSet = new Set(kw.map(x => x.id));
  const vecSet = new Set(vec.map(x => x.id));

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({
      chunk: byId.get(id) as StoredChunk,
      score,
      via: [...(kwSet.has(id) ? ['keyword' as const] : []), ...(vecSet.has(id) ? ['vector' as const] : [])],
    }));
}

/** Evenly spaced sample, in reading order. Used when there is no query (quizzes, gap analysis). */
export function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

/** Add the chunks next to each hit (same document), keeping reading order and removing duplicates. */
export function withNeighbors(hits: StoredChunk[], all: StoredChunk[], radius = 1): StoredChunk[] {
  const wanted = new Set<string>();
  const byDoc = new Map<string, StoredChunk[]>();
  for (const c of all) {
    const doc = c.id.slice(0, c.id.lastIndexOf(':'));
    (byDoc.get(doc) ?? byDoc.set(doc, []).get(doc)!).push(c);
  }
  for (const h of hits) {
    const doc = h.id.slice(0, h.id.lastIndexOf(':'));
    const list = byDoc.get(doc) ?? [];
    const pos = list.findIndex(c => c.id === h.id);
    for (let i = Math.max(0, pos - radius); i <= Math.min(list.length - 1, pos + radius); i++) wanted.add(list[i].id);
  }
  return all.filter(c => wanted.has(c.id));
}
