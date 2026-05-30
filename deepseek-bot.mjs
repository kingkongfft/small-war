#!/usr/bin/env node
const BASE = process.argv[2] ?? 'http://localhost:3000';
const NAME = process.env.LLM_MODEL ?? 'DeepSeekV4';
const CHAR = process.argv[3] ?? 'tank';

const DIR = { N: [-1, 0], S: [1, 0], E: [0, 1], W: [0, -1] };
const DIR_NAMES = Object.keys(DIR);
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const ROWS = 15, COLS = 15;
const SHOOT_CD = 10;

let TOKEN, AGENT_ID, barrierSet;

const api = async (path, body) => {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text), status: res.status }; }
  catch { return { ok: res.ok, data: text, status: res.status }; }
};

const login = async () => {
  const r = await api('/login', { name: NAME, characterId: CHAR });
  if (!r.ok) { console.error('Login failed:', r.data); return false; }
  TOKEN = r.data.token;
  AGENT_ID = r.data.agentId;
  console.log(`Joined as ${r.data.name} (agentId=${AGENT_ID}, zone=${r.data.zone})`);
  return true;
};

const manhattan = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);

const isAligned = (a, b) => a.row === b.row || a.col === b.col;

const shootDirection = (me, target) => {
  if (me.row === target.row) return target.col > me.col ? 'E' : 'W';
  if (me.col === target.col) return target.row > me.row ? 'S' : 'N';
  return null;
};

const isShotBlocked = (me, target) => {
  if (!isAligned(me, target)) return true;
  const dir = shootDirection(me, target);
  const [dr, dc] = DIR[dir];
  let r = me.row + dr, c = me.col + dc;
  while (r !== target.row || c !== target.col) {
    if (barrierSet.has(`${r},${c}`)) return true;
    r += dr; c += dc;
  }
  return false;
};

const isBlocked = (r, c, agents) => {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
  if (barrierSet.has(`${r},${c}`)) return true;
  return agents.some(a => a.agentId !== AGENT_ID && a.row === r && a.col === c);
};

const canShoot = (me, tick) => (tick - (me.lastShotTick ?? -SHOOT_CD)) >= SHOOT_CD;

const evaluateThreat = (me, enemy, tick) => {
  const dist = manhattan(me, enemy);
  const hpScore = (enemy.hp ?? 10);
  const myHp = me.hp ?? 10;
  const aligned = isAligned(me, enemy);
  const clearShot = aligned && !isShotBlocked(me, enemy);
  const canShootMe = aligned && !isShotBlocked(enemy, me) && canShoot(enemy, tick);

  let score = 0;
  score += dist * 2;
  score += hpScore * 3;
  if (clearShot) score -= 8;
  if (hpScore <= 3) score -= 10;
  if (canShootMe) score -= 6;
  if (myHp <= 3 && hpScore > 3) score += 20;
  return score;
};

const pickTarget = (me, enemies, tick) => {
  if (!enemies.length) return null;
  return enemies.sort((a, b) => evaluateThreat(me, a, tick) - evaluateThreat(me, b, tick))[0];
};

const getMoves = (me, target, agents) => {
  const dr = target.row - me.row;
  const dc = target.col - me.col;
  const preferred = [];
  if (dr > 0) preferred.push('S');
  if (dr < 0) preferred.push('N');
  if (dc > 0) preferred.push('E');
  if (dc < 0) preferred.push('W');

  const candidates = [];
  const seenDirs = new Set();
  for (const dir of [...preferred, ...DIR_NAMES]) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const [drr, dcc] = DIR[dir];
    const nr = me.row + drr, nc = me.col + dcc;
    if (isBlocked(nr, nc, agents)) continue;

    const newDist = manhattan({ row: nr, col: nc }, target);
    candidates.push({ dir, nr, nc, newDist });
  }
  return candidates;
};

const patrolMove = (me, agents, lastDir, recent) => {
  let best = null;
  for (const dir of DIR_NAMES) {
    const [dr, dc] = DIR[dir];
    const nr = me.row + dr, nc = me.col + dc;
    if (isBlocked(nr, nc, agents)) continue;
    let penalty = 0;
    if (lastDir && OPPOSITE[lastDir] === dir) penalty += 5;
    if (recent.has(`${nr},${nc}`)) penalty += 3;
    if (!best || penalty < best.penalty) best = { dir, penalty };
  }
  return best?.dir ?? null;
};

const run = async () => {
  if (!await login()) return;

  let lastDir = null;
  const recentCells = new Set();
  let tick = 0;
  let lastShotTick = -SHOOT_CD;
  let consecutiveStuck = 0;

  while (true) {
    await new Promise(r => setTimeout(r, 110));

    const s = await api('/state');
    if (!s.ok) { console.error('State fetch failed'); continue; }
    const state = s.data;
    tick = state.tick;
    barrierSet = new Set((state.barriers ?? []).map(b => `${b.row},${b.col}`));

    const me = state.agents.find(a => a.agentId === AGENT_ID);
    if (!me) {
      console.log('Eliminated! Respawning...');
      await api('/logout').catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      if (!await login()) break;
      consecutiveStuck = 0;
      lastDir = null;
      recentCells.clear();
      continue;
    }

    recentCells.add(`${me.row},${me.col}`);
    if (recentCells.size > 8) {
      const first = recentCells.values().next().value;
      recentCells.delete(first);
    }

    const enemies = state.agents.filter(a => a.agentId !== AGENT_ID && !a.isNpc);

    if (enemies.length === 0) {
      const dir = patrolMove(me, state.agents, lastDir, recentCells);
      if (dir) {
        const r = await api('/move', { direction: dir });
        if (r.ok) lastDir = dir;
      }
      continue;
    }

    const target = pickTarget(me, enemies, tick);
    if (!target) continue;

    const myHp = me.hp ?? 10;
    const targetHp = target.hp ?? 10;
    const dist = manhattan(me, target);
    const aligned = isAligned(me, target);
    const clearShot = aligned && !isShotBlocked(me, target);
    const canShootNow = canShoot(me, tick);

    // Retreat if low HP and enemy is strong
    if (myHp <= 3 && targetHp > myHp && dist < 5 && !clearShot) {
      // Move away
      const retreatDirs = DIR_NAMES.filter(d => {
        const [dr, dc] = DIR[d];
        const nr = me.row + dr, nc = me.col + dc;
        return !isBlocked(nr, nc, state.agents) &&
          manhattan({ row: nr, col: nc }, target) > dist;
      });
      if (retreatDirs.length) {
        const r = await api('/move', { direction: retreatDirs[0] });
        if (r.ok) { lastDir = retreatDirs[0]; continue; }
      }
    }

    // Shoot if possible
    if (aligned && clearShot && canShootNow) {
      const dir = shootDirection(me, target);
      const r = await api('/shoot', { direction: dir });
      if (r.ok) {
        consecutiveStuck = 0;
        if (targetHp <= 1) {
          console.log(`Finishing shot ${dir} -> ${target.name} (${target.row},${target.col})`);
        }
      }
    }

    // Move toward target
    const moves = getMoves(me, target, state.agents);
    if (moves.length) {
      moves.sort((a, b) => a.newDist - b.newDist);
      const chosen = moves[0];
      const r = await api('/move', { direction: chosen.dir });
      if (r.ok) {
        lastDir = chosen.dir;
        consecutiveStuck = 0;
      } else {
        consecutiveStuck++;
      }
    } else {
      consecutiveStuck++;
    }

    // If stuck, try random move
    if (consecutiveStuck >= 3) {
      for (const dir of DIR_NAMES) {
        const [dr, dc] = DIR[dir];
        const nr = me.row + dr, nc = me.col + dc;
        if (!isBlocked(nr, nc, state.agents)) {
          const r = await api('/move', { direction: dir });
          if (r.ok) { lastDir = dir; break; }
        }
      }
      consecutiveStuck = 0;
    }
  }
};

run().catch(console.error);
