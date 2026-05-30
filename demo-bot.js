#!/usr/bin/env node
// demo-bot.js — example AI agent for small-war
//
// Strategy:
//   1. Poll /state every tick (100 ms)
//   2. Prefer wounded / easy-to-finish living enemies (non-NPC, not self)
//   3. Shoot when aligned and no barrier blocks the path
//   4. Otherwise move closer while avoiding barriers and occupied cells
//   5. Patrol when alone so the bot stays active between fights
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
const OPPOSITE_DIR = { N: 'S', S: 'N', E: 'W', W: 'E' };

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

function targetScore(me, enemy, state) {
  const distance = manhattan(me, enemy);
  const enemyHp = enemy.hp ?? 10;
  const myHp = me.hp ?? 10;
  const clearShot = aligned(me, enemy) && !shotBlockedByBarrier(me, enemy, state);

  let score = distance;
  score += enemyHp * 2;
  if (clearShot) score -= 6;
  if (enemyHp <= 2) score -= 5;
  if (myHp <= 4) score -= Math.max(0, 5 - enemyHp);
  return score;
}

function chooseTarget(me, enemies, state) {
  return [...enemies].sort((a, b) => targetScore(me, a, state) - targetScore(me, b, state))[0] ?? null;
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

function moveScore(next, dir, target, context) {
  let score = manhattan(next, target) * 10;
  if (context.lastMoveDir && OPPOSITE_DIR[context.lastMoveDir] === dir) score += 7;
  if (context.recentCells.has(`${next.row},${next.col}`)) score += 4;
  return score;
}

function chooseMove(me, target, state, selfId, context) {
  let best = null;

  for (const dir of moveCandidates(me, target)) {
    const next = step(me, dir);
    if (isBlocked(next.row, next.col, state, selfId)) continue;

    const score = moveScore(next, dir, target, context);
    if (!best || score < best.score) best = { dir, score };
  }

  return best?.dir ?? null;
}

function choosePatrolMove(me, state, selfId, context) {
  let best = null;
  for (const dir of DIRS) {
    const next = step(me, dir);
    if (isBlocked(next.row, next.col, state, selfId)) continue;

    let score = 0;
    if (context.lastMoveDir && OPPOSITE_DIR[context.lastMoveDir] === dir) score += 3;
    if (context.recentCells.has(`${next.row},${next.col}`)) score += 2;
    if (!best || score < best.score) best = { dir, score };
  }
  return best?.dir ?? null;
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
  let lastMoveDir = null;
  const recentCells = new Set();

  function rememberCell(row, col) {
    recentCells.add(`${row},${col}`);
    if (recentCells.size > 6) {
      const first = recentCells.values().next().value;
      recentCells.delete(first);
    }
  }

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
        lastMoveDir = null;
        recentCells.clear();
        console.log(`Respawned as ${loginData.name} (${agentId}) zone=${myZone}`);
      } catch (e) {
        console.error('Re-login failed:', e.message);
      }
      continue;
    }

    // Find enemy target (exclude self and NPCs)
    const enemies = state.agents.filter(a => a.agentId !== agentId && !a.isNpc);
    rememberCell(me.row, me.col);

    if (enemies.length === 0) {
      const dir = choosePatrolMove(me, state, agentId, { lastMoveDir, recentCells });
      if (!dir) {
        if (lastAction !== 'idle') { console.log('No enemies — waiting…'); lastAction = 'idle'; }
        continue;
      }

      try {
        await post('/move', { direction: dir }, token);
        lastMoveDir = dir;
        const action = `PATROL ${dir} (me=${me.row},${me.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      } catch (e) {
        console.error('Patrol failed:', e.message);
      }
      continue;
    }

    const target = chooseTarget(me, enemies, state);

    try {
      if (aligned(me, target) && !shotBlockedByBarrier(me, target, state) && canShoot(me, state)) {
        const dir = shootDir(me, target);
        await post('/shoot', { direction: dir }, token);
        const action = `SHOOT ${dir} -> ${target.name} (${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      } else if (aligned(me, target) && !shotBlockedByBarrier(me, target, state) && !canShoot(me, state)) {
        const action = `HOLD lane vs ${target.name} (${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      } else {
        const dir = chooseMove(me, target, state, agentId, { lastMoveDir, recentCells })
          ?? choosePatrolMove(me, state, agentId, { lastMoveDir, recentCells });
        if (!dir) {
          if (lastAction !== 'idle') { console.log('No safe move available'); lastAction = 'idle'; }
          continue;
        }
        await post('/move', { direction: dir }, token);
        lastMoveDir = dir;
        const action = `MOVE ${dir} (me=${me.row},${me.col} -> target=${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      }
    } catch (e) {
      console.error('Action failed:', e.message);
    }
  }
}

run();
