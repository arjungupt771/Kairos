import { HttpPost, defaultPost, safeError, isConfiguredKey } from '../llm';
import { normalize } from './retrieval';

/**
 * Gemini embeddings (only Gemini: Groq has no embeddings API). Vectors are truncated to EMBED_DIMS and
 * L2-normalised here, which Google requires for truncated dimensions, so cosine similarity is a dot product.
 * Everything that uses this must keep working without it: keyword search needs no API.
 */

export const EMBED_DIMS = 768;
const BATCH_SIZE = 100;
const MAX_TEXT_CHARS = 8000;

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'EmbeddingUnavailableError'; }
}

export function embeddingConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    configured: isConfiguredKey(env.GEMINI_API_KEY),
    model: env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
    baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
  };
}

export interface EmbedDeps { env?: NodeJS.ProcessEnv; post?: HttpPost; timeoutMs?: number }

export async function embedTexts(texts: string[], task: EmbedTask, deps: EmbedDeps = {}): Promise<number[][]> {
  const env = deps.env ?? process.env;
  const post = deps.post ?? defaultPost;
  const timeoutMs = deps.timeoutMs ?? 30000;
  const cfg = embeddingConfig(env);
  if (!cfg.configured) throw new EmbeddingUnavailableError('No Gemini key configured for embeddings');
  if (texts.length === 0) return [];

  const url = `${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:batchEmbedContents`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': (env.GEMINI_API_KEY as string).trim() };
  // taskType is marked deprecated in some docs; send it, but fall back to omitting it if the API refuses it
  let withTask = true;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const build = (useTask: boolean) => ({
      requests: batch.map(t => ({
        model: `models/${cfg.model}`,
        content: { parts: [{ text: t.slice(0, MAX_TEXT_CHARS) }] },
        ...(useTask ? { taskType: task } : {}),
        outputDimensionality: EMBED_DIMS,
      })),
    });

    let data: any;
    try {
      try {
        data = await post(url, build(withTask), headers, timeoutMs);
      } catch (e: any) {
        if (withTask && e?.response?.status === 400) {
          withTask = false;
          data = await post(url, build(false), headers, timeoutMs);
        } else throw e;
      }
    } catch (e) {
      throw new EmbeddingUnavailableError(safeError(e));
    }

    const vectors = data?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new EmbeddingUnavailableError('Embedding response had the wrong number of vectors');
    }
    for (const v of vectors) {
      const values = v?.values;
      if (!Array.isArray(values) || values.length === 0 || values.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))) {
        throw new EmbeddingUnavailableError('Embedding response contained an invalid vector');
      }
      out.push(normalize(values));
    }
  }
  return out;
}
