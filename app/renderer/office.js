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

  // ==========================================================================
  // 1b. Chat-transcript formatting — pure string functions (no DOM), so the
  //     dependency-free markdown renderer's XSS-safety is provable in the
  //     Node self-test, not just eyeballed in a browser.
  // ==========================================================================

  // NON-NEGOTIABLE: escape HTML special chars BEFORE any markdown transform
  // ever runs. Model output is untrusted — this is the only line standing
  // between a code block and stored XSS.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const COPY_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</svg>';

  function renderCodeBlock(block) {
    const lang = escapeHtml((block.lang || '').trim());
    const code = escapeHtml(String(block.code).replace(/\n$/, ''));
    return '<div class="code-block">' +
      '<div class="code-block-head">' +
        '<span class="code-lang">' + (lang || 'text') + '</span>' +
        '<button type="button" class="copy-btn" aria-label="Copy code">' +
          COPY_ICON_SVG + '<span class="copy-btn-label">Copy</span>' +
        '</button>' +
      '</div>' +
      '<pre><code>' + code + '</code></pre>' +
    '</div>';
  }

  // Inline spans, applied to already-escaped text — order matters (bold
  // before italic so ** isn't eaten by the * rule first).
  function renderInline(text) {
    let out = text;
    out = out.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    // links render as plain text — never clickable, this is untrusted output.
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 <span class="md-link">($2)</span>');
    return out;
  }

  // Fenced code blocks are located and rendered directly off the raw
  // (pre-escape) text and spliced back in — no placeholder/sentinel token
  // needed, so there is no risk of a sentinel colliding with real text.
  const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;

  function renderBlocks(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') { i++; continue; }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
        i++; continue;
      }

      if (/^&gt;\s?/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          quoted.push('<p>' + renderInline(lines[i].replace(/^&gt;\s?/, '')) + '</p>');
          i++;
        }
        out.push('<blockquote>' + quoted.join('') + '</blockquote>');
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      const para = [];
      while (
        i < lines.length && lines[i].trim() !== '' &&
        !/^(#{1,6})\s+/.test(lines[i]) && !/^&gt;\s?/.test(lines[i]) &&
        !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])
      ) {
        para.push(renderInline(lines[i]));
        i++;
      }
      out.push('<p>' + para.join('<br>') + '</p>');
    }
    return out.join('');
  }

  // Dependency-free markdown -> safe HTML. Fenced-code segments are sliced
  // out and rendered off their own content BEFORE the surrounding prose is
  // escaped and block/inline-parsed, so a code sample's markdown-looking
  // characters are never re-interpreted as markdown syntax.
  function markdownToHtml(raw) {
    const src = String(raw == null ? '' : raw);
    let html = '';
    let lastIndex = 0;
    let m;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(src))) {
      const textPart = src.slice(lastIndex, m.index);
      if (textPart) html += renderBlocks(escapeHtml(textPart));
      html += renderCodeBlock({ lang: m[1], code: m[2] });
      lastIndex = FENCE_RE.lastIndex;
    }
    const rest = src.slice(lastIndex);
    if (rest) html += renderBlocks(escapeHtml(rest));
    return html;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function safeJsonOneLine(obj) {
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  function safeJsonPretty(obj) {
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  // One-line summary for a collapsed tool row — prefers the fields that
  // actually explain what a tool call *did* over a raw JSON dump.
  function summarizeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    const v = input.file_path != null ? input.file_path
      : input.command != null ? input.command
      : input.pattern != null ? input.pattern
      : null;
    const s = v != null ? String(v) : safeJsonOneLine(input);
    return truncate(s, 80);
  }

  function formatDuration(ms) {
    return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  // Footer stat line. tokens is nullable by contract — omit it rather than
  // ever rendering a fabricated "0".
  function formatDoneStats(stats) {
    if (!stats) return '';
    const parts = [];
    if (typeof stats.costUsd === 'number') parts.push('$' + stats.costUsd.toFixed(4));
    if (typeof stats.ms === 'number') parts.push(formatDuration(stats.ms));
    if (typeof stats.turns === 'number') parts.push(stats.turns + (stats.turns === 1 ? ' turn' : ' turns'));
    if (stats.tokens && typeof stats.tokens.input === 'number' && typeof stats.tokens.output === 'number') {
      parts.push(stats.tokens.input + '→' + stats.tokens.output + ' tok');
    }
    return parts.join(' · ');
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

    // ---- markdown renderer: escaping, transforms, and the XSS guarantee ----
    assert(escapeHtml('<b>&"</b>') === '&lt;b&gt;&amp;&quot;&lt;/b&gt;', 'escapeHtml escapes & < > " exactly');

    // SECURITY: the whole point of the renderer — untrusted model text that
    // looks like an HTML element must never become a live element.
    const xssInput = 'before <img src=x onerror=alert(1)> after';
    const xssRendered = markdownToHtml(xssInput);
    assert(!/<img/i.test(xssRendered), 'a raw <img> tag never appears unescaped in rendered output');
    assert(xssRendered.indexOf('&lt;img') !== -1, 'the angle bracket renders as visible escaped text, not a tag');
    assert(xssRendered.indexOf('onerror') !== -1, 'the payload text is preserved but inert (plain text, not a live attribute)');
    // Strip every tag the renderer itself is known to emit; anything left
    // over would mean injected markup survived — i.e. an XSS hole.
    const KNOWN_TAGS = /<\/?(p|strong|em|code|pre|h[1-6]|ul|ol|li|blockquote|div|span|button|rect|path|svg)(\s[^>]*)?>/gi;
    assert(xssRendered.replace(KNOWN_TAGS, '').indexOf('<') === -1,
      'no tag survives besides the renderer\'s own safe, hardcoded markup');

    assert(markdownToHtml('**bold** and *italic* and `code`') ===
      '<p><strong>bold</strong> and <em>italic</em> and <code class="inline-code">code</code></p>',
      'bold/italic/inline-code transforms');
    assert(markdownToHtml('# Heading').indexOf('<h1>Heading</h1>') !== -1, 'heading transform');
    assert(markdownToHtml('- a\n- b').indexOf('<ul><li>a</li><li>b</li></ul>') !== -1, 'bullet list transform');
    assert(markdownToHtml('1. a\n2. b').indexOf('<ol><li>a</li><li>b</li></ol>') !== -1, 'numbered list transform');
    assert(markdownToHtml('> quoted').indexOf('<blockquote><p>quoted</p></blockquote>') !== -1, 'blockquote transform');
    const linkRendered = markdownToHtml('see [docs](https://example.com/x)');
    assert(linkRendered.indexOf('<a ') === -1, 'links never become clickable anchors');
    assert(linkRendered.indexOf('docs') !== -1 && linkRendered.indexOf('example.com') !== -1,
      'link text and URL both still render as plain text');
    const codeRendered = markdownToHtml('```js\nconst x = 1 < 2;\n```');
    assert(codeRendered.indexOf('code-lang">js<') !== -1, 'fenced code block carries its language label');
    assert(codeRendered.indexOf('1 &lt; 2') !== -1, 'code content is escaped, not executed as further markdown');
    assert(codeRendered.indexOf('copy-btn') !== -1, 'fenced code block carries a copy button');

    // ---- tool-row / footer formatting ----
    assert(summarizeToolInput({ file_path: '/a/b.js' }) === '/a/b.js', 'tool summary prefers file_path');
    assert(summarizeToolInput({ command: 'ls -la' }) === 'ls -la', 'tool summary prefers command');
    assert(summarizeToolInput({ pattern: '*.ts' }) === '*.ts', 'tool summary prefers pattern');
    assert(summarizeToolInput({ x: 1 }) === '{"x":1}', 'tool summary falls back to compact JSON');
    assert(summarizeToolInput({ command: 'x'.repeat(200) }).length === 80, 'tool summary truncates long input');

    assert(formatDoneStats({ costUsd: 0.0123, ms: 4200, turns: 3, tokens: { input: 512, output: 128 } }) ===
      '$0.0123 · 4.2s · 3 turns · 512→128 tok', 'done-stats line with tokens present');
    assert(formatDoneStats({ costUsd: 0.01, ms: 500, turns: 1, tokens: null }) === '$0.0100 · 500ms · 1 turn',
      'done-stats omits tokens entirely when null, never fabricates a number');

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

    // ---- chat transcript state (the agent panel's message stream) ----
    // Keyed by stepId so switching agents and back (or a background
    // handleChange re-render) never loses history already streamed in.
    const stepBlocks = new Map();     // stepId -> [{kind:'text'|'thinking', text} | {kind:'tool', id, name, input, result} | ...]
    const stepDoneStats = new Map();  // stepId -> { costUsd, ms, turns, tokens } from the 'done' event

    // Live-DOM bookkeeping for the transcript currently on screen — reset by
    // renderAgentPanel() on every (re)mount so handleStream() can append
    // directly into it instead of re-rendering the whole transcript on every
    // chunk (that would jank badly under fast streaming).
    let panelStreamStepId = null;   // stepId the mounted transcript is showing
    let panelTranscriptEl = null;   // the .transcript scroll container
    let panelToolRowEls = null;     // Map(toolCallId -> row <details> element)
    let panelPinnedToBottom = true; // auto-scroll only while already at the bottom
    let panelJumpBtn = null;        // "jump to latest" affordance, shown when not pinned
    let panelRunIndicatorEl = null; // header's animated "working" pill
    let panelStopBtnEl = null;      // Stop button — both this and the above hide on completion
    let panelFooterEl = null;       // cost/duration/turns/tokens line, populated on 'done'

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

    // Typed event contract: { stepId, event } where event is exactly one of
    // { kind:'text', text } | { kind:'thinking', text } |
    // { kind:'tool', id, name, input } | { kind:'tool_result', id, ok, preview } |
    // { kind:'done', costUsd, ms, turns, tokens }. History is kept per-step
    // in `stepBlocks` (data, not DOM) so switching agents and back never
    // loses what already streamed in; the live transcript is appended to
    // directly rather than re-rendered on every chunk (renderPanel() would
    // jank badly under fast streaming).
    function handleStream(d) {
      if (!d || !d.stepId || !d.event) return;
      const { stepId, event } = d;
      lastChunkAt.set(stepId, performance.now());

      let blocks = stepBlocks.get(stepId);
      if (!blocks) { blocks = []; stepBlocks.set(stepId, blocks); }
      const isLive = !!panelTranscriptEl && panelStreamStepId === stepId;

      if (event.kind === 'text' || event.kind === 'thinking') {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === event.kind) {
          last.text += event.text;
          if (isLive) updateOpenTranscriptBlock(last);
        } else {
          const block = { kind: event.kind, text: event.text };
          blocks.push(block);
          if (isLive) appendTranscriptBlock(block);
        }
      } else if (event.kind === 'tool') {
        const block = { kind: 'tool', id: event.id, name: event.name, input: event.input, result: null };
        blocks.push(block);
        if (isLive) appendTranscriptBlock(block);
      } else if (event.kind === 'tool_result') {
        const block = findToolBlock(blocks, event.id);
        if (block) {
          block.result = { ok: event.ok, preview: event.preview };
          if (isLive) updateToolResultMark(block);
        }
      } else if (event.kind === 'done') {
        stepDoneStats.set(stepId, {
          costUsd: event.costUsd, ms: event.ms, turns: event.turns, tokens: event.tokens || null,
        });
        if (isLive) renderRunState(stepId);
      }

      ensureLoop();
      draw();
    }

    function findToolBlock(blocks, id) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === 'tool' && blocks[i].id === id) return blocks[i];
      }
      return null;
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
      resetTranscriptRefs();
      hidePanel();
      draw();
    }

    function resetTranscriptRefs() {
      panelTranscriptEl = null;
      panelStreamStepId = null;
      panelToolRowEls = null;
      panelJumpBtn = null;
      panelPinnedToBottom = true;
      panelRunIndicatorEl = null;
      panelStopBtnEl = null;
      panelFooterEl = null;
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

    // ---------------- transcript (the Claude-Code-style message stream) ----------------

    const DEFAULT_MODEL_BADGE = 'claude-sonnet-5';

    const TOOL_ICON_SVG =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path d="M2.5 3.5 6 8l-3.5 4.5M8 12.5h5.5" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const TOOL_OK_ICON =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M5 8.2 7 10.2 11 6" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const TOOL_FAIL_ICON =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path d="M8 1.5 14.5 13h-13Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M8 6.4v3.1M8 11.4v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

    // markup is always our own hardcoded string above, never model/user
    // text — safe to build via innerHTML, unlike anything derived from a
    // stream event.
    function svgFromMarkup(markup) {
      const tmp = document.createElement('div');
      tmp.innerHTML = markup;
      return tmp.firstElementChild;
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    }
    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* clipboard unavailable — no-op */ }
      document.body.removeChild(ta);
    }

    // Wires every code block's copy button under `rootEl`. Called after any
    // innerHTML assignment (initial render AND every streamed markdown
    // update), since resetting innerHTML always produces fresh button nodes.
    function wireCodeCopyButtons(rootEl) {
      rootEl.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const codeEl = btn.closest('.code-block').querySelector('pre code');
          copyToClipboard(codeEl ? codeEl.textContent : '');
          const label = btn.querySelector('.copy-btn-label');
          if (!label) return;
          clearTimeout(btn._copyTimer);
          label.textContent = 'Copied';
          btn.classList.add('copied');
          btn._copyTimer = setTimeout(() => {
            label.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 1500);
        });
      });
    }

    function buildTextBubble(block) {
      const bubble = el('div', 'msg-text');
      const body = el('div', 'msg-body');
      body.innerHTML = markdownToHtml(block.text);
      wireCodeCopyButtons(body);
      bubble.appendChild(body);
      return bubble;
    }

    // Collapsed + dimmed by default — <details> gives expand/collapse and
    // keyboard support for free, no custom toggle JS needed.
    function buildThinkingBlock(block) {
      const details = document.createElement('details');
      details.className = 'msg-thinking';
      const summary = document.createElement('summary');
      summary.textContent = 'Thought';
      details.appendChild(summary);
      const body = el('div', 'msg-body thinking-body');
      body.innerHTML = markdownToHtml(block.text);
      wireCodeCopyButtons(body);
      details.appendChild(body);
      return details;
    }

    function applyToolResultToRow(rowEl, result) {
      const markEl = rowEl._markEl;
      if (markEl) {
        markEl.innerHTML = result.ok ? TOOL_OK_ICON : TOOL_FAIL_ICON;
        markEl.classList.toggle('is-ok', !!result.ok);
        markEl.classList.toggle('is-failed', !result.ok);
        markEl.setAttribute('aria-label', result.ok ? 'succeeded' : 'failed');
      }
      const detailEl = rowEl._detailEl;
      if (detailEl && !detailEl.querySelector('.tool-result-preview')) {
        detailEl.appendChild(el('div', 'panel-label', 'Result'));
        detailEl.appendChild(el('pre', 'tool-result-preview', result.preview || ''));
      }
    }

    // One compact row per tool call — name + a one-line input summary,
    // collapsed; clicking expands the full input as formatted JSON. The
    // ok/failed marker (once tool_result arrives) is shape AND colour, never
    // colour alone — see TOOL_OK_ICON/TOOL_FAIL_ICON above.
    function buildToolRow(block) {
      const details = document.createElement('details');
      details.className = 'tool-row';
      const summary = document.createElement('summary');
      summary.className = 'tool-row-summary';
      summary.appendChild(svgFromMarkup(TOOL_ICON_SVG));
      summary.appendChild(el('span', 'tool-name', block.name));
      summary.appendChild(el('span', 'tool-input-line', summarizeToolInput(block.input)));
      const markEl = el('span', 'tool-result-mark');
      summary.appendChild(markEl);
      details.appendChild(summary);

      const detail = el('div', 'tool-row-detail');
      detail.appendChild(el('div', 'panel-label', 'Input'));
      detail.appendChild(el('pre', 'tool-input-json', safeJsonPretty(block.input)));
      details.appendChild(detail);

      details._markEl = markEl;
      details._detailEl = detail;
      if (block.result) applyToolResultToRow(details, block.result);
      return details;
    }

    function updateToolResultMark(block) {
      const rowEl = panelToolRowEls && panelToolRowEls.get(block.id);
      if (rowEl) applyToolResultToRow(rowEl, block.result);
    }

    function scrollTranscriptToBottom() {
      if (!panelTranscriptEl) return;
      panelTranscriptEl.scrollTop = panelTranscriptEl.scrollHeight;
      panelPinnedToBottom = true;
      if (panelJumpBtn) panelJumpBtn.hidden = true;
    }

    // Only auto-scrolls while already pinned to the bottom — a user who has
    // scrolled up to read earlier output never gets yanked back down.
    function afterTranscriptMutate() {
      if (!panelTranscriptEl) return;
      if (panelPinnedToBottom) scrollTranscriptToBottom();
      else if (panelJumpBtn) panelJumpBtn.hidden = false;
    }

    function wireTranscriptScroll(container) {
      container.addEventListener('scroll', () => {
        const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
        panelPinnedToBottom = gap < 24;
        if (panelJumpBtn) panelJumpBtn.hidden = panelPinnedToBottom;
      });
    }

    function appendTranscriptBlock(block) {
      // Real content just arrived — clear a stale "no activity" placeholder
      // left over from a mount that happened before this step had anything.
      const empty = panelTranscriptEl.querySelector('.transcript-empty');
      if (empty) empty.remove();
      let node;
      if (block.kind === 'text') node = buildTextBubble(block);
      else if (block.kind === 'thinking') node = buildThinkingBlock(block);
      else if (block.kind === 'tool') node = buildToolRow(block);
      else return;
      panelTranscriptEl.appendChild(node);
      if (block.kind === 'tool' && panelToolRowEls) panelToolRowEls.set(block.id, node);
      afterTranscriptMutate();
    }

    // A streamed text/thinking delta merges into the already-open block
    // (see handleStream) — update the existing bubble in place rather than
    // appending a new one per chunk.
    function updateOpenTranscriptBlock(block) {
      const last = panelTranscriptEl && panelTranscriptEl.lastElementChild;
      const body = last && last.querySelector('.msg-body');
      if (!body) return;
      body.innerHTML = markdownToHtml(block.text);
      wireCodeCopyButtons(body);
      afterTranscriptMutate();
    }

    function mountTranscript(step) {
      panelToolRowEls = new Map();
      const blocks = step && stepBlocks.get(step.id);
      if (blocks && blocks.length) {
        for (const block of blocks) appendTranscriptBlock(block);
        return;
      }
      // Fallback for a step whose event history predates this panel session
      // (e.g. already complete when the app opened) — render what we have
      // as one message instead of showing nothing.
      if (step && step.output) {
        appendTranscriptBlock({ kind: 'text', text: step.output });
        return;
      }
      panelTranscriptEl.appendChild(el('div', 'transcript-empty',
        step ? 'No output yet.' : 'No activity yet.'));
    }

    // Shows/hides the running indicator + Stop button and the completion
    // footer stats — called on mount and again (without a full re-render)
    // when a live 'done' event lands for the step currently on screen.
    function renderRunState(stepId) {
      const agent = roster.agents.find((a) => a.id === selected.id);
      if (!agent) return;
      const steps = (appState && appState.steps) || [];
      const status = liveStatus(agent, steps, performance.now());
      const running = status === 'working' || status === 'streaming';
      if (panelRunIndicatorEl) panelRunIndicatorEl.hidden = !running;
      if (panelStopBtnEl) panelStopBtnEl.hidden = !running;
      const stats = stepDoneStats.get(stepId);
      if (panelFooterEl) {
        if (!running && stats) {
          panelFooterEl.textContent = formatDoneStats(stats);
          panelFooterEl.hidden = false;
        } else {
          panelFooterEl.hidden = true;
        }
      }
    }

    function renderPanel() {
      if (!panel || !selected) return;
      panel.replaceChildren();
      resetTranscriptRefs();
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
      const running = status === 'working' || status === 'streaming';

      // ---- header: name, department, model badge, status pill, running indicator ----
      const head = el('div', 'panel-head');
      const titleRow = el('div', 'panel-title-row');
      titleRow.appendChild(el('h3', 'panel-title', agent.name));
      titleRow.appendChild(el('span', 'model-badge', agent.model || DEFAULT_MODEL_BADGE));
      head.appendChild(titleRow);
      head.appendChild(el('div', 'panel-sub', agent.dept));
      const statusRow = el('div', 'panel-status-row');
      statusRow.appendChild(el('span', 'panel-status status-' + status, status.replace('_', ' ')));
      const runInd = el('span', 'run-indicator');
      runInd.hidden = true; // renderRunState() below sets the real value
      runInd.appendChild(el('span', 'run-dot'));
      runInd.appendChild(document.createTextNode('Working'));
      statusRow.appendChild(runInd);
      panelRunIndicatorEl = runInd;
      head.appendChild(statusRow);
      panel.appendChild(head);

      // ---- message stream ----
      const transcriptWrap = el('div', 'transcript-wrap');
      const transcript = el('div', 'transcript');
      transcriptWrap.appendChild(transcript);
      const jumpBtn = el('button', 'jump-latest', 'Jump to latest ↓');
      jumpBtn.type = 'button';
      jumpBtn.hidden = true;
      jumpBtn.addEventListener('click', scrollTranscriptToBottom);
      transcriptWrap.appendChild(jumpBtn);
      panel.appendChild(transcriptWrap);

      panelTranscriptEl = transcript;
      panelPinnedToBottom = true;
      panelJumpBtn = jumpBtn;
      panelStreamStepId = step ? step.id : null;
      wireTranscriptScroll(transcript);
      mountTranscript(step);

      if (step && step.error) panel.appendChild(el('div', 'panel-error', step.error));

      // ---- footer: cost/duration/turns/tokens, populated only on 'done' ----
      const footer = el('div', 'panel-footer-stats');
      footer.hidden = true;
      panel.appendChild(footer);
      panelFooterEl = footer;

      if (running && step) {
        const stop = el('button', 'panel-stop', 'Stop');
        stop.addEventListener('click', () => window.office.cancel(step.id));
        panel.appendChild(stop);
        panelStopBtnEl = stop;
      }

      renderRunState(step ? step.id : null);
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
    escapeHtml, markdownToHtml, summarizeToolInput, formatDoneStats, formatDuration, truncate,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicApi;
  }
})();
