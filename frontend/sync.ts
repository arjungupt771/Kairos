import {
  AppState,
  FocusSession,
  TaskOp,
  Task,
  SyncRequest,
  SyncResponse,
  QuizAttempt,
} from './types';

export const BACKEND_URL = 'http://localhost:3001';

// ─── Conflict resolution (mirrors server logic) ───────────────────────────────

/**
 * Client-side task merge: same Lamport + delete-wins strategy.
 * When the server returns authoritative tasks, we merge them with local,
 * giving precedence to the server's version for the same task.
 *
 * (The server already ran this logic, so we just adopt the server state.
 * This function is used when applying the sync response.)
 */
export function mergeTaskLists(local: Task[], remote: Task[]): Task[] {
  const merged = new Map<string, Task>(local.map(t => [t.id, t]));

  for (const remoteTask of remote) {
    const existing = merged.get(remoteTask.id);
    if (!existing) {
      merged.set(remoteTask.id, remoteTask);
      continue;
    }

    // Delete wins
    if (remoteTask.deleted && !existing.deleted) {
      merged.set(remoteTask.id, remoteTask);
      continue;
    }
    if (!remoteTask.deleted && existing.deleted) {
      continue; // keep tombstone
    }

    // Higher Lamport wins
    if (remoteTask.lamport > existing.lamport) {
      merged.set(remoteTask.id, remoteTask);
    } else if (remoteTask.lamport === existing.lamport) {
      // Tie-break: lexicographically greater deviceId
      if (remoteTask.deviceId > existing.deviceId) {
        merged.set(remoteTask.id, remoteTask);
      }
    }
  }

  return Array.from(merged.values());
}

// ─── Local rewards update (optimistic, for offline) ───────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function prevDayUTC(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Optimistically update rewards on-device for a completed session.
 * The server is the source of truth; this just keeps the UI responsive offline.
 */
export function applyLocalRewards(state: AppState, session: FocusSession): AppState {
  const today = todayUTC();
  let { coins, streak, lastStreakDate, todayFocusMinutes, todayDate } = state.rewards;

  if (todayDate !== today) {
    todayFocusMinutes = 0;
    todayDate = today;
  }

  todayFocusMinutes += session.targetMinutes;
  coins += 50;

  const yesterday = prevDayUTC(today);
  if (lastStreakDate === today) {
    // already bumped today
  } else if (lastStreakDate === yesterday || lastStreakDate === '') {
    streak += 1;
    lastStreakDate = today;
  } else {
    streak = 1;
    lastStreakDate = today;
  }

  return {
    ...state,
    rewards: { ...state.rewards, coins, streak, lastStreakDate, todayFocusMinutes, todayDate },
  };
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  newlyConfirmedSessions: string[];
  error?: string;
  /** What was pushed (the state at call time) and what the server answered. Apply with reconcileSync. */
  snapshot?: AppState;
  response?: SyncResponse;
}

const byId = <T extends { id: string }>(items: T[]): Map<string, T> => new Map(items.map(i => [i.id, i]));

/**
 * Apply a sync response to the CURRENT state without losing anything created while the request
 * was in flight. Pending items are removed only if they were part of the pushed snapshot, and
 * sessions / quiz attempts are unioned by id (they are immutable, so the server copy is identical).
 * Tasks use the normal Lamport merge, so a local edit made during the sync still wins.
 */
export function reconcileSync(current: AppState, snapshot: AppState, data: SyncResponse): AppState {
  const pushedSessions = new Set(snapshot.pendingSessions.map(s => s.id));
  const pushedAttempts = new Set(snapshot.pendingQuizAttempts.map(a => a.id));
  const opKey = (op: TaskOp) => `${op.type}:${op.task.id}:${op.task.lamport}`;
  const pushedOps = new Set(snapshot.pendingTaskOps.map(opKey));

  const sessions = byId(current.sessions);
  for (const s of data.sessions) sessions.set(s.id, { ...s, synced: true });
  const attempts = byId(current.quizAttempts);
  for (const a of data.quizAttempts ?? []) attempts.set(a.id, { ...a, synced: true });

  const pendingSessions = current.pendingSessions.filter(s => !pushedSessions.has(s.id));

  // Server rewards are authoritative; re-apply optimistic rewards for sessions it has not seen yet
  let next: AppState = { ...current, rewards: data.rewards };
  for (const s of pendingSessions) if (s.status === 'completed') next = applyLocalRewards(next, s);

  return {
    ...next,
    tasks: mergeTaskLists(current.tasks, data.tasks),
    sessions: Array.from(sessions.values()),
    pendingSessions,
    quizAttempts: Array.from(attempts.values()),
    pendingQuizAttempts: current.pendingQuizAttempts.filter(a => !pushedAttempts.has(a.id)),
    pendingTaskOps: current.pendingTaskOps.filter(op => !pushedOps.has(opKey(op))),
    lamport: Math.max(current.lamport, data.serverLamport) + 1,
  };
}

/**
 * Push pending ops to the server and receive authoritative state.
 * After a successful sync, the server state is adopted wholesale for rewards
 * (server is authoritative). Tasks are merged client-side post-sync.
 */
export async function syncWithServer(state: AppState): Promise<SyncResult> {
  const payload: SyncRequest = {
    studentId: 'student_alcovia_01',
    deviceId: state.deviceId,
    sessions: state.pendingSessions,
    taskOps: state.pendingTaskOps,
    quizAttempts: state.pendingQuizAttempts,
    clientLamport: state.lamport,
  };

  try {
    const res = await fetch(`${BACKEND_URL}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data: SyncResponse = await res.json();

    return {
      success: true,
      newlyConfirmedSessions: data.newlyConfirmedSessions,
      snapshot: state,
      response: data,
    };
  } catch (err: any) {
    return {
      success: false,
      newlyConfirmedSessions: [],
      error: err?.message ?? 'Unknown error',
    };
  }
}

/**
 * Bootstrap from server on first load.
 */
export async function bootstrapFromServer(state: AppState): Promise<Partial<AppState> | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/bootstrap`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      tasks: data.tasks,
      rewards: data.rewards,
      sessions: data.sessions,
      quizAttempts: data.quizAttempts ?? [],
      subjects: data.subjects,
      chapters: data.chapters,
      lamport: data.serverLamport + 1,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch current notification log from backend (for dev panel)
 */
export async function fetchNotifications(): Promise<any[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/notifications`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Fetch server state (for dev panel)
 */
export async function fetchServerState(): Promise<any | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/state`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
