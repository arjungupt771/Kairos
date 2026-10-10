import axios from 'axios';

/**
 * Minimal, dependency-free LLM layer for Gemini and Groq.
 *
 * - Keys are read from the environment at call time and never leave the server.
 * - A key that is empty or still a placeholder (`your_...`) counts as "not configured".
 * - Providers are tried in order (LLM_PROVIDER first, then the other one). If every
 *   configured provider fails, or none is configured, `LLMUnavailableError` is thrown
 *   and callers fall back to rule-based behaviour.
 */

export type ProviderName = 'gemini' | 'groq';

export interface GenerateOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResult {
  provider: ProviderName;
  model: string;
  json: unknown;
}

export class LLMUnavailableError extends Error {
  constructor(message: string, public readonly attempts: { provider: string; error: string }[] = []) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

/** Injectable for tests. Must resolve with the parsed JSON body or reject. */
export type HttpPost = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<any>;

export const defaultPost: HttpPost = async (url, body, headers, timeoutMs) => {
  const res = await axios.post(url, body, { headers, timeout: timeoutMs });
  return res.data;
};

// ─── Config ───────────────────────────────────────────────────────────────────

const PLACEHOLDER = /^(your[_-].*|paste[_-].*|changeme|xxx+|<.*>)$/i;

export function isConfiguredKey(key: string | undefined): boolean {
  if (!key) return false;
  const k = key.trim();
  return k.length > 0 && !PLACEHOLDER.test(k);
}

export function providerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    gemini: {
      configured: isConfiguredKey(env.GEMINI_API_KEY),
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    },
    groq: {
      configured: isConfiguredKey(env.GROQ_API_KEY),
      model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com').replace(/\/$/, ''),
    },
  };
}

/** Configured providers, preferred one first. */
export function providerOrder(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const cfg = providerConfig(env);
  const preferred: ProviderName = (env.LLM_PROVIDER || '').toLowerCase() === 'groq' ? 'groq' : 'gemini';
  const other: ProviderName = preferred === 'gemini' ? 'groq' : 'gemini';
  return [preferred, other].filter(p => cfg[p].configured);
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

/** Models sometimes wrap JSON in ``` fences or add a sentence around it. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Model did not return JSON');
  }
}

// ─── Providers ────────────────────────────────────────────────────────────────

async function callGemini(opts: GenerateOptions, env: NodeJS.ProcessEnv, post: HttpPost, timeoutMs: number) {
  const c = providerConfig(env).gemini;
  const data = await post(
    `${c.baseUrl}/v1beta/models/${encodeURIComponent(c.model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts: [{ text: opts.user }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        // Gemini 2.5 models spend part of this budget on internal reasoning, so keep it generous
        maxOutputTokens: opts.maxTokens ?? 2048,
        responseMimeType: 'application/json',
      },
    },
    // Key goes in a header, not the URL, so it can't leak into logs
    { 'Content-Type': 'application/json', 'x-goog-api-key': (env.GEMINI_API_KEY as string).trim() },
    timeoutMs,
  );

  if (data?.promptFeedback?.blockReason) throw new Error(`blocked: ${data.promptFeedback.blockReason}`);
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
  if (!text) throw new Error(`empty response (finishReason=${data?.candidates?.[0]?.finishReason ?? 'unknown'})`);
  return { model: c.model, text };
}

async function callGroq(opts: GenerateOptions, env: NodeJS.ProcessEnv, post: HttpPost, timeoutMs: number) {
  const c = providerConfig(env).groq;
  const data = await post(
    `${c.baseUrl}/openai/v1/chat/completions`,
    {
      model: c.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 2048,
      // JSON mode requires the word "JSON" to appear in the prompt; our prompts do.
      response_format: { type: 'json_object' },
    },
    { 'Content-Type': 'application/json', Authorization: `Bearer ${(env.GROQ_API_KEY as string).trim()}` },
    timeoutMs,
  );
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new Error('empty response');
  return { model: c.model, text };
}

/** Error text safe to log and return: status + message only, never headers/config. */
export function safeError(e: any): string {
  const status = e?.response?.status;
  const apiMsg = e?.response?.data?.error?.message;
  const msg = typeof apiMsg === 'string' ? apiMsg : e?.message ?? 'unknown error';
  return `${status ? `HTTP ${status}: ` : ''}${String(msg).slice(0, 200)}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LLMDeps {
  env?: NodeJS.ProcessEnv;
  post?: HttpPost;
  timeoutMs?: number;
  /** Optional check on the parsed JSON; throwing makes us try the next provider. */
  validate?: (json: unknown) => unknown;
}

export async function generateJSON(opts: GenerateOptions, deps: LLMDeps = {}): Promise<LLMResult> {
  const env = deps.env ?? process.env;
  const post = deps.post ?? defaultPost;
  const timeoutMs = deps.timeoutMs ?? 25000;
  const order = providerOrder(env);

  if (order.length === 0) {
    throw new LLMUnavailableError('No LLM provider configured. Set GEMINI_API_KEY and/or GROQ_API_KEY in backend/.env');
  }

  const attempts: { provider: string; error: string }[] = [];
  for (const provider of order) {
    try {
      const { model, text } =
        provider === 'gemini'
          ? await callGemini(opts, env, post, timeoutMs)
          : await callGroq(opts, env, post, timeoutMs);
      const parsed = parseJsonLoose(text);
      const json = deps.validate ? deps.validate(parsed) : parsed;
      return { provider, model, json };
    } catch (e) {
      attempts.push({ provider, error: safeError(e) });
    }
  }
  throw new LLMUnavailableError('All configured LLM providers failed', attempts);
}
