'use strict';
// Turns ~/.claude/agents/*.md charter files into virtual-office floorplan
// geometry (rooms + desks). Pure data — no rendering, no Electron, no network.
// Renderer multiplies everything here by 32 to get pixels.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ROW_W = 44; // shelf-packer wrap width, grid units
const DESK_GAP = 2;   // desks ~2 units apart

// FNV-1a 32-bit — deterministic seat hash so an agent keeps its desk across
// restarts. Collisions resolved by linear probing (see assignDesks).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function titleCase(id) {
  return id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function readAgentName(file, id) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const m = text.slice(0, end).match(/^name:\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return titleCase(id);
}

// Fixed, non-engineering department routing.
const SINGLE_ROOM = {
  'chief-of-staff': 'Corner Office',
};
const EXECUTIVE = new Set(['ceo', 'cfo', 'cmo', 'coo', 'cto']);
const ARCHITECTURE = new Set(['principal-architect', 'solution-architect']);
const DELIVERY = new Set(['developer', 'deployer', 'tester', 'research-analyst']);

function roomFor(id) {
  if (SINGLE_ROOM[id]) return SINGLE_ROOM[id];
  if (EXECUTIVE.has(id)) return 'Executive';
  if (ARCHITECTURE.has(id)) return 'Architecture';
  if (DELIVERY.has(id)) return 'Delivery';
  if (id.startsWith('security-')) return 'Security';
  if (id.startsWith('project-management-') || id.startsWith('project-manager')) return 'Project Management';
  if (id.startsWith('product-')) return 'Product';
  return null; // engineering-* (pod'd) or unrecognized
}

// Engineering pods: first keyword match wins, rest fall into Specialty.
const POD_KEYWORDS = [
  ['Web', ['frontend', 'cms', 'wordpress', 'drupal', 'uswds', 'wechat', 'filament']],
  ['Infra', ['devops', 'sre', 'network', 'finops', 'incident', 'it-service', 'deployer']],
  ['Data', ['data', 'database', 'search', 'email-intelligence', 'ai-', 'remediation']],
  ['Mobile', ['mobile', 'embedded', 'desktop', 'video', 'webassembly']],
  ['Platform', ['api', 'backend', 'payments', 'identity', 'realtime', 'i18n', 'software-architect', 'orgscript', 'feishu']],
];
const POD_NAMES = [...POD_KEYWORDS.map(([n]) => n), 'Specialty'];

function podFor(rest) {
  for (const [pod, kws] of POD_KEYWORDS) {
    if (kws.some((kw) => rest.includes(kw))) return pod;
  }
  return 'Specialty';
}

// A keyword split can overload one pod (Specialty, mainly). Rebalance by
// moving the alphabetically-last member of any pod over 10 into whichever
// pod is currently smallest, until every pod holds <=10.
function balancePods(buckets) {
  let guard = 0;
  while (guard++ < 1000) {
    const over = POD_NAMES.find((n) => buckets.get(n).length > 10);
    if (!over) break;
    const arr = buckets.get(over);
    arr.sort();
    const id = arr.pop();
    const target = POD_NAMES.filter((n) => n !== over)
      .reduce((a, b) => (buckets.get(b).length < buckets.get(a).length ? b : a));
    buckets.get(target).push(id);
  }
}

// Grid of desk slots for n occupants: roughly square, 1-unit wall padding,
// DESK_GAP apart. Returns { w, h, slots: [{x,y}, ...] } (slots.length === n).
function deskGrid(n) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const slots = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    slots.push({ x: 1 + DESK_GAP * col, y: 1 + DESK_GAP * row });
  }
  return { w: DESK_GAP * cols + 1, h: DESK_GAP * rows + 1, slots };
}

// Deterministic seat assignment: hash each id into the slot array, linear-
// probe past collisions. `ids` must already be sorted for reproducibility.
function assignDesks(ids, slots) {
  const n = slots.length;
  const occupied = new Array(n).fill(false);
  const out = new Map();
  for (const id of ids) {
    let idx = fnv1a(id) % n;
    while (occupied[idx]) idx = (idx + 1) % n;
    occupied[idx] = true;
    out.set(id, slots[idx]);
  }
  return out;
}

function loadRoster(agentsDir = path.join(os.homedir(), '.claude', 'agents')) {
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort();

  // roomId -> [{ id, name }]
  const rooms = new Map();
  const podBuckets = new Map(POD_NAMES.map((n) => [n, []]));
  const names = new Map();

  for (const file of files) {
    const id = file.slice(0, -3);
    names.set(id, readAgentName(path.join(agentsDir, file), id));

    const room = roomFor(id);
    if (room) {
      if (!rooms.has(room)) rooms.set(room, []);
      rooms.get(room).push(id);
    } else if (id.startsWith('engineering-')) {
      podBuckets.get(podFor(id.slice('engineering-'.length))).push(id);
    } else {
      // Not expected given the roster is fully classified above, but keep
      // roster building total rather than silently dropping an agent.
      if (!rooms.has('Specialty')) rooms.set('Specialty', []);
      rooms.get('Specialty').push(id);
    }
  }

  balancePods(podBuckets);
  for (const pod of POD_NAMES) {
    const bucket = podBuckets.get(pod);
    if (bucket.length) rooms.set(`Engineering — ${pod}`, bucket);
  }
  rooms.set('Lounge', []); // no permanent occupants

  // Fixed room order keeps output deterministic across runs.
  const order = [
    'Corner Office', 'Executive', 'Architecture', 'Delivery', 'Security',
    'Project Management', 'Product',
    ...POD_NAMES.map((p) => `Engineering — ${p}`),
    'Specialty', 'Lounge',
  ].filter((r) => rooms.has(r));

  // Shelf-pack rooms, sized from occupant count (Lounge fixed 10x8).
  const packed = [];
  let x = 0, y = 0, rowH = 0;
  for (const roomName of order) {
    const occupants = rooms.get(roomName).slice().sort();
    const isLounge = roomName === 'Lounge';
    const { w, h, slots } = isLounge ? { w: 10, h: 8, slots: [] } : deskGrid(occupants.length);

    if (x > 0 && x + w > MAX_ROW_W) { x = 0; y += rowH + 1; rowH = 0; }
    const roomId = roomName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    packed.push({ id: roomId, name: roomName, x, y, w, h, occupants, slots });
    x += w + 1;
    rowH = Math.max(rowH, h);
  }

  const agents = [];
  for (const room of packed) {
    const desks = assignDesks(room.occupants, room.slots);
    for (const id of room.occupants) {
      const local = desks.get(id);
      agents.push({
        id,
        name: names.get(id),
        dept: room.name,
        roomId: room.id,
        desk: { x: room.x + local.x, y: room.y + local.y }, // global grid units
      });
    }
  }

  const outRooms = packed.map(({ id, name, x, y, w, h }) => ({ id, name, x, y, w, h }));
  const bounds = {
    w: Math.max(...outRooms.map((r) => r.x + r.w)),
    h: Math.max(...outRooms.map((r) => r.y + r.h)),
  };

  return { rooms: outRooms, agents, bounds };
}

module.exports = { loadRoster };

if (require.main === module) {
  const assert = require('node:assert');
  const agentsDir = path.join(os.homedir(), '.claude', 'agents');
  const fileCount = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).length;

  const roster = loadRoster();
  const roster2 = loadRoster();
  assert.deepStrictEqual(roster, roster2, 'loadRoster() is not deterministic');
  assert.strictEqual(JSON.stringify(roster), JSON.stringify(roster2));

  assert.strictEqual(roster.agents.length, fileCount, 'agent count mismatch');

  const byDept = (name) => roster.agents.filter((a) => a.dept === name).length;
  assert.strictEqual(
    roster.agents.filter((a) => a.dept.startsWith('Engineering — ')).length,
    49,
  );
  assert.strictEqual(byDept('Security'), 10);
  assert.strictEqual(byDept('Project Management'), 8);
  assert.strictEqual(byDept('Product'), 5);

  const deskKeys = new Set();
  for (const a of roster.agents) {
    const key = `${a.desk.x},${a.desk.y}`;
    assert(!deskKeys.has(key), `desk collision at ${key}`);
    deskKeys.add(key);

    const room = roster.rooms.find((r) => r.id === a.roomId);
    assert(room, `agent ${a.id} references missing room ${a.roomId}`);
    assert(a.desk.x > room.x && a.desk.x < room.x + room.w, `${a.id} desk outside room x`);
    assert(a.desk.y > room.y && a.desk.y < room.y + room.h, `${a.id} desk outside room y`);
  }

  for (let i = 0; i < roster.rooms.length; i++) {
    for (let j = i + 1; j < roster.rooms.length; j++) {
      const a = roster.rooms[i], b = roster.rooms[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert(!overlap, `rooms overlap: ${a.name} / ${b.name}`);
    }
  }

  for (const pod of POD_NAMES) {
    const n = byDept(`Engineering — ${pod}`);
    assert(n <= 10, `pod ${pod} has ${n} occupants, exceeds 10`);
  }

  console.log(`roster.js: all checks pass (${roster.agents.length} agents, ${roster.rooms.length} rooms)`);
}
