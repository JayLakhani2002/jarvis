// End-to-end: roster -> runners -> engine, driven by a FAKE SDK query so it costs
// nothing and needs no network. The unit self-checks cover each module alone; this
// covers the seam between them, and specifically the one guarantee that matters most:
// NO worker runs before the operator approves the plan.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert');
const { loadRoster } = require('./roster');
const { createRunners, BOSS_MODEL, WORKER_MODEL } = require('./office-runners');
const { createOffice } = require('./office');

const roster = loadRoster();
const agentIds = roster.agents.map(a => a.id);
const models = [];

// Fake SDK: boss returns a plan naming two REAL agents; workers return findings.
const fakeQuery = ({ options }) => {
  models.push(options.model);
  const boss = options.model === BOSS_MODEL;
  const text = boss
    ? JSON.stringify({ summary: 'Audit the eval harness',
        steps: [ { agent: 'engineering-code-reviewer', task: 'review bin/rag_eval.py', skills: [] },
                 { agent: 'tester', task: 'propose edge cases', skills: [] } ] })
    : 'findings: looks fine';
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result', total_cost_usd: 0.05, is_error: false };
  })();
};

const dbPath = path.join(os.tmpdir(), 'office-integration.json');
fs.rmSync(dbPath, { force: true });

const runners = createRunners({ query: fakeQuery, agentIds, cwd: process.cwd() });
const office = createOffice({ dbPath, runBoss: runners.runBoss, runWorker: runners.runWorker, maxConcurrent: 4 });

const changes = [];
office.on('change', () => changes.push(office.getState().tasks[0].state));

(async () => {
  const taskId = await office.submit('Audit the eval harness');
  await new Promise(r => setTimeout(r, 60));
  let s = office.getState();
  assert.equal(s.tasks[0].state, 'awaiting_approval', 'must stop for approval, got ' + s.tasks[0].state);
  assert.equal(s.steps.length, 0, 'NO steps may exist before approval');
  console.log('1. boss planned, gated on approval  ✓   model=' + models[0]);

  await office.approvePlan(taskId, true);
  await new Promise(r => setTimeout(r, 200));
  s = office.getState();
  assert.equal(s.steps.length, 2, 'two steps expected');
  assert(s.steps.every(x => x.state === 'needs_review'), 'steps -> needs_review, got ' + s.steps.map(x=>x.state));
  assert(agentIds.includes(s.steps[0].agent), 'step agent must be a real charter');
  console.log('2. workers ran -> needs_review       ✓   model=' + models[1]);

  for (const st of s.steps) await office.approveStep(st.id, true);
  await new Promise(r => setTimeout(r, 60));
  s = office.getState();
  assert.equal(s.tasks[0].state, 'done', 'task should be done, got ' + s.tasks[0].state);
  console.log('3. operator approved -> task done    ✓   cost=$' + s.tasks[0].costUsd.toFixed(2));

  assert.equal(models[0], BOSS_MODEL, 'boss must be Fable 5.1');
  assert(models.slice(1).every(m => m === WORKER_MODEL), 'workers must be Sonnet 5');
  console.log('4. model routing correct            ✓   boss=' + BOSS_MODEL + ' workers=' + WORKER_MODEL);

  office.close();
  const reopened = createOffice({ dbPath, runBoss: runners.runBoss, runWorker: runners.runWorker });
  assert.equal(reopened.getState().tasks[0].state, 'done', 'state must survive restart');
  console.log('5. survived restart                 ✓   ' + reopened.getState().steps.length + ' steps rehydrated');
  reopened.close();
  fs.rmSync(dbPath, { force: true });
  console.log('\nintegration: all checks pass');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
