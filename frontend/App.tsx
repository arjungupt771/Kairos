import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  Platform,
  Alert,
} from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import {
  AppState,
  FocusSession,
  Task,
  TaskStatus,
  TaskOp,
  FailReason,
  QuizDifficulty,
} from './types';
import { DeviceStorage, ActiveSessionState } from './storage';
import {
  syncWithServer,
  reconcileSync,
  bootstrapFromServer,
  applyLocalRewards,
  fetchNotifications,
  fetchServerState,
} from './sync';
import {
  DAILY_GOAL_MIN,
  taskProgress,
  taskFocusMinutes,
  taskEstimate,
  chapterProgress,
  subjectProgress,
  focusMinutesToday,
  effectiveStreak,
  sessionsToday,
  rankTasks,
  buildTodayPlan,
} from './insights';
import {
  computeStats, ruleFindings, learnProfile, localDay, MIN_TOTAL_SESSIONS,
} from './analytics';
import {
  StudyPlan, PlanSource, BlockItem, BlockStatus, windowEnd, availableMinutes, layoutBlocks,
  blockStatuses, missedTaskIds, ruleBasedItems, isPlanFromToday, buildScheduleRequest, MIN_BLOCK_MIN,
} from './schedule';
import {
  AiStatus, StoredAnalysis, ExplainResponse, fetchAiStatus, requestSchedule, requestAnalysis, requestExplain, requestQuiz,
} from './aiClient';
import { computeMastery, subjectMastery, revisionAdvice, levelEmoji, MIN_QUESTIONS_FOR_RATING } from './mastery';
import { QuizScope, ActiveQuiz, resolveScope, scoreQuiz, buildAttempt } from './quiz';
import NotesPanel, { ChatEntry } from './NotesPanel';
import { NoteMeta, listNotes } from './notesApi';
import { noteMastery, topicTitle } from './notesLogic';
import BarChart from './BarChart';
import { Period, periodStats, deltaLabel, fmtDuration } from './progress';
import {
  clampGoal, weeklyHistory, goalProgress, suggestWeeklyGoal, longestStreak, MIN_GOAL, MAX_GOAL,
} from './goals';
import { computeAchievements, nextUp } from './achievements';

// ─── Constants ────────────────────────────────────────────────────────────────

const STUDENT_ID = 'student_alcovia_01';
const APP_SWITCH_GRACE_MS = 5000;

// Read deviceId from URL (?device=A or ?device=B), default to A
function getDeviceId(): string {
  if (Platform.OS === 'web') {
    const params = new URLSearchParams(window.location.search);
    return params.get('device') || 'DeviceA';
  }
  return 'DeviceA';
}

// ─── Theme ────────────────────────────────────────────────────────────────────

import { COLORS } from './theme';

const TAB_LABELS = {
  home: ['🏠', 'Home'], focus: ['⏱', 'Focus'], syllabus: ['📚', 'Syllabus'],
  learn: ['📖', 'Learn'], insights: ['📈', 'Insights'], dev: ['🔧', 'Dev'],
} as const;

// ─── Progress helpers ─────────────────────────────────────────────────────────
// Progress is derived from focus sessions + task status; see insights.ts.

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ─── Timer display ────────────────────────────────────────────────────────────

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const deviceId = getDeviceId();
  const storageRef = useRef<DeviceStorage>(new DeviceStorage(deviceId));

  // ── State ──────────────────────────────────────────────────────────────────

  const [appState, setAppStateRaw] = useState<AppState>(() =>
    storageRef.current.loadState(deviceId)
  );
  const [isOnline, setIsOnline] = useState(true);
  const [activeTab, setActiveTab] = useState<'home' | 'focus' | 'syllabus' | 'learn' | 'insights' | 'dev'>('home');

  // Focus session state
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const [targetMinutes, setTargetMinutes] = useState(25);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionStartTime, setSessionStartTime] = useState(0);

  // Task ↔ focus link
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [lastCompletion, setLastCompletion] = useState<null | {
    taskTitle: string | null; minutes: number; before: number; after: number; coins: number;
  }>(null);
  // Ref mirrors focusTaskId so timer/recovery callbacks never read a stale closure
  const taskIdRef = useRef<string | null>(null);

  // AI plan + analysis (Phase 2)
  const [plan, setPlan] = useState<StudyPlan | null>(() => storageRef.current.loadPlan());
  const [planBusy, setPlanBusy] = useState(false);
  const [planMsg, setPlanMsg] = useState('');
  const [analysis, setAnalysis] = useState<StoredAnalysis | null>(() => storageRef.current.loadAnalysis());
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisMsg, setAnalysisMsg] = useState('');
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);

  // Learn: explainer + quiz (Phase 3)
  const [learnMode, setLearnMode] = useState<'explain' | 'quiz' | 'notes'>('explain');
  const [learnScope, setLearnScope] = useState<QuizScope>({ subjectId: '' });
  const [freeTopic, setFreeTopic] = useState('');
  const [explainEntries, setExplainEntries] = useState<{ question?: string; data: ExplainResponse }[]>([]);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explainMsg, setExplainMsg] = useState('');
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('medium');
  const savedQuiz = useRef<ActiveQuiz | null>(null);
  if (savedQuiz.current === null) {
    const q = storageRef.current.loadQuiz<ActiveQuiz>();
    // Ignore anything that does not look like a quiz written by this version
    savedQuiz.current = q && Array.isArray(q.questions) && Array.isArray(q.answers) && q.questions.length === q.answers.length ? q : null;
  }
  const [activeQuiz, setActiveQuiz] = useState<ActiveQuiz | null>(savedQuiz.current);
  const [quizStep, setQuizStep] = useState<number>(() => {
    const q = savedQuiz.current;
    if (!q) return 0;
    const i = q.answers.findIndex(a => a === null);
    return i === -1 ? q.questions.length : i;
  });
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizMsg, setQuizMsg] = useState('');

  // Progress (Phase 5)
  const [insightsView, setInsightsView] = useState<'progress' | 'patterns' | 'mastery'>('progress');
  const [period, setPeriod] = useState<Period>('week');
  const [weeklyGoal, setWeeklyGoal] = useState<number | null>(() => storageRef.current.loadGoal());
  const updateGoal = (n: number | null) => {
    const v = n === null ? null : clampGoal(n);
    setWeeklyGoal(v);
    storageRef.current.saveGoal(v);
  };

  // Notes / RAG (Phase 4): documents live on the server; the chat is kept here so it survives tab switches
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [notesChat, setNotesChat] = useState<ChatEntry[]>([]);
  const refreshNotes = useCallback(async () => {
    const r = await listNotes();
    if (r.ok) setNotes(r.data.docs);
  }, []);
  useEffect(() => { refreshNotes(); }, [refreshNotes]);

  // Dev panel
  const [notifications, setNotifications] = useState<any[]>([]);
  const [serverState, setServerState] = useState<any>(null);
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [lastSyncResult, setLastSyncResult] = useState<string>('');

  // Refs for timers
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBackgroundedRef = useRef(false);

  // Latest state for reading inside callbacks that must not close over stale state
  const appStateRef = useRef(appState);
  appStateRef.current = appState;

  // ── Persist state ──────────────────────────────────────────────────────────

  const setAppState = useCallback((updater: AppState | ((prev: AppState) => AppState)) => {
    setAppStateRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      storageRef.current.saveState(next);
      return next;
    });
  }, []);

  // ── Lamport clock helper ───────────────────────────────────────────────────

  const nextLamport = useCallback((state: AppState): [number, AppState] => {
    const l = state.lamport + 1;
    return [l, { ...state, lamport: l }];
  }, []);

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  // Crash/refresh recovery: restore active session if one was in progress
  useEffect(() => {
    const saved = storageRef.current.loadActiveSession();
    if (saved) {
      const wallDrift = Math.floor((Date.now() - saved.savedAt) / 1000);
      const restoredElapsed = saved.elapsedSeconds + wallDrift;
      const totalSeconds = saved.targetMinutes * 60;

      taskIdRef.current = saved.taskId ?? null;
      setFocusTaskId(saved.taskId ?? null);

      if (restoredElapsed >= totalSeconds) {
        // Session already expired while app was closed — count as completed
        storageRef.current.clearActiveSession();
        setSessionId(saved.sessionId);
        setTargetMinutes(saved.targetMinutes);
        setSessionStartTime(saved.startedAt);
        setElapsedSeconds(totalSeconds);
        addLog(`🔄 Restored crashed session — marking complete`);
        // Trigger complete after mount
        setTimeout(() => handleSessionComplete({
          id: saved.sessionId,
          targetMinutes: saved.targetMinutes,
          startedAt: saved.startedAt,
        }), 100);
      } else {
        // Resume in-progress session
        setSessionId(saved.sessionId);
        setTargetMinutes(saved.targetMinutes);
        setSessionStartTime(saved.startedAt);
        setElapsedSeconds(restoredElapsed);
        setSessionActive(true);
        addLog(`🔄 Resumed session after refresh (${restoredElapsed}s elapsed)`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasTasks = appState.tasks.length > 0;
    if (!hasTasks && isOnline) {
      bootstrapFromServer(appState).then(partial => {
        if (partial) {
          setAppState(s => ({ ...s, ...partial }));
          addLog('Bootstrapped from server');
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which AI providers does the server have keys for? (keys themselves never reach the client)
  useEffect(() => {
    fetchAiStatus().then(r => { if (r.ok) setAiStatus(r.data); });
  }, []);

  // ── Auto-sync when online ──────────────────────────────────────────────────

  useEffect(() => {
    if (isOnline) {
      // Immediate sync on coming online
      doSync();
    }
    if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    if (isOnline) {
      syncTimerRef.current = setInterval(doSync, 10000);
    }
    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ── App visibility (background detection) ─────────────────────────────────

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleVisibility = () => {
      if (document.hidden) {
        // App went to background
        if (sessionActive) {
          isBackgroundedRef.current = true;
          backgroundTimerRef.current = setTimeout(() => {
            // Grace period exceeded — fail the session
            if (isBackgroundedRef.current && sessionActive) {
              handleSessionFail('app_switch');
            }
          }, APP_SWITCH_GRACE_MS);
        }
      } else {
        // App came back to foreground
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
        }
        isBackgroundedRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [sessionActive]);

  // ── Persist active session on every tick (crash recovery) ─────────────────

  useEffect(() => {
    if (sessionActive && sessionId) {
      const snapshot: ActiveSessionState = {
        sessionId,
        targetMinutes,
        startedAt: sessionStartTime,
        elapsedSeconds,
        savedAt: Date.now(),
        taskId: taskIdRef.current ?? undefined,
      };
      storageRef.current.saveActiveSession(snapshot);
    }
  }, [elapsedSeconds, sessionActive, sessionId, targetMinutes, sessionStartTime]);

  // ── Focus timer ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (sessionActive) {
      timerRef.current = setInterval(() => {
        setElapsedSeconds(prev => {
          const next = prev + 1;
          if (next >= targetMinutes * 60) {
            // Session completed!
            clearInterval(timerRef.current!);
            handleSessionComplete();
          }
          return next;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, targetMinutes]);

  // ── Sync logic ────────────────────────────────────────────────────────────

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setSyncLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  };

  const doSync = useCallback(async () => {
    const currentState = storageRef.current.loadState(deviceId);
    addLog(`Syncing: ${currentState.pendingSessions.length} sessions, ${currentState.pendingTaskOps.length} task ops`);
    const result = await syncWithServer(currentState);

    if (result.success && result.snapshot && result.response) {
      const { snapshot, response } = result;
      setAppState(s => reconcileSync(s, snapshot, response));
      const confirmed = result.newlyConfirmedSessions.length;
      const msg = confirmed > 0
        ? `✅ Synced! ${confirmed} session(s) confirmed`
        : `✅ Synced`;
      setLastSyncResult(msg);
      addLog(msg);
      if (result.newlyConfirmedSessions.length > 0) {
        refreshNotifications();
      }
    } else {
      setLastSyncResult(`❌ Sync failed: ${result.error}`);
      addLog(`Sync failed: ${result.error}`);
    }
  }, [deviceId, setAppState]);

  const refreshNotifications = async () => {
    const notifs = await fetchNotifications();
    setNotifications(notifs);
    const srv = await fetchServerState();
    setServerState(srv);
  };

  // ── Focus Session actions ─────────────────────────────────────────────────

  const handleStartSession = (
    taskId: string | null = focusTaskId,
    minutes: number = targetMinutes,
  ) => {
    // Only link to a task that still exists
    const valid = taskId && appStateRef.current.tasks.some(t => t.id === taskId && !t.deleted) ? taskId : null;
    taskIdRef.current = valid;
    setFocusTaskId(valid);
    setTaskPickerOpen(false);
    setTargetMinutes(minutes);
    setLastCompletion(null);

    const id = uuidv4();
    setSessionId(id);
    setElapsedSeconds(0);
    setSessionStartTime(Date.now());
    setSessionActive(true);
    addLog(`Started session ${id.slice(0, 8)}… (${minutes}m${valid ? `, task ${valid}` : ''})`);
  };

  const handleSessionComplete = useCallback((override?: {
    id: string; targetMinutes: number; startedAt: number;
  }) => {
    setSessionActive(false);
    storageRef.current.clearActiveSession();

    const sid = override?.id || sessionId || uuidv4();
    const minutes = override?.targetMinutes ?? targetMinutes;
    const taskId = taskIdRef.current ?? undefined;
    const session: FocusSession = {
      id: sid,
      studentId: STUDENT_ID,
      targetMinutes: minutes,
      startedAt: override?.startedAt ?? sessionStartTime,
      status: 'completed',
      completedAt: Date.now(),
      taskId,
      synced: false,
    };

    // Summary for the "Focus completed → task progress" card
    const cur = appStateRef.current;
    const linked = taskId ? cur.tasks.find(t => t.id === taskId && !t.deleted) : undefined;
    setLastCompletion({
      taskTitle: linked ? linked.title : null,
      minutes,
      before: linked ? taskProgress(linked, cur.sessions.filter(x => x.id !== sid)) : 0,
      after: linked ? taskProgress(linked, [...cur.sessions.filter(x => x.id !== sid), session]) : 0,
      coins: 50,
    });

    setAppState(s => {
      const withRewards = applyLocalRewards(s, session);

      // Working on an untouched task makes it "in progress" (a normal Lamport-stamped task op).
      // Progress itself is derived from sessions, so nothing else needs to sync.
      let { tasks, pendingTaskOps, lamport } = s;
      const t = taskId ? s.tasks.find(x => x.id === taskId) : undefined;
      if (t && !t.deleted && t.status === 'not_started') {
        lamport = s.lamport + 1;
        const updated: Task = { ...t, status: 'in_progress', lamport, deviceId };
        tasks = s.tasks.map(x => (x.id === t.id ? updated : x));
        pendingTaskOps = [...s.pendingTaskOps, { type: 'upsert', task: updated }];
      }

      return {
        ...withRewards,
        lamport,
        tasks,
        pendingTaskOps,
        sessions: [...s.sessions.filter(x => x.id !== session.id), session],
        pendingSessions: [...s.pendingSessions.filter(x => x.id !== session.id), session],
      };
    });
    addLog(`🎉 Session completed! +50 coins${linked ? ` · ${linked.title}` : ''}`);
    if (isOnline) setTimeout(doSync, 500);
  }, [sessionId, targetMinutes, sessionStartTime, isOnline, doSync, setAppState, deviceId]);

  const handleSessionFail = useCallback((reason: FailReason) => {
    setSessionActive(false);
    storageRef.current.clearActiveSession();
    if (timerRef.current) clearInterval(timerRef.current);
    setAppState(s => {
      const session: FocusSession = {
        id: sessionId || uuidv4(),
        studentId: STUDENT_ID,
        targetMinutes,
        startedAt: sessionStartTime,
        status: 'failed',
        failReason: reason,
        taskId: taskIdRef.current ?? undefined,
        synced: false,
      };
      return {
        ...s,
        sessions: [...s.sessions.filter(x => x.id !== session.id), session],
        pendingSessions: [...s.pendingSessions.filter(x => x.id !== session.id), session],
      };
    });
    addLog(`Session failed: ${reason}`);
    if (isOnline) setTimeout(doSync, 500);
  }, [sessionId, targetMinutes, sessionStartTime, isOnline, doSync, setAppState]);

  // ── AI plan / reschedule / analysis ────────────────────────────────────────

  const tzOffset = () => new Date().getTimezoneOffset();

  const handlePlanDay = async () => {
    if (planBusy) return;
    setPlanBusy(true);
    setPlanMsg('');
    try {
      const now = Date.now();
      const tz = tzOffset();
      const cur = appStateRef.current;
      const endMs = windowEnd(now, tz);
      const avail = availableMinutes(now, endMs);
      if (avail < MIN_BLOCK_MIN) { setPlanMsg("It's too late to plan more study today."); return; }

      const profile = learnProfile(computeStats(cur.sessions, cur.tasks, cur.subjects, cur.chapters, now, tz));
        const mastery = computeMastery(cur.quizAttempts);
        const ranked = rankTasks(cur.tasks, cur.sessions, cur.chapters, cur.subjects, now, profile, mastery);
      if (ranked.length === 0) { setPlanMsg('No open tasks to plan. Add tasks in Syllabus first.'); return; }

      // Missed blocks of today's existing plan are what turns "plan" into "reschedule"
      const active = plan && isPlanFromToday(plan, now, tz) ? plan : null;
      const missed = active ? missedTaskIds(blockStatuses(active, cur.sessions, now)) : [];
      const mode = missed.length > 0 ? 'reschedule' : 'plan';
      const goalRemaining = Math.max(0, DAILY_GOAL_MIN - focusMinutesToday(cur.rewards, now));

      const res = await requestSchedule(buildScheduleRequest({
        mode, now, tz, ranked, sessions: cur.sessions, goalRemainingMin: goalRemaining,
          availableMin: avail, missed, profile, mastery,
      }));

      let items: BlockItem[];
      let source: PlanSource = 'rules';
      let model: string | undefined;
      let summary: string;
      if (res.ok) {
        items = res.data.blocks;
        source = res.data.source.provider;
        model = res.data.source.model;
        summary = res.data.summary;
      } else {
        items = ruleBasedItems(ranked, goalRemaining, avail, missed);
        summary = mode === 'reschedule' ? 'Rebuilt your plan around what is left.' : 'Plan built from your progress.';
        setPlanMsg(`${res.reason}. Used the rule-based planner instead.`);
      }

      // Time passes while waiting for the model, so lay the blocks out from "now", not from the request time
      const placedAt = Date.now();
      const blocks = layoutBlocks(items, placedAt, endMs, `p${placedAt}`);
      if (blocks.length === 0) { setPlanMsg('Nothing fits before the end of the day.'); return; }

      const next: StudyPlan = { id: `p${placedAt}`, createdAt: now, mode, source, model, summary, blocks };
      setPlan(next);
      storageRef.current.savePlan(next);
      addLog(`📅 ${mode === 'reschedule' ? 'Rescheduled' : 'Planned'} ${blocks.length} blocks via ${source}`);
    } finally {
      setPlanBusy(false);
    }
  };

  const handleAnalyze = async () => {
    if (analysisBusy) return;
    setAnalysisBusy(true);
    setAnalysisMsg('');
    try {
      const now = Date.now();
      const cur = appStateRef.current;
      const st = computeStats(cur.sessions, cur.tasks, cur.subjects, cur.chapters, now, tzOffset());
      const res = await requestAnalysis(st, ruleFindings(st).map(f => f.text));
      if (res.ok) {
        const stored: StoredAnalysis = { ...res.data, generatedAt: now, basedOnSessions: st.totalSessions };
        setAnalysis(stored);
        storageRef.current.saveAnalysis(stored);
      } else {
        setAnalysisMsg(`${res.reason}. Showing the rule-based findings.`);
      }
    } finally {
      setAnalysisBusy(false);
    }
  };

  // ── Learn: explain + quiz ──────────────────────────────────────────────────

  const effectiveScope = (): QuizScope => ({
    ...learnScope,
    subjectId: learnScope.subjectId || appStateRef.current.subjects[0]?.id || '',
  });

  const openLearn = (taskId: string | null, mode: 'explain' | 'quiz') => {
    const t = taskId ? appStateRef.current.tasks.find(x => x.id === taskId && !x.deleted) : undefined;
    setLearnScope(t ? { subjectId: t.subjectId, chapterId: t.chapterId, taskId: t.id } : effectiveScope());
    setLearnMode(mode);
    setExplainEntries([]);
    setExplainMsg('');
    setQuizMsg('');
    setFreeTopic('');
    setActiveTab('learn');
  };

  const handleExplain = async (question?: string) => {
    if (explainBusy) return;
    const cur = appStateRef.current;
    const scope = effectiveScope();
    const task = scope.taskId ? cur.tasks.find(t => t.id === scope.taskId) : undefined;
    const subject = cur.subjects.find(x => x.id === scope.subjectId)?.title ?? '';
    const chapter = cur.chapters.find(c => c.id === scope.chapterId)?.title ?? '';
    const topic = task?.title || freeTopic.trim() || chapter;
    if (!topic) { setExplainMsg('Pick a topic or type one first.'); return; }

    setExplainBusy(true);
    setExplainMsg('');
    try {
      const res = await requestExplain({ subject, chapter, topic, ...(question ? { question } : {}) });
      if (res.ok) {
        setExplainEntries(prev => (question ? [...prev, { question, data: res.data }] : [{ data: res.data }]));
      } else {
        setExplainMsg(`${res.reason}.`);
      }
    } finally {
      setExplainBusy(false);
    }
  };

  const handleGenerateQuiz = async () => {
    if (quizBusy) return;
    const cur = appStateRef.current;
    const scope = effectiveScope();
    const resolved = resolveScope(scope, cur.tasks, cur.chapters, cur.subjects);
    if (!resolved) { setQuizMsg('Nothing to quiz here yet. Add tasks in Syllabus first.'); return; }

    setQuizBusy(true);
    setQuizMsg('');
    try {
      const res = await requestQuiz({
        subject: resolved.subjectTitle, chapter: resolved.chapterTitle, difficulty,
        count: resolved.count, topics: resolved.topics,
      });
      if (!res.ok) { setQuizMsg(`${res.reason}.`); return; }
      const quiz: ActiveQuiz = {
        id: uuidv4(), scope, label: resolved.label, difficulty,
        questions: res.data.questions, answers: res.data.questions.map(() => null),
        startedAt: Date.now(), provider: res.data.source.provider, model: res.data.source.model,
      };
      setActiveQuiz(quiz);
      setQuizStep(0);
      storageRef.current.saveQuiz(quiz);
    } finally {
      setQuizBusy(false);
    }
  };

  const handleAnswer = (index: number, option: number) => {
    const quiz = activeQuiz;
    if (!quiz || quiz.answers[index] !== null) return; // an answer is final
    const next: ActiveQuiz = { ...quiz, answers: quiz.answers.map((a, i) => (i === index ? option : a)) };
    setActiveQuiz(next);
    storageRef.current.saveQuiz(next);

    // The attempt is recorded the moment the last question is answered (immutable, deduped by id)
    const attempt = buildAttempt(next, STUDENT_ID, Date.now());
    if (attempt) {
      setAppState(s => ({
        ...s,
        quizAttempts: [...s.quizAttempts.filter(a => a.id !== attempt.id), attempt],
        pendingQuizAttempts: [...s.pendingQuizAttempts.filter(a => a.id !== attempt.id), attempt],
      }));
      const score = scoreQuiz(next);
      addLog(`🧠 Quiz finished: ${score.correct}/${score.total} (${next.label})`);
      if (isOnline) setTimeout(doSync, 500);
    }
  };

  // A quiz written from the student's notes plays and records exactly like any other quiz
  const handleNotesQuizReady = (quiz: ActiveQuiz) => {
    setActiveQuiz(quiz);
    setQuizStep(0);
    storageRef.current.saveQuiz(quiz);
  };

  const handleCloseQuiz = () => {
    setActiveQuiz(null);
    setQuizStep(0);
    storageRef.current.saveQuiz(null);
  };

  const sourceLabel = (s: PlanSource) => (s === 'gemini' ? 'Gemini' : s === 'groq' ? 'Groq' : 'Rule-based');
  const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ── Task actions ──────────────────────────────────────────────────────────

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    setAppState(s => {
      const [lamport, newS] = nextLamport(s);
      const existing = s.tasks.find(t => t.id === taskId);
      if (!existing) return s;

      const updated: Task = { ...existing, status, lamport, deviceId };
      const op: TaskOp = { type: 'upsert', task: updated };

      return {
        ...newS,
        tasks: s.tasks.map(t => t.id === taskId ? updated : t),
        pendingTaskOps: [...s.pendingTaskOps, op],
      };
    });
    if (isOnline) setTimeout(doSync, 1000);
  };

  const deleteTask = (taskId: string) => {
    setAppState(s => {
      const [lamport, newS] = nextLamport(s);
      const existing = s.tasks.find(t => t.id === taskId);
      if (!existing) return s;

      const deleted: Task = {
        ...existing,
        deleted: true,
        deletedBy: deviceId,
        deletedLamport: lamport,
        lamport,
        deviceId,
      };
      const op: TaskOp = { type: 'delete', task: deleted };

      return {
        ...newS,
        tasks: s.tasks.map(t => t.id === taskId ? deleted : t),
        pendingTaskOps: [...s.pendingTaskOps, op],
      };
    });
    if (isOnline) setTimeout(doSync, 1000);
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const progressColor = (p: number) => {
    if (p >= 0.8) return COLORS.success;
    if (p >= 0.4) return COLORS.warn;
    return COLORS.accentLight;
  };

  const statusCycle: TaskStatus[] = ['not_started', 'in_progress', 'done'];
  const statusLabel: Record<TaskStatus, string> = {
    not_started: 'Not Started',
    in_progress: 'In Progress',
    done: '✓ Done',
  };
  const statusColor: Record<TaskStatus, string> = {
    not_started: COLORS.textMuted,
    in_progress: COLORS.warn,
    done: COLORS.success,
  };

  const cycleStatus = (current: TaskStatus): TaskStatus => {
    const idx = statusCycle.indexOf(current);
    return statusCycle[(idx + 1) % statusCycle.length];
  };

  // ── Progress bar ──────────────────────────────────────────────────────────

  const ProgressBar = ({ value }: { value: number }) => (
    <View style={styles.progressBg}>
      <View style={[styles.progressFill, { width: `${Math.round(value * 100)}%` as any, backgroundColor: progressColor(value) }]} />
    </View>
  );

  // ── Home Tab ──────────────────────────────────────────────────────────────

  const renderHomeTab = () => {
    const nowMs = Date.now();
    const profile = learnProfile(computeStats(appState.sessions, appState.tasks, appState.subjects, appState.chapters, nowMs, tzOffset()));
    const ranked = rankTasks(appState.tasks, appState.sessions, appState.chapters, appState.subjects, nowMs, profile, computeMastery(appState.quizAttempts));
    const rec = ranked[0];
    const todayMin = focusMinutesToday(appState.rewards, nowMs);
    const streakInfo = effectiveStreak(appState.rewards, nowMs);
    const today = sessionsToday(appState.sessions, nowMs);
    const dailyGoalPct = Math.min(1, todayMin / DAILY_GOAL_MIN);
    const suggestion = buildTodayPlan(ranked, DAILY_GOAL_MIN, todayMin);
    const plan_fallback = () => (
      <>
        {suggestion.length === 0 && (
          <Text style={styles.emptyText}>
            {todayMin >= DAILY_GOAL_MIN ? 'Daily goal reached. Anything more is a bonus.' : 'Nothing left to plan.'}
          </Text>
        )}
        {suggestion.map((b, i) => (
          <TouchableOpacity
            key={b.task.id}
            style={homeStyles.planRow}
            disabled={sessionActive}
            onPress={() => { handleStartSession(b.task.id, b.minutes); setActiveTab('focus'); }}
          >
            <Text style={homeStyles.planIndex}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={homeStyles.planTitle}>{b.task.title}</Text>
              <Text style={homeStyles.planMeta}>{b.subjectTitle}</Text>
            </View>
            <Text style={homeStyles.planMin}>{b.minutes}m</Text>
          </TouchableOpacity>
        ))}
      </>
    );

    return (
      <ScrollView style={styles.tabContent}>
        {/* Focus just completed → what changed */}
        {lastCompletion && (
          <View style={[styles.card, { borderColor: COLORS.success }]}>
            <Text style={styles.cardTitle}>✅ Focus completed · {lastCompletion.minutes}m</Text>
            {lastCompletion.taskTitle ? (
              <Text style={homeStyles.flowLine}>
                {lastCompletion.taskTitle}: {pct(lastCompletion.before)} → {pct(lastCompletion.after)}
              </Text>
            ) : (
              <Text style={homeStyles.flowLine}>Free focus, not linked to a task</Text>
            )}
            <Text style={homeStyles.flowLine}>Today: {todayMin}m focused · +{lastCompletion.coins} coins</Text>
            <TouchableOpacity onPress={() => setLastCompletion(null)}>
              <Text style={homeStyles.dismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* What should I study right now? */}
        <View style={[styles.card, homeStyles.recommendCard]}>
          <View style={homeStyles.recHeader}>
            <Text style={homeStyles.eyebrow}>{sessionActive ? 'CURRENT SESSION' : 'YOUR NEXT STUDY STEP'}</Text>
            <View style={homeStyles.recMark}><Text style={homeStyles.recMarkText}>✦</Text></View>
          </View>

          {sessionActive ? (
            <>
              <Text style={homeStyles.recTitle}>Session in progress</Text>
              <Text style={homeStyles.recMeta}>
                {fmtTime(Math.max(0, targetMinutes * 60 - elapsedSeconds))} remaining
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setActiveTab('focus')}>
                <Text style={styles.primaryBtnText}>Go to timer</Text>
              </TouchableOpacity>
            </>
          ) : rec ? (
            <>
              <Text style={homeStyles.recTitle}>{rec.task.title}</Text>
              <Text style={homeStyles.recMeta}>{rec.subjectTitle} · {rec.chapterTitle}</Text>
              <Text style={homeStyles.recReason}>✦  {rec.reason}</Text>
              <Text style={homeStyles.recProgress}>{pct(rec.progress)} complete</Text>
              <ProgressBar value={rec.progress} />
              <TouchableOpacity
                style={[styles.primaryBtn, { marginTop: 14 }]}
                accessibilityRole="button"
                accessibilityLabel={`Start a ${rec.suggestedMinutes} minute focus session for ${rec.task.title}`}
                onPress={() => { handleStartSession(rec.task.id, rec.suggestedMinutes); setActiveTab('focus'); }}
              >
                <Text style={styles.primaryBtnText}>▶ Start {rec.suggestedMinutes} min Focus</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={homeStyles.recMeta}>
                {appState.tasks.some(t => !t.deleted)
                  ? 'Every task is done. Nice work.'
                  : 'No tasks yet. Add some in Syllabus, or start a free focus session.'}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => { handleStartSession(null, 25); setActiveTab('focus'); }}>
                <Text style={styles.primaryBtnText}>▶ Start 25 min Focus</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Weak topic: revise before moving on */}
        {(() => {
          const adv = revisionAdvice({
            mastery: computeMastery(appState.quizAttempts), tasks: appState.tasks, chapters: appState.chapters, next: rec?.task,
          });
          if (!adv) return null;
          return (
            <View style={[styles.card, homeStyles.revisionCard]}>
              <Text style={styles.cardTitle}>📌 Revise first</Text>
              <Text style={homeStyles.flowLine}>{adv.message}</Text>
              <View style={homeStyles.btnRow}>
                <TouchableOpacity
                  style={[styles.secondaryBtn, { flex: 1 }]}
                  disabled={sessionActive}
                  onPress={() => { handleStartSession(adv.task.id, 25); setActiveTab('focus'); }}
                >
                  <Text style={styles.secondaryBtnText}>Revise 25 min</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => openLearn(adv.task.id, 'quiz')}>
                  <Text style={styles.secondaryBtnText}>Quiz me</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })()}

        {/* Today's progress */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Today's progress</Text>
          <View style={homeStyles.statRow}>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{todayMin}m</Text>
              <Text style={styles.rewardLabel}>⏱ Focus time</Text>
            </View>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{streakInfo.days}</Text>
              <Text style={styles.rewardLabel}>🔥 Day streak</Text>
            </View>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{today.completed}</Text>
              <Text style={styles.rewardLabel}>✅ Sessions</Text>
            </View>
          </View>
          <Text style={homeStyles.goalLabel}>Daily goal: {Math.min(todayMin, DAILY_GOAL_MIN)} / {DAILY_GOAL_MIN} min</Text>
          <ProgressBar value={dailyGoalPct} />
          {streakInfo.atRisk && (
            <Text style={homeStyles.warn}>Your {streakInfo.days}-day streak ends tonight unless you finish a session today.</Text>
          )}
        </View>

        {/* This week: goal, streak, next achievement */}
        {(() => {
          const tz = tzOffset();
          const hist = weeklyHistory(appState.sessions, nowMs, tz);
          const week = hist[hist.length - 1];
          const suggestion = suggestWeeklyGoal(hist);
          const gp = weeklyGoal ? goalProgress(week.sessions, weeklyGoal, nowMs, tz) : null;
          const ach = computeAchievements({
            sessions: appState.sessions, attempts: appState.quizAttempts, currentStreak: streakInfo.days,
            weekSessions: week.sessions, weekMinutes: week.minutes, weeklyGoal, tz,
            subjectMasteryPcts: appState.subjects
              .map(sub => subjectMastery(computeMastery(appState.quizAttempts), appState.tasks, sub.id)?.pct)
              .filter((x): x is number => x !== undefined),
          });
          const upcoming = nextUp(ach, 1)[0];
          return (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>This week</Text>
              {gp ? (
                <>
                  <Text style={homeStyles.goalLabel}>🏆 Weekly goal: {gp.done} / {gp.target} sessions</Text>
                  <ProgressBar value={gp.pct / 100} />
                  <Text style={homeStyles.hint}>
                    {gp.met ? '🎉 Goal reached. Anything more is a bonus.' : `${gp.remaining} to go · ${gp.daysLeft} day${gp.daysLeft === 1 ? '' : 's'} left this week`}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={homeStyles.flowLine}>No weekly goal yet. Suggested: {suggestion.target} sessions.</Text>
                  <Text style={homeStyles.hint}>{suggestion.explanation}</Text>
                  <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 10 }]} onPress={() => updateGoal(suggestion.target)}>
                    <Text style={styles.secondaryBtnText}>Set goal to {suggestion.target}</Text>
                  </TouchableOpacity>
                </>
              )}
              <Text style={[homeStyles.flowLine, { marginTop: 12 }]}>
                🔥 {streakInfo.days}-day streak · ⏱ {fmtDuration(week.minutes)} focused this week
              </Text>
              {upcoming && (
                <Text style={homeStyles.hint}>⭐ Next: {upcoming.title} ({upcoming.id.startsWith('hours') ? `${fmtDuration(upcoming.current)} of ${fmtDuration(upcoming.target)}` : `${upcoming.current} / ${upcoming.target}`})</Text>
              )}
            </View>
          );
        })()}

        {/* Today's plan: AI-scheduled when a plan exists, otherwise the unscheduled suggestion */}
        {(() => {
          const tz = tzOffset();
          const activePlan = plan && isPlanFromToday(plan, nowMs, tz) ? plan : null;
          const statuses = activePlan ? blockStatuses(activePlan, appState.sessions, nowMs) : [];
          const missedCount = missedTaskIds(statuses).length;
          const statusIcon: Record<BlockStatus, string> = { done: '✓', missed: '✕', now: '▶', upcoming: '·' };
          const statusTint: Record<BlockStatus, string> = {
            done: COLORS.success, missed: COLORS.danger, now: COLORS.warn, upcoming: COLORS.textMuted,
          };
          const aiReady = aiStatus?.anyConfigured;

          return (
            <View style={styles.card}>
              <View style={homeStyles.planHeader}>
                <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Today's plan</Text>
                {activePlan && <Text style={homeStyles.badge}>{sourceLabel(activePlan.source)}</Text>}
              </View>

              {activePlan ? (
                <>
                  {!!activePlan.summary && <Text style={homeStyles.planSummary}>{activePlan.summary}</Text>}
                  {statuses.map(({ block, status }) => {
                    const t = appState.tasks.find(x => x.id === block.taskId);
                    const subj = appState.subjects.find(x => x.id === t?.subjectId)?.title ?? '';
                    return (
                      <TouchableOpacity
                        key={block.id}
                        style={homeStyles.planRow}
                        disabled={sessionActive || status === 'done'}
                        onPress={() => { handleStartSession(block.taskId, block.minutes); setActiveTab('focus'); }}
                      >
                        <Text style={[homeStyles.planIndex, { color: statusTint[status] }]}>{statusIcon[status]}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={[homeStyles.planTitle, status === 'done' && { textDecorationLine: 'line-through', color: COLORS.textMuted }]}>
                            {t?.title ?? 'Task removed'}
                          </Text>
                          <Text style={homeStyles.planMeta}>
                            {fmtClock(block.startAt)} · {subj}{block.reason ? ` · ${block.reason}` : ''}
                          </Text>
                        </View>
                        <Text style={homeStyles.planMin}>{block.minutes}m</Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              ) : plan_fallback()}

              <TouchableOpacity
                style={[missedCount > 0 ? styles.primaryBtn : styles.secondaryBtn, { marginTop: 12 }]}
                onPress={handlePlanDay}
                disabled={planBusy || sessionActive}
              >
                <Text style={missedCount > 0 ? styles.primaryBtnText : styles.secondaryBtnText}>
                  {planBusy
                    ? 'Thinking…'
                    : missedCount > 0
                      ? `Reschedule ${missedCount} missed with AI`
                      : activePlan ? 'Re-plan with AI' : 'Plan my day with AI'}
                </Text>
              </TouchableOpacity>
              {aiStatus && !aiReady && (
                <Text style={homeStyles.hint}>No AI key set on the server yet, so this uses the rule-based planner.</Text>
              )}
              {!!planMsg && <Text style={homeStyles.warn}>{planMsg}</Text>}
            </View>
          );
        })()}
      </ScrollView>
    );
  };

  // ── Focus Tab ─────────────────────────────────────────────────────────────

  const renderFocusTab = () => {
    const remaining = targetMinutes * 60 - elapsedSeconds;
    const progress = sessionActive ? elapsedSeconds / (targetMinutes * 60) : 0;
    const recentSessions = [...appState.sessions].reverse().slice(0, 5);
    const nowMs = Date.now();
    const profile = learnProfile(computeStats(appState.sessions, appState.tasks, appState.subjects, appState.chapters, nowMs, tzOffset()));
      const ranked = rankTasks(appState.tasks, appState.sessions, appState.chapters, appState.subjects, nowMs, profile, computeMastery(appState.quizAttempts));
    const focusTask = appState.tasks.find(t => t.id === focusTaskId && !t.deleted);
    const streakInfo = effectiveStreak(appState.rewards, nowMs);

    return (
      <ScrollView style={styles.tabContent}>
        {/* Rewards banner */}
        <View style={styles.rewardsBanner}>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{streakInfo.days}</Text>
            <Text style={styles.rewardLabel}>🔥 Day Streak</Text>
          </View>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{appState.rewards.coins}</Text>
            <Text style={styles.rewardLabel}>🪙 Coins</Text>
          </View>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{focusMinutesToday(appState.rewards, nowMs)}m</Text>
            <Text style={styles.rewardLabel}>⏱ Today</Text>
          </View>
        </View>

        {/* Timer card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Focus Session</Text>

          {!sessionActive ? (
            <>
              <Text style={styles.label}>Studying</Text>
              <TouchableOpacity style={homeStyles.pickerBtn} onPress={() => setTaskPickerOpen(o => !o)}>
                <View style={{ flex: 1 }}>
                  <Text style={homeStyles.pickerTitle}>{focusTask ? focusTask.title : 'Free focus (no task)'}</Text>
                  {focusTask && (
                    <Text style={homeStyles.pickerSub}>
                      {pct(taskProgress(focusTask, appState.sessions))} complete
                    </Text>
                  )}
                </View>
                <Text style={homeStyles.pickerChange}>{taskPickerOpen ? 'Close ▴' : 'Change ▾'}</Text>
              </TouchableOpacity>
              {taskPickerOpen && (
                <View style={homeStyles.pickerList}>
                  <TouchableOpacity style={homeStyles.pickerItem} onPress={() => { setFocusTaskId(null); setTaskPickerOpen(false); }}>
                    <Text style={homeStyles.pickerItemText}>Free focus (no task)</Text>
                  </TouchableOpacity>
                  {ranked.slice(0, 8).map(r => (
                    <TouchableOpacity
                      key={r.task.id}
                      style={homeStyles.pickerItem}
                      onPress={() => { setFocusTaskId(r.task.id); setTaskPickerOpen(false); }}
                    >
                      <Text style={homeStyles.pickerItemText}>{r.task.title}</Text>
                      <Text style={homeStyles.pickerItemMeta}>{r.subjectTitle} · {pct(r.progress)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <Text style={styles.label}>Target duration (minutes)</Text>
              <View style={styles.durationRow}>
                {[15, 25, 45, 60, 90].map(m => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setTargetMinutes(m)}
                    style={[styles.durationBtn, targetMinutes === m && styles.durationBtnActive]}
                  >
                    <Text style={[styles.durationBtnText, targetMinutes === m && styles.durationBtnTextActive]}>
                      {m}m
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => handleStartSession()}>
                <Text style={styles.primaryBtnText}>▶ Start Session</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {focusTask && <Text style={homeStyles.pickerSub}>Studying: {focusTask.title}</Text>}
              <Text style={styles.timerDisplay}>{fmtTime(remaining)}</Text>
              <Text style={styles.timerSub}>remaining of {targetMinutes}m</Text>
              <ProgressBar value={progress} />
              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={() => handleSessionFail('give_up')}
              >
                <Text style={styles.dangerBtnText}>Give Up</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Recent sessions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Sessions</Text>
          {recentSessions.length === 0 && (
            <Text style={styles.emptyText}>No sessions yet — start one above!</Text>
          )}
          {recentSessions.map(s => (
            <View key={s.id} style={styles.sessionRow}>
              <View style={[styles.sessionDot, { backgroundColor: s.status === 'completed' ? COLORS.success : COLORS.danger }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.sessionLabel}>
                  {s.targetMinutes}m · {s.status === 'completed' ? 'Completed' : `Failed (${s.failReason})`}
                  {s.taskId ? ` · ${appState.tasks.find(t => t.id === s.taskId)?.title ?? 'task'}` : ''}
                </Text>
                <Text style={styles.sessionMeta}>
                  {new Date(s.startedAt).toLocaleString()} {s.synced ? '✓ synced' : '⏳ pending sync'}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  // ── Syllabus Tab ──────────────────────────────────────────────────────────

  const renderSyllabusTab = () => {
    return (
      <ScrollView style={styles.tabContent}>
        {appState.subjects.map(subject => {
          const subProgress = subjectProgress(appState.tasks, appState.sessions, subject.id, appState.chapters);
          const subChapters = appState.chapters.filter(c => c.subjectId === subject.id);

          return (
            <View key={subject.id} style={styles.card}>
              <View style={styles.subjectHeader}>
                <Text style={styles.cardTitle}>{subject.title}</Text>
                <Text style={[styles.pctLabel, { color: progressColor(subProgress) }]}>{pct(subProgress)}</Text>
              </View>
              <ProgressBar value={subProgress} />

              {subChapters.map(chapter => {
                const chProgress = chapterProgress(appState.tasks, appState.sessions, chapter.id);
                const chapterTasks = appState.tasks.filter(
                  t => t.chapterId === chapter.id && !t.deleted
                );

                return (
                  <View key={chapter.id} style={styles.chapterBlock}>
                    <View style={styles.chapterHeader}>
                      <Text style={styles.chapterTitle}>{chapter.title}</Text>
                      <Text style={[styles.pctLabel, { color: progressColor(chProgress), fontSize: 12 }]}>
                        {pct(chProgress)}
                      </Text>
                    </View>
                    <ProgressBar value={chProgress} />

                    {chapterTasks.map(task => (
                      <View key={task.id} style={styles.taskRow}>
                        <TouchableOpacity
                          style={[styles.taskStatus, { borderColor: statusColor[task.status] }]}
                          onPress={() => updateTaskStatus(task.id, cycleStatus(task.status))}
                        >
                          <Text style={[styles.taskStatusText, { color: statusColor[task.status] }]}>
                            {statusLabel[task.status]}
                          </Text>
                        </TouchableOpacity>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.taskTitle}>{task.title}</Text>
                          <Text style={homeStyles.pickerSub}>
                            {pct(taskProgress(task, appState.sessions))} · {taskFocusMinutes(appState.sessions, task.id)}/{taskEstimate(task)}m focused
                          </Text>
                        </View>
                        {task.status !== 'done' && !sessionActive && (
                          <TouchableOpacity
                            style={homeStyles.miniFocusBtn}
                            onPress={() => { handleStartSession(task.id, 25); setActiveTab('focus'); }}
                          >
                            <Text style={homeStyles.miniFocusText}>▶ 25m</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          style={styles.deleteBtn}
                          onPress={() => deleteTask(task.id)}
                        >
                          <Text style={styles.deleteBtnText}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    ))}

                    {chapterTasks.length === 0 && (
                      <Text style={styles.emptyText}>All tasks removed</Text>
                    )}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    );
  };

  // ── Learn Tab ─────────────────────────────────────────────────────────────

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <TouchableOpacity key={key} style={[homeStyles.chip, active && homeStyles.chipActive]} onPress={onPress}>
      <Text style={[homeStyles.chipText, active && homeStyles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );

  const renderLearnTab = () => {
    const scope = effectiveScope();
    const chaptersOf = appState.chapters.filter(c => c.subjectId === scope.subjectId);
    const topicsOf = appState.tasks.filter(t => !t.deleted && !!scope.chapterId && t.chapterId === scope.chapterId);
    const noAiKey = !!aiStatus && !aiStatus.anyConfigured;

    // ── a quiz is in progress (or just finished) ──
    if (activeQuiz) {
      const n = activeQuiz.questions.length;
      const taskTitle = (id: string) => topicTitle(id, appState.tasks, notes);

      if (quizStep >= n) {
        const score = scoreQuiz(activeQuiz);
        const wrong = activeQuiz.questions.map((q, i) => ({ q, i })).filter(({ q, i }) => activeQuiz.answers[i] !== q.correctIndex);
        return (
          <ScrollView style={styles.tabContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Quiz results · {activeQuiz.label}</Text>
              <Text style={homeStyles.score}>{score.correct} / {score.total}</Text>
              {score.byTopic.map(t => (
                <Text key={t.taskId} style={homeStyles.flowLine}>
                  {t.correct === t.total ? '🟢' : t.correct === 0 ? '🔴' : '🟡'} {taskTitle(t.taskId)}: {t.correct}/{t.total}
                </Text>
              ))}
              <Text style={homeStyles.hint}>Saved. See Insights for how this changes your topic mastery.</Text>
            </View>

            {wrong.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Review what you missed</Text>
                {wrong.map(({ q, i }) => (
                  <View key={i} style={homeStyles.reviewItem}>
                    <Text style={homeStyles.planTitle}>{q.question}</Text>
                    <Text style={[homeStyles.flowLine, { color: COLORS.success }]}>Correct: {q.options[q.correctIndex]}</Text>
                    {!!q.explanation && <Text style={homeStyles.planMeta}>{q.explanation}</Text>}
                    {!!q.evidence && (
                      <Text style={homeStyles.hint}>From your notes{q.source?.page ? ` (p.${q.source.page})` : ''}: “{q.evidence}”</Text>
                    )}
                  </View>
                ))}
              </View>
            )}

            <View style={homeStyles.btnRow}>
              <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={() => { handleCloseQuiz(); handleGenerateQuiz(); }}>
                <Text style={styles.primaryBtnText}>New quiz</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={handleCloseQuiz}>
                <Text style={styles.secondaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );
      }

      const q = activeQuiz.questions[quizStep];
      const picked = activeQuiz.answers[quizStep];
      return (
        <ScrollView style={styles.tabContent}>
          <View style={styles.card}>
            <View style={homeStyles.planHeader}>
              <Text style={homeStyles.planMeta}>{activeQuiz.label} · {activeQuiz.difficulty}</Text>
              <Text style={homeStyles.badge}>{quizStep + 1} / {n}</Text>
            </View>
            <Text style={homeStyles.question2}>{q.question}</Text>
            {q.options.map((opt, oi) => {
              const answered = picked !== null;
              const isRight = answered && oi === q.correctIndex;
              const isWrongPick = answered && oi === picked && oi !== q.correctIndex;
              return (
                <TouchableOpacity
                  key={oi}
                  disabled={answered}
                  style={[homeStyles.option, isRight && homeStyles.optionRight, isWrongPick && homeStyles.optionWrong]}
                  onPress={() => handleAnswer(quizStep, oi)}
                >
                  <Text style={homeStyles.optionText}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
            {picked !== null && (
              <>
                <Text style={[homeStyles.flowLine, { marginTop: 10, color: picked === q.correctIndex ? COLORS.success : COLORS.danger }]}>
                  {picked === q.correctIndex ? 'Correct' : 'Not quite'} · {taskTitle(q.taskId)}
                </Text>
                {!!q.explanation && <Text style={homeStyles.planMeta}>{q.explanation}</Text>}
                    {!!q.evidence && (
                      <Text style={homeStyles.hint}>From your notes{q.source?.page ? ` (p.${q.source.page})` : ''}: “{q.evidence}”</Text>
                    )}
                <TouchableOpacity style={[styles.primaryBtn, { marginTop: 12 }]} onPress={() => setQuizStep(quizStep + 1)}>
                  <Text style={styles.primaryBtnText}>{quizStep + 1 < n ? 'Next' : 'See results'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
          <Text style={homeStyles.hint}>AI-generated question. If an answer looks wrong, check your textbook.</Text>
          <TouchableOpacity onPress={handleCloseQuiz}>
            <Text style={homeStyles.dismiss}>Abandon quiz (not saved)</Text>
          </TouchableOpacity>
        </ScrollView>
      );
    }

    // ── scope + mode ──
    return (
      <ScrollView style={styles.tabContent} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <View style={homeStyles.chipRow}>
            {chip('m-explain', '💡 Explain', learnMode === 'explain', () => setLearnMode('explain'))}
            {chip('m-quiz', '📝 Quiz', learnMode === 'quiz', () => setLearnMode('quiz'))}
            {chip('m-notes', '📄 My notes', learnMode === 'notes', () => { setLearnMode('notes'); refreshNotes(); })}
          </View>

          {learnMode !== 'notes' && (<>
          <Text style={styles.label}>Subject</Text>
          <View style={homeStyles.chipRow}>
            {appState.subjects.map(sub =>
              chip(sub.id, sub.title, scope.subjectId === sub.id, () => setLearnScope({ subjectId: sub.id })))}
          </View>

          {chaptersOf.length > 0 && (
            <>
              <Text style={styles.label}>Chapter</Text>
              <View style={homeStyles.chipRow}>
                {chip('c-all', 'All', !scope.chapterId, () => setLearnScope({ subjectId: scope.subjectId }))}
                {chaptersOf.map(c =>
                  chip(c.id, c.title, scope.chapterId === c.id, () => setLearnScope({ subjectId: scope.subjectId, chapterId: c.id })))}
              </View>
            </>
          )}

          {!!scope.chapterId && (
            <>
              <Text style={styles.label}>Topic</Text>
              <View style={homeStyles.chipRow}>
                {chip('t-all', 'Whole chapter', !scope.taskId, () => setLearnScope({ subjectId: scope.subjectId, chapterId: scope.chapterId }))}
                {topicsOf.map(t =>
                  chip(t.id, t.title, scope.taskId === t.id, () => setLearnScope({ subjectId: scope.subjectId, chapterId: scope.chapterId, taskId: t.id })))}
              </View>
            </>
          )}

          {learnMode === 'explain' ? (
            <>
              {!scope.taskId && (
                <>
                  <Text style={styles.label}>Or type any topic</Text>
                  <TextInput
                    style={homeStyles.input}
                    value={freeTopic}
                    onChangeText={setFreeTopic}
                    placeholder="e.g. conservation of momentum"
                    placeholderTextColor={COLORS.textMuted}
                    maxLength={100}
                  />
                </>
              )}
              <TouchableOpacity style={[styles.primaryBtn, { marginTop: 14 }]} onPress={() => handleExplain()} disabled={explainBusy}>
                <Text style={styles.primaryBtnText}>{explainBusy ? 'Thinking…' : 'Explain it simply'}</Text>
              </TouchableOpacity>
              {!!explainMsg && <Text style={homeStyles.warn}>{explainMsg}</Text>}
            </>
          ) : (
            <>
              <Text style={styles.label}>Difficulty</Text>
              <View style={homeStyles.chipRow}>
                {(['easy', 'medium', 'hard'] as const).map(d => chip(d, d[0].toUpperCase() + d.slice(1), difficulty === d, () => setDifficulty(d)))}
              </View>
              <TouchableOpacity style={[styles.primaryBtn, { marginTop: 14 }]} onPress={handleGenerateQuiz} disabled={quizBusy}>
                <Text style={styles.primaryBtnText}>{quizBusy ? 'Writing questions…' : 'Generate quiz'}</Text>
              </TouchableOpacity>
              {!!quizMsg && <Text style={homeStyles.warn}>{quizMsg}</Text>}
            </>
          )}
          {noAiKey && <Text style={homeStyles.hint}>No AI key is set on the server yet. Explanations and quizzes need one (backend/.env).</Text>}
          </>)}
        </View>

        {learnMode === 'notes' && (
          <NotesPanel
            notes={notes}
            onNotesChanged={refreshNotes}
            subjects={appState.subjects}
            tasks={appState.tasks}
            sessions={appState.sessions}
            mastery={computeMastery(appState.quizAttempts)}
            noAiKey={noAiKey}
            semantic={!!aiStatus?.embeddings?.configured}
            defaultSubjectId={scope.subjectId}
            chat={notesChat}
            setChat={setNotesChat}
            onQuizReady={handleNotesQuizReady}
          />
        )}

        {learnMode === 'explain' && explainEntries.map((e, i) => (
          <View key={i} style={styles.card}>
            {!!e.question && <Text style={homeStyles.recReason}>{e.question}</Text>}
            <Text style={homeStyles.finding}>{e.data.explanation}</Text>
            {e.data.examples.map((ex, j) => (
              <Text key={j} style={homeStyles.exampleBox}>Example {j + 1}: {ex}</Text>
            ))}
            {i === explainEntries.length - 1 && e.data.followUps.length > 0 && (
              <>
                <Text style={[styles.label, { marginTop: 8 }]}>Ask a follow-up</Text>
                <View style={homeStyles.chipRow}>
                  {e.data.followUps.map((f, j) => chip(`f${j}`, f, false, () => handleExplain(f)))}
                </View>
              </>
            )}
            <Text style={homeStyles.hint}>AI-generated. Double-check important facts against your textbook. · {sourceLabel(e.data.source.provider)}</Text>
          </View>
        ))}
      </ScrollView>
    );
  };

  // ── Insights Tab ──────────────────────────────────────────────────────────

  // ── Progress view: analytics, weekly goal, achievements ─────────────────────

  const renderProgressView = () => {
    const nowMs = Date.now();
    const tz = tzOffset();
    const cur = periodStats(appState.sessions, appState.tasks, appState.subjects, appState.chapters, nowMs, tz, period);
    const prev = periodStats(appState.sessions, appState.tasks, appState.subjects, appState.chapters, nowMs, tz, period, 1);
    const mastery = computeMastery(appState.quizAttempts);
    const streakNow = effectiveStreak(appState.rewards, nowMs);
    const hist = weeklyHistory(appState.sessions, nowMs, tz);
    const week = hist[hist.length - 1];
    const suggestion = suggestWeeklyGoal(hist);
    const gp = weeklyGoal ? goalProgress(week.sessions, weeklyGoal, nowMs, tz) : null;
    const masteryPcts = appState.subjects
      .map(sub => subjectMastery(mastery, appState.tasks, sub.id)?.pct)
      .filter((x): x is number => x !== undefined);
    const achievements = computeAchievements({
      sessions: appState.sessions, attempts: appState.quizAttempts, currentStreak: streakNow.days,
      weekSessions: week.sessions, weekMinutes: week.minutes, weeklyGoal, subjectMasteryPcts: masteryPcts, tz,
    });
    const unlocked = achievements.filter(a => a.unlocked);
    const upcoming = nextUp(achievements, 3);
    const maxSubject = Math.max(1, ...cur.subjects.map(x => x.minutes));
    const longest = Math.max(streakNow.days, longestStreak(appState.sessions, tz));
    const range = period === 'week' ? 'last 7 days' : 'last 30 days';
    const compare = (c: number, p: number) => deltaLabel(c, p);

    return (
      <>
        <View style={styles.card}>
          <View style={homeStyles.planHeader}>
            <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Study analytics</Text>
            <View style={[homeStyles.chipRow, { marginBottom: 0 }]}>
              {chip('p-week', 'Week', period === 'week', () => setPeriod('week'))}
              {chip('p-month', 'Month', period === 'month', () => setPeriod('month'))}
            </View>
          </View>
          <Text style={homeStyles.hint}>{range[0].toUpperCase() + range.slice(1)}. Small figures show the change from the {period === 'week' ? '7' : '30'} days before.</Text>

          {cur.sessions + cur.endedEarly === 0 ? (
            <Text style={[homeStyles.finding, { marginTop: 12 }]}>Nothing in the {range} yet. Finish a focus session and it will show up here.</Text>
          ) : (
            <>
              <View style={[homeStyles.statRow, { marginTop: 14 }]}>
                <View style={styles.rewardItem}>
                  <Text style={styles.rewardValue}>{fmtDuration(cur.focusMinutes)}</Text>
                  <Text style={styles.rewardLabel}>Focus time</Text>
                  <Text style={homeStyles.delta}>{compare(cur.focusMinutes, prev.focusMinutes)}</Text>
                </View>
                <View style={styles.rewardItem}>
                  <Text style={styles.rewardValue}>{cur.sessions}</Text>
                  <Text style={styles.rewardLabel}>Sessions</Text>
                  <Text style={homeStyles.delta}>{compare(cur.sessions, prev.sessions)}</Text>
                </View>
                <View style={styles.rewardItem}>
                  <Text style={styles.rewardValue}>{cur.completionPct === null ? '–' : `${cur.completionPct}%`}</Text>
                  <Text style={styles.rewardLabel}>Completed</Text>
                  <Text style={homeStyles.delta}>{prev.completionPct === null ? 'no earlier data' : `before: ${prev.completionPct}%`}</Text>
                </View>
              </View>
              <BarChart data={cur.buckets.map(b => ({ label: b.label, value: b.minutes }))} />
              <Text style={homeStyles.hint}>
                Focus minutes per {period === 'week' ? 'day' : '5 days'} · active {cur.activeDays} of {cur.buckets.length * (period === 'week' ? 1 : 5)} days
                · streak {streakNow.days} (best {longest})
              </Text>
              <Text style={[homeStyles.finding, { marginTop: 10 }]}>
                {cur.mostProductive
                  ? `⏰ Most focus time: ${cur.mostProductive.label} (${fmtDuration(cur.mostProductive.minutes)}, ${cur.mostProductive.sharePct}% of the total)`
                  : '⏰ Most productive time needs 3 or more sessions in this period.'}
              </Text>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>By subject · {range}</Text>
          {cur.subjects.map(sub => {
            const sm = subjectMastery(mastery, appState.tasks, sub.id);
            return (
              <View key={sub.id} style={{ marginBottom: 14 }}>
                <View style={homeStyles.planHeader}>
                  <Text style={homeStyles.planTitle}>{sub.title}</Text>
                  <Text style={homeStyles.planMeta}>{fmtDuration(sub.minutes)} · {sub.sessions} session{sub.sessions === 1 ? '' : 's'}</Text>
                </View>
                <ProgressBar value={sub.minutes / maxSubject} />
                <Text style={homeStyles.hint}>
                  Syllabus progress {sub.progressPct}% · {sm ? `🎯 ${sub.title} mastery ${sm.pct}%` : 'mastery not rated yet (quizzes needed)'}
                </Text>
              </View>
            );
          })}
          {cur.freeFocusMinutes > 0 && <Text style={homeStyles.hint}>Plus {fmtDuration(cur.freeFocusMinutes)} of free focus not linked to a task.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Weekly goal</Text>
          {gp ? (
            <>
              <Text style={homeStyles.score}>{gp.done} / {gp.target}</Text>
              <ProgressBar value={gp.pct / 100} />
              <Text style={homeStyles.hint}>
                sessions this week (Mon to Sun) · {gp.met ? '🎉 goal reached' : `${gp.remaining} to go, ${gp.daysLeft} day${gp.daysLeft === 1 ? '' : 's'} left`}
              </Text>
              <View style={homeStyles.btnRow}>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} disabled={weeklyGoal! <= MIN_GOAL} onPress={() => updateGoal(weeklyGoal! - 1)}>
                  <Text style={styles.secondaryBtnText}>− 1</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} disabled={weeklyGoal! >= MAX_GOAL} onPress={() => updateGoal(weeklyGoal! + 1)}>
                  <Text style={styles.secondaryBtnText}>+ 1</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => updateGoal(null)}>
                  <Text style={styles.secondaryBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <Text style={homeStyles.finding}>No weekly goal set.</Text>
          )}
          {suggestion.target !== weeklyGoal && (
            <View style={homeStyles.suggestBox}>
              <Text style={homeStyles.flowLine}>Suggested: {suggestion.target} sessions per week</Text>
              <Text style={homeStyles.hint}>{suggestion.explanation}</Text>
              <TouchableOpacity style={[styles.primaryBtn, { marginTop: 10 }]} onPress={() => updateGoal(suggestion.target)}>
                <Text style={styles.primaryBtnText}>Use {suggestion.target}</Text>
              </TouchableOpacity>
            </View>
          )}
          <Text style={homeStyles.hint}>
            Suggestions come from your own last full weeks (a small step up, never a jump), not from AI. The goal is saved on this device.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Achievements · {unlocked.length} of {achievements.length}</Text>
          {upcoming.length > 0 && (
            <>
              <Text style={homeStyles.hint}>Next up</Text>
              {upcoming.map(a => (
                <View key={a.id} style={{ marginTop: 8 }}>
                  <Text style={homeStyles.planTitle}>{a.icon} {a.title}</Text>
                  <ProgressBar value={a.current / a.target} />
                  <Text style={homeStyles.hint}>{a.description} · {a.id.startsWith('hours') ? `${fmtDuration(a.current)} of ${fmtDuration(a.target)}` : `${a.current} / ${a.target}`}</Text>
                </View>
              ))}
            </>
          )}
          <View style={[homeStyles.chipRow, { marginTop: 14 }]}>
            {achievements.map(a => (
              <View key={a.id} style={[homeStyles.badgeBox, !a.unlocked && { opacity: 0.4 }]}>
                <Text style={{ fontSize: 22 }}>{a.icon}</Text>
                <Text style={homeStyles.badgeTitle} numberOfLines={2}>{a.title}</Text>
              </View>
            ))}
          </View>
          <Text style={homeStyles.hint}>Achievements are worked out from your sessions and quizzes, so they always match your real history.</Text>
        </View>
      </>
    );
  };

  const renderInsightsTab = () => {
    const nowMs = Date.now();
    const st = computeStats(appState.sessions, appState.tasks, appState.subjects, appState.chapters, nowMs, tzOffset());
    const rules = ruleFindings(st);
    const profile = learnProfile(st);
    const mastery = computeMastery(appState.quizAttempts);
    const advice = revisionAdvice({ mastery, tasks: appState.tasks, chapters: appState.chapters });
    const showAi = !!analysis;
    const ago = analysis ? Math.max(0, Math.round((nowMs - analysis.generatedAt) / 60000)) : 0;

    return (
      <ScrollView style={styles.tabContent}>
        <View style={[homeStyles.chipRow, { marginBottom: 12 }]}>
          {chip('iv-progress', '🏆 Progress', insightsView === 'progress', () => setInsightsView('progress'))}
          {chip('iv-patterns', '🔍 Patterns', insightsView === 'patterns', () => setInsightsView('patterns'))}
          {chip('iv-mastery', '🎓 Mastery', insightsView === 'mastery', () => setInsightsView('mastery'))}
        </View>

        {insightsView === 'progress' && renderProgressView()}

        {insightsView === 'patterns' && (<>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Last {st.windowDays} days</Text>
          <View style={homeStyles.statRow}>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{st.completionPct === null ? '–' : `${st.completionPct}%`}</Text>
              <Text style={styles.rewardLabel}>Completed</Text>
            </View>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{st.focusMinutes}m</Text>
              <Text style={styles.rewardLabel}>Focus time</Text>
            </View>
            <View style={styles.rewardItem}>
              <Text style={styles.rewardValue}>{st.activeDaysLast7}/7</Text>
              <Text style={styles.rewardLabel}>Active days</Text>
            </View>
          </View>
          <Text style={homeStyles.hint}>
            {st.totalSessions} sessions · {st.completed} completed · {st.endedEarly} ended early
            {st.avgCompletedMinutes !== null ? ` · avg ${st.avgCompletedMinutes}m` : ''}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={homeStyles.planHeader}>
            <Text style={[styles.cardTitle, { marginBottom: 0 }]}>Performance analysis</Text>
            <Text style={homeStyles.badge}>{showAi ? sourceLabel(analysis!.source.provider) : 'Rule-based'}</Text>
          </View>

          {showAi && !!analysis!.summary && <Text style={homeStyles.planSummary}>{analysis!.summary}</Text>}
          {(showAi ? analysis!.findings.map(f => f.text) : rules.map(f => f.text)).map((t, i) => (
            <Text key={i} style={homeStyles.finding}>• {t}</Text>
          ))}
          {showAi && !!analysis!.nextStep && (
            <Text style={homeStyles.nextStep}>Next step: {analysis!.nextStep}</Text>
          )}
          {showAi && (
            <Text style={homeStyles.hint}>
              Based on {analysis!.basedOnSessions} sessions, {ago === 0 ? 'just now' : `${ago} min ago`}.
            </Text>
          )}

          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 12 }]}
            onPress={handleAnalyze}
            disabled={analysisBusy || st.totalSessions === 0}
          >
            <Text style={styles.secondaryBtnText}>
              {analysisBusy ? 'Analyzing…' : showAi ? 'Refresh AI analysis' : 'Analyze with AI'}
            </Text>
          </TouchableOpacity>
          {aiStatus && !aiStatus.anyConfigured && (
            <Text style={homeStyles.hint}>No AI key set on the server yet. Add one in backend/.env to enable this.</Text>
          )}
          {!!analysisMsg && <Text style={homeStyles.warn}>{analysisMsg}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>What the app has learned</Text>
          {!profile.ready ? (
            <Text style={homeStyles.finding}>
              Still learning: {st.totalSessions} of {MIN_TOTAL_SESSIONS} sessions. Recommendations adapt once there is enough history.
            </Text>
          ) : (
            <>
              <Text style={homeStyles.finding}>
                • Best time: {profile.bestBlock ? `${profile.bestBlock.label} (${profile.bestBlock.completionPct}% completed)` : 'no clear difference yet'}
              </Text>
              <Text style={homeStyles.finding}>
                • Session length you finish most: {profile.bestDurationMinutes ? `${profile.bestDurationMinutes} min` : 'no clear difference yet'}
              </Text>
              <Text style={homeStyles.finding}>
                • Subject to watch: {profile.weakSubjectTitle ?? 'no clear difference yet'}
              </Text>
              <Text style={homeStyles.hint}>
                These shape your recommended task, suggested session length and AI plan. They describe your own history, not causes.
              </Text>
            </>
          )}
        </View>
        </>)}

        {insightsView === 'mastery' && (<>
        {/* Topic mastery from quizzes */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Topic mastery</Text>
          {advice && <Text style={homeStyles.nextStep}>{advice.message}</Text>}
          {appState.quizAttempts.length === 0 && (
            <Text style={homeStyles.finding}>No quizzes yet. Take one in the Learn tab to see which topics are strong and which need work.</Text>
          )}
          {appState.subjects.map(sub => {
            const sm = subjectMastery(mastery, appState.tasks, sub.id);
            const subTasks = appState.tasks.filter(t => !t.deleted && t.subjectId === sub.id);
            if (subTasks.length === 0) return null;
            return (
              <View key={sub.id} style={{ marginTop: 12 }}>
                <Text style={homeStyles.planTitle}>{sub.title}{sm ? ` · ${sm.pct}%` : ''}</Text>
                {subTasks.map(t => {
                  const m = mastery.get(t.id);
                  return (
                    <View key={t.id} style={homeStyles.masteryRow}>
                      <Text style={homeStyles.masteryTitle}>
                        {levelEmoji[m?.level ?? 'unknown']} {t.title}
                      </Text>
                      <Text style={homeStyles.masteryMeta}>
                        {m && m.pct !== null
                          ? `${m.pct}% · ${m.questions} q${m.level === 'unknown' ? ' (not rated yet)' : ''}`
                          : 'no quiz yet'}
                      </Text>
                      <TouchableOpacity style={homeStyles.miniFocusBtn} onPress={() => openLearn(t.id, 'quiz')}>
                        <Text style={homeStyles.miniFocusText}>Quiz</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[homeStyles.miniFocusBtn, { marginLeft: 6 }]} onPress={() => openLearn(t.id, 'explain')}>
                        <Text style={homeStyles.miniFocusText}>Explain</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            );
          })}
          {noteMastery(mastery, notes).length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={homeStyles.planTitle}>📄 From your notes</Text>
              {noteMastery(mastery, notes).map(({ note, mastery: m }) => (
                <View key={note.id} style={homeStyles.masteryRow}>
                  <Text style={homeStyles.masteryTitle}>{levelEmoji[m.level]} {note.title}</Text>
                  <Text style={homeStyles.masteryMeta}>{m.pct}% · {m.questions} q{m.level === 'unknown' ? ' (not rated yet)' : ''}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={homeStyles.hint}>
            Based on your last 3 quizzes per topic. A topic is rated after {MIN_QUESTIONS_FOR_RATING}+ answered questions: 🟢 80%+ · 🟡 50 to 79% · 🔴 under 50%.
          </Text>
        </View>
        </>)}
      </ScrollView>
    );
  };

  // ── Dev Panel ─────────────────────────────────────────────────────────────

  const renderDevPanel = () => (
    <ScrollView style={styles.tabContent}>
      {/* Network Toggle */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔧 Dev Controls</Text>

        <View style={styles.devRow}>
          <Text style={styles.label}>Network:</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, { backgroundColor: isOnline ? COLORS.success : COLORS.danger }]}
            onPress={() => setIsOnline(!isOnline)}
          >
            <Text style={styles.toggleBtnText}>{isOnline ? '🟢 Online' : '🔴 Offline'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={doSync} disabled={!isOnline}>
          <Text style={styles.primaryBtnText}>⟳ Force Sync Now</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryBtn} onPress={refreshNotifications}>
          <Text style={styles.secondaryBtnText}>⟳ Refresh Notifications</Text>
        </TouchableOpacity>

        <Text style={styles.lastSync}>{lastSyncResult}</Text>
      </View>

      {/* Local State */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📱 This Device ({deviceId})</Text>
        <Text style={styles.devInfo}>Lamport Clock: {appState.lamport}</Text>
        <Text style={styles.devInfo}>Pending Sessions: {appState.pendingSessions.length}</Text>
        <Text style={styles.devInfo}>Pending Task Ops: {appState.pendingTaskOps.length}</Text>
        <Text style={styles.devInfo}>Total Sessions: {appState.sessions.length}</Text>
        <Text style={styles.devInfo}>Total Tasks (active): {appState.tasks.filter(t => !t.deleted).length}</Text>
        <Text style={styles.devInfo}>Coins: {appState.rewards.coins} | Streak: {appState.rewards.streak} | Today: {appState.rewards.todayFocusMinutes}m</Text>
      </View>

      {/* Server State */}
      {serverState && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🖥 Server State</Text>
          <Text style={styles.devInfo}>Lamport: {serverState.lamport}</Text>
          <Text style={styles.devInfo}>Sessions: {serverState.sessions?.length ?? 0}</Text>
          <Text style={styles.devInfo}>Tasks (active): {serverState.tasks?.filter((t: Task) => !t.deleted).length ?? 0}</Text>
          <Text style={styles.devInfo}>
            Coins: {serverState.rewards?.coins} | Streak: {serverState.rewards?.streak} | Today: {serverState.rewards?.todayFocusMinutes}m
          </Text>
        </View>
      )}

      {/* N8N Notifications */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📲 N8N Notifications ({notifications.length})</Text>
        {notifications.length === 0 && (
          <Text style={styles.emptyText}>No notifications fired yet</Text>
        )}
        {[...notifications].reverse().map((n, i) => (
          <View key={i} style={styles.notifRow}>
            <Text style={styles.notifText}>
              🔔 {n.receivedAt?.slice(11, 19)} — Session {n.payload?.sessionId?.slice(0, 8)}… | Streak {n.payload?.streak} | +{n.payload?.coinsEarned} coins
            </Text>
          </View>
        ))}
      </View>

      {/* Sync Log */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📋 Sync Log</Text>
        {syncLog.slice(0, 20).map((entry, i) => (
          <Text key={i} style={styles.logEntry}>{entry}</Text>
        ))}
      </View>

      {/* Conflict Scenarios - One Click Triggers */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>⚡ Conflict Scenario Triggers</Text>
        <Text style={styles.devInfo}>
          These buttons simulate offline conflict scenarios on THIS device. Run both devices offline, trigger on each, then sync.
        </Text>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            // Set task t1 → done on this device (offline conflict trigger)
            updateTaskStatus('t1', 'done');
            addLog(`[SCENARIO] Set t1=done on ${deviceId} (lamport ${appState.lamport + 1})`);
          }}
        >
          <Text style={styles.scenarioBtnText}>📝 Set "Linear equations" → Done</Text>
          <Text style={styles.scenarioBtnSub}>Use on Device A for conflict with Device B</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            updateTaskStatus('t1', 'in_progress');
            addLog(`[SCENARIO] Set t1=in_progress on ${deviceId} (lamport ${appState.lamport + 1})`);
          }}
        >
          <Text style={styles.scenarioBtnText}>📝 Set "Linear equations" → In Progress</Text>
          <Text style={styles.scenarioBtnSub}>Use on Device B for conflict with Device A</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            deleteTask('t2');
            addLog(`[SCENARIO] Deleted t2 on ${deviceId}`);
          }}
        >
          <Text style={styles.scenarioBtnText}>🗑 Delete "Quadratic equations"</Text>
          <Text style={styles.scenarioBtnSub}>While other device edits it → delete wins</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.scenarioBtn, { borderColor: COLORS.accent }]}
          onPress={() => {
            // Inject a completed session directly (simulates completing one offline)
            const id = `offline-session-${deviceId}-${Date.now()}`;
            const now = Date.now();
            setAppState(s => {
              const session: FocusSession = {
                id,
                studentId: STUDENT_ID,
                targetMinutes: 1,
                startedAt: now - 60000,
                status: 'completed',
                completedAt: now,
                synced: false,
              };
              const withRewards = applyLocalRewards(s, session);
              return {
                ...withRewards,
                sessions: [...s.sessions, session],
                pendingSessions: [...s.pendingSessions, session],
              };
            });
            addLog(`[SCENARIO] Injected offline session ${id.slice(0, 20)}…`);
          }}
        >
          <Text style={[styles.scenarioBtnText, { color: COLORS.accentLight }]}>⏱ Inject Offline Session (1m)</Text>
          <Text style={styles.scenarioBtnSub}>Adds a completed session to pending queue</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.scenarioBtn, { borderColor: COLORS.danger }]}
          onPress={() => {
            storageRef.current.clear();
            if (Platform.OS === 'web') window.location.reload();
          }}
        >
          <Text style={[styles.scenarioBtnText, { color: COLORS.danger }]}>🔄 Reset This Device</Text>
          <Text style={styles.scenarioBtnSub}>Clears localStorage and reloads</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.logo}>Kairos</Text>
          <Text style={styles.deviceTag}>{deviceId}</Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: isOnline ? COLORS.online : COLORS.offline }]} />
        <Text style={[styles.statusText, { color: isOnline ? COLORS.online : COLORS.offline }]}>
          {isOnline ? 'Online' : 'Offline'}
        </Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(['home', 'focus', 'syllabus', 'learn', 'insights', 'dev'] as const).map(tab => {
          const [icon, word] = TAB_LABELS[tab];
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={styles.tabIcon}>{icon}</Text>
              <Text numberOfLines={1} style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{word}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Content */}
      {activeTab === 'home' && renderHomeTab()}
      {activeTab === 'focus' && renderFocusTab()}
      {activeTab === 'syllabus' && renderSyllabusTab()}
      {activeTab === 'learn' && renderLearnTab()}
      {activeTab === 'insights' && renderInsightsTab()}
      {activeTab === 'dev' && renderDevPanel()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg, minHeight: '100vh' as any },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { fontSize: 20, fontWeight: '800', color: COLORS.accentLight, letterSpacing: 0.5 },
  deviceTag: {
    fontSize: 11, color: COLORS.textMuted, backgroundColor: COLORS.card,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: 12, fontWeight: '600' },

  tabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', minHeight: 54 },
  tabIcon: { fontSize: 16, marginBottom: 2 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: COLORS.accent },
  tabText: { fontSize: 11, color: COLORS.textMuted, fontWeight: '500' },
  tabTextActive: { color: COLORS.accentLight, fontWeight: '700' },

  tabContent: { flex: 1, padding: 16 },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 14 },

  rewardsBanner: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'space-around',
  },
  rewardItem: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  rewardValue: { fontSize: 26, fontWeight: '800', color: COLORS.accentLight },
  rewardLabel: { fontSize: 11, color: COLORS.textMuted, marginTop: 2, textAlign: 'center' },

  label: { fontSize: 13, color: COLORS.textMuted, marginBottom: 10 },
  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  durationBtn: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 8, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  durationBtnActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  durationBtnText: { fontSize: 13, color: COLORS.textMuted },
  durationBtnTextActive: { color: '#fff', fontWeight: '700' },

  primaryBtn: {
    backgroundColor: COLORS.accent, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 4,
  },
  primaryBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  dangerBtn: {
    backgroundColor: COLORS.danger, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 18,
  },
  dangerBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  secondaryBtn: {
    backgroundColor: COLORS.surface, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginTop: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  secondaryBtnText: { fontSize: 14, color: COLORS.textMuted },

  timerDisplay: {
    fontSize: 64, fontWeight: '800', color: COLORS.text,
    textAlign: 'center', fontVariant: ['tabular-nums'] as any,
    letterSpacing: 2, marginTop: 8,
  },
  timerSub: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', marginBottom: 14 },

  progressBg: { height: 7, backgroundColor: COLORS.surface, borderRadius: 4, marginBottom: 8, overflow: 'hidden' },
  progressFill: { height: 7, borderRadius: 4 },

  sessionRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  sessionDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  sessionLabel: { fontSize: 13, color: COLORS.text },
  sessionMeta: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },

  // Syllabus
  subjectHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  pctLabel: { fontSize: 14, fontWeight: '700' },
  chapterBlock: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.border },
  chapterHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  chapterTitle: { fontSize: 13, color: COLORS.text, fontWeight: '600' },

  taskRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  taskStatus: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
    minWidth: 100,
  },
  taskStatusText: { fontSize: 11, fontWeight: '600' },
  taskTitle: { flex: 1, fontSize: 13, color: COLORS.text },
  deleteBtn: { padding: 4 },
  deleteBtnText: { fontSize: 13, color: COLORS.textMuted },

  emptyText: { fontSize: 13, color: COLORS.textMuted, fontStyle: 'italic', textAlign: 'center', padding: 8 },

  // Dev
  devRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  toggleBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  toggleBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  lastSync: { fontSize: 12, color: COLORS.textMuted, marginTop: 10 },
  devInfo: { fontSize: 12, color: COLORS.textMuted, marginBottom: 6, lineHeight: 20 },
  notifRow: {
    backgroundColor: COLORS.surface, borderRadius: 8, padding: 10, marginBottom: 6,
    borderLeftWidth: 3, borderLeftColor: COLORS.success,
  },
  notifText: { fontSize: 12, color: COLORS.text },
  logEntry: { fontSize: 11, color: COLORS.textMuted, marginBottom: 3, fontFamily: 'monospace' as any },

  // Scenario buttons
  scenarioBtn: {
    backgroundColor: COLORS.surface, borderRadius: 10,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  scenarioBtnText: { fontSize: 13, color: COLORS.text, fontWeight: '600' },
  scenarioBtnSub: { fontSize: 11, color: COLORS.textMuted, marginTop: 3 },
});

const homeStyles = StyleSheet.create({
  recommendCard: {
    borderColor: 'rgba(139,132,255,0.65)',
    backgroundColor: '#24283D',
    shadowColor: COLORS.accent,
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  revisionCard: { borderColor: 'rgba(248,113,113,0.55)', backgroundColor: '#292532' },
  recHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  eyebrow: { fontSize: 10, letterSpacing: 1.25, fontWeight: '800', color: COLORS.accentLight },
  recMark: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(139,132,255,0.16)' },
  recMarkText: { color: COLORS.accentLight, fontSize: 15, fontWeight: '800' },
  recTitle: { fontSize: 24, lineHeight: 30, fontWeight: '800', color: COLORS.text },
  recMeta: { fontSize: 13, color: COLORS.textMuted, marginTop: 4 },
  recReason: { fontSize: 13, lineHeight: 19, color: COLORS.accentLight, marginTop: 12, marginBottom: 14, backgroundColor: 'rgba(139,132,255,0.09)', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, overflow: 'hidden' },
  recProgress: { fontSize: 12, color: COLORS.textMuted, marginBottom: 6 },
  statRow: { flexDirection: 'row', marginBottom: 14 },
  goalLabel: { fontSize: 12, color: COLORS.textMuted, marginBottom: 6 },
  warn: { fontSize: 12, color: COLORS.warn, marginTop: 10 },
  flowLine: { fontSize: 13, color: COLORS.text, marginBottom: 4 },
  dismiss: { fontSize: 12, color: COLORS.textMuted, marginTop: 8 },
  planRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: COLORS.border, gap: 12,
  },
  planIndex: { width: 22, fontSize: 14, fontWeight: '800', color: COLORS.accentLight },
  planTitle: { fontSize: 14, color: COLORS.text, fontWeight: '600' },
  planMeta: { fontSize: 12, color: COLORS.textMuted },
  planMin: { fontSize: 13, color: COLORS.textMuted, fontWeight: '700' },
  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, marginBottom: 12,
  },
  pickerTitle: { fontSize: 14, color: COLORS.text, fontWeight: '600' },
  pickerSub: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
  pickerChange: { fontSize: 12, color: COLORS.accentLight },
  pickerList: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, marginBottom: 12, overflow: 'hidden' },
  pickerItem: { padding: 10, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  pickerItemText: { fontSize: 13, color: COLORS.text },
  pickerItemMeta: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
  miniFocusBtn: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: COLORS.accent,
  },
  planHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  planSummary: { fontSize: 13, color: COLORS.textMuted, marginBottom: 6 },
  badge: {
    fontSize: 11, color: COLORS.accentLight, borderWidth: 1, borderColor: COLORS.accent,
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
  },
  hint: { fontSize: 11, color: COLORS.textMuted, marginTop: 8 },
  finding: { fontSize: 13, color: COLORS.text, marginBottom: 8, lineHeight: 18 },
  nextStep: { fontSize: 13, color: COLORS.accentLight, marginTop: 4, fontWeight: '600' },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  delta: { fontSize: 10, color: COLORS.textMuted, marginTop: 2, textAlign: 'center' },
  suggestBox: { marginTop: 14, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.accent, backgroundColor: COLORS.surface },
  badgeBox: { width: 76, alignItems: 'center', padding: 8, borderRadius: 10, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  badgeTitle: { fontSize: 10, color: COLORS.text, textAlign: 'center', marginTop: 4 },
  input: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, color: COLORS.text, borderRadius: 10, padding: 12, fontSize: 14 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  chipActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  chipText: { fontSize: 12, color: COLORS.text },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  score: { fontSize: 40, fontWeight: '800', color: COLORS.text, marginBottom: 8 },
  reviewItem: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: COLORS.border },
  question2: { fontSize: 17, fontWeight: '700', color: COLORS.text, marginBottom: 14, lineHeight: 24 },
  option: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, marginBottom: 8 },
  optionRight: { borderColor: COLORS.success, backgroundColor: 'rgba(74,222,128,0.12)' },
  optionWrong: { borderColor: COLORS.danger, backgroundColor: 'rgba(248,113,113,0.12)' },
  optionText: { fontSize: 14, color: COLORS.text },
  exampleBox: { fontSize: 13, color: COLORS.text, backgroundColor: COLORS.surface, borderRadius: 10, padding: 10, marginBottom: 8, lineHeight: 19 },
  masteryRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: COLORS.border },
  masteryTitle: { flex: 1, fontSize: 13, color: COLORS.text },
  masteryMeta: { fontSize: 11, color: COLORS.textMuted, marginRight: 8 },
  miniFocusText: { fontSize: 11, color: COLORS.accentLight, fontWeight: '700' },
});
