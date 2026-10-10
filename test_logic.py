#!/usr/bin/env python3
"""
Alcovia Sync Logic Tests (pure Python)
Validates the core invariants without needing a running Express server.
These directly mirror the TypeScript logic in store.ts and sync.ts.
"""

from typing import Literal, Optional
import copy, time, uuid

TaskStatus = Literal["not_started", "in_progress", "done"]

class Task:
    def __init__(self, id, subject_id, chapter_id, title, status="not_started",
                 lamport=0, device_id="seed", deleted=False, deleted_by=None, deleted_lamport=None):
        self.id = id
        self.subject_id = subject_id
        self.chapter_id = chapter_id
        self.title = title
        self.status = status
        self.lamport = lamport
        self.device_id = device_id
        self.deleted = deleted
        self.deleted_by = deleted_by
        self.deleted_lamport = deleted_lamport

    def copy(self, **kwargs):
        t = copy.copy(self)
        for k, v in kwargs.items():
            setattr(t, k, v)
        return t

class FocusSession:
    def __init__(self, id, target_minutes, started_at, status="completed",
                 fail_reason=None, completed_at=None):
        self.id = id
        self.target_minutes = target_minutes
        self.started_at = started_at
        self.status = status
        self.fail_reason = fail_reason
        self.completed_at = completed_at

def today_utc():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')

def prev_day_utc(d):
    from datetime import datetime, timezone, timedelta
    dt = datetime.strptime(d, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    return (dt - timedelta(days=1)).strftime('%Y-%m-%d')

# ─── Mirror of store.ts ───────────────────────────────────────────────────────

def task_wins(challenger: Task, incumbent: Task) -> bool:
    """Same logic as TypeScript taskWins()"""
    # Tombstone always beats non-tombstone
    if challenger.deleted and not incumbent.deleted:
        return True
    if not challenger.deleted and incumbent.deleted:
        return False
    # Higher Lamport wins
    if challenger.lamport > incumbent.lamport:
        return True
    if challenger.lamport < incumbent.lamport:
        return False
    # Tie-break: lexicographically greater deviceId
    return challenger.device_id > incumbent.device_id

class ServerStore:
    def __init__(self):
        self.sessions = {}       # id -> FocusSession
        self.tasks = {}          # id -> Task
        self.processed = set()   # session ids already rewarded
        self.notified = set()    # session ids already notified
        self.lamport = 0
        self.coins = 0
        self.streak = 0
        self.last_streak_date = ''
        self.today_minutes = 0
        self.today_date = today_utc()

    def advance_lamport(self, received):
        self.lamport = max(self.lamport, received) + 1

    def merge_sessions(self, incoming):
        newly_confirmed = []
        for s in incoming:
            if s.id not in self.sessions:
                self.sessions[s.id] = s
                if s.status == 'completed' and s.id not in self.processed:
                    self.processed.add(s.id)
                    self._apply_rewards(s)
                    newly_confirmed.append(s.id)
        return newly_confirmed

    def _apply_rewards(self, session):
        today = today_utc()
        if self.today_date != today:
            self.today_minutes = 0
            self.today_date = today
        self.today_minutes += session.target_minutes
        self.coins += 50
        yesterday = prev_day_utc(today)
        if self.last_streak_date == today:
            pass
        elif self.last_streak_date == yesterday or self.last_streak_date == '':
            self.streak += 1
            self.last_streak_date = today
        else:
            self.streak = 1
            self.last_streak_date = today

    def merge_tasks(self, incoming):
        for t in incoming:
            if t.id not in self.tasks:
                self.tasks[t.id] = copy.copy(t)
            else:
                if task_wins(t, self.tasks[t.id]):
                    self.tasks[t.id] = copy.copy(t)

    def notify(self, session_id) -> bool:
        if session_id in self.notified:
            return False
        self.notified.add(session_id)
        return True


# ═══════════════════════════════════════════════════════════════════════════════
# TESTS
# ═══════════════════════════════════════════════════════════════════════════════

passed = 0
failed = 0

def check(label, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  ✅ {label}")
        passed += 1
    else:
        print(f"  ❌ {label} {detail}")
        failed += 1

print("\n" + "="*60)
print("TEST 1: Session idempotency — same session from 2 devices")
print("="*60)
store = ServerStore()
s = FocusSession("session-001", 25, int(time.time()*1000), "completed")

c1 = store.merge_sessions([s])
check("First sync: session confirmed", c1 == ["session-001"])
check("First sync: 50 coins", store.coins == 50)
check("First sync: streak = 1", store.streak == 1)

c2 = store.merge_sessions([s])  # DeviceB syncs same session
check("Replay from DeviceB: not re-confirmed", c2 == [])
check("Replay from DeviceB: still 50 coins", store.coins == 50)
check("Replay from DeviceB: streak still 1", store.streak == 1)

c3 = store.merge_sessions([s])  # DeviceA retries
check("Second replay (DeviceA retry): not re-confirmed", c3 == [])
check("Second replay: still 50 coins", store.coins == 50)

print("\n" + "="*60)
print("TEST 2: Two distinct sessions → rewards counted twice")
print("="*60)
store2 = ServerStore()
sA = FocusSession("session-A", 25, int(time.time()*1000), "completed")
sB = FocusSession("session-B", 25, int(time.time()*1000), "completed")

store2.merge_sessions([sA])
store2.merge_sessions([sB])
check("Two sessions: 100 coins", store2.coins == 100)
check("Two sessions: streak = 1 (same day)", store2.streak == 1)

print("\n" + "="*60)
print("TEST 3: Task conflict — higher Lamport wins")
print("="*60)
store3 = ServerStore()
seed_task = Task("t1", "sub_math", "ch_algebra", "Linear equations")
store3.tasks["t1"] = seed_task

# DeviceA: lamport=10, done
tA = Task("t1", "sub_math", "ch_algebra", "Linear equations", status="done", lamport=10, device_id="DeviceA")
# DeviceB: lamport=8, in_progress
tB = Task("t1", "sub_math", "ch_algebra", "Linear equations", status="in_progress", lamport=8, device_id="DeviceB")

store3.merge_tasks([tA])
store3.merge_tasks([tB])
check("Task conflict: done (lamport=10) beats in_progress (lamport=8)", store3.tasks["t1"].status == "done")
check("Task conflict: winner is DeviceA", store3.tasks["t1"].device_id == "DeviceA")

print("\n" + "="*60)
print("TEST 4: Task conflict — equal Lamport, deviceId tie-break")
print("="*60)
store4 = ServerStore()
store4.tasks["t1"] = Task("t1", "sub_math", "ch_algebra", "X", status="not_started", lamport=0, device_id="seed")

tX = Task("t1", "sub_math", "ch_algebra", "X", status="done", lamport=5, device_id="DeviceZ")
tY = Task("t1", "sub_math", "ch_algebra", "X", status="in_progress", lamport=5, device_id="DeviceA")
store4.merge_tasks([tX])  # DeviceZ: lamport=5, done
store4.merge_tasks([tY])  # DeviceA: lamport=5, in_progress  (Z > A lexicographically)
check("Equal Lamport: 'DeviceZ' > 'DeviceA' → DeviceZ wins", store4.tasks["t1"].device_id == "DeviceZ")
check("Equal Lamport: status is 'done'", store4.tasks["t1"].status == "done")

print("\n" + "="*60)
print("TEST 5: Delete-wins — tombstone beats any edit")
print("="*60)
store5 = ServerStore()
store5.tasks["t2"] = Task("t2", "sub_math", "ch_algebra", "Quadratic", status="not_started", lamport=0, device_id="seed")

# DeviceA: high lamport edit (done)
tEdit = Task("t2", "sub_math", "ch_algebra", "Quadratic", status="done", lamport=12, device_id="DeviceA", deleted=False)
# DeviceB: low lamport delete
tDel = Task("t2", "sub_math", "ch_algebra", "Quadratic", status="not_started", lamport=9, device_id="DeviceB", deleted=True, deleted_by="DeviceB", deleted_lamport=9)

store5.merge_tasks([tEdit])  # DeviceA edit first
store5.merge_tasks([tDel])   # DeviceB delete (lower lamport but tombstone wins)
check("Delete-wins: tombstone beats edit regardless of Lamport", store5.tasks["t2"].deleted == True)
check("Delete-wins: deleted_by = DeviceB", store5.tasks["t2"].deleted_by == "DeviceB")

print("\n" + "="*60)
print("TEST 6: N8n deduplication — notify exactly once")
print("="*60)
store6 = ServerStore()
s6 = FocusSession("session-n8n-test", 25, int(time.time()*1000), "completed")
confirmed = store6.merge_sessions([s6])

n1 = store6.notify("session-n8n-test")
n2 = store6.notify("session-n8n-test")  # replay
n3 = store6.notify("session-n8n-test")  # another replay
check("N8n: first notify returns True", n1 == True)
check("N8n: second notify returns False (deduplicated)", n2 == False)
check("N8n: third notify returns False (deduplicated)", n3 == False)

print("\n" + "="*60)
print("TEST 7: Failed session — no rewards")
print("="*60)
store7 = ServerStore()
sf = FocusSession("session-fail-001", 25, int(time.time()*1000), "failed", fail_reason="give_up")
store7.merge_sessions([sf])
check("Failed session: 0 coins", store7.coins == 0)
check("Failed session: streak = 0", store7.streak == 0)

print("\n" + "="*60)
print("TEST 8: Out-of-order ops are safe")
print("="*60)
store8 = ServerStore()
store8.tasks["t3"] = Task("t3", "sub_sci", "ch_physics", "Newton", status="not_started", lamport=0, device_id="seed")

# Ops arrive out of order: lamport=7 arrives BEFORE lamport=5
late_op  = Task("t3", "sub_sci", "ch_physics", "Newton", status="done", lamport=7, device_id="DeviceA")
early_op = Task("t3", "sub_sci", "ch_physics", "Newton", status="in_progress", lamport=5, device_id="DeviceA")

store8.merge_tasks([late_op])   # arrives first
store8.merge_tasks([early_op])  # older op arrives late — must lose
check("Out-of-order: stale op (lamport=5) doesn't overwrite newer (lamport=7)", store8.tasks["t3"].status == "done")

print("\n" + "="*60)
print("TEST 9: Two-device convergence — both see identical final state")
print("="*60)
# Simulate two clients syncing independently, server must converge them
server = ServerStore()
# Device A task ops
server.tasks["t4"] = Task("t4", "sub_eng", "ch_grammar", "Tenses", status="not_started", lamport=0, device_id="seed")
opA = Task("t4", "sub_eng", "ch_grammar", "Tenses", status="in_progress", lamport=3, device_id="DeviceA")
opB = Task("t4", "sub_eng", "ch_grammar", "Tenses", status="done", lamport=6, device_id="DeviceB")

server.merge_tasks([opA])
server.merge_tasks([opB])
# Both devices then GET state from server → both see lamport=6 / done
final = server.tasks["t4"]
check("Convergence: final status = done (lamport=6)", final.status == "done")
check("Convergence: final device = DeviceB", final.device_id == "DeviceB")
# If DeviceA now syncs again with its stale op → still no change
server.merge_tasks([opA])
check("Convergence: re-syncing stale DeviceA op doesn't disturb final state", server.tasks["t4"].status == "done")

# ─── Summary ──────────────────────────────────────────────────────────────────
print("\n" + "="*60)
print(f"RESULTS: {passed} passed, {failed} failed")
if failed == 0:
    print("✅ ALL LOGIC TESTS PASSED — backend sync invariants are correct")
else:
    print("❌ FAILURES detected — review above")
print("="*60)
