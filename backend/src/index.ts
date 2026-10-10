import express, { Request, Response } from 'express';
import cors from 'cors';
import { store, STUDENT_ID } from './store';
import { notifyN8n } from './n8nNotifier';
import { SyncRequest, SyncResponse, N8nPayload } from './types';
import { registerAiRoutes, makeRateLimiter } from './ai';
import { registerNotesUpload, registerNotesRoutes } from './notes/routes';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());

// One rate-limit bucket shared by every endpoint that costs LLM/embedding quota
const aiLimiter = makeRateLimiter(Number(process.env.AI_RATE_LIMIT_PER_MIN) || 20);

// Notes upload carries a PDF (base64), so it must come BEFORE the global 2 MB parser and brings its own
registerNotesUpload(app, { limiter: aiLimiter });

app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3001;

// AI endpoints (Gemini / Groq). Without keys they return 503 and the app falls back to rules.
registerAiRoutes(app, {}, aiLimiter);
registerNotesRoutes(app, { limiter: aiLimiter });

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, lamport: store.getLamport() });
});

// ─── Seed / Bootstrap ─────────────────────────────────────────────────────────

/**
 * GET /bootstrap
 * Returns initial state (subjects, chapters, tasks, rewards) so a fresh client
 * can hydrate without needing a prior sync.
 */
app.get('/bootstrap', (_req: Request, res: Response) => {
  res.json({
    subjects: store.subjects,
    chapters: store.chapters,
    tasks: store.getAllTasks(),
    rewards: store.getRewards(),
    sessions: store.getAllSessions(),
    quizAttempts: store.getAllQuizAttempts(),
    serverLamport: store.getLamport(),
  });
});

// ─── Sync Endpoint ────────────────────────────────────────────────────────────

/**
 * POST /sync
 *
 * The core of the system. A client pushes everything it knows that the server
 * might not have, and the server returns the full authoritative state.
 *
 * Idempotency guarantees:
 *  - Sessions are keyed by stable UUID — replayed sessions are ignored
 *  - Rewards are computed exactly once per session (processedSessions set)
 *  - n8n notifications sent at most once per session (notifiedSessions set)
 *  - Task ops are merged with Lamport clocks — replaying the same op is safe
 *    because taskWins() is a total order: identical lamport+deviceId pair never
 *    beats itself (equal clocks → stable tie-break by deviceId)
 */
app.post('/sync', async (req: Request, res: Response) => {
  const body = req.body as SyncRequest;

  if (!body || !body.studentId || !body.deviceId) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Advance server lamport
  store.advanceLamport(body.clientLamport ?? 0);

  // ── 1. Merge sessions, compute rewards ────────────────────────────────────
  const newlyConfirmed = store.mergeSessions(body.sessions ?? []);

  // ── 2. Merge task ops ────────────────────────────────────────────────────
  const taskOps = (body.taskOps ?? []).map(op => op.task);
  store.mergeTasks(taskOps);

  // ── 2b. Merge quiz attempts (idempotent by id) ───────────────────────────
  const newAttempts = store.mergeQuizAttempts(body.quizAttempts ?? []);

  // ── 3. Build response ────────────────────────────────────────────────────
  const rewards = store.getRewards();
  const response: SyncResponse = {
    rewards,
    tasks: store.getAllTasks(),
    sessions: store.getAllSessions(),
    quizAttempts: store.getAllQuizAttempts(),
    serverLamport: store.getLamport(),
    newlyConfirmedSessions: newlyConfirmed,
  };

  // ── 4. Fire n8n notifications for newly confirmed sessions ───────────────
  // We fire these *after* building the response so the client isn't blocked.
  // Each call is individually idempotent.
  for (const sessionId of newlyConfirmed) {
    const session = store.getSession(sessionId);
    if (session) {
      notifyN8n(sessionId, rewards, 50, session.targetMinutes).catch(console.error);
    }
  }

  console.log(`[sync] device=${body.deviceId} sessions_pushed=${body.sessions?.length ?? 0} newly_confirmed=${newlyConfirmed.length} task_ops=${taskOps.length} quiz_attempts_new=${newAttempts.length}`);

  res.json(response);
});

// ─── State Inspector (Dev Panel) ──────────────────────────────────────────────

app.get('/state', (_req: Request, res: Response) => {
  res.json({
    rewards: store.getRewards(),
    tasks: store.getAllTasks(),
    sessions: store.getAllSessions(),
    lamport: store.getLamport(),
  });
});

// ─── Mock N8N Sink ───────────────────────────────────────────────────────────

/**
 * This acts as our "mock WhatsApp notification" endpoint.
 * In production, replace N8N_WEBHOOK_URL with your real n8n Cloud webhook.
 *
 * The n8n workflow itself should:
 *  1. Receive the webhook
 *  2. Check a dedup store (e.g., n8n's built-in static data) for sessionId
 *  3. If already seen → stop
 *  4. If new → mark seen → send WhatsApp / notification
 */
const notificationLog: Array<{ receivedAt: string; payload: N8nPayload }> = [];

app.post('/mock-n8n-sink', (req: Request, res: Response) => {
  const payload = req.body as N8nPayload;
  notificationLog.push({ receivedAt: new Date().toISOString(), payload });
  console.log(`[mock-n8n-sink] 📲 NOTIFICATION: Streak ${payload.streak} days, +${payload.coinsEarned} coins (session: ${payload.sessionId})`);
  res.json({ ok: true, message: `Notification received for session ${payload.sessionId}` });
});

app.get('/notifications', (_req: Request, res: Response) => {
  res.json(notificationLog);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Alcovia backend running on http://localhost:${PORT}`);
  console.log(`   POST /sync          — sync client state`);
  console.log(`   GET  /bootstrap     — initial state`);
  console.log(`   GET  /state         — inspect server state`);
  console.log(`   GET  /notifications — mock n8n notification log`);
  console.log(`   POST /mock-n8n-sink — n8n webhook target\n`);
});

export default app;
