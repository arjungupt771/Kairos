import { BACKEND_URL } from './sync';
import { PlanSource } from './schedule';
import { PerformanceStats } from './analytics';

/**
 * Thin client for the backend AI endpoints. API keys live on the server only.
 * Every call resolves (never throws) with ok/false + a human-readable reason, so the
 * caller can fall back to its rule-based version and tell the user why.
 */

export interface AiStatus {
  anyConfigured: boolean;
  order: ('gemini' | 'groq')[];
  providers: Record<'gemini' | 'groq', { configured: boolean; model: string }>;
  embeddings?: { configured: boolean; model: string };
}

export type AiResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface ScheduleResponse {
  source: { provider: Exclude<PlanSource, 'rules'>; model: string };
  summary: string;
  blocks: { taskId: string; minutes: number; reason: string }[];
}

export interface AnalyzeResponse {
  source: { provider: Exclude<PlanSource, 'rules'>; model: string };
  summary: string;
  findings: { text: string }[];
  nextStep: string;
}

export async function call<T>(
  path: string, body?: unknown, timeoutMs = 40000, method?: 'GET' | 'POST' | 'DELETE',
): Promise<AiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: json as T };
    return { ok: false, reason: explain(res.status, json) };
  } catch (e: any) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'The AI took too long to answer' : "Can't reach the server" };
  } finally {
    clearTimeout(timer);
  }
}

function explain(status: number, json: any): string {
  // Notes endpoints send a user-safe explanation for these (too large, scanned PDF, upload some notes first...)
  if ([400, 409, 413, 422].includes(status) && typeof json?.detail === 'string') return json.detail;
  if (status === 413) return 'That file is too large';
  if (status === 429) return 'Too many AI requests, try again in a minute';
  if (status === 503) {
    return json?.attempts?.length
      ? 'The AI providers returned errors'
      : 'No AI key is set on the server (see backend/.env.example)';
  }
  if (status === 400) return 'The request was rejected';
  if (status === 404) return 'Not found';
  return `Server error (${status})`;
}

export interface ExplainResponse {
  source: { provider: Exclude<PlanSource, 'rules'>; model: string };
  explanation: string;
  examples: string[];
  followUps: string[];
}

export interface QuizResponse {
  source: { provider: Exclude<PlanSource, 'rules'>; model: string };
  difficulty: 'easy' | 'medium' | 'hard';
  questions: { taskId: string; question: string; options: string[]; correctIndex: number; explanation: string }[];
}

export interface StoredAnalysis extends AnalyzeResponse {
  generatedAt: number;
  basedOnSessions: number;
}

export const fetchAiStatus = () => call<AiStatus>('/ai/status');
export const requestSchedule = (body: unknown) => call<ScheduleResponse>('/ai/schedule', body);
export const requestAnalysis = (stats: PerformanceStats, ruleFindings: string[]) =>
  call<AnalyzeResponse>('/ai/analyze', { stats, ruleFindings });
export const requestExplain = (body: { subject: string; chapter: string; topic: string; question?: string }) =>
  call<ExplainResponse>('/ai/explain', body);
export const requestQuiz = (body: unknown) => call<QuizResponse>('/ai/quiz', body, 60000);
