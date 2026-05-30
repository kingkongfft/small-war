#!/usr/bin/env node
// demo-bot.js — example AI agent for small-war
//
// Strategy:
//   1. Poll /state every tick (100 ms)
//   2. Find the nearest living enemy (non-NPC, not self)
//   3. Shoot when aligned and no barrier blocks the path
//   4. Otherwise move closer while avoiding barriers and occupied cells
//
// Usage:
//   node demo-bot.js [name] [characterId] [serverUrl]
//   LLM_MODEL=<model> node demo-bot.js [serverUrl]
//
// The login name embeds the LLM version so observers can identify the agent.
// Priority: CLI arg (argv[2]) > LLM_MODEL env var > 'DemoBot'
// When LLM_MODEL is set, skip the name positional arg — pass only [characterId] [serverUrl].
//
// Examples:
//   node demo-bot.js MyBot tank
//   node demo-bot.js MyBot jet http://localhost:3000
//   LLM_MODEL="Sonnet4.6" node demo-bot.js              # name from env, random char
//   LLM_MODEL="GPT4o" node demo-bot.js http://HOST:3000 # name from env, custom server
//   BOT_RUN_MS=5000 node demo-bot.js MyBot tank           # auto-logout after 5s

const _CHARS = ['warrior', 'mage', 'archer', 'tank', 'rogue', 'paladin', 'ranger', 'monk'];
const DELAY = 120; // ms between actions — slightly above 100 ms tick
const SHOOT_COOLDOWN_TICKS = 10;
const RUN_MS = Number.parseInt(process.env.BOT_RUN_MS ?? '', 10);
const DIR = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  E: { dr: 0, dc: 1 },
  W: { dr: 0, dc: -1 },
};
const DIRS = Object.keys(DIR);

function randomCharacter() {
  return _CHARS[Math.floor(Math.random() * _CHARS.length)];
}

function isCharacterId(value) {
  return _CHARS.includes(value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function parseArgs(argv) {
  const args = [...argv];
  let base = 'http://localhost:3000';

  if (args.length && isUrl(args[args.length - 1])) base = args.pop();

  const envName = process.env.LLM_MODEL;
  let name = envName ?? 'DemoBot';
  let characterId;

  if (args.length >= 2) {
    name = args[0];
    characterId = args[1];
  } else if (args.length === 1) {
    if (envName && isCharacterId(args[0])) characterId = args[0];
    else name = args[0];
  }

  return {
    base,
    name,
    characterId: characterId ?? randomCharacter(),
  };
}

const { base: BASE, name: NAME, characterId: CHAR } = parseArgs(process.argv.slice(2));

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getState(token) {
  const res = await fetch(`${BASE}/state`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

// ── Geometry ─────────────────────────────────────────────────────────────────

function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

// Return the direction char to move/shoot from `me` toward `target`
// Prefers closing the larger gap first.
function dirToward(me, target) {
  const dr = target.row - me.row;
  const dc = target.col - me.col;
  if (Math.abs(dr) >= Math.abs(dc)) {
    return dr > 0 ? 'S' : dr < 0 ? 'N' : (dc > 0 ? 'E' : 'W');
  } else {
    return dc > 0 ? 'E' : dc < 0 ? 'W' : (dr > 0 ? 'S' : 'N');
  }
}

// True when me and target share a row or column (clear to shoot)
function aligned(me, target) {
  return me.row === target.row || me.col === target.col;
}

// Direction to shoot when aligned
function shootDir(me, target) {
  if (me.row === target.row) return target.col > me.col ? 'E' : 'W';
  return target.row > me.row ? 'S' : 'N';
}

function canShoot(me, state) {
  return (state.tick - (me.lastShotTick ?? -SHOOT_COOLDOWN_TICKS)) >= SHOOT_COOLDOWN_TICKS;
}

function step(pos, dir) {
  const d = DIR[dir];
  return { row: pos.row + d.dr, col: pos.col + d.dc };
}

function inBounds(row, col, state) {
  return row >= 0 && row < state.grid.rows && col >= 0 && col < state.grid.cols;
}

function isBlocked(row, col, state, selfId) {
  if (!inBounds(row, col, state)) return true;
  if (state.barrierSet.has(`${row},${col}`)) return true;
  return state.agents.some(a => a.agentId !== selfId && a.row === row && a.col === col);
}

function shotBlockedByBarrier(me, target, state) {
  if (!aligned(me, target)) return true;

  const dir = shootDir(me, target);
  const d = DIR[dir];
  let row = me.row + d.dr;
  let col = me.col + d.dc;

  while (row !== target.row || col !== target.col) {
    if (state.barrierSet.has(`${row},${col}`)) return true;
    row += d.dr;
    col += d.dc;
  }

  return false;
}

function moveCandidates(me, target) {
  const dirs = [];
  const dr = target.row - me.row;
  const dc = target.col - me.col;

  if (Math.abs(dr) >= Math.abs(dc) && dr !== 0) dirs.push(dr > 0 ? 'S' : 'N');
  if (Math.abs(dc) >= Math.abs(dr) && dc !== 0) dirs.push(dc > 0 ? 'E' : 'W');
  if (Math.abs(dr) < Math.abs(dc) && dr !== 0) dirs.push(dr > 0 ? 'S' : 'N');
  if (Math.abs(dc) < Math.abs(dr) && dc !== 0) dirs.push(dc > 0 ? 'E' : 'W');

  for (const dir of DIRS) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }

  return dirs;
}

function chooseMove(me, target, state, selfId) {
  let best = null;

  for (const dir of moveCandidates(me, target)) {
    const next = step(me, dir);
    if (isBlocked(next.row, next.col, state, selfId)) continue;

    const distance = manhattan(next, target);
    if (!best || distance < best.distance) best = { dir, distance };
  }

  return best?.dir ?? null;
}

function choosePatrolMove(me, state, selfId) {
  const shuffled = [...DIRS].sort(() => Math.random() - 0.5);
  for (const dir of shuffled) {
    const next = step(me, dir);
    if (!isBlocked(next.row, next.col, state, selfId)) return dir;
  }
  return null;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  // Login
  const clientId = `demo-${NAME}-${Date.now()}`;
  const startedAt = Date.now();
  let loginData;
  try {
    loginData = await post('/login', { name: NAME, characterId: CHAR, clientId });
  } catch (e) {
    console.error('Login failed:', e.message);
    process.exit(1);
  }
  let { agentId, token, zone: myZone } = loginData;
  console.log(`Logged in as ${loginData.name} (${agentId}) zone=${myZone} char=${CHAR}`);

  // Graceful logout on Ctrl-C
  process.on('SIGINT', async () => {
    console.log('\nLogging out…');
    await post('/logout', null, token).catch(() => {});
    process.exit(0);
  });

  let lastAction = '';

  while (true) {
    if (Number.isFinite(RUN_MS) && RUN_MS > 0 && Date.now() - startedAt >= RUN_MS) {
      console.log(`Run limit reached (${RUN_MS} ms), logging out...`);
      await post('/logout', null, token).catch(() => {});
      return;
    }

    await new Promise(r => setTimeout(r, DELAY));

    let state;
    try {
      state = await getState(token);
      state.barrierSet = new Set(state.barriers.map(b => `${b.row},${b.col}`));
    } catch (e) {
      console.error('State fetch failed:', e.message);
      continue;
    }

    const me = state.agents.find(a => a.agentId === agentId);
    if (!me) {
      console.log('Not in state — eliminated. Re-logging in…');
      try {
        // Best-effort logout to clear the session entry, then re-login
        await post('/logout', null, token).catch(() => {});
        const re = await post('/login', { name: NAME, characterId: CHAR, clientId });
        Object.assign(loginData, re);
        ({ agentId, token } = loginData);
        myZone = loginData.zone;
        console.log(`Respawned as ${loginData.name} (${agentId}) zone=${myZone}`);
      } catch (e) {
        console.error('Re-login failed:', e.message);
      }
      continue;
    }

    // Find nearest enemy (exclude self and NPCs)
    const enemies = state.agents.filter(a => a.agentId !== agentId && !a.isNpc);
    if (enemies.length === 0) {
      if (lastAction !== 'idle') { console.log('No enemies — waiting…'); lastAction = 'idle'; }
      continue;
    }

    enemies.sort((a, b) => manhattan(me, a) - manhattan(me, b));
    const target = enemies[0];

    try {
      if (aligned(me, target) && !shotBlockedByBarrier(me, target, state) && canShoot(me, state)) {
        const dir = shootDir(me, target);
        await post('/shoot', { direction: dir }, token);
        const action = `SHOOT ${dir} -> ${target.name} (${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      } else {
        const dir = chooseMove(me, target, state, agentId) ?? choosePatrolMove(me, state, agentId);
        if (!dir) {
          if (lastAction !== 'idle') { console.log('No safe move available'); lastAction = 'idle'; }
          continue;
        }
        await post('/move', { direction: dir }, token);
        const action = `MOVE ${dir} (me=${me.row},${me.col} -> target=${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      }
    } catch (e) {
      console.error('Action failed:', e.message);
    }
  }
}

run();
