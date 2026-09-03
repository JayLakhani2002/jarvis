'use strict';
/*
 * Office — a procedurally-drawn top-down floorplan (no image assets).
 * Plain classic script (no require/import), shares the global scope with
 * app.js via <script src>. Wrapped in an IIFE only to avoid leaking helper
 * names into that shared scope.
 *
 * Layout: 32px grid units. `desk` coords on an agent are GLOBAL grid coords
 * (already placed inside their room), matching the roster shape in the spec.
 *
 * File is split in two halves:
 *   1. Pure geometry/state-resolution functions — no DOM, reusable by the
 *      self-test (runnable via `node -e`) and by the renderer below.
 *   2. DOM/canvas wiring — guarded so requiring this file in Node is a no-op
 *      beyond exposing part 1.
 */
(function () {
  // ==========================================================================
  // 1. Pure logic — grid math, status resolution, hit-testing. No DOM here.
  // ==========================================================================

  const GRID = 32;

  function gridToPixel(gx, gy) {
    return { x: gx * GRID, y: gy * GRID };
  }

  // Single source of truth for "where does this agent's avatar sit" — used by
  // both the renderer (to draw it) and hit-testing (to click it). Keeping one
  // function means the click target can never drift from the drawn position.
  function agentAvatarCenter(agent) {
    const p = gridToPixel(agent.desk.x, agent.desk.y);
    return { x: p.x, y: p.y - 8 };
  }

  function roomCenterPixel(room) {
    return gridToPixel(room.x + room.w / 2, room.y + room.h / 2);
  }

  function findRoomByName(rooms, name) {
    const n = String(name).toLowerCase();
    return (rooms || []).find((r) => String(r.name || '').toLowerCase() === n) || null;
  }

  // The spec's step/task field names (`instruction`, `planJson`) are the
  // documented contract and stay primary; these fall back to the sibling
  // field names (`task`, `plan`) actually emitted by app/office.js's state
  // machine, so the panel still renders real instruction/plan text either way.
  function stepInstruction(step) {
    return step.instruction != null ? step.instruction : step.task;
  }
  function taskPlan(task) {
    return task.planJson != null ? task.planJson : task.plan;
  }

  function findAgentForStep(step, agents) {
    return (agents || []).find((a) => a.id === step.agent || a.name === step.agent) || null;
  }

  function stepMatchesAgent(step, agent) {
    return step.agent === agent.id || step.agent === agent.name;
  }

  // Steps are assumed chronological (appended in order); the agent's current
  // status is whatever their most recent step says.
  function latestStepForAgent(steps, agent) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (stepMatchesAgent(steps[i], agent)) return steps[i];
    }
    return null;
  }

  // The five drawable statuses. TOTAL over any input: every possible raw
  // step.state (known or not) resolves to exactly one of these, so the
  // status->shape map below can never be asked to draw "nothing".
  const AGENT_STATES = ['idle', 'working', 'streaming', 'needs_review', 'failed'];

  function resolveStepStatus(rawState) {
    switch (rawState) {
      case 'working': return 'working';
      case 'streaming': return 'streaming';
      case 'needs_review': return 'needs_review';
      case 'failed': return 'failed';
      default: return 'idle'; // covers undefined, 'queued', 'done', 'cancelled', anything else
    }
  }

  function agentStatus(agent, steps) {
    const step = latestStepForAgent(steps || [], agent);
    return step ? resolveStepStatus(step.state) : 'idle';
  }

  // Shape name per status — never color alone. Distinct shapes, colors added
  // at draw time. `shapeForStatus` is total: unknown status still returns the
  // idle shape rather than undefined.
  const STATUS_SHAPE = {
    idle: 'ring-hollow',
    working: 'ring-pulse',
    streaming: 'dots-three',
    needs_review: 'square-filled',
    failed: 'triangle-filled',
  };
  function shapeForStatus(status) {
    return STATUS_SHAPE[status] || STATUS_SHAPE.idle;
  }

  function roomIsActive(room, agents, steps) {
    for (const a of agents) {
      if (a.roomId !== room.id) continue;
      const st = agentStatus(a, steps);
      if (st === 'working' || st === 'streaming') return true;
    }
    return false;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // Pan bounds: keeps the whole floor reachable but stops the camera from
  // drifting off into empty space beyond a small margin.
  function clampCamera(cam, boundsPxW, boundsPxH, viewW, viewH) {
    const margin = 200;
    const minX = -margin;
    const minY = -margin;
    const maxX = Math.max(minX, boundsPxW - viewW / cam.zoom + margin);
    const maxY = Math.max(minY, boundsPxH - viewH / cam.zoom + margin);
    cam.x = clamp(cam.x, minX, maxX);
    cam.y = clamp(cam.y, minY, maxY);
  }

  function screenToWorld(cssX, cssY, camera) {
    return { x: cssX / camera.zoom + camera.x, y: cssY / camera.zoom + camera.y };
  }

  const HIT_RADIUS = 16;
  function hitTestAgent(agents, worldX, worldY) {
    let best = null;
    let bestDist = HIT_RADIUS;
    for (const a of agents) {
      const c = agentAvatarCenter(a);
      const dx = c.x - worldX;
      const dy = c.y - worldY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= bestDist) { bestDist = d; best = a; }
    }
    return best;
  }

  function __selftest() {
    const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };

    // grid -> pixel
    const p = gridToPixel(2, 3);
    assert(p.x === 64 && p.y === 96, 'gridToPixel converts grid units to 32px pixels');

    // fake roster
    const rooms = [
      { id: 'corner', name: 'Corner Office', x: 0, y: 0, w: 4, h: 4 },
      { id: 'eng', name: 'Engineering', x: 5, y: 0, w: 6, h: 6 },
    ];
    const agents = [
      { id: 'a1', name: 'Ada', dept: 'Engineering', roomId: 'eng', desk: { x: 6, y: 1 } },
      { id: 'a2', name: 'Bo', dept: 'Engineering', roomId: 'eng', desk: { x: 8, y: 3 } },
    ];
    const steps = [
      { id: 's1', taskId: 't1', agent: 'a1', instruction: 'do x', state: 'working', output: '', error: null, costUsd: 0.01 },
    ];

    // status -> shape map is total: every known state AND unknown ones resolve
    // to a real, non-empty shape name.
    [
      'idle', 'working', 'streaming', 'needs_review', 'failed',
      'queued', 'done', 'cancelled', 'bogus', undefined,
    ].forEach((raw) => {
      const shape = shapeForStatus(resolveStepStatus(raw));
      assert(typeof shape === 'string' && shape.length > 0, 'status->shape total for state=' + raw);
    });
    const distinctShapes = new Set(Object.values(STATUS_SHAPE));
    assert(distinctShapes.size === Object.keys(STATUS_SHAPE).length, 'all status shapes are pairwise distinct');
    assert(Object.keys(STATUS_SHAPE).length === AGENT_STATES.length, 'shape map covers every agent state');

    // agent status resolution from steps
    assert(agentStatus(agents[0], steps) === 'working', 'agent with a working step resolves to working');
    assert(agentStatus(agents[1], steps) === 'idle', 'agent with no steps resolves to idle');

    // room heat resolution
    assert(roomIsActive(rooms[1], agents, steps) === true, 'room containing a working agent is active');
    assert(roomIsActive(rooms[0], agents, steps) === false, 'room with no working agents is not active');

    // click hit-testing resolves to the correct agent, at the drawn position
    const c1 = agentAvatarCenter(agents[0]);
    const hit1 = hitTestAgent(agents, c1.x, c1.y);
    assert(hit1 && hit1.id === 'a1', 'hit test at a1 avatar center resolves to a1');
    const c2 = agentAvatarCenter(agents[1]);
    const hit2 = hitTestAgent(agents, c2.x + 4, c2.y - 3);
    assert(hit2 && hit2.id === 'a2', 'hit test near a2 avatar center resolves to a2');
    const miss = hitTestAgent(agents, -5000, -5000);
    assert(miss === null, 'hit test far from any desk resolves to nothing');

    // screen <-> world camera transform
    const cam = { x: 100, y: 50, zoom: 2 };
    const w = screenToWorld(40, 20, cam);
    assert(Math.abs(w.x - 120) < 1e-9 && Math.abs(w.y - 60) < 1e-9, 'screenToWorld applies pan+zoom correctly');

    // pan clamps to keep the floor reachable without drifting into the void
    const cam2 = { x: -9999, y: 9999, zoom: 1 };
    clampCamera(cam2, 800, 600, 400, 300);
    assert(cam2.x >= -200 && cam2.y <= 600 - 300 + 200, 'clampCamera keeps camera within a margin of the floor bounds');

    // room / agent lookups used by the delegation beam
    const corner = findRoomByName(rooms, 'corner office');
    assert(corner && corner.id === 'corner', 'findRoomByName is case-insensitive');
    const stepAgent = findAgentForStep(steps[0], agents);
    assert(stepAgent && stepAgent.id === 'a1', 'findAgentForStep resolves the step.agent id back to a roster agent');

    // instruction/plan field fallback: the documented contract name wins,
    // the real backend's sibling field name (task/plan) is the fallback.
    assert(stepInstruction({ instruction: 'do x', task: 'ignored' }) === 'do x', 'stepInstruction prefers the documented field');
    assert(stepInstruction({ task: 'do y' }) === 'do y', 'stepInstruction falls back to the real backend field');
    assert(taskPlan({ planJson: { a: 1 }, plan: { b: 2 } }).a === 1, 'taskPlan prefers the documented field');
    assert(taskPlan({ plan: { b: 2 } }).b === 2, 'taskPlan falls back to the real backend field');

    // perf sanity: pure per-agent status resolution stays cheap at 84-agent
    // scale — this is the hot path re-run every draw() call.
    const manyAgents = Array.from({ length: 84 }, (_, i) => ({
      id: 'g' + i, name: 'Agent ' + i, dept: 'Eng', roomId: 'eng',
      desk: { x: i % 12, y: Math.floor(i / 12) },
    }));
    const manySteps = manyAgents.slice(0, 40).map((a, i) => ({
      id: 'gs' + i, taskId: 't1', agent: a.id, instruction: 'x',
      state: i % 3 === 0 ? 'working' : i % 3 === 1 ? 'streaming' : 'needs_review',
      output: '', error: null, costUsd: 0,
    }));
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      for (const a of manyAgents) agentStatus(a, manySteps);
    }
    const dt = Date.now() - t0;
    assert(dt < 1000, 'resolving status for 84 agents, 1000x, stays cheap (' + dt + 'ms for 84000 calls)');

    console.log('office renderer: all checks pass');
  }

  // ==========================================================================
  // 2. DOM / canvas wiring. Guarded so `require`-ing this file in plain Node
  //    (for the self-test) never touches `window`/`document`.
  // ==========================================================================
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
    const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";
    const COLOR = {
      bg: '#020617', panel: '#0f172a', raised: '#1e293b', line: '#1e293b',
      text: '#f8fafc', dim: '#94a3b8', muted: '#64748b',
      cyan: '#22d3ee', amber: '#f59e0b', green: '#22c55e', red: '#f43f5e',
    };
    const STATUS_TEXT_COLOR = {
      idle: COLOR.dim, working: COLOR.amber, streaming: COLOR.cyan,
      needs_review: COLOR.green, failed: COLOR.red,
    };
    const TAU = Math.PI * 2;
    const DESK_W = 30, DESK_H = 16;
    const BEAM_MS = 600;
    const PULSE_MS = 1400;
    const PAN_STEP = 48;

    function withAlpha(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function roundRectPath(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    const canvas = document.getElementById('office-canvas');
    const listTable = document.getElementById('office-list');
    const panel = document.getElementById('office-panel');
    const ctx = canvas ? canvas.getContext('2d') : null;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = motionQuery.matches;
    motionQuery.addEventListener('change', (e) => { reducedMotion = e.matches; draw(); });

    let booted = false;
    let roster = null;      // { rooms, agents, bounds }
    let appState = null;    // { tasks, steps, activeCount, costToday }
    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let camera = { x: 0, y: 0, zoom: 1 };

    let hoverAgentId = null;
    let focusedAgentId = null;
    let selected = null;    // { kind: 'agent'|'task', id }
    let panelOutputEl = null; // <pre> currently receiving live stream deltas
    let listMode = false;

    let dragging = false, dragged = false, dragStart = null, camStart = null;

    let animations = [];    // [{ kind:'beam', x1,y1,x2,y2, start }]
    let rafHandle = null;
    const prevStepState = new Map(); // stepId -> last-seen state, to detect entry into 'working'
    const lastChunkAt = new Map();   // stepId -> performance.now() of most recent stream chunk
    const STREAM_WINDOW_MS = 1200;   // recent chunk => draw as streaming instead of plain working

    // The real backend (app/office.js) never sets step.state to 'streaming' —
    // 'working' covers both "assigned, thinking" and "actively producing
    // output". We infer the distinction from stream-chunk recency so the
    // three-dots shape means something real rather than being dead code.
    function liveStatus(agent, steps, now) {
      const step = latestStepForAgent(steps, agent);
      if (!step) return 'idle';
      const base = resolveStepStatus(step.state);
      if (base === 'working') {
        const last = lastChunkAt.get(step.id);
        if (last != null && now - last < STREAM_WINDOW_MS) return 'streaming';
      }
      return base;
    }

    // ---------------- boot (lazy — the Office view triggers this) ----------------

    document.addEventListener('view:change', (e) => { if (e.detail === 'office') boot(); });

    async function boot() {
      if (booted || !canvas || !ctx) return;
      booted = true;

      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      try {
        roster = await window.office.roster();
      } catch {
        roster = { rooms: [], agents: [], bounds: { w: 40, h: 30 } };
      }
      cacheAgentLabels();
      focusedAgentId = roster.agents[0] ? roster.agents[0].id : null;

      try {
        appState = await window.office.state();
      } catch {
        appState = { tasks: [], steps: [], activeCount: 0, costToday: 0 };
      }
      primeStepCache();

      window.office.onChange(handleChange);
      window.office.onStream(handleStream);

      wireInputEvents();
      updateMeters();
      maybeAutoOpenApproval(appState.tasks || []);
      draw();
    }

    function cacheAgentLabels() {
      for (const a of roster.agents) {
        a.label = a.name.length > 14 ? a.name.slice(0, 13) + '…' : a.name;
      }
      if (ctx) {
        ctx.font = '500 10px ' + MONO;
        for (const a of roster.agents) a.labelWidth = ctx.measureText(a.label).width;
      }
    }

    function primeStepCache() {
      for (const s of (appState.steps || [])) prevStepState.set(s.id, s.state);
    }

    // ---------------- state updates ----------------

    function handleChange(s) {
      appState = s || appState;
      detectNewWorkAndBeam(appState.steps || []);
      maybeAutoOpenApproval(appState.tasks || []);
      updateMeters();
      if (listMode) renderList();
      if (selected) renderPanel();
      draw();
      if (!reducedMotion && (hasWorkingSteps() || animations.length)) ensureLoop();
    }

    function handleStream(d) {
      // Real payload (app/office.js: bus.emit('stream', { stepId, chunk }),
      // forwarded verbatim by main.js) — not specified in the contract, so
      // this aligns to the concrete shape rather than guessing one.
      if (!d || !appState || !d.stepId) return;
      const { stepId, chunk } = d;
      lastChunkAt.set(stepId, performance.now());
      if (chunk) {
        const step = (appState.steps || []).find((s) => s.id === stepId);
        if (step) step.output = (step.output || '') + chunk;
        if (panelOutputEl && selected && selected.kind === 'agent') {
          const agent = roster.agents.find((a) => a.id === selected.id);
          const current = agent && latestStepForAgent(appState.steps || [], agent);
          if (current && current.id === stepId) {
            panelOutputEl.textContent += chunk;
            panelOutputEl.scrollTop = panelOutputEl.scrollHeight;
          }
        }
      }
      // A chunk means this step is live right now — make sure the
      // streaming-dots shape (see liveStatus) gets drawn and keeps ticking.
      if (!reducedMotion) ensureLoop();
      draw();
    }

    function hasWorkingSteps() {
      return !!(appState && (appState.steps || []).some((s) => s.state === 'working'));
    }

    function detectNewWorkAndBeam(steps) {
      for (const step of steps) {
        const prev = prevStepState.get(step.id);
        if (prev !== 'working' && step.state === 'working' && !reducedMotion) {
          const agent = findAgentForStep(step, roster.agents);
          if (agent) startBeam(agent);
        }
        prevStepState.set(step.id, step.state);
      }
    }

    function startBeam(agent) {
      const corner = findRoomByName(roster.rooms, 'Corner Office') || roster.rooms[0];
      if (!corner) return;
      const from = roomCenterPixel(corner);
      const to = agentAvatarCenter(agent);
      animations.push({ kind: 'beam', x1: from.x, y1: from.y, x2: to.x, y2: to.y, start: performance.now() });
      ensureLoop();
    }

    // The approval gate is the thing that must never be missed: surface it
    // automatically the moment a task needs a decision, unless the operator
    // is already looking at something else.
    function maybeAutoOpenApproval(tasks) {
      if (selected) return;
      const pending = tasks.find((t) => t.state === 'awaiting_approval');
      if (pending) {
        selected = { kind: 'task', id: pending.id };
        showPanel();
        renderPanel();
      }
    }

    function updateMeters() {
      const activeEl = document.getElementById('office-active');
      const burnEl = document.getElementById('office-burn');
      if (activeEl) activeEl.textContent = (appState.activeCount || 0) + ' working';
      if (burnEl) burnEl.textContent = '$' + (appState.costToday || 0).toFixed(2) + ' today';
    }

    // ---------------- animation loop — only runs while something moves ----------------

    function ensureLoop() {
      if (rafHandle != null) return;
      rafHandle = requestAnimationFrame(tick);
    }

    function tick(now) {
      rafHandle = null;
      animations = animations.filter((a) => now - a.start < BEAM_MS);
      draw(now);
      if (!reducedMotion && (hasWorkingSteps() || animations.length)) {
        rafHandle = requestAnimationFrame(tick);
      }
    }

    // ---------------- draw ----------------

    function draw(now) {
      if (!ctx || !roster) return;
      now = now || performance.now();
      const w = canvas.clientWidth, h = canvas.clientHeight;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLOR.bg;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-camera.x, -camera.y);

      const steps = (appState && appState.steps) || [];
      for (const room of roster.rooms) drawRoom(room, roomIsActive(room, roster.agents, steps));
      for (const agent of roster.agents) drawAgent(agent, steps, now);
      drawBeams(now);

      ctx.restore();
    }

    function drawRoom(room, isActive) {
      const x = room.x * GRID, y = room.y * GRID, w = room.w * GRID, h = room.h * GRID;
      ctx.globalAlpha = isActive ? 1 : 0.45;
      roundRectPath(ctx, x, y, w, h, 10);
      ctx.fillStyle = COLOR.panel;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLOR.line;
      ctx.stroke();
      if (isActive) {
        roundRectPath(ctx, x + 2, y + 2, w - 4, h - 4, 9);
        ctx.strokeStyle = withAlpha(COLOR.cyan, 0.35);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLOR.dim;
      ctx.font = '600 11px ' + MONO;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(room.name, x + 10, y + 8);
    }

    function drawAgent(agent, steps, now) {
      const status = liveStatus(agent, steps, now);
      const p = gridToPixel(agent.desk.x, agent.desk.y);
      const deskX = p.x - DESK_W / 2, deskY = p.y;
      const ac = agentAvatarCenter(agent);

      // chair
      ctx.beginPath();
      ctx.arc(p.x, deskY + DESK_H + 5, 5, 0, Math.PI, false);
      ctx.strokeStyle = COLOR.line;
      ctx.lineWidth = 2;
      ctx.stroke();

      // desk (1px darker edge for flat-shaded depth)
      ctx.fillStyle = COLOR.raised;
      ctx.strokeStyle = COLOR.panel;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(deskX, deskY, DESK_W, DESK_H);
      ctx.fill();
      ctx.stroke();

      // monitor
      const monW = 10, monH = 7;
      ctx.fillStyle = (status === 'working' || status === 'streaming') ? withAlpha(COLOR.cyan, 0.55) : '#0b1220';
      ctx.fillRect(p.x - monW / 2, deskY - monH + 2, monW, monH);
      ctx.strokeStyle = COLOR.panel;
      ctx.strokeRect(p.x - monW / 2, deskY - monH + 2, monW, monH);

      // avatar: head + body capsule, ~14px tall
      ctx.beginPath();
      ctx.arc(ac.x, ac.y - 5, 3.4, 0, TAU);
      ctx.fillStyle = '#cbd5e1';
      ctx.fill();
      roundRectPath(ctx, ac.x - 4, ac.y - 1, 8, 8, 3);
      ctx.fillStyle = '#94a3b8';
      ctx.fill();

      drawStatusMark(status, ac.x + 7, ac.y - 7, now);

      if (hoverAgentId === agent.id || (selected && selected.kind === 'agent' && selected.id === agent.id)) {
        ctx.beginPath();
        ctx.arc(ac.x, ac.y - 2, 12, 0, TAU);
        ctx.strokeStyle = COLOR.cyan;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (focusedAgentId === agent.id && document.activeElement === canvas) {
        ctx.beginPath();
        ctx.arc(ac.x, ac.y - 2, 15, 0, TAU);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = COLOR.cyan;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      drawNametag(agent, ac.x, ac.y - 22, status);
    }

    // STATUS — shape carries the meaning, color is a reinforcement only.
    // idle = hollow circle · working = filled circle + expanding ring ·
    // streaming = three dots · needs_review = filled square · failed = triangle.
    function drawStatusMark(status, cx, cy, now) {
      switch (status) {
        case 'idle':
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, TAU);
          ctx.strokeStyle = COLOR.muted;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          break;
        case 'working': {
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, TAU);
          ctx.fillStyle = COLOR.amber;
          ctx.fill();
          const t = reducedMotion ? 0.5 : ((now % PULSE_MS) / PULSE_MS);
          ctx.beginPath();
          ctx.arc(cx, cy, 5 + t * 7, 0, TAU);
          ctx.strokeStyle = withAlpha(COLOR.amber, 0.7 * (1 - t));
          ctx.lineWidth = 1.5;
          ctx.stroke();
          break;
        }
        case 'streaming':
          ctx.fillStyle = COLOR.cyan;
          for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.arc(cx + i * 5, cy, 1.6, 0, TAU);
            ctx.fill();
          }
          break;
        case 'needs_review':
          ctx.fillStyle = COLOR.green;
          ctx.fillRect(cx - 4, cy - 4, 8, 8);
          break;
        case 'failed':
          ctx.beginPath();
          ctx.moveTo(cx, cy - 5);
          ctx.lineTo(cx + 5, cy + 4);
          ctx.lineTo(cx - 5, cy + 4);
          ctx.closePath();
          ctx.fillStyle = COLOR.red;
          ctx.fill();
          break;
      }
    }

    function drawNametag(agent, cx, y, status) {
      ctx.font = '500 10px ' + MONO;
      const textW = agent.labelWidth != null ? agent.labelWidth : ctx.measureText(agent.label).width;
      const padX = 6, h = 14;
      const w = textW + padX * 2;
      const x = cx - w / 2;
      roundRectPath(ctx, x, y, w, h, 7);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.85)';
      ctx.fill();
      ctx.fillStyle = STATUS_TEXT_COLOR[status] || COLOR.dim;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(agent.label, cx, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
    }

    function drawBeams(now) {
      for (const b of animations) {
        if (b.kind !== 'beam') continue;
        const t = Math.min(1, (now - b.start) / BEAM_MS);
        const ex = b.x1 + (b.x2 - b.x1) * t;
        const ey = b.y1 + (b.y2 - b.y1) * t;
        ctx.beginPath();
        ctx.moveTo(b.x1, b.y1);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = withAlpha(COLOR.cyan, 1 - t * 0.5);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    function resizeCanvas() {
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      draw();
    }

    function clampToFloor() {
      if (!roster) return;
      clampCamera(camera, roster.bounds.w * GRID, roster.bounds.h * GRID, canvas.clientWidth, canvas.clientHeight);
    }

    function zoomAt(cssX, cssY, factor) {
      const before = screenToWorld(cssX, cssY, camera);
      camera.zoom = clamp(camera.zoom * factor, 0.5, 2.5);
      camera.x = before.x - cssX / camera.zoom;
      camera.y = before.y - cssY / camera.zoom;
      clampToFloor();
      draw();
    }

    // ---------------- selection / panel ----------------

    function selectAgent(agent) {
      selected = { kind: 'agent', id: agent.id };
      focusedAgentId = agent.id;
      showPanel();
      renderPanel();
      draw();
    }

    function clearSelection() {
      selected = null;
      panelOutputEl = null;
      hidePanel();
      draw();
    }

    function showPanel() { if (panel) panel.hidden = false; }
    function hidePanel() { if (panel) panel.hidden = true; }

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function renderPanel() {
      if (!panel || !selected) return;
      panel.replaceChildren();
      panelOutputEl = null;
      if (selected.kind === 'agent') renderAgentPanel();
      else if (selected.kind === 'task') renderTaskPanel();
    }

    function renderAgentPanel() {
      const agent = roster.agents.find((a) => a.id === selected.id);
      if (!agent) { clearSelection(); return; }
      const steps = (appState && appState.steps) || [];
      const step = latestStepForAgent(steps, agent);
      const status = liveStatus(agent, steps, performance.now());

      panel.appendChild(el('h3', 'panel-title', agent.name));
      panel.appendChild(el('div', 'panel-sub', agent.dept + (agent.model ? ' · ' + agent.model : '')));
      panel.appendChild(el('div', 'panel-status status-' + status, status.replace('_', ' ')));

      panel.appendChild(el('div', 'panel-label', 'Instruction'));
      panel.appendChild(el('p', 'panel-text', (step && stepInstruction(step)) || 'No active instruction.'));

      panel.appendChild(el('div', 'panel-label', 'Output'));
      const outputEl = el('pre', 'panel-output', (step && step.output) || '—');
      panel.appendChild(outputEl);
      if (step && (status === 'working' || status === 'streaming')) panelOutputEl = outputEl;

      if (step && step.error) panel.appendChild(el('div', 'panel-error', step.error));

      panel.appendChild(el('div', 'panel-label', 'Cost'));
      panel.appendChild(el('div', 'panel-text', '$' + ((step && step.costUsd) || 0).toFixed(4)));

      if (step && (status === 'working' || status === 'streaming')) {
        const stop = el('button', 'panel-stop', 'Stop');
        stop.addEventListener('click', () => window.office.cancel(step.id));
        panel.appendChild(stop);
      }
    }

    function formatPlan(planJson) {
      if (!planJson) return 'No plan details.';
      if (typeof planJson === 'string') return planJson;
      try { return JSON.stringify(planJson, null, 2); } catch { return String(planJson); }
    }

    function renderTaskPanel() {
      const task = (appState.tasks || []).find((t) => t.id === selected.id);
      if (!task) { clearSelection(); return; }

      panel.appendChild(el('h3', 'panel-title', 'Plan awaiting approval'));
      panel.appendChild(el('p', 'panel-text', task.prompt));
      panel.appendChild(el('div', 'panel-label', 'Plan'));
      panel.appendChild(el('pre', 'panel-output', formatPlan(taskPlan(task))));
      if (task.error) panel.appendChild(el('div', 'panel-error', task.error));

      const actions = el('div', 'plan-actions');
      const approve = el('button', 'plan-approve', 'Approve');
      approve.addEventListener('click', () => { window.office.approvePlan(task.id, true); clearSelection(); });
      const reject = el('button', 'plan-reject', 'Reject');
      reject.addEventListener('click', () => { window.office.approvePlan(task.id, false); clearSelection(); });
      actions.appendChild(approve);
      actions.appendChild(reject);
      panel.appendChild(actions);
    }

    // ---------------- list view ----------------

    function renderList() {
      if (!listTable || !roster) return;
      listTable.replaceChildren();
      const steps = (appState && appState.steps) || [];

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['Agent', 'Dept', 'State', 'Task', 'Cost'].forEach((h) => headRow.appendChild(el('th', null, h)));
      thead.appendChild(headRow);
      listTable.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const agent of roster.agents) {
        const step = latestStepForAgent(steps, agent);
        const status = liveStatus(agent, steps, performance.now());
        const tr = document.createElement('tr');
        tr.tabIndex = 0;
        tr.appendChild(el('td', null, agent.name));
        tr.appendChild(el('td', null, agent.dept));
        tr.appendChild(el('td', 'status-' + status, status.replace('_', ' ')));
        tr.appendChild(el('td', null, (step && stepInstruction(step)) || '—'));
        tr.appendChild(el('td', null, '$' + ((step && step.costUsd) || 0).toFixed(4)));
        tr.addEventListener('click', () => selectAgent(agent));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectAgent(agent); });
        tbody.appendChild(tr);
      }
      listTable.appendChild(tbody);
    }

    function toggleListMode() {
      listMode = !listMode;
      canvas.hidden = listMode;
      listTable.hidden = !listMode;
      const toggleBtn = document.getElementById('office-toggle');
      if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(listMode));
      if (listMode) renderList(); else draw();
    }

    // ---------------- input wiring ----------------

    function wireInputEvents() {
      const ask = document.getElementById('office-ask');
      const prompt = document.getElementById('office-prompt');
      if (ask && prompt) {
        ask.addEventListener('submit', (e) => {
          e.preventDefault();
          const val = prompt.value.trim();
          if (!val) return;
          window.office.submit(val);
          prompt.value = '';
        });
      }

      const toggleBtn = document.getElementById('office-toggle');
      if (toggleBtn) toggleBtn.addEventListener('click', toggleListMode);

      document.addEventListener('keydown', (e) => {
        const view = document.getElementById('view-office');
        if (!view || view.hidden) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          toggleListMode();
        }
      });

      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        dragging = true;
        dragged = false;
        dragStart = { x: e.clientX, y: e.clientY };
        camStart = { x: camera.x, y: camera.y };
      });

      canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left, cssY = e.clientY - rect.top;

        if (dragging) {
          const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
          if (dragged) {
            camera.x = camStart.x - dx / camera.zoom;
            camera.y = camStart.y - dy / camera.zoom;
            clampToFloor();
            canvas.style.cursor = 'grabbing';
            draw();
            return;
          }
        }

        const world = screenToWorld(cssX, cssY, camera);
        const hit = hitTestAgent(roster.agents, world.x, world.y);
        const newHoverId = hit ? hit.id : null;
        if (newHoverId !== hoverAgentId) {
          hoverAgentId = newHoverId;
          if (newHoverId) focusedAgentId = newHoverId;
          canvas.style.cursor = hit ? 'pointer' : 'default';
          draw();
        }
      });

      canvas.addEventListener('pointerup', (e) => {
        dragging = false;
        canvas.style.cursor = hoverAgentId ? 'pointer' : 'default';
        if (!dragged) {
          const rect = canvas.getBoundingClientRect();
          const cssX = e.clientX - rect.left, cssY = e.clientY - rect.top;
          const world = screenToWorld(cssX, cssY, camera);
          const hit = hitTestAgent(roster.agents, world.x, world.y);
          if (hit) selectAgent(hit); else clearSelection();
        }
        dragged = false;
      });

      canvas.addEventListener('pointerleave', () => {
        if (!dragging && hoverAgentId) {
          hoverAgentId = null;
          canvas.style.cursor = 'default';
          draw();
        }
      });

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left, cssY = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomAt(cssX, cssY, factor);
      }, { passive: false });

      canvas.addEventListener('keydown', (e) => {
        const step = PAN_STEP / camera.zoom;
        switch (e.key) {
          case 'ArrowLeft': camera.x -= step; clampToFloor(); draw(); e.preventDefault(); break;
          case 'ArrowRight': camera.x += step; clampToFloor(); draw(); e.preventDefault(); break;
          case 'ArrowUp': camera.y -= step; clampToFloor(); draw(); e.preventDefault(); break;
          case 'ArrowDown': camera.y += step; clampToFloor(); draw(); e.preventDefault(); break;
          case 'Enter': {
            const agent = roster.agents.find((a) => a.id === focusedAgentId);
            if (agent) selectAgent(agent);
            e.preventDefault();
            break;
          }
        }
      });

      canvas.addEventListener('focus', () => draw());
      canvas.addEventListener('blur', () => draw());
    }
  }

  // ==========================================================================
  // Exports for the self-test (Node only — no-op in the browser, since
  // `module` is undefined there).
  // ==========================================================================
  const publicApi = {
    GRID, gridToPixel, agentAvatarCenter, roomCenterPixel, findRoomByName,
    findAgentForStep, stepMatchesAgent, latestStepForAgent, resolveStepStatus,
    agentStatus, STATUS_SHAPE, shapeForStatus, roomIsActive, clamp, clampCamera,
    screenToWorld, hitTestAgent, stepInstruction, taskPlan, __selftest,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicApi;
  }
})();
