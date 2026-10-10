// ─── Shared Types (mirrored from backend) ─────────────────────────────────────

export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type FailReason = 'give_up' | 'app_switch';
export type SessionStatus = 'completed' | 'failed';

export interface FocusSession {
  id: string;
  studentId: string;
  targetMinutes: number;
  startedAt: number;
  status: SessionStatus;
  failReason?: FailReason;
  completedAt?: number;
  taskId?: string; // task this session was spent on (undefined = free focus)
  synced: boolean;
}

export interface StudentRewards {
  studentId: string;
  coins: number;
  streak: number;
  lastStreakDate: string;
  todayFocusMinutes: number;
  todayDate: string;
}

export interface Task {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
  status: TaskStatus;
  estimatedMinutes?: number; // focus time expected to finish the task (default 60)
  lamport: number;
  deviceId: string;
  deleted: boolean;
  deletedBy?: string;
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

export interface TaskOp {
  type: 'upsert' | 'delete';
  task: Task;
}

export type QuizDifficulty = 'easy' | 'medium' | 'hard';

/**
 * One finished quiz. Immutable and deduplicated by id, exactly like FocusSession.
 * Topic mastery is derived from these and never stored.
 */
export interface QuizAttempt {
  id: string;
  studentId: string;
  subjectId: string;
  chapterId?: string;
  taskId?: string;
  difficulty: QuizDifficulty;
  startedAt: number;
  completedAt: number;
  /** One entry per question: the topic (task) it tested and whether it was answered correctly. */
  results: { taskId: string; correct: boolean }[];
  provider?: string;
  model?: string;
  synced: boolean;
}

export interface SyncRequest {
  studentId: string;
  deviceId: string;
  sessions: FocusSession[];
  taskOps: TaskOp[];
  quizAttempts: QuizAttempt[];
  clientLamport: number;
}

export interface SyncResponse {
  rewards: StudentRewards;
  tasks: Task[];
  sessions: FocusSession[];
  quizAttempts: QuizAttempt[];
  serverLamport: number;
  newlyConfirmedSessions: string[];
}

export interface AppState {
  deviceId: string;
  lamport: number;
  sessions: FocusSession[];
  tasks: Task[];
  rewards: StudentRewards;
  pendingTaskOps: TaskOp[];
  pendingSessions: FocusSession[];
  quizAttempts: QuizAttempt[];
  pendingQuizAttempts: QuizAttempt[];
  subjects: Subject[];
  chapters: Chapter[];
}
