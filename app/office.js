'use strict';
// State, persistence and lifecycle for the agent Office. No rendering, no model
// calls — runBoss/runWorker are injected (see office-runners.js for the real ones).
//
// Persistence is a single JSON file, written atomically (tmp + rename) and
// debounced so a burst of transitions costs one write. node:sqlite is not used —
// unavailable on this machine's Node (ERR_UNKNOWN_BUILTIN_MODULE) — and no
// dependency is added for what fs + JSON already does.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WRITE_DEBOUNCE_MS = 100;
const TIMED_OUT = Symbol('timeout');

// The only legal edges. Anything not listed here throws.
const TASK_EDGES = {
  queued: ['planning', 'cancelled'],
  planning: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'cancelled'],
  running: ['needs_review', 'done', 'failed', 'cancelled'],
  needs_review: ['done', 'failed', 'cancelled'],
  done: [], failed: [], cancelled: [],
};
const STEP_EDGES = {
  queued: ['working', 'cancelled'],
  working: ['needs_review', 'failed', 'cancelled'],
  needs_review: ['done', 'cancelled'],
  done: [], failed: [], cancelled: [],
};
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function transition(edges, obj, to) {
  const allowed = edges[obj.state] || [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal transition: ${obj.id} ${obj.state} -> ${to}`);
  }
  obj.state = to;
}

function createOffice({ dbPath, runBoss, runWorker, maxConcurrent = 4, stepTimeoutMs = 600000, now = Date.now }) {
  const tasks = new Map();
  const steps = new Map();
  let costLog = []; // [{amount, at}] — costToday() sums same-local-day entries

  if (dbPath && fs.existsSync(dbPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      for (const t of saved.tasks || []) tasks.set(t.id, t);
      for (const s of saved.steps || []) steps.set(s.id, s);
      costLog = saved.costLog || [];
    } catch { /* corrupt or unreadable file: start fresh rather than crash a restart */ }
  }

  // A process that died mid-step did not succeed. working -> failed is a legal
  // edge already, so rehydration reuses the normal transition function.
  for (const step of steps.values()) {
    if (step.state === 'working') {
      step.error = 'interrupted';
      step.updatedAt = now();
      transition(STEP_EDGES, step, 'failed');
    }
  }
  for (const task of tasks.values()) maybeFinishTask(task);

  let writeTimer = null;
  function scheduleWrite() {
    if (!dbPath || writeTimer) return;
    writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  }
  function flushWrite() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (!dbPath) return;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const body = JSON.stringify({ tasks: [...tasks.values()], steps: [...steps.values()], costLog });
    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dbPath);
  }

  const bus = new EventEmitter();
  function emitChange() { bus.emit('change', getState()); }

  function addCost(amount) {
    if (!amount) return;
    costLog.push({ amount, at: now() });
  }
  function costToday() {
    const today = new Date(now()).toDateString();
    let sum = 0;
    for (const e of costLog) if (new Date(e.at).toDateString() === today) sum += e.amount;
    return sum;
  }

  function maybeFinishTask(task) {
    if (!task || task.state !== 'running' || task.stepIds.length === 0) return;
    const stepObjs = task.stepIds.map((id) => steps.get(id));
    if (!stepObjs.every((s) => TERMINAL.has(s.state))) return;
    transition(TASK_EDGES, task, stepObjs.some((s) => s.state === 'failed') ? 'failed' : 'done');
    task.updatedAt = now();
  }

  // ---- boss ---------------------------------------------------------------

  async function attemptBoss(task) {
    let result;
    try {
      result = await runBoss(task.prompt);
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (result && typeof result.costUsd === 'number') {
      task.costUsd += result.costUsd;
      addCost(result.costUsd);
    }
    if (!result || !result.ok) {
      return { ok: false, error: (result && result.error) || 'boss failed', raw: result && result.output };
    }
    let plan = null;
    try { plan = JSON.parse(result.output); } catch { /* unparseable, re-parsed defensively */ }
    const stepsOk = plan && Array.isArray(plan.steps) && plan.steps.length > 0
      && plan.steps.every((s) => s && typeof s.agent === 'string' && typeof s.task === 'string');
    if (!plan || typeof plan.summary !== 'string' || !stepsOk) {
      return { ok: false, error: 'unparseable or malformed boss output', raw: result.output };
    }
    return { ok: true, plan };
  }

  async function planTask(task) {
    transition(TASK_EDGES, task, 'planning');
    task.updatedAt = now();
    emitChange();

    let attempt = await attemptBoss(task);
    if (!attempt.ok) attempt = await attemptBoss(task); // retry exactly once, never invent a plan

    if (!attempt.ok) {
      task.error = attempt.error;
      task.rawOutput = attempt.raw != null ? attempt.raw : null;
      transition(TASK_EDGES, task, 'failed');
    } else {
      task.summary = attempt.plan.summary;
      task.plan = attempt.plan;
      transition(TASK_EDGES, task, 'awaiting_approval');
    }
    task.updatedAt = now();
    emitChange();
    scheduleWrite();
  }

  // ---- scheduler ------------------------------------------------------------

  function countWorking() {
    let n = 0;
    for (const s of steps.values()) if (s.state === 'working') n++;
    return n;
  }

  function schedule() {
    let free = maxConcurrent - countWorking();
    for (const step of steps.values()) {
      if (free <= 0) break;
      if (step.state === 'queued') {
        free--;
        startStep(step).catch((e) => console.error('office.js: startStep failed unexpectedly', e));
      }
    }
  }

  async function startStep(step) {
    const task = tasks.get(step.taskId);
    transition(STEP_EDGES, step, 'working');
    step.startedAt = now();
    step.updatedAt = now();
    emitChange();
    scheduleWrite();

    let timer;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), stepTimeoutMs);
      timer.unref?.();
    });
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => runWorker(step.agent, step.task, step.skills, step.id)),
        timeoutP,
      ]);
    } catch (e) {
      result = { ok: false, error: e.message };
    } finally {
      clearTimeout(timer);
    }

    // A concurrent cancel() may already have moved this step to a terminal state.
    if (step.state !== 'working') { schedule(); return; }

    if (result === TIMED_OUT) {
      step.error = `timeout after ${stepTimeoutMs}ms`;
      transition(STEP_EDGES, step, 'failed');
    } else {
      // A failed call still cost money — accumulate before branching on ok.
      if (result && typeof result.costUsd === 'number') {
        step.costUsd += result.costUsd;
        task.costUsd += result.costUsd;
        addCost(result.costUsd);
      }
      if (result && result.ok) {
        step.output = result.output;
        transition(STEP_EDGES, step, 'needs_review');
      } else {
        step.error = (result && result.error) || 'worker failed';
        step.output = (result && result.output) || null;
        transition(STEP_EDGES, step, 'failed');
      }
    }
    step.updatedAt = now();
    maybeFinishTask(task);
    emitChange();
    scheduleWrite();
    schedule();
  }

  // ---- public API -------------------------------------------------------

  function submit(prompt) {
    const id = crypto.randomUUID();
    const t = now();
    const task = {
      id, prompt, state: 'queued', summary: null, plan: null,
      stepIds: [], error: null, rawOutput: null, costUsd: 0,
      createdAt: t, updatedAt: t,
    };
    tasks.set(id, task);
    emitChange();
    planTask(task).catch((e) => console.error('office.js: planTask failed unexpectedly', e));
    return id;
  }

  function approvePlan(taskId, approved) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.state !== 'awaiting_approval') {
      throw new Error(`cannot approve/reject task ${taskId} in state ${task.state}`);
    }
    if (!approved) {
      transition(TASK_EDGES, task, 'cancelled');
      task.updatedAt = now();
      emitChange();
      scheduleWrite();
      return;
    }
    const t = now();
    for (const s of task.plan.steps) {
      const stepId = crypto.randomUUID();
      steps.set(stepId, {
        id: stepId, taskId: task.id, agent: s.agent, task: s.task, skills: s.skills || [],
        state: 'queued', output: null, error: null, costUsd: 0,
        createdAt: t, updatedAt: t, startedAt: null,
      });
      task.stepIds.push(stepId);
    }
    transition(TASK_EDGES, task, 'running');
    task.updatedAt = t;
    emitChange();
    scheduleWrite();
    schedule();
  }

  function approveStep(stepId, approved) {
    const step = steps.get(stepId);
    if (!step) throw new Error(`unknown step ${stepId}`);
    if (step.state !== 'needs_review') {
      throw new Error(`cannot approve/reject step ${stepId} in state ${step.state}`);
    }
    transition(STEP_EDGES, step, approved ? 'done' : 'cancelled');
    step.updatedAt = now();
    maybeFinishTask(tasks.get(step.taskId));
    emitChange();
    scheduleWrite();
    schedule();
  }

  function cancelStep(step) {
    if (TERMINAL.has(step.state)) return;
    transition(STEP_EDGES, step, 'cancelled');
    step.updatedAt = now();
  }
  function cancelTask(task) {
    if (TERMINAL.has(task.state)) return;
    for (const id of task.stepIds) {
      const s = steps.get(id);
      if (s) cancelStep(s);
    }
    transition(TASK_EDGES, task, 'cancelled');
    task.updatedAt = now();
  }
  function cancel(id) {
    const task = tasks.get(id);
    if (task) {
      cancelTask(task);
      emitChange();
      scheduleWrite();
      schedule();
      return;
    }
    const step = steps.get(id);
    if (step) {
      cancelStep(step);
      maybeFinishTask(tasks.get(step.taskId));
      emitChange();
      scheduleWrite();
      schedule();
      return;
    }
    throw new Error(`unknown id ${id}`);
  }

  function getState() {
    // JSON round-trip: guarantees plain data and stops callers mutating our maps.
    return JSON.parse(JSON.stringify({
      tasks: [...tasks.values()],
      steps: [...steps.values()],
      activeCount: countWorking(),
      costToday: costToday(),
    }));
  }

  function onStream(stepId, chunk) {
    bus.emit('stream', { stepId, chunk });
  }

  function close() {
    flushWrite();
  }

  return Object.assign(bus, { submit, approvePlan, approveStep, cancel, getState, onStream, close });
}

module.exports = { createOffice };

// ------------------------------------------------------------------ self-check
if (require.main === module) {
  const assert = require('node:assert');
  const os = require('node:os');

  function waitFor(pred, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (pred()) { clearInterval(iv); resolve(); }
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('waitFor timeout')); }
      }, 5);
    });
  }

  const GOOD_PLAN = JSON.stringify({ summary: 'ship it', steps: [{ agent: 'developer', task: 'do the thing', skills: [] }] });

  (async () => {
    let n = 0;
    const dbPath = path.join(os.tmpdir(), `office-selfcheck-${process.pid}.json`);
    fs.rmSync(dbPath, { force: true });

    // 1. happy path
    {
      let bossCalls = 0, workerCalls = 0;
      const office = createOffice({
        dbPath,
        runBoss: async () => { bossCalls++; return { ok: true, output: GOOD_PLAN, costUsd: 0.01 }; },
        runWorker: async () => { workerCalls++; return { ok: true, output: 'built', costUsd: 0.02 }; },
      });
      const id = office.submit('build a thing');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      n++; assert.equal(bossCalls, 1);
      office.approvePlan(id, true);
      await waitFor(() => {
        const t = office.getState().tasks.find((x) => x.id === id);
        return t.stepIds.length === 1 && office.getState().steps.find((s) => s.id === t.stepIds[0]).state === 'needs_review';
      });
      n++; assert.equal(workerCalls, 1);
      const stepId = office.getState().tasks.find((t) => t.id === id).stepIds[0];
      office.approveStep(stepId, true);
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'done');
      n++; assert.equal(office.getState().tasks.find((t) => t.id === id).state, 'done');
      office.close();
    }

    // 2. rejecting the plan cancels the task, worker never called
    {
      let workerCalls = 0;
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: async () => { workerCalls++; return { ok: true, output: 'x', costUsd: 0 }; },
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, false);
      n++; assert.equal(office.getState().tasks.find((t) => t.id === id).state, 'cancelled');
      n++; assert.equal(workerCalls, 0);
      office.close();
    }

    // 3. invalid boss output retries exactly once, then fails, raw output preserved
    {
      let bossCalls = 0;
      const office = createOffice({
        dbPath: null,
        runBoss: async () => { bossCalls++; return { ok: true, output: 'not json', costUsd: 0 }; },
        runWorker: async () => { throw new Error('must not be called'); },
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'failed');
      n++; assert.equal(bossCalls, 2);
      const t = office.getState().tasks.find((x) => x.id === id);
      n++; assert.equal(t.state, 'failed');
      n++; assert.equal(t.rawOutput, 'not json');
      office.close();
    }

    // 4. concurrency cap
    {
      let active = 0, peak = 0;
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({
          ok: true,
          output: JSON.stringify({
            summary: 'ten steps',
            steps: Array.from({ length: 10 }, (_, i) => ({ agent: 'developer', task: `step ${i}`, skills: [] })),
          }),
          costUsd: 0,
        }),
        runWorker: async () => {
          active++; peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
          return { ok: true, output: 'ok', costUsd: 0.001 };
        },
        maxConcurrent: 2,
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      await waitFor(() => {
        const t = office.getState().tasks.find((x) => x.id === id);
        return t.stepIds.every((sid) => office.getState().steps.find((s) => s.id === sid).state === 'needs_review');
      }, 5000);
      n++; assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap`);
      office.close();
    }

    // 5. illegal transitions throw
    {
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: async () => ({ ok: true, output: 'x', costUsd: 0 }),
      });
      const id = office.submit('x');
      n++; assert.throws(() => office.approvePlan(id, true), /state queued|state planning/);
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      n++; assert.throws(() => office.approvePlan(id, true)); // already running
      const stepId = office.getState().tasks.find((t) => t.id === id).stepIds[0];
      n++; assert.throws(() => office.approveStep(stepId, true)); // still queued/working, not needs_review
      await waitFor(() => office.getState().steps.find((s) => s.id === stepId).state === 'needs_review');
      office.approveStep(stepId, true);
      n++; assert.throws(() => office.approveStep(stepId, true)); // already done
      n++; assert.throws(() => office.cancel('no-such-id'));
      office.close();
    }

    // 6. cancel mid-flight
    {
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: () => new Promise(() => {}), // never resolves
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      await waitFor(() => {
        const t = office.getState().tasks.find((x) => x.id === id);
        return t.stepIds.length === 1 && office.getState().steps.find((s) => s.id === t.stepIds[0]).state === 'working';
      });
      office.cancel(id);
      n++; assert.equal(office.getState().tasks.find((t) => t.id === id).state, 'cancelled');
      const stepId = office.getState().tasks.find((t) => t.id === id).stepIds[0];
      n++; assert.equal(office.getState().steps.find((s) => s.id === stepId).state, 'cancelled');
      office.close();
    }

    // 7. worker throws -> step failed, task failed, task not done
    {
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: async () => { throw new Error('boom'); },
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state !== 'running');
      const t = office.getState().tasks.find((x) => x.id === id);
      n++; assert.equal(t.state, 'failed');
      n++; assert.notEqual(t.state, 'done');
      office.close();
    }

    // 8. worker exceeds stepTimeoutMs
    {
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: () => new Promise(() => {}), // never resolves
        stepTimeoutMs: 30,
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'failed', 5000);
      const stepId = office.getState().tasks.find((t) => t.id === id).stepIds[0];
      const step = office.getState().steps.find((s) => s.id === stepId);
      n++; assert.equal(step.state, 'failed');
      n++; assert.match(step.error, /timeout/);
      office.close();
    }

    // 9. restart: interrupted step becomes failed
    {
      fs.rmSync(dbPath, { force: true });
      const office1 = createOffice({
        dbPath,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: () => new Promise(() => {}), // "process" dies mid-step
      });
      const id = office1.submit('x');
      await waitFor(() => office1.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office1.approvePlan(id, true);
      await waitFor(() => {
        const t = office1.getState().tasks.find((x) => x.id === id);
        return t.stepIds.length === 1 && office1.getState().steps.find((s) => s.id === t.stepIds[0]).state === 'working';
      });
      office1.close(); // flush 'working' to disk, simulating a crash

      const office2 = createOffice({
        dbPath,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: async () => ({ ok: true, output: 'x', costUsd: 0 }),
      });
      const state2 = office2.getState();
      const step2 = state2.steps.find((s) => s.taskId === id);
      n++; assert.equal(step2.state, 'failed');
      n++; assert.equal(step2.error, 'interrupted');
      n++; assert.equal(state2.tasks.find((t) => t.id === id).state, 'failed');
      office2.close();
    }

    // 10. costs accumulate on success and failure; costToday correct
    {
      fs.rmSync(dbPath, { force: true });
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({
          ok: true,
          costUsd: 0.05,
          output: JSON.stringify({
            summary: 'two steps',
            steps: [
              { agent: 'developer', task: 'a', skills: [] },
              { agent: 'developer', task: 'b', skills: [] },
            ],
          }),
        }),
        runWorker: async (agentId, instruction) =>
          instruction === 'a'
            ? { ok: true, output: 'ok', costUsd: 0.1 }
            : { ok: false, error: 'nope', costUsd: 0.2 },
      });
      const id = office.submit('x');
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state === 'awaiting_approval');
      office.approvePlan(id, true);
      // step 'a' succeeds -> needs_review (not terminal until approved); step 'b' fails outright.
      await waitFor(() => {
        const t = office.getState().tasks.find((x) => x.id === id);
        return t.stepIds.map((sid) => office.getState().steps.find((s) => s.id === sid).state)
          .every((st) => st === 'needs_review' || st === 'failed');
      });
      const okStepId = office.getState().steps.find((s) => s.taskId === id && s.state === 'needs_review').id;
      office.approveStep(okStepId, true);
      await waitFor(() => office.getState().tasks.find((t) => t.id === id).state !== 'running');
      const state = office.getState();
      const t = state.tasks.find((x) => x.id === id);
      n++; assert.equal(t.state, 'failed'); // one step failed, so the task fails even though the other was approved
      n++; assert.ok(Math.abs(t.costUsd - 0.35) < 1e-9, `task cost ${t.costUsd}`); // 0.05 boss + 0.1 + 0.2
      n++; assert.ok(Math.abs(state.costToday - 0.35) < 1e-9, `costToday ${state.costToday}`);
      office.close();
    }

    // 11. getState survives a JSON round-trip
    {
      const office = createOffice({
        dbPath: null,
        runBoss: async () => ({ ok: true, output: GOOD_PLAN, costUsd: 0 }),
        runWorker: async () => ({ ok: true, output: 'x', costUsd: 0 }),
      });
      office.submit('x');
      const state = office.getState();
      n++; assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
      office.close();
    }

    fs.rmSync(dbPath, { force: true });
    console.log(`office.js: all checks pass (${n} assertions)`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
