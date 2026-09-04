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
  // 1a. Pixel-art sprite appearance — pure (no DOM), so "same id, same
  //     sprite across restarts" and "84 agents read as visually distinct"
  //     are provable in the Node self-test, not just eyeballed on screen.
  // ==========================================================================

  // FNV-1a-ish string hash — deterministic, no randomness. Drives both the
  // sprite appearance below and the renderer's idle-bob phase stagger.
  function idHash(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  const HAIR_STYLES = ['short', 'spiky', 'long', 'curly', 'bald', 'hat'];
  const HAIR_COLORS = ['#1f1712', '#4a2c17', '#7a4a24', '#c9a227', '#8b8b8b', '#a83232'];
  const SKIN_TONES = ['#ffdbac', '#f1c27d', '#c68642', '#8d5524', '#5a3825'];
  const SHIRT_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#e67e22', '#16a085', '#34495e', '#c9a227'];

  // Deterministic per-agent look, derived purely from a hash of agent.id
  // (never randomness) so it's identical across restarts. Four axes read
  // off the same hash with different divisors so they vary roughly
  // independently — 6 hair styles x 6 hair colours x 5 skin tones x 8 shirt
  // colours = 1440 combinations, comfortably distinct across an 84-agent
  // roster (see __selftest).
  function agentAppearance(id) {
    const h = idHash(id);
    const hairStyleI = h % HAIR_STYLES.length;
    const hairColorI = Math.floor(h / 7) % HAIR_COLORS.length;
    const skinI = Math.floor(h / 53) % SKIN_TONES.length;
    const shirtI = Math.floor(h / 311) % SHIRT_COLORS.length;
    return {
      hairStyle: HAIR_STYLES[hairStyleI],
      hairColor: HAIR_COLORS[hairColorI],
      skin: SKIN_TONES[skinI],
      shirt: SHIRT_COLORS[shirtI],
      key: hairStyleI + '.' + hairColorI + '.' + skinI + '.' + shirtI,
    };
  }

  // The two sprite poses' anatomy differences, as one shared source of
  // truth for both the renderer and the self-test — 'seated' (back of
  // head/shoulders, agent at a desk facing a monitor) has no face and no
  // legs, and wider shoulders, vs. 'front' (face + eyes, arms, legs, feet).
  const POSE_ANATOMY = {
    front: { hasFace: true, hasLegs: true, shoulderCols: 12 },
    seated: { hasFace: false, hasLegs: false, shoulderCols: 14 },
  };

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

    // ---- pixel-art sprite appearance: deterministic, varied, pose-distinct ----
    assert(JSON.stringify(agentAppearance('agent-1')) === JSON.stringify(agentAppearance('agent-1')),
      'appearance-from-id is deterministic — hashing the same id twice yields an identical descriptor');

    // Prefer the real 84-agent roster (~/.claude/agents/*.md, same source
    // app/roster.js reads) when this machine has it; fall back to 84
    // synthetic ids otherwise so the check still runs anywhere.
    let rosterIds = null;
    try {
      const fs = require('fs'), os = require('os'), path = require('path');
      const dir = path.join(os.homedir(), '.claude', 'agents');
      rosterIds = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    } catch { rosterIds = null; }
    if (!rosterIds || rosterIds.length < 20) {
      rosterIds = Array.from({ length: 84 }, (_, i) => 'synthetic-agent-' + i);
    }
    const distinctAppearances = new Set(rosterIds.map((id) => agentAppearance(id).key));
    assert(distinctAppearances.size >= 20,
      'at least 20 distinct appearance combinations across the roster (got ' + distinctAppearances.size +
      ' from ' + rosterIds.length + ' ids)');

    assert(POSE_ANATOMY.front.hasFace !== POSE_ANATOMY.seated.hasFace &&
      POSE_ANATOMY.front.hasLegs !== POSE_ANATOMY.seated.hasLegs &&
      POSE_ANATOMY.front.shoulderCols !== POSE_ANATOMY.seated.shoulderCols,
      "'seated' pose anatomy differs from 'front' (no face, no legs, wider shoulders)");

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

    // ---- pixel-art sprite/furniture/floor palette — 2-3 shades per
    // material (base/shadow/highlight) plus one shared near-black outline;
    // never more than a handful of colours per sprite. ----
    const OUTLINE = '#141414';
    const TROUSER_COLOR = '#33363b';
    const SHOE_COLOR = '#20201f';
    const HAT_COLOR = '#2b2b2b';
    const TAG_BG = 'rgba(31, 31, 31, 0.85)';
    const TAG_TEXT = '#ffffff';
    const FLOOR_BASE = '#f0e4d0';
    const FLOOR_GROUT = '#e0d2ba';

    const DESK_W = 30, DESK_H = 16;
    const BEAM_MS = 700;
    const PULSE_MS = 1400;
    const PAN_STEP = 48;
    const BOB_PERIOD_MS = 2600; // idle breathing — a 1-art-pixel head/shoulder shift, not a smooth tween
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
    // Lightens a hex color toward white by `amt` (0..1) — the highlight half
    // of the darken() pair, together giving every sprite/furniture material
    // its base/shadow/highlight triad.
    function lighten(hex, amt) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const f = (c) => Math.min(255, Math.round(c + (255 - c) * amt));
      return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
    }

    // ==========================================================================
    // Pixel grid — the one technique that makes this read as 16-bit instead
    // of vector art. Every sprite/furniture/floor shape is drawn through
    // px()/blockRect() so it always lands on a whole "art pixel" (ART canvas
    // units), never a fractional or antialiased coordinate. No arc(), no
    // gradients, no shadowBlur anywhere below this line.
    // ==========================================================================
    const ART = 2; // 1 art pixel = ART canvas units — stays chunky at any camera zoom

    function px(ctx, x, y, w, h, color) {
      const x0 = Math.floor(x / ART) * ART;
      const y0 = Math.floor(y / ART) * ART;
      const x1 = Math.ceil((x + w) / ART) * ART;
      const y1 = Math.ceil((y + h) / ART) * ART;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, Math.max(ART, x1 - x0), Math.max(ART, y1 - y0));
    }

    // A rect whose corners are cut in ART-sized steps ("staircase" rounding)
    // instead of an arc — exactly how real pixel art rounds a corner.
    function blockRect(ctx, x, y, w, h, color, cornerN) {
      cornerN = cornerN || 0;
      const c = cornerN * ART;
      if (h - 2 * c > 0) px(ctx, x, y + c, w, h - 2 * c, color);
      for (let i = 0; i < cornerN; i++) {
        const inset = (cornerN - i) * ART;
        if (w - 2 * inset > 0) {
          px(ctx, x + inset, y + i * ART, w - 2 * inset, ART, color);
          px(ctx, x + inset, y + h - ART - i * ART, w - 2 * inset, ART, color);
        }
      }
    }

    // blockRect drawn twice — an ART-larger silhouette in OUTLINE behind the
    // real fill — giving every big shape its 1-art-pixel dark border.
    function outlinedBlock(ctx, x, y, w, h, color, cornerN) {
      blockRect(ctx, x - ART, y - ART, w + 2 * ART, h + 2 * ART, OUTLINE, cornerN ? cornerN + 1 : 0);
      blockRect(ctx, x, y, w, h, color, cornerN);
    }

    // Hollow rectangular ring (hover/selection/keyboard-focus), `thickness`
    // canvas units wide — a pixel-grid stand-in for a stroked circle.
    // `dashed` skips every other ART segment for the keyboard-focus variant.
    function pxRingOutline(ctx, x, y, w, h, color, thickness, dashed) {
      const step = dashed ? ART * 2 : ART;
      for (let dx = 0; dx < w; dx += step) {
        px(ctx, x + dx, y, Math.min(ART, w - dx), thickness, color);
        px(ctx, x + dx, y + h - thickness, Math.min(ART, w - dx), thickness, color);
      }
      for (let dy = 0; dy < h; dy += step) {
        px(ctx, x, y + dy, thickness, Math.min(ART, h - dy), color);
        px(ctx, x + w - thickness, y + dy, thickness, Math.min(ART, h - dy), color);
      }
    }

    // ==========================================================================
    // Sprites — ~16x24 art pixels. Each distinct (appearance, pose,
    // idle-bob-frame) combination is rendered ONCE to a small offscreen
    // canvas and cached; draw() just blits it (see getAgentSprite), so nothing
    // here re-issues rects on every frame for every agent.
    // ==========================================================================
    const SPR_COLS = 16, SPR_ROWS = 24; // "~16 wide x 24 tall art pixels"
    const SPR_TOP = 2 * ART; // spare headroom (bob shift + the outline's 1px bleed) so nothing clips
    const SPR_W = SPR_COLS * ART;
    const SPR_H = 2 * SPR_TOP + SPR_ROWS * ART;
    const spriteCache = new Map(); // "hairStyle.hairColor.skin.shirt|pose|frame" -> offscreen canvas

    function getAgentSprite(appearance, pose, frame) {
      const key = appearance.key + '|' + pose + '|' + frame;
      let c = spriteCache.get(key);
      if (c) return c;
      c = document.createElement('canvas');
      c.width = SPR_W;
      c.height = SPR_H;
      const sctx = c.getContext('2d');
      sctx.imageSmoothingEnabled = false;
      drawAgentSprite(sctx, SPR_W / 2, SPR_TOP, appearance, pose, frame);
      spriteCache.set(key, c);
      return c;
    }

    // Hair silhouette for the given style, centered at cx, `capCols` art
    // pixels wide starting `capRows` art pixels tall at (cx, y0). 'curly' and
    // the spike/side-hair accents are the only style-specific shapes; the
    // rest share one capped-rect base — blockRect's staircase corners, never
    // arc(), give the rounding.
    function drawHair(ctx, cx, y0, style, color, capCols, capRows) {
      if (style === 'bald') return;
      const half = (capCols / 2) * ART;
      if (style === 'hat') {
        outlinedBlock(ctx, cx - half - ART, y0 + (capRows - 1) * ART, capCols * ART + 2 * ART, ART, HAT_COLOR, 0);
        outlinedBlock(ctx, cx - half, y0, capCols * ART, (capRows - 1) * ART, HAT_COLOR, 1);
        return;
      }
      if (style === 'curly') {
        outlinedBlock(ctx, cx - half - ART, y0, capCols * ART + 2 * ART, (capRows + 1) * ART, color, 2);
        return;
      }
      outlinedBlock(ctx, cx - half, y0, capCols * ART, capRows * ART, color, 1);
      if (style === 'spiky') {
        [-half + ART, -ART, half - 2 * ART].forEach((dx) => px(ctx, cx + dx, y0 - ART, ART, ART, color));
      }
      if (style === 'long') {
        const sideH = (capRows + 3) * ART;
        px(ctx, cx - half - ART, y0 + (capRows - 2) * ART, 2 * ART, sideH, color);
        px(ctx, cx + half - ART, y0 + (capRows - 2) * ART, 2 * ART, sideH, color);
      }
      px(ctx, cx - half, y0 + (capRows - 1) * ART, ART, ART, darken(color, 0.3)); // shadow accent
    }

    // 'front' — face-on: hair, face + eyes, neck, shirt torso with arms,
    // trousers, feet. `headShift` (0 or ART) is the idle-bob offset applied
    // ONLY to the head/neck rows — the one-art-pixel step the spec asks for.
    function drawFrontSprite(ctx, cx, topY, appearance, headShift) {
      const hy = topY - headShift;
      const skin = appearance.skin;
      const shirt = appearance.shirt;
      drawHair(ctx, cx, hy, appearance.hairStyle, appearance.hairColor, 8, 4);
      outlinedBlock(ctx, cx - 3 * ART, hy + 4 * ART, 6 * ART, 4 * ART, skin, 1); // face
      px(ctx, cx - 2 * ART, hy + 6 * ART, ART, ART, OUTLINE); // eyes
      px(ctx, cx + 1 * ART, hy + 6 * ART, ART, ART, OUTLINE);
      px(ctx, cx - 2 * ART, hy + 8 * ART, 4 * ART, ART, darken(skin, 0.15)); // neck

      outlinedBlock(ctx, cx - 6 * ART, topY + 9 * ART, 12 * ART, 8 * ART, shirt, 1); // torso + arms
      px(ctx, cx - 6 * ART, topY + 9 * ART, 12 * ART, ART, lighten(shirt, 0.22));
      px(ctx, cx - 6 * ART, topY + 16 * ART, 12 * ART, ART, darken(shirt, 0.35));

      outlinedBlock(ctx, cx - 4 * ART, topY + 17 * ART, 8 * ART, 5 * ART, TROUSER_COLOR, 1); // trousers
      px(ctx, cx - 4 * ART, topY + 21 * ART, 8 * ART, ART, darken(TROUSER_COLOR, 0.3));

      outlinedBlock(ctx, cx - 4 * ART, topY + 22 * ART, 3 * ART, 2 * ART, SHOE_COLOR, 0); // feet
      outlinedBlock(ctx, cx + 1 * ART, topY + 22 * ART, 3 * ART, 2 * ART, SHOE_COLOR, 0);
    }

    // 'seated' — back-of-head-and-shoulders view for an agent at a desk
    // facing a monitor: hair fills the whole head (no face/eyes cutout),
    // wider shoulders, no legs. The whole thing bobs together by `headShift`
    // since it's nothing but head + shoulders.
    function drawSeatedSprite(ctx, cx, topY, appearance, headShift) {
      const y = topY - headShift;
      const shirt = appearance.shirt;
      drawHair(ctx, cx, y, appearance.hairStyle, appearance.hairColor, 10, 6);
      px(ctx, cx - 2 * ART, y + 6 * ART, 4 * ART, ART, darken(appearance.skin, 0.1)); // neck sliver
      outlinedBlock(ctx, cx - 7 * ART, y + 7 * ART, 14 * ART, 7 * ART, shirt, 2); // wide shoulders/back
      px(ctx, cx - 7 * ART, y + 7 * ART, 14 * ART, ART, lighten(shirt, 0.2));
      px(ctx, cx - 7 * ART, y + 12 * ART, 14 * ART, 2 * ART, darken(shirt, 0.3));
    }

    function drawAgentSprite(ctx, cx, topY, appearance, pose, frame) {
      const headShift = frame ? ART : 0;
      if (pose === 'seated') drawSeatedSprite(ctx, cx, topY, appearance, headShift);
      else drawFrontSprite(ctx, cx, topY, appearance, headShift);
    }

    // ---- status glyph — leads the nametag, shape (not colour alone) tells
    // the status apart: filled dot=idle, pulsing dot+ring=working, three
    // dots=streaming, filled square=needs_review, filled triangle=failed.
    function drawTagGlyph(ctx, status, x, cy, now) {
      switch (status) {
        case 'working': {
          px(ctx, x, cy - ART, ART * 2, ART * 2, COLOR.amber);
          const t = reducedMotion ? 0.5 : ((now % PULSE_MS) / PULSE_MS);
          const ring = ART * 2 + Math.round(t * 2) * ART;
          pxRingOutline(ctx, x - (ring - ART * 2) / 2, cy - ring / 2, ring, ring, withAlpha(COLOR.amber, 0.6 * (1 - t)), ART);
          break;
        }
        case 'streaming':
          px(ctx, x, cy - ART / 2, ART, ART, COLOR.accent);
          px(ctx, x + ART * 2, cy - ART / 2, ART, ART, COLOR.accent);
          px(ctx, x + ART * 4, cy - ART / 2, ART, ART, COLOR.accent);
          break;
        case 'needs_review':
          px(ctx, x, cy - ART * 1.5, ART * 3, ART * 3, COLOR.green);
          break;
        case 'failed':
          px(ctx, x + ART * 1.5, cy - ART, ART, ART, COLOR.red);
          px(ctx, x + ART, cy, ART * 2, ART, COLOR.red);
          px(ctx, x, cy + ART, ART * 4, ART, COLOR.red);
          break;
        default: // idle — filled green dot
          px(ctx, x, cy - ART, ART * 2, ART * 2, COLOR.green);
      }
    }

    // ---- furniture: desk (light top, darker front edge, monitor, keyboard,
    // and a hash-varied mug or mini plant so pods aren't visibly cloned),
    // top-down chair, and the room-corner potted plant. ----
    function drawDeskFurniture(ctx, agent, deskX, deskY, colors, working, now) {
      const top = lighten(colors.border, 0.55);
      outlinedBlock(ctx, deskX, deskY, DESK_W, DESK_H, top, 1);
      px(ctx, deskX, deskY + DESK_H - 2 * ART, DESK_W, 2 * ART, darken(colors.border, 0.4)); // front edge

      const cx = deskX + DESK_W / 2;
      const monW = 12 * ART, monH = 8 * ART;
      const monX = cx - monW / 2, monY = deskY - monH + 3 * ART;
      outlinedBlock(ctx, monX, monY, monW, monH, '#1c1c1c', 0);
      const blink = working && !reducedMotion && Math.floor(now / 500) % 2 === 0;
      px(ctx, monX + 3 * ART, monY + 3 * ART, ART, ART, working ? withAlpha(COLOR.accent, 0.9) : '#3a3a3a');
      px(ctx, monX + 7 * ART, monY + 3 * ART, ART, ART, working ? withAlpha(COLOR.amber, 0.9) : '#3a3a3a');
      px(ctx, monX + 5 * ART, monY + 6 * ART, ART, ART, working ? (blink ? COLOR.accent : withAlpha(COLOR.accent, 0.4)) : '#2c2c2c');

      px(ctx, cx - 5 * ART, deskY + 5 * ART, 10 * ART, 3 * ART, '#dcd6c8'); // keyboard
      px(ctx, cx - 5 * ART, deskY + 5 * ART, 10 * ART, ART, '#efe9db');

      const v = idHash(agent.id) % 3; // hash-varied desk clutter — not every pod clones the same desk
      if (v === 0) {
        const mx = deskX + DESK_W - 6 * ART, my = deskY + DESK_H - 6 * ART;
        outlinedBlock(ctx, mx, my, 3 * ART, 3 * ART, '#e5e5e5', 0); // mug
        px(ctx, mx + 3 * ART, my + ART, ART, ART, '#e5e5e5'); // handle
      } else if (v === 1) {
        const px0 = deskX + DESK_W - 6 * ART, py0 = deskY + DESK_H - 7 * ART;
        outlinedBlock(ctx, px0, py0 + 3 * ART, 3 * ART, 2 * ART, '#a0522d', 0); // mini pot
        px(ctx, px0 + ART, py0, ART, 3 * ART, COLOR.green);
        px(ctx, px0, py0 + ART, ART, 2 * ART, COLOR.green);
      }
    }

    function drawChair(ctx, cx, cy) {
      outlinedBlock(ctx, cx - 3 * ART, cy - 2 * ART, 6 * ART, 5 * ART, '#3a3a3a', 1); // seat
      px(ctx, cx - 3 * ART, cy - 2 * ART, 6 * ART, 2 * ART, '#5a5a5a'); // back, nearer the agent
      [[-4, 7], [4, 7], [-4, 13], [4, 13]].forEach(([dx, dy]) => px(ctx, cx + dx, cy + dy, ART, ART, '#232323')); // 4-spoke base
    }

    // A potted plant tucked in the room's far corner — decorative furniture,
    // skipped in rooms too small to fit it without crowding a desk.
    function drawPlant(ctx, room, colors) {
      if (room.w < 3 || room.h < 3) return;
      const cx = (room.x + room.w) * GRID - 14, cy = (room.y + room.h) * GRID - 10;
      const pot = darken(colors.border, 0.35);
      outlinedBlock(ctx, cx - 5, cy, 10, 7, pot, 1);
      px(ctx, cx - 5, cy, 10, ART, lighten(pot, 0.25)); // rim highlight
      [[-3, -4, 3, 4], [2, -5, 3, 4], [-1, -8, 4, 5]].forEach(([dx, dy, w, h]) => {
        outlinedBlock(ctx, cx + dx, cy + dy, w, h, COLOR.green, 1);
      });
    }

    // ---- tiled floor + carpet texture — rendered once to small repeating
    // patterns and cached, so filling a whole viewport is a single fillRect
    // rather than thousands of per-tile fillRect calls per frame. ----
    let floorPatternCache = null;
    function getFloorPattern(ctx) {
      if (floorPatternCache) return floorPatternCache;
      const ts = 8 * ART;
      const t = document.createElement('canvas');
      t.width = ts; t.height = ts;
      const tctx = t.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      px(tctx, 0, 0, ts, ts, FLOOR_BASE);
      px(tctx, 0, 0, ts, ART, FLOOR_GROUT);
      px(tctx, 0, 0, ART, ts, FLOOR_GROUT);
      floorPatternCache = ctx.createPattern(t, 'repeat');
      return floorPatternCache;
    }

    let carpetPatternCache = null;
    function getCarpetPattern(ctx) {
      if (carpetPatternCache) return carpetPatternCache;
      const ts = 8 * ART;
      const t = document.createElement('canvas');
      t.width = ts; t.height = ts;
      const tctx = t.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      px(tctx, 0, 0, ART, ART, 'rgba(0,0,0,0.05)');
      px(tctx, ts / 2, ts / 2, ART, ART, 'rgba(0,0,0,0.05)');
      carpetPatternCache = ctx.createPattern(t, 'repeat');
      return carpetPatternCache;
    }

    const canvas = document.getElementById('office-canvas');
    const listTable = document.getElementById('office-list');
    const panel = document.getElementById('office-panel');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx) ctx.imageSmoothingEnabled = false;

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
        ctx.font = '600 10px ' + MONO; // matches drawNametag's font exactly, so the cached width is accurate
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
      ctx.fillStyle = FLOOR_BASE; // flat safety base under the tiled pattern, covers any edge gap
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-camera.x, -camera.y);

      // tiled tan floor across the visible world rect, not a flat fill
      ctx.fillStyle = getFloorPattern(ctx);
      ctx.fillRect(camera.x - GRID, camera.y - GRID, w / camera.zoom + GRID * 2, h / camera.zoom + GRID * 2);

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
      const band = 2 * ART; // "2-art-pixel band" wall

      blockRect(ctx, x, y, w, h, colors.border, 2); // wall
      blockRect(ctx, x + band, y + band, w - 2 * band, h - 2 * band, colors.fill, 2); // carpet interior
      px(ctx, x + band, y + band - ART, w - 2 * band, ART, lighten(colors.border, 0.35)); // wall top highlight

      // carpet texture — a subtle repeating dot pattern clipped to the room interior
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + band, y + band, w - 2 * band, h - 2 * band);
      ctx.clip();
      ctx.fillStyle = getCarpetPattern(ctx);
      ctx.fillRect(x + band, y + band, w - 2 * band, h - 2 * band);
      ctx.restore();

      // "room heat" — an animated (not snapped) amber glow while an agent in
      // the room is working/streaming.
      if (heat > 0.01) {
        pxRingOutline(ctx, x + band, y + band, w - 2 * band, h - 2 * band, withAlpha(COLOR.amber, 0.55 * heat), ART * 2);
      }

      ctx.fillStyle = COLOR.dim;
      ctx.font = '600 11px ' + MONO;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(room.name, x + band + 8, y + band + 6);

      drawPlant(ctx, room, colors);
    }

    function drawAgent(agent, steps, now) {
      const status = liveStatus(agent, steps, now);
      const p = gridToPixel(agent.desk.x, agent.desk.y);
      const deskX = p.x - DESK_W / 2, deskY = p.y;
      const ac = agentAvatarCenter(agent);
      const room = roomsById.get(agent.roomId);
      const colors = room ? roomColors(room.name) : ROOM_FALLBACK;
      const working = status === 'working' || status === 'streaming';

      // idle "breathing" — a single ART-pixel head/shoulder shift, phase
      // staggered per agent (stepped, not a smooth tween — sprite idle
      // animation reads as a discrete frame flip, not motion).
      const bobFrame = reducedMotion ? 0 : (Math.floor(now / (BOB_PERIOD_MS / 2)) + (idHash(agent.id) % 2)) % 2;

      // hover — eased lift + nametag fade-in (the ease itself stays smooth;
      // only the idle bob above is required to be a discrete step).
      const hovered = hoverAgentId === agent.id;
      const ht = ease(hoverT, agent.id, hovered ? 1 : 0, now, EASE_HOVER_MS);
      const isSelected = selected && selected.kind === 'agent' && selected.id === agent.id;
      const focused = focusedAgentId === agent.id && document.activeElement === canvas;
      const lift = ht * 2 * ART;
      const vx = ac.x, vy = ac.y - lift;

      drawDeskFurniture(ctx, agent, deskX, deskY, colors, working, now);
      drawChair(ctx, vx, deskY - 4 * ART); // between the desk and the seated agent

      const appearance = agentAppearance(agent.id);
      const sprite = getAgentSprite(appearance, 'seated', bobFrame);
      const visibleH = 14 * ART; // hair+shoulders footprint, used to center the sprite on vy
      const bx = Math.floor((vx - SPR_W / 2) / ART) * ART;
      const by = Math.floor((vy - visibleH / 2 - SPR_TOP) / ART) * ART;
      ctx.drawImage(sprite, bx, by);

      if (hovered || isSelected) {
        pxRingOutline(ctx, bx - ART, by - ART, SPR_W + 2 * ART, visibleH + 2 * ART, COLOR.accent, ART);
      }
      if (focused) {
        pxRingOutline(ctx, bx - 3 * ART, by - 3 * ART, SPR_W + 6 * ART, visibleH + 6 * ART, COLOR.accent, ART, true);
      }

      if (status === 'streaming') drawSpeechBubble(ctx, vx, by - 34, now);

      const nametagAlpha = Math.max(ht, isSelected ? 1 : 0, focused ? 1 : 0, status !== 'idle' ? 1 : 0);
      drawNametag(agent, vx, by - 18, status, nametagAlpha, now);
    }

    // A small white pixel-art speech bubble above the nametag while a step
    // is actively streaming — three dots and a short tail pointing down.
    function drawSpeechBubble(ctx, cx, y, now) {
      const w = 22, h = 12;
      const x = Math.floor((cx - w / 2) / ART) * ART;
      const yy = Math.floor(y / ART) * ART;
      outlinedBlock(ctx, x, yy, w, h, '#ffffff', 2);
      px(ctx, cx - ART, yy + h - ART, ART * 2, ART * 2, '#ffffff');
      px(ctx, cx - ART / 2, yy + h + ART, ART, ART, '#ffffff'); // tail tip
      const dotY = yy + h / 2 - ART / 2;
      [-6, 0, 6].forEach((dx) => px(ctx, cx + dx - ART / 2, dotY, ART, ART, OUTLINE));
    }

    // Nametags are hidden by default (Gather-style) and fade in on hover,
    // selection, or keyboard focus — `alpha` is the eased 0..1 amount. Any
    // agent that isn't idle is always shown (the people doing something are
    // the labelled ones), matching the reference.
    function drawNametag(agent, cx, y, status, alpha, now) {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '600 10px ' + MONO;
      const textW = agent.labelWidth != null ? agent.labelWidth : ctx.measureText(agent.label).width;
      const glyphW = 5 * ART, padX = 6, h = 14;
      const w = Math.ceil(textW) + padX * 2 + glyphW;
      const x = Math.floor((cx - w / 2) / ART) * ART;
      const yy = Math.floor(y / ART) * ART;
      blockRect(ctx, x, yy, w, h, TAG_BG, 3); // near-black, ~85% opaque, rounded via omitted corners
      drawTagGlyph(ctx, status, x + padX / 2, yy + h / 2, now);
      ctx.fillStyle = TAG_TEXT; // white text
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(agent.label, x + padX + glyphW, yy + h / 2 + 0.5);
      ctx.restore();
    }

    // Delegation beam: a travelling dot along the Corner Office -> desk path
    // with a fading pixel trail behind it, over BEAM_MS (~700ms).
    function drawBeams(now) {
      for (const b of animations) {
        if (b.kind !== 'beam') continue;
        const t = Math.min(1, (now - b.start) / BEAM_MS);
        const ex = b.x1 + (b.x2 - b.x1) * t;
        const ey = b.y1 + (b.y2 - b.y1) * t;

        const steps = 10;
        for (let i = 0; i <= steps; i++) {
          const tt = t * (i / steps);
          const sx = b.x1 + (b.x2 - b.x1) * tt, sy = b.y1 + (b.y2 - b.y1) * tt;
          px(ctx, sx, sy, ART, ART, withAlpha(COLOR.accent, 0.28 * (1 - tt * 0.5)));
        }
        px(ctx, ex - ART, ey - ART, ART * 3, ART * 3, withAlpha(COLOR.accent, 0.5));
        px(ctx, ex - ART / 2, ey - ART / 2, ART, ART, COLOR.accent);
      }
    }

    function resizeCanvas() {
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.imageSmoothingEnabled = false; // resizing the backing store resets context state
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
        tr.addEventListener('click', () => {
          // Returning to the floor is the point of clicking a row: you get the
          // agent's panel AND the office back, rather than staying in the table.
          setListMode(false);
          selectAgent(agent);
        });
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectAgent(agent); });
        tbody.appendChild(tr);
      }
      listTable.appendChild(tbody);
    }

    function toggleListMode() {
      setListMode(!listMode);
    }

    // The button names where it TAKES you, not where you are. It used to read
    // "List" in both modes and only flip aria-pressed, so from the list there was
    // no visible way back to the floorplan.
    function setListMode(on) {
      listMode = on;
      canvas.hidden = listMode;
      listTable.hidden = !listMode;

      const toggleBtn = document.getElementById('office-toggle');
      const label = document.getElementById('office-toggle-label');
      const icon = document.getElementById('office-toggle-icon');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', String(listMode));
        toggleBtn.title = listMode
          ? 'Back to the office floor (Cmd+L)'
          : 'Show the list of agents (Cmd+L)';
      }
      if (label) label.textContent = listMode ? 'Office' : 'List';
      if (icon) icon.setAttribute('href', listMode ? '#i-back' : '#i-tasks');

      if (listMode) renderList(); else { resizeCanvas(); draw(); }
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
    idHash, agentAppearance, POSE_ANATOMY,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicApi;
  }
})();
