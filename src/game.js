// game.js — in-memory game state + tick loop

import { v4 as uuidv4 } from 'uuid';

export const GRID_ROWS    = 15;
export const GRID_COLS    = 15;
export const TICK_MS      = 100;
export const BULLET_SPEED = 2;  // cells advanced per tick (each cell still checked for hits)

// ── Barriers ──────────────────────────────────────────────────────────────────
// Two vertical barriers in the left/right middle of the grid.
// Bullets are destroyed on contact; agents cannot enter barrier cells.
//   Left  barrier — col 3,  rows 5–9  (left-side mid-column)
//   Right barrier — col 11, rows 5–9  (right-side mid-column)
export const BARRIERS = [
  { row: 5, col:  3 }, { row: 6, col:  3 }, { row: 7, col:  3 },
  { row: 8, col:  3 }, { row: 9, col:  3 },
  { row: 5, col: 11 }, { row: 6, col: 11 }, { row: 7, col: 11 },
  { row: 8, col: 11 }, { row: 9, col: 11 },
];
const _barrierSet = new Set(BARRIERS.map(b => `${b.row},${b.col}`));
function barrierAt(row, col) { return _barrierSet.has(`${row},${col}`); }

// Direction vectors
const DIR = {
  N: { dr: -1, dc:  0 },
  S: { dr:  1, dc:  0 },
  E: { dr:  0, dc:  1 },
  W: { dr:  0, dc: -1 },
};

// ── Zone definitions ──────────────────────────────────────────────────────────
// 4 quadrant zones separated by a 2-row / 2-col neutral band (rows 6-7, cols 6-7).
//   Zone 0 Alpha   — top-left     rows 0-5,  cols 0-5
//   Zone 1 Bravo   — top-right    rows 0-5,  cols 8-14
//   Zone 2 Charlie — bottom-left  rows 8-14, cols 0-5
//   Zone 3 Delta   — bottom-right rows 8-14, cols 8-14
export const ZONES = [
  { id: 0, name: 'Alpha',   color: '#ff6b6b', rowMin: 0, rowMax:  5, colMin: 0, colMax:  5 },
  { id: 1, name: 'Bravo',   color: '#4d96ff', rowMin: 0, rowMax:  5, colMin: 8, colMax: 14 },
  { id: 2, name: 'Charlie', color: '#6bcb77', rowMin: 8, rowMax: 14, colMin: 0, colMax:  5 },
  { id: 3, name: 'Delta',   color: '#ffd93d', rowMin: 8, rowMax: 14, colMin: 8, colMax: 14 },
];

// Team prefix assigned per zone (round-robin). Prepended to every agent name.
//   Zone 0 → RED, Zone 1 → BLUE, Zone 2 → YELLOW, Zone 3 → BLACK
export const TEAM_PREFIXES = ['RED', 'BLUE', 'YELLOW', 'BLACK'];

let _nextZone = 0; // round-robin zone assignment counter

// ── State ────────────────────────────────────────────────────────────────────
// agents: Map<agentId, Agent>
// bullets: Map<bulletId, Bullet>
// tick: number

const MAX_CHAT = 100; // keep last 100 messages

const state = {
  tick: 0,
  agents:   new Map(),   // agentId → Agent
  bullets:  new Map(),   // bulletId → Bullet
  chat:     [],          // [ { ts, agentId, name, message } ] newest-last
  sessions: new Map(),   // clientId → agentId (one account per clientId)
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function inBounds(row, col) {
  return row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
}

function agentAt(row, col) {
  for (const a of state.agents.values()) {
    if (a.alive && a.row === row && a.col === col) return a;
  }
  return null;
}

function randomEmptyCell() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = Math.floor(Math.random() * GRID_ROWS);
    const col = Math.floor(Math.random() * GRID_COLS);
    if (!agentAt(row, col) && !barrierAt(row, col)) return { row, col };
  }
  throw new Error('Grid is full');
}

function randomEmptyCellInZone(zoneId) {
  const z = ZONES[zoneId];
  const rows = z.rowMax - z.rowMin + 1;
  const cols = z.colMax - z.colMin + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = z.rowMin + Math.floor(Math.random() * rows);
    const col = z.colMin + Math.floor(Math.random() * cols);
    if (!agentAt(row, col) && !barrierAt(row, col)) return { row, col };
  }
  throw new Error('Zone is full');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Login: create a new agent, return { agentId, token, name, zone, characterId, personality, avatar }.
 *  Zones are assigned round-robin (0→1→2→3→0…).
 *  Agent name is formatted as [TEAM]basename#NNN (e.g. [RED]MyBot#427).
 *  If clientId is provided, throws if that clientId already has an active agent. */
export function login({ name, characterId, personality, avatar, clientId }) {
  if (clientId && state.sessions.has(clientId)) {
    throw new Error('Already logged in. Call /logout first.');
  }
  const agentId  = uuidv4();
  const token    = uuidv4();
  const suffix   = String(Math.floor(Math.random() * 900) + 100);
  const zone     = _nextZone % ZONES.length;
  _nextZone++;
  const team     = TEAM_PREFIXES[zone];
  // Reserve room for [TEAM] prefix (up to 8 chars) + '#NNN' suffix (4 chars)
  const baseName = String(name).slice(0, 20);
  const fullName = `[${team}]${baseName}#${suffix}`;
  const { row, col } = randomEmptyCellInZone(zone);
  const charId = String(characterId).slice(0, 16);
  state.agents.set(agentId, {
    agentId,
    token,
    name:        fullName,
    characterId: charId,
    personality: personality ? String(personality).slice(0, 100) : '',
    avatar:      avatar ? String(avatar) : '',
    row, col,
    zone,
    score:        0,
    alive:        true,
    hp:           10,
    facingDir:    'S',
    lastShotTick: -10,   // allows shooting immediately on spawn
    clientId:     clientId ?? null,
  });
  if (clientId) state.sessions.set(clientId, agentId);
  return { agentId, token, name: fullName, zone, characterId: charId, personality: personality ?? '', avatar: avatar ?? '' };
}

/** Logout: purge agent from state */
export function logout(agentId) {
  const agent = state.agents.get(agentId);
  if (agent?.clientId) state.sessions.delete(agent.clientId);
  state.agents.delete(agentId);
  for (const [id, b] of state.bullets) {
    if (b.ownerId === agentId) state.bullets.delete(id);
  }
  // keep chat messages (history stays visible after logout)
}

// No zone movement restriction — agents may move anywhere on the grid.

/** Move agent one cell. Returns new { row, col } or throws.
 *  Agents may not enter another team's zone — only their own zone + neutral band. */
export function move(agentId, direction) {
  const d = DIR[direction];
  if (!d) throw new Error(`Unknown direction: ${direction}`);
  const agent = state.agents.get(agentId);
  if (!agent || !agent.alive) throw new Error('Agent not found');

  const newRow = agent.row + d.dr;
  const newCol = agent.col + d.dc;
  if (!inBounds(newRow, newCol)) throw new Error('Out of bounds');
  if (agentAt(newRow, newCol))   throw new Error('Cell occupied');
  if (barrierAt(newRow, newCol)) throw new Error('Cell is a barrier');

  agent.row = newRow;
  agent.col = newCol;
  agent.facingDir = direction;
  return { row: newRow, col: newCol };
}

const SHOOT_COOLDOWN_TICKS = 10; // 10 ticks × 100 ms = 1 shot per second

/** Shoot a bullet in given direction. Returns bulletId. */
export function shoot(agentId, direction) {
  const d = DIR[direction];
  if (!d) throw new Error(`Unknown direction: ${direction}`);
  const agent = state.agents.get(agentId);
  if (!agent || !agent.alive) throw new Error('Agent not found');

  const ticksSinceLast = state.tick - agent.lastShotTick;
  if (ticksSinceLast < SHOOT_COOLDOWN_TICKS) {
    const waitMs = (SHOOT_COOLDOWN_TICKS - ticksSinceLast) * TICK_MS;
    throw new Error(`Shoot cooldown: wait ${waitMs} ms`);
  }

  const bulletId = uuidv4();
  state.bullets.set(bulletId, {
    bulletId,
    ownerId:   agentId,
    row:       agent.row,   // spawn at shooter's own cell;
    col:       agent.col,   // first tick will advance it +1 before hit check
    direction,
  });
  agent.facingDir    = direction;
  agent.lastShotTick = state.tick;
  return { bulletId };
}

/** Post a chat message. Returns the message object. */
export function chat(agentId, message) {
  const agent = state.agents.get(agentId);
  if (!agent || !agent.alive) throw new Error('Agent not found');
  const msg = {
    ts:      Date.now(),
    agentId,
    name:    agent.name,
    message: String(message).slice(0, 200),
  };
  state.chat.push(msg);
  if (state.chat.length > MAX_CHAT) state.chat.shift();
  return msg;
}

/** Return a serialisable snapshot of current state */
export function getState() {
  return {
    tick:     state.tick,
    grid:     { rows: GRID_ROWS, cols: GRID_COLS },
    agents:   [...state.agents.values()].map(({ token, ...pub }) => pub),
    bullets:  [...state.bullets.values()],
    barriers: BARRIERS,
    chat:     [...state.chat],
  };
}

/** Resolve agent token → agentId, or null */
export function resolveToken(token) {
  for (const a of state.agents.values()) {
    if (a.token === token) return a.agentId;
  }
  return null;
}

// ── Tick loop ─────────────────────────────────────────────────────────────────
// onTick callback is injected by server.js so game.js stays transport-agnostic.

let _onTick = null;
export function startLoop(onTick) {
  _onTick = onTick;
  setInterval(_tick, TICK_MS);
}

function _tick() {
  try {
    state.tick++;

    // NPC periodic chat hint
    if (state.tick % NPC_CHAT_INTERVAL === 0) _npcChat();

    // Move each bullet BULLET_SPEED cells, checking hits at every intermediate cell
    for (const [bulletId, bullet] of state.bullets) {
      const d = DIR[bullet.direction];

      for (let step = 0; step < BULLET_SPEED; step++) {
        bullet.row += d.dr;
        bullet.col += d.dc;

        // Out of bounds → remove
        if (!inBounds(bullet.row, bullet.col)) {
          state.bullets.delete(bulletId);
          break;
        }

        // Hit barrier → absorb bullet
        if (barrierAt(bullet.row, bullet.col)) {
          state.bullets.delete(bulletId);
          break;
        }

        // Hit check — bullets pass through NPCs; all other agents take damage
        const victim = agentAt(bullet.row, bullet.col);
        if (victim && !victim.isNpc) {

          victim.score -= 1;
          victim.hp    -= 1;
          const shooter = state.agents.get(bullet.ownerId);
          if (shooter) shooter.score += 1;
          state.bullets.delete(bulletId);

          // Eliminated — purge agent
          if (victim.hp <= 0) {
            if (victim.clientId) state.sessions.delete(victim.clientId);
            // remove all bullets belonging to the victim
            for (const [bid, b] of state.bullets) {
              if (b.ownerId === victim.agentId) state.bullets.delete(bid);
            }
            state.agents.delete(victim.agentId);
            // broadcast elimination message in chat
            state.chat.push({
              ts:      Date.now(),
              agentId: 'system',
              name:    'System',
              message: `💀 ${victim.name} was eliminated!`,
            });
            if (state.chat.length > MAX_CHAT) state.chat.shift();
          }
          break; // bullet consumed, stop stepping
        }
      }
    }

    if (_onTick) _onTick(getState());
  } catch (err) {
    console.error('[tick] uncaught error in _tick — game loop continues', err);
  }
}

// ── NPC initialisation ────────────────────────────────────────────────────────

const NPC_HINTS = [
  '🗺 Grid is 15×15. Move with N/S/E/W. Bullets fly straight until they hit a wall, barrier, or agent.',
  '💥 Hit an enemy → +1 score. Get hit → -1 score. Take 10 hits and you are eliminated!',
  '🔑 POST /login to join. Use your token in Authorization: Bearer <token> for all actions.',
  '🏃 You can move AND shoot each tick (100ms). Shoot cooldown: 1 shot per second.',
  '💬 Chat is public — bluff, negotiate, or form alliances. Opponents can read everything.',
  '👻 The NPC on the map cannot be hit. Bullets pass right through.',
  '🔄 Eliminated? Just POST /login again to respawn at a new random cell in your zone.',
  '🎯 Aim ahead — bullets take one tick per cell. Lead your target by one step.',
  '📡 Subscribe to WS /ws for live GameState every 100ms, or poll GET /state.',
  '🛡 Zones: Alpha🔴 Bravo🔵 Charlie🟢 Delta🟡. Zone only affects spawn position — all agents can shoot each other!',
  '⚠️ Moving into a wall, barrier, or occupied cell returns 400. Check bounds before moving.',
  '🧱 Two barriers block bullets: left-center (col 3, rows 5–9) and right-center (col 11, rows 5–9). Use them as cover!',
  '☯ 知己知彼，百战不殆。Read state.agents for every opponent\'s position and HP before acting.',
  '🃏 A well-timed chat message can mislead opponents. They read your chat too — choose your words wisely.',
  '🧩 Barrier tactics: move perpendicular to your attacker so the barrier blocks their line of fire.',
];

let _npcId   = null;
let _npcTick = 0;
const NPC_CHAT_INTERVAL = 300; // every 300 ticks ≈ 30 seconds

export function spawnNpcs() {
  const row = 7, col = 7; // fixed center of the 15×15 grid
  _npcId = uuidv4();
  state.agents.set(_npcId, {
    agentId:     _npcId,
    token:       null,
    name:        'NPC',
    characterId: 'npc',
    row, col,
    score:       0,
    alive:       true,
    facingDir:   'S',
    isNpc:       true,
  });
}

function _npcChat() {
  if (!_npcId) return;
  const msg = NPC_HINTS[_npcTick % NPC_HINTS.length];
  _npcTick++;
  state.chat.push({ ts: Date.now(), agentId: _npcId, name: 'NPC', message: msg });
  if (state.chat.length > MAX_CHAT) state.chat.shift();
}
