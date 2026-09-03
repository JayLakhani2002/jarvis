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

  // Selection reducer — pure, so the panel's close/swap behavior (JOB 1:
  // close button, Escape, clicking a different agent) can be verified
  // without a DOM. The DOM layer's selectAgent()/clearSelection() both funnel
  // through this so there is exactly one place selection state changes.
  function nextSelection(action) {
    if (!action || action.type === 'close') return null;
    if (action.type === 'select') return { kind: action.kind, id: action.id };
    return null;
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

    // selection reducer — models the office panel's close/swap behavior
    // (JOB 1) without a DOM.
    const afterA1 = nextSelection({ type: 'select', kind: 'agent', id: 'a1' });
    assert(afterA1 && afterA1.id === 'a1', 'selecting an agent sets the selection');
    const afterClose = nextSelection({ type: 'close' });
    assert(afterClose === null, 'close clears selection');
    const afterA2 = nextSelection({ type: 'select', kind: 'agent', id: 'a2' });
    assert(afterA2.id === 'a2' && afterA1.id === 'a1', 'selecting another agent replaces the selection rather than getting stuck on the first');

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

    // Tokens come from the VS Code Light Modern theme defined in styles.css —
    // read live off the root element rather than re-guessing hex values here,
    // so office.js can never drift from the rest of the app's palette.
    function cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    }
    const COLOR = {
      bg: cssVar('--bg', '#ffffff'), panel: cssVar('--panel', '#f8f8f8'),
      raised: cssVar('--raised', '#f3f3f3'), line: cssVar('--line', '#e5e5e5'),
      text: cssVar('--text', '#1f1f1f'), dim: cssVar('--dim', '#616161'),
      muted: cssVar('--muted', '#8b8b8b'), accent: cssVar('--accent', '#005fb8'),
      green: cssVar('--green', '#107c10'), amber: cssVar('--amber', '#946600'),
      red: cssVar('--red', '#c42b1c'),
      // Not a locked token — the spec calls for a warm off-white floor
      // (distinct from --bg white) so rooms read as rooms against it.
      floor: '#faf8f5',
    };
    const STATUS_TEXT_COLOR = {
      idle: COLOR.dim, working: COLOR.amber, streaming: COLOR.accent,
      needs_review: COLOR.green, failed: COLOR.red,
    };

    // Gather-style room identity: fill/border per room name (lowercased),
    // falling back to the neutral raised/line surface for anything unmapped.
    const ROOM_COLORS = {
      'corner office': { fill: '#fff4d6', border: '#d9a93a' },
      'executive': { fill: '#f0e6ff', border: '#9b6fd4' },
      'architecture': { fill: '#ddf3f5', border: '#4c9fb0' },
      'delivery': { fill: '#e3f5e3', border: '#4a9d4a' },
      'security': { fill: '#ffe6e6', border: '#cf6b7a' },
      'project management': { fill: '#ffeeda', border: '#d9832f' },
      'product': { fill: '#fce4f0', border: '#cf6699' },
      'engineering — web': { fill: '#e3efff', border: '#5484c9' },
      'engineering — infra': { fill: '#e6ebf5', border: '#6a7fae' },
      'engineering — data': { fill: '#ddf0f7', border: '#4494b5' },
      'engineering — mobile': { fill: '#edf7dd', border: '#84b545' },
      'engineering — platform': { fill: '#e8e6fb', border: '#7d71c7' },
      'engineering — specialty': { fill: '#f2ebe3', border: '#a8825c' },
      'lounge': { fill: '#f5f2ee', border: '#bbae9e' },
    };
    const ROOM_FALLBACK = { fill: COLOR.raised, border: COLOR.line };
    function roomColors(roomName) {
      return ROOM_COLORS[String(roomName || '').toLowerCase()] || ROOM_FALLBACK;
    }

    const TAU = Math.PI * 2;
    const DESK_W = 30, DESK_H = 16;
    const BEAM_MS = 700;
    const PULSE_MS = 1400;
    const PAN_STEP = 48;
    const BOB_PERIOD_MS = 2600; // idle breathing — slow, 1-2px
    const EASE_ROOM_HEAT_MS = 220;
    const EASE_HOVER_MS = 140;

    function withAlpha(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    // Darkens a hex color toward black by `amt` (0..1) — used to derive
    // furniture colors from a room's border tone so a desk on a pale fill
    // reads as visibly darker rather than a same-shade tint.
    function darken(hex, amt) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const f = (c) => Math.max(0, Math.round(c * (1 - amt)));
      return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
    }

    // FNV-1a-ish string hash → stable per-agent phase offset (0..TAU) so the
    // idle-bob animation isn't synchronized across every agent.
    function idHash(id) {
      let h = 0;
      const s = String(id);
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return h;
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
    motionQuery.addEventListener('change', (e) => {
      reducedMotion = e.matches;
      // Beams are inherently transient (a delegation just happened or it
      // didn't) — there's no meaningful "static end state" for one still in
      // flight, so drop it rather than leaving a stray dot frozen on screen
      // once the loop that would otherwise expire it stops.
      if (reducedMotion) { animations = []; stopLoop(); } else { ensureLoop(); }
      draw();
    });

    let booted = false;
    let officeVisible = false; // the Office tab is the active view right now
    let roster = null;      // { rooms, agents, bounds }
    let roomsById = new Map();
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
    let lastDrawTime = null;
    const roomHeat = new Map(); // roomId -> eased 0..1 "how active" glow amount
    const hoverT = new Map();   // agentId -> eased 0..1 hover lift/nametag amount
    const prevStepState = new Map(); // stepId -> last-seen state, to detect entry into 'working'
    const lastChunkAt = new Map();   // stepId -> performance.now() of most recent stream chunk
    const STREAM_WINDOW_MS = 1200;   // recent chunk => draw as streaming instead of plain working

    // Eases a 0..1 value toward `target`, frame-rate independent via dt.
    // Under reduced motion, every caller snaps straight to `target` instead
    // (this is what "render the static end state" means for room heat and
    // hover lift/nametag opacity).
    function ease(map, key, target, now, rateMs) {
      if (reducedMotion) { map.set(key, target); return target; }
      const prev = map.has(key) ? map.get(key) : target;
      const dt = lastDrawTime == null ? 0 : Math.min(64, now - lastDrawTime);
      const next = prev + (target - prev) * Math.min(1, dt / rateMs);
      map.set(key, next);
      return next;
    }

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

    // The Office tab's visibility gates the animation loop: idle-bob means
    // the loop now runs continuously while the tab is visible, so it must
    // stop the instant the tab isn't (JOB 3).
    document.addEventListener('view:change', (e) => {
      officeVisible = e.detail === 'office';
      if (officeVisible) { boot(); ensureLoop(); } else { stopLoop(); }
    });

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
      roomsById = new Map(roster.rooms.map((r) => [r.id, r]));
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
      ensureLoop();
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
      ensureLoop();
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
      ensureLoop();
      draw();
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
        selected = nextSelection({ type: 'select', kind: 'task', id: pending.id });
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

    // ---------------- animation loop ----------------
    // Gated on officeVisible + !reducedMotion in one place (ensureLoop), so
    // every caller can just call it unconditionally. Idle-bob means the loop
    // now runs continuously whenever the Office tab is visible, but it still
    // stops the instant the tab is hidden (view:change) or reduced-motion
    // turns on (motionQuery listener above) — see stopLoop().

    function ensureLoop() {
      if (rafHandle != null || !officeVisible || reducedMotion) return;
      rafHandle = requestAnimationFrame(tick);
    }

    function stopLoop() {
      if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    }

    function tick(now) {
      rafHandle = null;
      animations = animations.filter((a) => now - a.start < BEAM_MS);
      draw(now);
      lastDrawTime = now;
      ensureLoop();
    }

    // ---------------- draw ----------------

    function draw(now) {
      if (!ctx || !roster) return;
      now = now || performance.now();
      const w = canvas.clientWidth, h = canvas.clientHeight;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLOR.floor; // warm off-white between rooms, not --bg white
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-camera.x, -camera.y);

      const steps = (appState && appState.steps) || [];
      for (const room of roster.rooms) drawRoom(room, roomIsActive(room, roster.agents, steps), now);
      for (const agent of roster.agents) drawAgent(agent, steps, now);
      drawBeams(now);

      ctx.restore();
    }

    function drawRoom(room, isActive, now) {
      const colors = roomColors(room.name);
      const x = room.x * GRID, y = room.y * GRID, w = room.w * GRID, h = room.h * GRID;
      const heat = ease(roomHeat, room.id, isActive ? 1 : 0, now, EASE_ROOM_HEAT_MS);

      roundRectPath(ctx, x, y, w, h, 10);
      ctx.fillStyle = colors.fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colors.border;
      ctx.stroke();

      // "room heat" — an animated (not snapped) amber glow while an agent in
      // the room is working/streaming.
      if (heat > 0.01) {
        roundRectPath(ctx, x + 2, y + 2, w - 4, h - 4, 9);
        ctx.strokeStyle = withAlpha(COLOR.amber, 0.55 * heat);
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.fillStyle = COLOR.dim;
      ctx.font = '600 11px ' + MONO;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(room.name, x + 10, y + 8);

      drawPlant(room, colors);
    }

    // A potted plant tucked in the room's far corner — decorative furniture,
    // skipped in rooms too small to fit it without crowding a desk.
    function drawPlant(room, colors) {
      if (room.w < 3 || room.h < 3) return;
      const px = (room.x + room.w) * GRID - 14, py = (room.y + room.h) * GRID - 12;
      ctx.fillStyle = darken(colors.border, 0.4);
      ctx.fillRect(px - 5, py - 2, 10, 7);
      ctx.fillStyle = COLOR.green;
      [[-4, -3], [4, -3], [0, -8]].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.arc(px + dx, py + dy, 4, 0, TAU);
        ctx.fill();
      });
    }

    function drawAgent(agent, steps, now) {
      const status = liveStatus(agent, steps, now);
      const p = gridToPixel(agent.desk.x, agent.desk.y);
      const deskX = p.x - DESK_W / 2, deskY = p.y;
      const ac = agentAvatarCenter(agent);
      const room = roomsById.get(agent.roomId);
      const colors = room ? roomColors(room.name) : ROOM_FALLBACK;
      const deskColor = darken(colors.border, 0.15);
      const deskEdgeColor = darken(colors.border, 0.4);
      const monIdleColor = darken(colors.border, 0.6);

      // idle "breathing" — 1-2px, slow, phase-staggered per agent so the
      // office doesn't animate in lockstep (JOB 3).
      const bob = reducedMotion ? 0 : Math.sin((now / BOB_PERIOD_MS) * TAU + (idHash(agent.id) % 1000) / 1000 * TAU) * 1.5;

      // hover — eased lift + nametag fade-in.
      const hovered = hoverAgentId === agent.id;
      const ht = ease(hoverT, agent.id, hovered ? 1 : 0, now, EASE_HOVER_MS);
      const isSelected = selected && selected.kind === 'agent' && selected.id === agent.id;
      const lift = ht * 3;
      const vx = ac.x, vy = ac.y + bob - lift;

      // chair
      ctx.beginPath();
      ctx.arc(p.x, deskY + DESK_H + 5, 5, 0, Math.PI, false);
      ctx.strokeStyle = deskEdgeColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      // desk — darkened off the room's own border tone so it reads as
      // furniture, not a same-shade tint of the floor.
      ctx.fillStyle = deskColor;
      ctx.strokeStyle = deskEdgeColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(deskX, deskY, DESK_W, DESK_H);
      ctx.fill();
      ctx.stroke();

      // monitor
      const monW = 10, monH = 7;
      const working = status === 'working' || status === 'streaming';
      ctx.fillStyle = working ? withAlpha(COLOR.accent, 0.6) : monIdleColor;
      ctx.fillRect(p.x - monW / 2, deskY - monH + 2, monW, monH);
      ctx.strokeStyle = deskEdgeColor;
      ctx.strokeRect(p.x - monW / 2, deskY - monH + 2, monW, monH);

      // small animated activity indicator over the desk while working.
      if (working) {
        const pulseT = reducedMotion ? 0.5 : (Math.sin((now / 500) * TAU) + 1) / 2;
        ctx.beginPath();
        ctx.arc(p.x + monW / 2 + 5, deskY - monH + 1, 2.2, 0, TAU);
        ctx.fillStyle = withAlpha(COLOR.amber, 0.5 + pulseT * 0.5);
        ctx.fill();
      }

      // avatar: head + body capsule, ~14px tall
      ctx.beginPath();
      ctx.arc(vx, vy - 5, 3.4, 0, TAU);
      ctx.fillStyle = '#4b4b4b';
      ctx.fill();
      roundRectPath(ctx, vx - 4, vy - 1, 8, 8, 3);
      ctx.fillStyle = '#6e6e6e';
      ctx.fill();

      drawStatusMark(status, vx + 7, vy - 7, now);

      if (hovered || isSelected) {
        ctx.beginPath();
        ctx.arc(vx, vy - 2, 12, 0, TAU);
        ctx.strokeStyle = COLOR.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (focusedAgentId === agent.id && document.activeElement === canvas) {
        ctx.beginPath();
        ctx.arc(vx, vy - 2, 15, 0, TAU);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = COLOR.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const nametagAlpha = Math.max(ht, isSelected ? 1 : 0, (focusedAgentId === agent.id && document.activeElement === canvas) ? 1 : 0);
      drawNametag(agent, vx, vy - 22, status, nametagAlpha);
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
          ctx.fillStyle = COLOR.accent;
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

    // Nametags are hidden by default (Gather-style) and fade in on hover,
    // selection, or keyboard focus — `alpha` is the eased 0..1 amount.
    function drawNametag(agent, cx, y, status, alpha) {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '500 10px ' + MONO;
      const textW = agent.labelWidth != null ? agent.labelWidth : ctx.measureText(agent.label).width;
      const padX = 6, h = 14;
      const w = textW + padX * 2;
      const x = cx - w / 2;
      roundRectPath(ctx, x, y, w, h, 7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLOR.line;
      ctx.stroke();
      ctx.fillStyle = STATUS_TEXT_COLOR[status] || COLOR.dim;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(agent.label, cx, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
      ctx.restore();
    }

    // Delegation beam: a travelling dot along the Corner Office -> desk path
    // with a fading trail behind it, over BEAM_MS (~700ms).
    function drawBeams(now) {
      for (const b of animations) {
        if (b.kind !== 'beam') continue;
        const t = Math.min(1, (now - b.start) / BEAM_MS);
        const ex = b.x1 + (b.x2 - b.x1) * t;
        const ey = b.y1 + (b.y2 - b.y1) * t;

        ctx.beginPath();
        ctx.moveTo(b.x1, b.y1);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = withAlpha(COLOR.accent, 0.32 * (1 - t * 0.5));
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(ex, ey, 6, 0, TAU);
        ctx.strokeStyle = withAlpha(COLOR.accent, 0.4);
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(ex, ey, 3.5, 0, TAU);
        ctx.fillStyle = COLOR.accent;
        ctx.fill();
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

    // Clicking a different agent while the panel is open swaps its content
    // (nextSelection just overwrites, never merges) rather than getting
    // stuck — see the pure `nextSelection` reducer and its self-test.
    function selectAgent(agent) {
      selected = nextSelection({ type: 'select', kind: 'agent', id: agent.id });
      focusedAgentId = agent.id;
      showPanel();
      renderPanel();
      draw();
    }

    function clearSelection() {
      selected = nextSelection({ type: 'close' });
      panelOutputEl = null;
      hidePanel();
      draw();
    }

    // The panel docks beside the canvas (see office.css: .office-stage is a
    // flex row, .office-panel is a flex item, not position:absolute), so
    // opening/closing it changes the canvas's own box — resize it so the
    // pixel buffer and hit-testing stay in sync with the new layout.
    function showPanel() { if (panel) panel.hidden = false; resizeCanvas(); }
    function hidePanel() { if (panel) panel.hidden = true; resizeCanvas(); }

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function closeButton() {
      const NS = 'http://www.w3.org/2000/svg';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'panel-close';
      btn.setAttribute('aria-label', 'Close');
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M3 3 L13 13 M13 3 L3 13');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.75');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
      btn.appendChild(svg);
      btn.addEventListener('click', clearSelection);
      return btn;
    }

    function renderPanel() {
      if (!panel || !selected) return;
      panel.replaceChildren();
      panelOutputEl = null;
      panel.appendChild(closeButton());
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
          return;
        }
        // JOB 1: Escape is the keyboard escape hatch out of the panel —
        // the click-empty-canvas dismissal isn't reachable once the panel
        // covers that space, so this (plus the close button) is required.
        if (e.key === 'Escape' && selected) {
          e.preventDefault();
          clearSelection();
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
    screenToWorld, hitTestAgent, stepInstruction, taskPlan, nextSelection, __selftest,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicApi;
  }
})();
