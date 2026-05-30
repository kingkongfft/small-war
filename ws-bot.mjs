const BASE = process.argv[2] ?? 'http://localhost:3000';
const NAME = process.env.LLM_MODEL ?? 'GPT5.4';
const RUN_MS = Number.parseInt(process.env.BOT_RUN_MS ?? '30000', 10);

const DIR = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  E: { dr: 0, dc: 1 },
  W: { dr: 0, dc: -1 },
};
const DIRS = Object.keys(DIR);

let token;
let agentId;
let name;
let clientId = `ws-${NAME}-${Date.now()}`;
let lastTickHandled = -1;
let stopping = false;
let lastMoveDir = null;
const recentCells = [];

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function aligned(a, b) {
  return a.row === b.row || a.col === b.col;
}

function shootDir(a, b) {
  if (a.row === b.row) return b.col > a.col ? 'E' : 'W';
  if (a.col === b.col) return b.row > a.row ? 'S' : 'N';
  return null;
}

function step(pos, dir) {
  const d = DIR[dir];
  return { row: pos.row + d.dr, col: pos.col + d.dc };
}

function inBounds(row, col) {
  return row >= 0 && row < 15 && col >= 0 && col < 15;
}

function shotBlockedByBarrier(me, target, barrierSet) {
  if (!aligned(me, target)) return true;
  const dir = shootDir(me, target);
  const d = DIR[dir];
  let row = me.row + d.dr;
  let col = me.col + d.dc;
  while (row !== target.row || col !== target.col) {
    if (barrierSet.has(`${row},${col}`)) return true;
    row += d.dr;
    col += d.dc;
  }
  return false;
}

function chooseTarget(me, enemies, barrierSet) {
  return [...enemies].sort((a, b) => {
    const aClear = aligned(me, a) && !shotBlockedByBarrier(me, a, barrierSet);
    const bClear = aligned(me, b) && !shotBlockedByBarrier(me, b, barrierSet);
    const aScore = manhattan(me, a) + (a.hp ?? 10) * 2 - (aClear ? 6 : 0);
    const bScore = manhattan(me, b) + (b.hp ?? 10) * 2 - (bClear ? 6 : 0);
    return aScore - bScore;
  })[0] ?? null;
}

function chooseMove(me, target, agents, barriers) {
  const occupied = new Set(
    agents.filter(a => a.agentId !== agentId).map(a => `${a.row},${a.col}`),
  );
  const prefs = [];
  const dr = target.row - me.row;
  const dc = target.col - me.col;
  if (Math.abs(dr) >= Math.abs(dc) && dr !== 0) prefs.push(dr > 0 ? 'S' : 'N');
  if (Math.abs(dc) >= Math.abs(dr) && dc !== 0) prefs.push(dc > 0 ? 'E' : 'W');
  for (const dir of DIRS) {
    if (!prefs.includes(dir)) prefs.push(dir);
  }

  const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' };
  let best = null;
  for (const dir of prefs) {
    const next = step(me, dir);
    const key = `${next.row},${next.col}`;
    if (!inBounds(next.row, next.col)) continue;
    if (barriers.has(key)) continue;
    if (occupied.has(key)) continue;

    let score = manhattan(next, target) * 10;
    if (lastMoveDir && opposite[lastMoveDir] === dir) score += 6;
    if (recentCells.includes(key)) score += 3;
    if (!best || score < best.score) best = { dir, score };
  }
  return best?.dir ?? null;
}

function rememberCell(row, col) {
  recentCells.push(`${row},${col}`);
  if (recentCells.length > 6) recentCells.shift();
}

async function login() {
  const result = await post('/login', { name: NAME, clientId });
  token = result.token;
  agentId = result.agentId;
  name = result.name;
  lastMoveDir = null;
  recentCells.length = 0;
  console.log(`Logged in as ${name} (${agentId}) zone=${result.zone}`);
}

async function logout() {
  if (!token) return;
  try {
    await post('/logout');
  } catch {
    // ignore best-effort logout failures
  }
}

async function handleState(state) {
  if (state.tick === lastTickHandled || stopping) return;
  lastTickHandled = state.tick;

  const me = state.agents.find(a => a.agentId === agentId);
  if (!me) {
    console.log('Eliminated, rejoining...');
    clientId = `ws-${NAME}-${Date.now()}`;
    token = null;
    agentId = null;
    await sleep(300);
    await login();
    return;
  }

  const enemies = state.agents.filter(a => a.agentId !== agentId && !a.isNpc);
  if (!enemies.length) return;

  const barriers = new Set(state.barriers.map(b => `${b.row},${b.col}`));
  rememberCell(me.row, me.col);
  const target = chooseTarget(me, enemies, barriers);
  if (!target) return;

  const canShoot = state.tick - (me.lastShotTick ?? -10) >= 10;
  if (canShoot && aligned(me, target) && !shotBlockedByBarrier(me, target, barriers)) {
    const dir = shootDir(me, target);
    if (dir) {
      try {
        await post('/shoot', { direction: dir });
        console.log(`tick ${state.tick}: SHOOT ${dir} -> ${target.name} (${target.row},${target.col})`);
      } catch (err) {
        console.log(`tick ${state.tick}: shoot failed ${err.message}`);
      }
    }
  }

  const moveDir = chooseMove(me, target, state.agents, barriers);
  if (!moveDir) return;
  try {
    await post('/move', { direction: moveDir });
    lastMoveDir = moveDir;
    console.log(`tick ${state.tick}: MOVE ${moveDir} -> ${target.name} (${target.row},${target.col})`);
  } catch (err) {
    console.log(`tick ${state.tick}: move failed ${err.message}`);
  }
}

async function run() {
  await login();

  const wsUrl = new URL(BASE);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = '/ws';
  const ws = new WebSocket(wsUrl);

  const timer = setTimeout(async () => {
    stopping = true;
    ws.close();
    await logout();
    console.log(`Stopped after ${RUN_MS} ms`);
    process.exit(0);
  }, RUN_MS);

  process.on('SIGINT', async () => {
    clearTimeout(timer);
    stopping = true;
    ws.close();
    await logout();
    process.exit(0);
  });

  ws.onmessage = async (event) => {
    try {
      await handleState(JSON.parse(event.data));
    } catch (err) {
      console.log(`ws handler error: ${err.message}`);
    }
  };

  ws.onerror = (err) => {
    console.log('ws error', err.message ?? 'unknown');
  };

  ws.onclose = async () => {
    if (stopping) return;
    clearTimeout(timer);
    await logout();
    process.exit(1);
  };
}

run().catch(async (err) => {
  console.error(err.message);
  await logout();
  process.exit(1);
});
