// ─── Shared Types ────────────────────────────────────────────────────────────

export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type FailReason = 'give_up' | 'app_switch';
export type SessionStatus = 'completed' | 'failed';

// ─── Focus Session ────────────────────────────────────────────────────────────

export interface FocusSession {
  id: string;              // stable uuid created on device
  studentId: string;
  targetMinutes: number;
  startedAt: number;       // epoch ms (device clock — only used for ordering, not dedup)
  status: SessionStatus;
  failReason?: FailReason;
  completedAt?: number;    // epoch ms
  taskId?: string;         // task the session was spent on (undefined = free focus)
  synced: boolean;         // server-side: always true; client: whether pushed
}

// ─── Rewards (server-of-record) ───────────────────────────────────────────────

export interface StudentRewards {
  studentId: string;
  coins: number;
  streak: number;          // consecutive days with ≥1 completed session
  lastStreakDate: string;  // YYYY-MM-DD in UTC
  todayFocusMinutes: number;
  todayDate: string;       // YYYY-MM-DD in UTC — resets todayFocusMinutes when date changes
}

// ─── Syllabus / Tasks ─────────────────────────────────────────────────────────

export interface Task {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
  status: TaskStatus;
  estimatedMinutes?: number; // focus time expected to finish the task
  // Logical clock: (lamportClock, deviceId) — used instead of wall-clock for conflict resolution
  lamport: number;
  deviceId: string;
  // Tombstone support
  deleted: boolean;
  deletedBy?: string;      // deviceId that deleted
  deletedLamport?: number;
}

export interface Chapter {
  id: string;
  subjectId: string;
  title: string;
}

export interface Subject {
  id: string;
  title: string;
}

// ─── Sync Protocol ────────────────────────────────────────────────────────────


export type QuizDifficulty = 'easy' | 'medium' | 'hard';

/**
 * One finished quiz. Immutable and deduplicated by id (exactly like FocusSession), so two
 * devices can never disagree about it. Topic mastery is derived from these, never stored.
 */
export interface QuizAttempt {
  id: string;
  studentId: string;
  subjectId: string;
  chapterId?: string;        // set when the quiz was scoped to a chapter or a single topic
  taskId?: string;           // set when the quiz was scoped to a single topic
  difficulty: QuizDifficulty;
  startedAt: number;         // epoch ms
  completedAt: number;       // epoch ms
  /** One entry per question: which topic (task) it tested and whether it was answered correctly. */
  results: { taskId: string; correct: boolean }[];
  provider?: string;
  model?: string;
  synced: boolean;
}

export interface SyncRequest {
  studentId: string;
  deviceId: string;
  // Sessions the client wants to push
  sessions: FocusSession[];
  // Task operations the client wants to push
  taskOps: TaskOp[];
  // Quiz attempts the client wants to push (optional for older clients)
  quizAttempts?: QuizAttempt[];
  // The client's current lamport clock value (so server can advance its own)
  clientLamport: number;
}

export interface TaskOp {
  type: 'upsert' | 'delete';
  task: Task;
}

export interface SyncResponse {
  // Merged authoritative state the client should adopt
  rewards: StudentRewards;
  tasks: Task[];
  sessions: FocusSession[];
  quizAttempts: QuizAttempt[];
  // Server's current lamport (client advances to max(client, server) + 1)
  serverLamport: number;
  // Sessions that were newly confirmed successful on this sync (for logging)
  newlyConfirmedSessions: string[];
}

// ─── N8N Webhook Payload ──────────────────────────────────────────────────────

export interface N8nPayload {
  sessionId: string;
  studentId: string;
  streak: number;
  coinsEarned: number;
  totalCoins: number;
  focusMinutes: number;
  timestamp: string;
}
