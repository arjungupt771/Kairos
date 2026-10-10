# Kairos — AI-Powered Study Companion

Kairos is an offline-first study companion built with React Native, Expo Web, TypeScript, and Express. It combines syllabus management, focus sessions, cross-device synchronization, AI-powered study planning, adaptive recommendations, quizzes, topic mastery, and a retrieval-augmented generation (RAG) study tutor.

Rather than simply tracking study time, Kairos connects a student's tasks, study sessions, quiz results, and personal notes to help them decide what to study, understand difficult topics, and track their progress.

## Features

### 1. Personalized Study Dashboard
- Today's recommended study task.
- One-tap focus sessions linked to syllabus tasks.
- Daily focus-time goals and session summaries.
- Current study streak and progress overview.
- Revision recommendations based on quiz performance and topic mastery.
- Weekly study goals and achievement tracking.

### 2. Syllabus and Task Management
- Organize learning through subjects, chapters, and tasks.
- Track task status: Not Started, In Progress, and Done.
- Link focus sessions to specific tasks.
- Derive task progress from completed focus time.
- Maintain consistent progress across synchronized devices.

### 3. Focus Sessions
- Start timed study sessions directly from tasks.
- Record completed sessions and study duration.
- Recover active sessions after a browser refresh.
- Deduplicate sessions during synchronization.
- Update study statistics, streaks, rewards, and task progress.

### 4. AI Study Planner and Rescheduling
- Generate personalized study schedules based on available time and unfinished tasks.
- Consider task status, syllabus progress, subject-level progress, and study history.
- Recommend study blocks and explain why particular tasks were selected.
- Identify missed or incomplete schedule blocks.
- Regenerate a schedule around remaining tasks.
- Fall back to rule-based planning when an AI provider is unavailable.

Task ranking and adaptive recommendations also use deterministic logic. The system combines these rules with AI-generated scheduling rather than relying entirely on an LLM.

### 5. AI Study Performance Analysis
- Analyze study-session history and subject-level progress.
- Generate explanations of observed study patterns.
- Identify potentially productive study periods and session durations.
- Recommend areas that may need additional attention.
- Apply minimum-data thresholds to avoid presenting weak patterns as reliable conclusions.

### 6. AI Topic Explainer
- Generate simple explanations for selected topics.
- Request examples and follow-up explanations.
- Ask contextual follow-up questions.
- Explore topics within a subject or chapter.

### 7. AI Quiz Generator
- Generate multiple-choice quizzes by subject, chapter, or topic.
- Choose easy, medium, or hard difficulty.
- Receive explanations after answering questions.
- Record completed quiz attempts and synchronize them across devices.
- Derive topic mastery from recent quiz results.

### 8. Topic Mastery and Revision
- Track quiz-based mastery for individual topics.
- Identify topics that may need revision.
- Recommend revision before progressing to subsequent material.
- Distinguish syllabus completion from demonstrated quiz performance.
- Provide one-tap access to revision sessions and quizzes.

### 9. Notes and PDF Study Tutor (RAG)

Upload text-based PDFs, Markdown files, or text documents, or paste notes directly into the app.

The notes tutor supports:
- Ask questions about uploaded material.
- Explain concepts in simpler language.
- Summarize chapters and sections.
- Generate quizzes grounded in the notes.
- Identify concepts that may not have been studied.
- Display source passages and page references for supported answers.

**Retrieval pipeline:**

PDF/text → text extraction → chunking → embeddings (optional) → retrieval → LLM-generated answer with citation verification.

Keyword-based retrieval works without embeddings. Gemini embeddings provide additional semantic retrieval when configured. The server checks generated quotations against retrieved passages before accepting cited answers.

### 10. Study Analytics
- Weekly and monthly study summaries.
- Focus duration and completed-session counts.
- Completion rates and active study days.
- Daily study-time charts.
- Subject-level study time and syllabus progress.
- Quiz-based mastery statistics.
- Comparisons against previous periods.

### 11. Goals and Gamification
- Set a weekly completed-session goal.
- Track progress toward the goal.
- Receive rule-based goal suggestions based on previous study history.
- Earn achievements for sessions, streaks, study time, quizzes, and mastery.
- Derive achievements from recorded activity instead of maintaining a separate achievement state.

### 12. Offline-First Synchronization
- Namespaced local storage for independent devices.
- Push-and-pull synchronization with an Express backend.
- Lamport-clock conflict resolution for task operations.
- Deterministic device-ID tie-breaking.
- Delete-wins tombstones for task deletions.
- Deduplication of immutable focus sessions and quiz attempts.
- Reconciliation that preserves local changes created while synchronization is in progress.

### 13. n8n Automation
- Trigger workflow notifications when focus sessions are completed.
- Send session events to an n8n webhook.
- Use a local mock notification sink when a webhook is not configured.
- Deduplicate repeated session notifications.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React Native, Expo Web |
| Language | TypeScript |
| Backend | Node.js, Express |
| Local device storage | Browser `localStorage` |
| Synchronization | Custom push-and-pull sync |
| Conflict resolution | Lamport clocks and delete-wins tombstones |
| AI providers | Google Gemini and Groq |
| Embeddings | Gemini Embeddings API |
| Retrieval | Keyword/BM25-style search, optional vector search, reciprocal rank fusion |
| Notes storage | File-backed JSON index |
| Automation | n8n |
| Testing | TypeScript tests, integration tests, Python logic tests |

## Architecture

```text
                    KAIROS
                       |
          +------------+-------------+
          |                          |
          v                          v
   Expo Web Frontend          Express Backend
          |                          |
          |                   +------+------+
          |                   |             |
          v                   v             v
   Local Storage          AI Services    Sync Engine
          |                   |             |
          |              +----+----+        |
          |              |         |        |
          |            Gemini     Groq       |
          |                                  |
          +------------- Sync ---------------+
                                             |
                                    +--------+--------+
                                    |                 |
                                    v                 v
                              Task/session       n8n webhook
                                state            automation

   Notes and PDFs → Chunking → Retrieval → LLM → Verified citations
```

The frontend handles the user experience, local state, focus sessions, and derived statistics. The backend coordinates synchronization, AI requests, and notes retrieval. AI API keys remain in the backend environment rather than the frontend bundle.

## Project Structure

```text
alcovia/
├── frontend/
│   ├── App.tsx
│   ├── aiClient.ts
│   ├── insights.ts
│   ├── schedule.ts
│   ├── analytics.ts
│   ├── progress.ts
│   ├── mastery.ts
│   ├── quiz.ts
│   ├── notesApi.ts
│   ├── notesLogic.ts
│   ├── NotesPanel.tsx
│   ├── sync.ts
│   ├── storage.ts
│   ├── goals.ts
│   ├── achievements.ts
│   └── *.test.ts
├── backend/
│   ├── src/
│   │   ├── index.ts
│   │   ├── ai.ts
│   │   ├── llm.ts
│   │   ├── store.ts
│   │   ├── types.ts
│   │   ├── n8nNotifier.ts
│   │   └── notes/
│   │       ├── routes.ts
│   │       ├── tutor.ts
│   │       ├── retrieval.ts
│   │       ├── embeddings.ts
│   │       ├── chunk.ts
│   │       ├── pdf.ts
│   │       └── store.ts
│   ├── ai.test.ts
│   ├── notes.test.ts
│   ├── fixtures/
│   └── .env.example
├── n8n/
│   └── n8n-workflow.json
├── test_logic.py
├── DECISIONS.md
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18 or later.
- npm.
- A modern web browser.
- Gemini and/or Groq API keys for AI features.
- n8n only if you want to run the notification workflow.

### 1. Start the backend

From the repository root:

```bash
cd backend
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Configure your API keys in `backend/.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile

LLM_PROVIDER=gemini
AI_RATE_LIMIT_PER_MIN=20

PORT=3001
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
```

Start the backend:

```bash
npm run dev
```

The backend runs at:

```text
http://localhost:3001
```

Check that it is responding:

```bash
curl http://localhost:3001/health
```

### 2. Start the frontend

Open a second terminal from the repository root:

```bash
cd frontend
npm install
npm start
```

Expo starts the web application, normally at:

```text
http://localhost:8081
```

Follow the URL printed by Expo if a different port is selected.

### 3. Run without AI API keys

Kairos's core study workflow can run without configured AI providers. Rule-based scheduling and recommendations remain available, while AI-dependent features require a working provider.

When both providers are configured, the backend can fall back to the alternative provider if the preferred provider fails.

### 4. Configure n8n (optional)

Start a local n8n instance:

```bash
npx n8n
```

Open `http://localhost:5678`, import `n8n/n8n-workflow.json`, and activate the workflow.

Configure the webhook URL in `backend/.env`:

```env
N8N_WEBHOOK_URL=http://localhost:5678/webhook/alcovia-session-complete
```

Restart the backend after changing environment variables. Without a configured webhook, the backend uses its mock notification sink.

## API Overview

The backend provides endpoints for health checks, synchronization, AI assistance, and notes-based learning.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Backend health check |
| `GET /bootstrap` | Initial application state |
| `POST /sync` | Synchronize task operations, sessions, and quiz attempts |
| `GET /state` | Inspect server state during development |
| `GET /notifications` | Inspect mock notifications |
| `GET /ai/status` | Check configured AI providers |
| `POST /ai/schedule` | Generate or reschedule study blocks |
| `POST /ai/analyze` | Analyze study performance |
| `POST /ai/explain` | Explain a topic |
| `POST /ai/quiz` | Generate a quiz |
| `/notes/*` | Notes upload, retrieval, tutoring, and related operations |

The exact request and response schemas are implemented in the backend source. Consult `backend/src/index.ts`, `backend/src/ai.ts`, and `backend/src/notes/routes.ts` when integrating with individual endpoints.

## Demonstrating Cross-Device Sync

Open two browser tabs using different device identifiers:

```text
http://localhost:8081?device=DeviceA
http://localhost:8081?device=DeviceB
```

For a realistic demonstration, use a regular browser window for one device and an incognito window for the other.

Test these scenarios:

1. **Concurrent task edits:** Edit the same task differently on both devices while offline, then reconnect and verify deterministic conflict resolution.
2. **Delete versus edit:** Delete a task on one device and edit it on the other. Verify that the deletion wins.
3. **Independent focus sessions:** Complete separate sessions on both devices and verify that each session is counted once.
4. **Repeated synchronization:** Replay a completed session and verify that rewards and notifications are not duplicated.
5. **Sync during an active request:** Create changes while synchronization is in progress and verify that the changes are preserved.
6. **Quiz synchronization:** Complete quizzes on separate devices and verify that attempts contribute consistently to derived mastery.

## Testing

Run the frontend tests:

```bash
cd frontend
npm test
```

Run the backend tests:

```bash
cd backend
npm test
```

Run the original synchronization logic tests from the repository root:

```bash
python3 test_logic.py
```

The test suites cover scheduling and analytics logic, AI response validation, notes retrieval, PDF processing, synchronization reconciliation, goals, achievements, and related application behaviour.

For a full verification, run all three commands and check their results in your local environment.

## Design Principles

**Derive, don't store.** Progress, mastery, and achievements are computed from recorded sessions and quiz attempts wherever possible.

**Validate AI output.** Model-generated task identifiers, durations, quiz questions, and citations are checked before being used.

**Be transparent about uncertainty.** Insights require sufficient history, and the application distinguishes observed patterns from causal explanations.

**Keep the core workflow usable offline.** Local study activity and rule-based recommendations should not depend on the availability of an AI provider.

**Prefer useful learning over feature count.** AI planning, focus sessions, quizzes, and notes should reinforce one another rather than function as unrelated demos.

## Current Limitations

- The synchronization backend persists tasks, sessions, rewards, quiz attempts, and deduplication state in SQLite at `backend/data/alcovia.sqlite` by default. Set `STORE_SQLITE_PATH` to choose another file. This uses Node's built-in SQLite support (Node 22.5+).
- Uploaded notes and their retrieval index are stored as files on the backend.
- Gemini and Groq requests require valid API keys and may be affected by provider availability, quota limits, or model changes.
- AI-generated explanations and quiz answer keys may contain errors; generated content should be reviewed critically.
- Scanned PDFs that contain images rather than extractable text are not supported by the current PDF pipeline.
- Complex PDF tables and multi-column layouts may not extract cleanly.
- Semantic retrieval requires configured embeddings; keyword retrieval is the fallback.
- Native iOS and Android behaviour should be tested separately; the primary development and verification target is Expo Web.
- Weekly goals use device-local preferences and are not synchronized.
- Study analytics depend on the quality and quantity of recorded sessions and quiz attempts.
- AI prioritization should be treated as a recommendation system, not an objective measure of a student's ability.

## Future Improvements

The next improvements focus on connecting and refining the existing features:

1. Continue improving AI-assisted task prioritization while retaining deterministic ranking and validation.
2. Quiz-based topic mastery now influences candidate ranking and is passed to the AI scheduler.
3. Improve the integration between recommended tasks, focus sessions, and rescheduling.
4. Refine the dashboard, loading states, error messages, and mobile layouts.
5. Expand regression tests for the complete study and AI workflows.
6. Local synchronization data now persists across backend restarts with SQLite.

## Project Scope

Kairos is a local-first learning and productivity project built to explore offline synchronization, AI-assisted planning, personalized learning, retrieval-augmented generation, and cross-feature application design.

The emphasis is on functional depth, understandable architecture, and demonstrable engineering decisions—not deployment infrastructure or production-scale operations.
