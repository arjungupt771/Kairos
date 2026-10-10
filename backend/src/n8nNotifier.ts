import axios from 'axios';
import { store } from './store';
import { N8nPayload, StudentRewards } from './types';
import dotenv from 'dotenv';
dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
// Point this at your n8n webhook URL.
// Falls back to a local mock sink if N8N_WEBHOOK_URL is not set.
console.log("ENV URL =", process.env.N8N_WEBHOOK_URL);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:3001/mock-n8n-sink';

/**
 * Fire the n8n notification for a confirmed session.
 * Idempotency is enforced HERE (server-side) before even calling n8n,
 * AND inside the n8n workflow itself (dedup on sessionId).
 *
 * This means even if this function is called twice concurrently, only one
 * notification goes out.
 */
export async function notifyN8n(
  sessionId: string,
  rewards: StudentRewards,
  coinsEarned: number,
  focusMinutes: number
): Promise<void> {
  // Guard: already notified this session?
  if (store.isNotified(sessionId)) {
    console.log(`[n8n] Skipping duplicate notification for session ${sessionId}`);
    return;
  }

  // Mark before firing — so concurrent calls don't both go through
  store.markNotified(sessionId);

  const payload: N8nPayload = {
    sessionId,
    studentId: rewards.studentId,
    streak: rewards.streak,
    coinsEarned,
    totalCoins: rewards.coins,
    focusMinutes,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await axios.post(N8N_WEBHOOK_URL, payload, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`[n8n] Notification sent for session ${sessionId} — status ${res.status}`);
  } catch (err: any) {
    console.error(`[n8n] Failed to notify for session ${sessionId}:`, err?.message);
    // Note: we don't un-mark notified — we accept at-most-once for the webhook.
    // In production you'd want a persistent outbox + retry queue here.
  }
}
