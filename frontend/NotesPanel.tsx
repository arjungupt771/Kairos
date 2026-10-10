import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import { COLORS } from './theme';
import { Task, Subject, FocusSession } from './types';
import { TopicMastery } from './mastery';
import { ActiveQuiz } from './quiz';
import {
  NoteMeta, AskResponse, SummarizeResponse, GapsResponse,
  uploadNote, deleteNote, askNotes, summarizeNotes, quizFromNotes, notesGaps, pickFile, canPickFiles,
} from './notesApi';
import { formatCitation, retrievalLabel, coverageLabel, buildGapTasks, toActiveQuiz } from './notesLogic';

export type ChatEntry =
  | { kind: 'ask'; question: string; style: 'answer' | 'explain'; res: AskResponse }
  | { kind: 'summary'; query: string; res: SummarizeResponse }
  | { kind: 'gaps'; res: GapsResponse };

export interface NotesPanelProps {
  notes: NoteMeta[];
  onNotesChanged: () => void;
  subjects: Subject[];
  tasks: Task[];
  sessions: FocusSession[];
  mastery: Map<string, TopicMastery>;
  /** Server has no LLM key at all. */
  noAiKey: boolean;
  /** Server can embed (Gemini key): semantic search on top of keyword search. */
  semantic: boolean;
  defaultSubjectId?: string;
  chat: ChatEntry[];
  setChat: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  onQuizReady: (quiz: ActiveQuiz) => void;
}

type Busy = null | 'upload' | 'ask' | 'explain' | 'summary' | 'quiz' | 'gaps';

export default function NotesPanel(p: NotesPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const selected = p.notes.find(n => n.id === selectedId) ?? null;
  const docIds = selected ? [selected.id] : [];
  const scopeLabel = selected ? selected.title : 'all your notes';
  const q = input.trim();

  // ── upload ──
  const finishUpload = (r: Awaited<ReturnType<typeof uploadNote>>) => {
    if (r.ok) {
      p.onNotesChanged();
      setMsg(r.data.note ?? `Added "${r.data.doc.title}": ${r.data.doc.pages} page(s), ${r.data.doc.chunks} sections, ready for questions.`);
      setPasteOpen(false); setPasteText(''); setPasteTitle('');
    } else {
      setMsg(`${r.reason}.`);
    }
  };

  const handlePick = async () => {
    if (busy) return;
    const f = await pickFile();
    if (!f) return;
    if ('error' in f) { setMsg(f.error); return; }
    setBusy('upload'); setMsg('Reading and indexing your notes…');
    try {
      const title = f.name.replace(/\.[a-z0-9]+$/i, '');
      finishUpload(await uploadNote(
        f.kind === 'pdf'
          ? { kind: 'pdf', fileName: f.name, title, subjectId: p.defaultSubjectId, dataBase64: f.base64 }
          : { kind: 'text', fileName: f.name, title, subjectId: p.defaultSubjectId, text: f.text },
      ));
    } finally { setBusy(null); }
  };

  const handlePaste = async () => {
    if (busy) return;
    if (pasteText.trim().length < 50) { setMsg('Paste a little more text first (at least a couple of sentences).'); return; }
    setBusy('upload'); setMsg('Indexing…');
    try {
      finishUpload(await uploadNote({
        kind: 'text', fileName: 'pasted.txt', title: pasteTitle.trim() || 'Pasted notes',
        subjectId: p.defaultSubjectId, text: pasteText,
      }));
    } finally { setBusy(null); }
  };

  const handleDelete = async (id: string) => {
    if (armedDelete !== id) { setArmedDelete(id); return; } // two taps: no accidental deletes
    setArmedDelete(null);
    const r = await deleteNote(id);
    if (r.ok) { if (selectedId === id) setSelectedId(null); p.onNotesChanged(); } else setMsg(`${r.reason}.`);
  };

  // ── tutor actions ──
  const ask = async (style: 'answer' | 'explain') => {
    if (busy) return;
    if (q.length < 2) { setMsg('Type a question or topic first.'); return; }
    setBusy(style === 'explain' ? 'explain' : 'ask'); setMsg('');
    try {
      const prev = [...p.chat].reverse().find(e => e.kind === 'ask') as Extract<ChatEntry, { kind: 'ask' }> | undefined;
      const r = await askNotes({ question: q, style, docIds, previousQuestion: prev?.question });
      if (r.ok) { p.setChat(c => [...c, { kind: 'ask', question: q, style, res: r.data }]); setInput(''); } else setMsg(`${r.reason}.`);
    } finally { setBusy(null); }
  };

  const summarize = async () => {
    if (busy) return;
    if (q.length < 2) { setMsg('Type what to summarise, for example "Chapter 4" or a topic.'); return; }
    setBusy('summary'); setMsg('');
    try {
      const r = await summarizeNotes({ query: q, docIds });
      if (r.ok) { p.setChat(c => [...c, { kind: 'summary', query: q, res: r.data }]); setInput(''); } else setMsg(`${r.reason}.`);
    } finally { setBusy(null); }
  };

  const quiz = async () => {
    if (busy) return;
    setBusy('quiz'); setMsg('');
    try {
      const r = await quizFromNotes({ docIds, difficulty, count: 5, query: q || undefined });
      if (!r.ok) { setMsg(`${r.reason}.`); return; }
      p.onQuizReady(toActiveQuiz(r.data, {
        id: uuidv4(), now: Date.now(), label: `Notes: ${selected?.title ?? 'all notes'}`,
        subjectId: selected?.subjectId || p.defaultSubjectId || p.subjects[0]?.id || '',
      }));
    } finally { setBusy(null); }
  };

  const gaps = async () => {
    if (busy) return;
    setBusy('gaps'); setMsg('');
    try {
      const r = await notesGaps({ docIds, tasks: buildGapTasks(p.tasks, p.subjects, p.sessions, p.mastery) });
      if (r.ok) p.setChat(c => [...c, { kind: 'gaps', res: r.data }]); else setMsg(`${r.reason}.`);
    } finally { setBusy(null); }
  };

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <TouchableOpacity key={key} style={[s.chip, active && s.chipActive]} onPress={onPress}>
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
  const btn = (label: string, onPress: () => void, primary = false, disabled = false) => (
    <TouchableOpacity style={[s.btn, primary && s.btnPrimary, disabled && { opacity: 0.5 }]} onPress={onPress} disabled={disabled}>
      <Text style={[s.btnText, primary && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
  const taskTitle = (id: string | null) => (id ? p.tasks.find(t => t.id === id)?.title : undefined);

  return (
    <>
      {/* ── documents ── */}
      <View style={s.card}>
        <Text style={s.title}>My notes</Text>
        {p.notes.length === 0 ? (
          <Text style={s.body}>
            Upload a PDF (text-based, up to 10 MB) or paste your notes. The tutor then answers from them, with the page and
            the exact line it used, summarises a chapter, quizzes you from them, and finds what you have not studied yet.
          </Text>
        ) : (
          <>
            <Text style={s.hint}>Ask about:</Text>
            <View style={s.chipRow}>
              {chip('all', 'All notes', selectedId === null, () => setSelectedId(null))}
              {p.notes.map(n => chip(n.id, n.title, selectedId === n.id, () => setSelectedId(n.id)))}
            </View>
            {p.notes.map(n => (
              <View key={n.id} style={s.docRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.docTitle}>{n.title}</Text>
                  <Text style={s.hint}>
                    {n.kind === 'pdf' ? `${n.pages} pages · ` : ''}{n.chunks} sections · {n.embedded ? 'semantic search' : 'keyword search only'}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => handleDelete(n.id)}>
                  <Text style={[s.hint, { color: COLORS.danger }]}>{armedDelete === n.id ? 'Tap again to delete' : 'Delete'}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        <View style={s.btnRow}>
          {canPickFiles() && btn(busy === 'upload' ? 'Uploading…' : '⬆ Upload PDF / text', handlePick, false, busy !== null)}
          {btn(pasteOpen ? 'Cancel paste' : '📋 Paste text', () => setPasteOpen(o => !o), false, busy !== null)}
        </View>
        {!canPickFiles() && <Text style={s.hint}>File upload works in the web app. On other devices, paste your notes instead.</Text>}

        {pasteOpen && (
          <>
            <TextInput style={[s.input, { marginTop: 10 }]} value={pasteTitle} onChangeText={setPasteTitle}
              placeholder="Title (optional)" placeholderTextColor={COLORS.textMuted} maxLength={80} />
            <TextInput style={[s.input, { marginTop: 8, minHeight: 120, textAlignVertical: 'top' }]} value={pasteText} onChangeText={setPasteText}
              placeholder="Paste your notes here" placeholderTextColor={COLORS.textMuted} multiline />
            {btn('Save notes', handlePaste, true, busy !== null)}
          </>
        )}
        {!!msg && <Text style={s.warn}>{msg}</Text>}
        {!p.semantic && p.notes.length > 0 && (
          <Text style={s.hint}>Semantic search is off (no Gemini key on the server). Keyword search still works.</Text>
        )}
      </View>

      {/* ── tutor ── */}
      {p.notes.length > 0 && (
        <View style={s.card}>
          <Text style={s.title}>Study tutor · {scopeLabel}</Text>
          <TextInput
            style={s.input} value={input} onChangeText={setInput} maxLength={400}
            placeholder={'A question, a topic, or "Chapter 4"'} placeholderTextColor={COLORS.textMuted}
          />
          <View style={s.btnRow}>
            {btn(busy === 'ask' ? 'Thinking…' : 'Ask', () => ask('answer'), true, busy !== null)}
            {btn(busy === 'explain' ? 'Thinking…' : 'Explain simply', () => ask('explain'), false, busy !== null)}
            {btn(busy === 'summary' ? 'Reading…' : 'Summarise', summarize, false, busy !== null)}
          </View>

          <Text style={[s.hint, { marginTop: 14 }]}>Quiz difficulty</Text>
          <View style={s.chipRow}>
            {(['easy', 'medium', 'hard'] as const).map(d => chip(d, d[0].toUpperCase() + d.slice(1), difficulty === d, () => setDifficulty(d)))}
          </View>
          <View style={s.btnRow}>
            {btn(busy === 'quiz' ? 'Writing questions…' : q ? `Quiz me on "${q.slice(0, 18)}"` : 'Quiz me from these notes', quiz, false, busy !== null)}
            {btn(busy === 'gaps' ? 'Comparing…' : "What haven't I studied?", gaps, false, busy !== null)}
          </View>
          {p.noAiKey && <Text style={s.hint}>No AI key is set on the server yet. The tutor needs one (backend/.env).</Text>}
        </View>
      )}

      {/* ── answers, newest first ── */}
      {[...p.chat].reverse().map((e, i) => {
        if (e.kind === 'ask') {
          return (
            <View key={i} style={s.card}>
              <Text style={s.you}>{e.style === 'explain' ? 'Explain: ' : ''}{e.question}</Text>
              <Text style={[s.body, !e.res.answerable && { color: COLORS.textMuted }]}>
                {!e.res.answerable ? '⚠ ' : ''}{e.res.answer}
              </Text>
              {e.res.citations.map((c, j) => (
                <View key={j} style={s.cite}>
                  <Text style={s.citeHead}>{formatCitation(c)}</Text>
                  <Text style={s.citeQuote}>“{c.quote}”</Text>
                </View>
              ))}
              <Text style={s.hint}>
                {retrievalLabel(e.res.retrieval)}{e.res.source ? ` · ${e.res.source.provider === 'gemini' ? 'Gemini' : 'Groq'}` : ''}
                {e.res.answerable ? ' · every citation was checked against your notes' : ''}
              </Text>
            </View>
          );
        }
        if (e.kind === 'summary') {
          return (
            <View key={i} style={s.card}>
              <Text style={s.you}>Summary: {e.query}</Text>
              {!e.res.found ? (
                <Text style={[s.body, { color: COLORS.textMuted }]}>⚠ {e.res.message}</Text>
              ) : (
                <>
                  <Text style={s.body}>{e.res.summary}</Text>
                  {e.res.keyPoints.map((k, j) => <Text key={j} style={s.point}>• {k}</Text>)}
                  <Text style={s.hint}>{coverageLabel(e.res.coverage)}</Text>
                </>
              )}
            </View>
          );
        }
        return (
          <View key={i} style={s.card}>
            <Text style={s.you}>Not studied yet</Text>
            {e.res.gaps.length === 0 && (
              <Text style={s.body}>Nothing important seems to be missing from the part of your notes I checked.</Text>
            )}
            {e.res.gaps.map((g, j) => (
              <View key={j} style={s.gap}>
                <Text style={s.docTitle}>{g.concept}</Text>
                <Text style={s.body}>{g.why}</Text>
                <Text style={s.hint}>{g.docTitle}{g.page ? `, p.${g.page}` : ''}{taskTitle(g.relatedTaskId) ? ` · closest topic: ${taskTitle(g.relatedTaskId)}` : ' · no matching topic in your syllabus'}</Text>
              </View>
            ))}
            <Text style={s.hint}>
              Checked {e.res.basis.passagesChecked} of {e.res.basis.passagesTotal} sections of your notes. "Studied" here means task
              progress and quiz results, not understanding.
            </Text>
          </View>
        );
      })}
    </>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: COLORS.card, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: COLORS.border },
  title: { fontSize: 15, fontWeight: '700', color: COLORS.text, marginBottom: 10 },
  you: { fontSize: 13, fontWeight: '700', color: COLORS.accentLight, marginBottom: 8 },
  body: { fontSize: 14, color: COLORS.text, lineHeight: 21, marginBottom: 8 },
  point: { fontSize: 13, color: COLORS.text, lineHeight: 19, marginBottom: 4 },
  hint: { fontSize: 11, color: COLORS.textMuted, marginTop: 6, lineHeight: 16 },
  warn: { fontSize: 12, color: COLORS.warn, marginTop: 10, lineHeight: 17 },
  docRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: COLORS.border, gap: 10 },
  docTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  chipActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  chipText: { fontSize: 12, color: COLORS.text },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.accent },
  btnPrimary: { backgroundColor: COLORS.accent },
  btnText: { fontSize: 13, fontWeight: '600', color: COLORS.accentLight },
  input: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, color: COLORS.text, borderRadius: 10, padding: 12, fontSize: 14 },
  cite: { backgroundColor: COLORS.surface, borderRadius: 10, padding: 10, marginBottom: 6 },
  citeHead: { fontSize: 12, fontWeight: '700', color: COLORS.accentLight, marginBottom: 2 },
  citeQuote: { fontSize: 12, color: COLORS.text, fontStyle: 'italic', lineHeight: 17 },
  gap: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: COLORS.border },
});
