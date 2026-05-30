#!/usr/bin/env node
// demo-bot.js — example AI agent for small-war
//
// Strategy:
//   1. Poll /state every tick (100 ms)
//   2. Find the nearest living enemy (non-NPC, not self)
//   3. If aligned on a row or column → shoot in that direction
//   4. Otherwise move one step closer (row-first, then col)
//
// Usage:
//   node demo-bot.js [name] [characterId] [serverUrl]
//
// Examples:
//   node demo-bot.js MyBot tank
//   node demo-bot.js MyBot jet http://localhost:3000

const BASE  = process.argv[4] ?? 'http://localhost:3000';
const NAME  = process.argv[2] ?? 'DemoBot';
const _CHARS = ['warrior', 'mage', 'archer', 'tank', 'rogue', 'paladin', 'ranger', 'monk'];
const CHAR  = process.argv[3] ?? _CHARS[Math.floor(Math.random() * _CHARS.length)];
const DELAY = 120; // ms between actions — slightly above 100 ms tick

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
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getState(token) {
  const res = await fetch(`${BASE}/state`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

// ── Zone definitions (mirrors src/game.js) ───────────────────────────────────

const ZONES = [
  { id: 0, rowMin: 0, rowMax:  5, colMin: 0, colMax:  5 },
  { id: 1, rowMin: 0, rowMax:  5, colMin: 8, colMax: 14 },
  { id: 2, rowMin: 8, rowMax: 14, colMin: 0, colMax:  5 },
  { id: 3, rowMin: 8, rowMax: 14, colMin: 8, colMax: 14 },
];

function myZoneDef(zoneId) {
  return ZONES[zoneId];
}

// Center cell of a zone
function zoneCenter(z) {
  return {
    row: Math.round((z.rowMin + z.rowMax) / 2),
    col: Math.round((z.colMin + z.colMax) / 2),
  };
}

// Is (row,col) inside zone bounds?
function inZone(row, col, z) {
  return row >= z.rowMin && row <= z.rowMax && col >= z.colMin && col <= z.colMax;
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

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  // Login
  const clientId = `demo-${NAME}-${Date.now()}`;
  let loginData;
  try {
    loginData = await post('/login', { name: NAME, characterId: CHAR, clientId });
  } catch (e) {
    console.error('Login failed:', e.message);
    process.exit(1);
  }
  let { agentId, token, zone: myZone } = loginData;
  console.log(`Logged in as ${NAME} (${agentId}) zone=${myZone}`);;

  // Graceful logout on Ctrl-C
  process.on('SIGINT', async () => {
    console.log('\nLogging out…');
    await post('/logout', null, token).catch(() => {});
    process.exit(0);
  });

  let lastAction = '';

  while (true) {
    await new Promise(r => setTimeout(r, DELAY));

    let state;
    try {
      state = await getState(token);
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

    // Strategy:
    //   1. Prioritise enemies inside MY zone (intruders) — sort by distance
    //   2. If no intruders, retreat/patrol inside own zone
    //   3. Only chase outside-zone enemies if they're adjacent (manhattan ≤ 2)

    const zoneDef = myZoneDef(myZone);
    const intruders = enemies.filter(e => inZone(e.row, e.col, zoneDef));
    intruders.sort((a, b) => manhattan(me, a) - manhattan(me, b));

    let target = null;
    let mode = '';

    if (intruders.length > 0) {
      target = intruders[0];
      mode = 'INTRUDER';
    } else {
      // No intruders — check if I'm outside my zone; if so, go back
      if (!inZone(me.row, me.col, zoneDef)) {
        target = zoneCenter(zoneDef);
        mode = 'RETURN';
      } else {
        // I'm home and there are no intruders — only engage enemies very close by
        enemies.sort((a, b) => manhattan(me, a) - manhattan(me, b));
        const nearest = enemies[0];
        if (manhattan(me, nearest) <= 2) {
          target = nearest;
          mode = 'SNIPE';
        }
        // else idle in zone
      }
    }

    try {
      if (!target) {
        // Idle — nothing to do this tick
        if (lastAction !== 'idle') { console.log('Patrolling zone…'); lastAction = 'idle'; }
        continue;
      }

      if (aligned(me, target) && mode !== 'RETURN') {
        // Shoot toward target
        const dir = shootDir(me, target);
        await post('/shoot', { direction: dir }, token);
        const action = `[${mode}] SHOOT ${dir} → ${target.name} (row=${target.row} col=${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      } else {
        // Move closer (or back to zone center)
        const dir = dirToward(me, target);
        await post('/move', { direction: dir }, token);
        const label = mode === 'RETURN' ? `RETURN home` : `[${mode}] MOVE ${dir}`;
        const action = `${label} (me=${me.row},${me.col} → ${target.row},${target.col})`;
        if (action !== lastAction) { console.log(action); lastAction = action; }
      }
    } catch (e) {
      console.error('Action failed:', e.message);
    }
  }
}

run();
