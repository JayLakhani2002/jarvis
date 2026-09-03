'use strict';
// The two model calls behind the Office: the boss that plans, and the workers that do.
//
// office.js owns state and never imports the SDK; this file owns the model calls and
// never owns state. That split is what lets office.js be tested with fakes for free.
//
// Two rules are enforced here rather than asked for in a prompt:
//   1. The boss cannot write. A planner able to edit files eventually stops planning
//      and just edits files.
//   2. Slice 1 workers cannot write either. Sandbox + diff approval is Slice 2; until
//      that exists, "read-only" is a capability, not a promise.

const { decide } = require('./guard');

const BOSS_MODEL = 'claude-fable-5-1';
const WORKER_MODEL = 'claude-sonnet-5';

// Tools that mutate the filesystem. Denied outright in Slice 1 — the guard's regex list
// covers dangerous *commands*, this covers the write tools the SDK exposes directly.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function readOnlyDecide(toolName, input) {
  if (WRITE_TOOLS.has(toolName)) {
    return {
      behavior: 'deny',
      message:
        `${toolName} is disabled in the Office. Agents report findings and drafts; ` +
        'file writing arrives with the sandbox + diff approval flow.',
    };
  }
  return decide(toolName, input); // then the existing draft-only boundary
}

const PLAN_SHAPE =
  '{"summary": "<one sentence>", "steps": [{"agent": "<exact id>", ' +
  '"task": "<what this agent must do>", "skills": ["<skill-name>"]}]}';

function bossPrompt(request, agentIds) {
  return [
    'You are the chief of staff of an agent office. You PLAN work. You never do the work',
    'yourself and you have no ability to edit files.',
    '',
    'Break the operator\'s request into the fewest steps that actually deliver it. Prefer one',
    'step over three. Assign each step to the single most appropriate specialist. Do not',
    'invent an agent id: every "agent" value MUST be copied exactly from the roster below.',
    'Name only skills a step genuinely needs; an empty list is fine and is better than a guess.',
    '',
    `ROSTER (${agentIds.length} agents):`,
    agentIds.join(', '),
    '',
    'OPERATOR REQUEST:',
    request,
    '',
    `Reply with ONLY this JSON object and no other text, no markdown fence:\n${PLAN_SHAPE}`,
  ].join('\n');
}

/** Pull the first balanced JSON object out of a model reply. */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Validate a plan against the roster. Returns { ok, plan } or { ok:false, error }.
 * An unknown agent id is rejected rather than repaired — a plan that names an agent
 * that does not exist is a plan the boss did not really make.
 */
function validatePlan(raw, agentIds) {
  const known = new Set(agentIds);
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'no JSON object in reply' };
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return { ok: false, error: 'missing summary' };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { ok: false, error: 'steps must be a non-empty array' };
  const steps = [];
  for (const [i, s] of raw.steps.entries()) {
    if (!s || typeof s !== 'object') return { ok: false, error: `step ${i} is not an object` };
    if (!known.has(s.agent)) return { ok: false, error: `step ${i}: unknown agent "${s.agent}"` };
    if (typeof s.task !== 'string' || !s.task.trim()) return { ok: false, error: `step ${i}: empty task` };
    const skills = Array.isArray(s.skills) ? s.skills.filter((k) => typeof k === 'string') : [];
    steps.push({ agent: s.agent, task: s.task.trim(), skills });
  }
  return { ok: true, plan: { summary: raw.summary.trim(), steps } };
}

const MAX_INPUT_FIELD = 300; // per-field truncation for tool_use.input, so a huge prompt/file body can't flood IPC
const MAX_TOOL_PREVIEW = 400; // truncation for tool_result preview text

// Truncate every string field of a tool_use input, one level deep — no redaction, the
// operator needs to see what their agent ran, just not all of it at once.
function truncateInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > MAX_INPUT_FIELD ? v.slice(0, MAX_INPUT_FIELD) : v;
  }
  return out;
}

// tool_result content is a string or an array of Messages-API blocks (text/image/...);
// only text blocks render as a preview.
function toolResultPreview(content) {
  const s = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';
  return s.length > MAX_TOOL_PREVIEW ? s.slice(0, MAX_TOOL_PREVIEW) : s;
}

/**
 * Drain an SDK query, returning collected text and cost.
 * onEvent (optional) receives one of the office:stream events as they happen:
 *   { kind:'text', text } | { kind:'thinking', text } |
 *   { kind:'tool', id, name, input } | { kind:'tool_result', id, ok, preview } |
 *   { kind:'done', costUsd, ms, turns, tokens }
 */
async function drain(q, onEvent) {
  let text = '';
  let costUsd = 0;
  let error = null;
  const emit = onEvent || (() => {});
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
          emit({ kind: 'text', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          emit({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          emit({ kind: 'tool', id: block.id, name: block.name, input: truncateInput(block.input) });
        }
      }
    } else if (msg.type === 'user') {
      // Tool results come back as a synthetic user turn (Messages API shape).
      const content = msg.message && msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            emit({
              kind: 'tool_result',
              id: block.tool_use_id,
              ok: !block.is_error,
              preview: toolResultPreview(block.content),
            });
          }
        }
      }
    } else if (msg.type === 'result') {
      if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
      if (msg.is_error) {
        // An error turn is a failed measurement — never followed by a done event with
        // numbers that describe a turn that didn't actually complete.
        error = msg.result || 'model reported an error';
      } else {
        const u = msg.usage;
        const tokens = u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
          ? { input: u.input_tokens, output: u.output_tokens }
          : null;
        emit({
          kind: 'done',
          costUsd,
          ms: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
          turns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
          tokens,
        });
      }
    }
  }
  return { text, costUsd, error };
}

/**
 * @param {object} deps
 * @param {Function} deps.query      SDK query fn (injected so this file is testable offline)
 * @param {string[]} deps.agentIds   valid agent ids from roster.js
 * @param {string}  deps.cwd
 * @param {string[]} deps.extraDirs
 * @param {Function} [deps.onStream] (stepId, event) — see drain()'s event shapes
 */
function createRunners({ query, agentIds, cwd, extraDirs = [], onStream }) {
  const base = {
    cwd,
    additionalDirectories: extraDirs,
    settingSources: ['project'],
    canUseTool: async (name, input) => readOnlyDecide(name, input),
  };

  async function runBoss(request, stepId = null) {
    let out;
    try {
      // query() can throw synchronously (bad options, transport down), so it stays
      // inside the try — a throw here must fail this call, never the whole Office.
      const q = query({
        prompt: bossPrompt(request, agentIds),
        options: {
          ...base,
          model: BOSS_MODEL,
          // Planning needs to look around, never to change anything.
          tools: { type: 'preset', preset: 'claude_code' },
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'You plan and delegate. You never implement, and you never edit files.',
          },
        },
      });
      out = await drain(q, stepId && onStream ? (event) => onStream(stepId, event) : null);
    } catch (e) {
      return { ok: false, error: `boss call failed: ${e.message}`, costUsd: 0 };
    }
    if (out.error) return { ok: false, error: out.error, costUsd: out.costUsd, output: out.text };

    const parsed = validatePlan(extractJson(out.text), agentIds);
    if (!parsed.ok) {
      // Preserve the raw reply: office.js retries once, and if it fails again the
      // operator needs to see what the boss actually said, not a summary of it.
      return { ok: false, error: `invalid plan: ${parsed.error}`, output: out.text, costUsd: out.costUsd };
    }
    return { ok: true, output: JSON.stringify(parsed.plan), costUsd: out.costUsd };
  }

  async function runWorker(agentId, instruction, skills = [], stepId = null) {
    const skillLine = skills.length
      ? `Relevant skills you may use: ${skills.join(', ')}.`
      : 'No specific skills were assigned; use your own judgement.';
    try {
      // query() stays inside the try for the same reason as runBoss above.
      const q = query({
        prompt: [
          `You are the "${agentId}" specialist in an agent office.`,
          skillLine,
          'You have READ access only. Produce findings, analysis, or a proposed patch as text.',
          'Do not attempt to write files — those tools are disabled and will be denied.',
          '',
          'TASK:',
          instruction,
        ].join('\n'),
        options: {
          ...base,
          model: WORKER_MODEL,
          tools: { type: 'preset', preset: 'claude_code' },
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      });
      const out = await drain(q, stepId && onStream ? (event) => onStream(stepId, event) : null);
      if (out.error) return { ok: false, error: out.error, output: out.text, costUsd: out.costUsd };
      if (!out.text.trim()) return { ok: false, error: 'empty output', costUsd: out.costUsd };
      return { ok: true, output: out.text, costUsd: out.costUsd };
    } catch (e) {
      return { ok: false, error: `worker call failed: ${e.message}`, costUsd: 0 };
    }
  }

  return { runBoss, runWorker };
}

module.exports = {
  createRunners, validatePlan, extractJson, readOnlyDecide,
  BOSS_MODEL, WORKER_MODEL,
};

// ------------------------------------------------------------------ self-check
if (require.main === module) {
  const assert = require('node:assert');
  const IDS = ['ceo', 'developer', 'engineering-frontend-developer'];

  // --- the boss and Slice-1 workers cannot write, whatever they try
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(readOnlyDecide(t, { file_path: '/x' }).behavior, 'deny', `${t} must be denied`);
  }
  assert.equal(readOnlyDecide('Read', { file_path: '/x' }).behavior, 'allow');
  assert.equal(readOnlyDecide('Grep', {}).behavior, 'allow');
  // the existing draft-only boundary still applies underneath
  assert.equal(readOnlyDecide('Bash', { command: 'git push origin main' }).behavior, 'deny');
  assert.equal(readOnlyDecide('Bash', { command: 'git status' }).behavior, 'allow');

  // --- JSON extraction survives the ways models actually wrap output
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' }, 'brace inside a string must not close the object');
  assert.deepEqual(extractJson('{"a":"\\""}'), { a: '"' }, 'escaped quote must not toggle string state');
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"a":'), null, 'truncated JSON is not a plan');

  // --- plan validation
  const good = { summary: 'do it', steps: [{ agent: 'ceo', task: 'decide', skills: ['x'] }] };
  assert.equal(validatePlan(good, IDS).ok, true);
  assert.equal(validatePlan({ ...good, steps: [{ agent: 'nope', task: 't' }] }, IDS).ok, false,
    'an unknown agent id must be rejected, never repaired');
  assert.equal(validatePlan({ summary: '', steps: good.steps }, IDS).ok, false);
  assert.equal(validatePlan({ summary: 's', steps: [] }, IDS).ok, false);
  assert.equal(validatePlan(null, IDS).ok, false);
  assert.deepEqual(validatePlan({ summary: 's', steps: [{ agent: 'ceo', task: 't' }] }, IDS).plan.steps[0].skills,
    [], 'missing skills becomes an empty list, not undefined');

  // --- runners drive the injected query and never touch the network here
  const fakeQuery = ({ options }) => {
    const reply = options.model === BOSS_MODEL
      ? JSON.stringify(good)
      : 'worker findings';
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } };
      yield { type: 'result', total_cost_usd: 0.02, is_error: false };
    })();
  };
  const seen = [];
  const r = createRunners({
    query: (a) => { seen.push(a.options.model); return fakeQuery(a); },
    agentIds: IDS, cwd: '/tmp',
  });

  (async () => {
    const b = await r.runBoss('ship the thing');
    assert.equal(b.ok, true);
    assert.equal(JSON.parse(b.output).steps[0].agent, 'ceo');
    assert.equal(b.costUsd, 0.02);
    assert.equal(seen[0], BOSS_MODEL, 'boss must run on Fable 5.1');

    const w = await r.runWorker('developer', 'look at the code', []);
    assert.equal(w.ok, true);
    assert.equal(seen[1], WORKER_MODEL, 'workers must run on Sonnet 5');

    // a model that errors is a failed measurement, never a result
    const errRunners = createRunners({
      query: () => (async function* () {
        yield { type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.01 };
      })(),
      agentIds: IDS, cwd: '/tmp',
    });
    assert.equal((await errRunners.runBoss('x')).ok, false);
    assert.equal((await errRunners.runWorker('ceo', 'x')).ok, false);

    // an empty worker reply is a failure, not a silent success
    const emptyRunners = createRunners({
      query: () => (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } };
        yield { type: 'result', total_cost_usd: 0 };
      })(),
      agentIds: IDS, cwd: '/tmp',
    });
    assert.equal((await emptyRunners.runWorker('ceo', 'x')).ok, false);

    // a thrown SDK error is caught, not propagated into the state machine
    const throwRunners = createRunners({
      query: () => { throw new Error('socket hang up'); },
      agentIds: IDS, cwd: '/tmp',
    });
    assert.equal((await throwRunners.runWorker('ceo', 'x')).ok, false);

    // --- drain() streams the new event contract: text, tool, tool_result, done, in order
    const longCmd = 'x'.repeat(500);
    const events = [];
    const stream = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] } };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: longCmd } }] },
      };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] },
      };
      yield {
        type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05,
        duration_ms: 1200, num_turns: 2, usage: { input_tokens: 10, output_tokens: 20 },
      };
    })();
    const out = await drain(stream, (e) => events.push(e));
    assert.equal(out.text, 'looking', 'accumulated .text must still equal the concatenated text deltas');
    assert.equal(out.costUsd, 0.05);
    assert.equal(out.error, null);
    assert.deepEqual(events.map((e) => e.kind), ['text', 'tool', 'tool_result', 'done']);
    assert.equal(events[1].name, 'Bash');
    assert.equal(events[1].input.command.length, 300, 'a >300-char input string must be truncated');
    assert.equal(events[2].ok, true);
    assert.equal(events[2].preview, 'ok');
    assert.deepEqual(events[3], { kind: 'done', costUsd: 0.05, ms: 1200, turns: 2, tokens: { input: 10, output: 20 } });

    // tokens is null when the SDK gives no usage on the result — never invented
    const noUsageEvents = [];
    await drain((async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 5, num_turns: 1 };
    })(), (e) => noUsageEvents.push(e));
    assert.deepEqual(noUsageEvents.map((e) => e.kind), ['done']);
    assert.equal(noUsageEvents[0].tokens, null);

    // an error result returns ok:false and must never emit a bogus done
    const errEvents = [];
    const errOut = await drain((async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', total_cost_usd: 0.01 };
    })(), (e) => errEvents.push(e));
    assert.equal(errOut.error, 'boom');
    assert.deepEqual(errEvents, [], 'an error result must never emit a done event');

    // runWorker tags every event with its stepId
    const workerStreamed = [];
    const streamingRunners = createRunners({
      query: () => (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      })(),
      agentIds: IDS, cwd: '/tmp',
      onStream: (stepId, event) => workerStreamed.push([stepId, event.kind]),
    });
    await streamingRunners.runWorker('ceo', 'x', [], 'step-1');
    assert.deepEqual(workerStreamed, [['step-1', 'text'], ['step-1', 'done']]);

    // runBoss streams too when given a stepId, and stays silent without one (unchanged signature)
    const bossStreamed = [];
    const bossStreamRunners = createRunners({
      query: () => (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(good) }] } };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
      })(),
      agentIds: IDS, cwd: '/tmp',
      onStream: (stepId, event) => bossStreamed.push([stepId, event.kind]),
    });
    await bossStreamRunners.runBoss('ship it', 'plan-1');
    assert.deepEqual(bossStreamed, [['plan-1', 'text'], ['plan-1', 'done']]);

    const silentBossRunners = createRunners({
      query: () => (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 0, duration_ms: 0 };
      })(),
      agentIds: IDS, cwd: '/tmp',
      onStream: () => { throw new Error('must not stream when runBoss is called with no stepId'); },
    });
    await silentBossRunners.runBoss('ship it'); // no stepId → no streaming, existing callers untouched

    console.log('office-runners.js: all checks pass');
  })().catch((e) => { console.error(e); process.exit(1); });
}
