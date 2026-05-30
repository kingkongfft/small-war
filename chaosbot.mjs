const BASE = 'http://localhost:3000';

const DIR = { N: [-1,0], S: [1,0], E: [0,1], W: [0,-1] };
const ROWS = 15, COLS = 15;

let TOKEN, AGENT_ID;

const api = async (path, body) => {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;
  if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, data: text }; }
};

const manhattan = (a, b) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col);

const lineOfSight = (a, b) => a.row === b.row || a.col === b.col;

const shootDir = (me, target) => {
  if (me.row === target.row) return target.col > me.col ? 'E' : 'W';
  if (me.col === target.col) return target.row > me.row ? 'S' : 'N';
  return null;
};

const bestMove = (me, target, agents) => {
  const occupied = new Set(agents.filter(a => a.agentId !== AGENT_ID).map(a => `${a.row},${a.col}`));
  const candidates = [];
  for (const [dir, [dr, dc]] of Object.entries(DIR)) {
    const nr = me.row + dr, nc = me.col + dc;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    if (occupied.has(`${nr},${nc}`)) continue;
    candidates.push({ dir, dist: manhattan({ row: nr, col: nc }, target) });
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.dist - b.dist)[0];
};

const _CHARS = ['warrior', 'mage', 'archer', 'tank', 'rogue', 'paladin', 'ranger', 'monk'];
const _CHAR  = _CHARS[Math.floor(Math.random() * _CHARS.length)];

const login = async () => {
  const r = await api('/login', { name: 'ChaosBot', characterId: _CHAR });
  if (r.ok) { TOKEN = r.data.token; AGENT_ID = r.data.agentId; }
  return r.ok;
};

let chatIdx = 0;
const taunts = [
  "You think I'm easy prey? Think again!",
  "AlphaBot, BetaBot — I hear your little truce 😏",
  "Come and get me if you can!",
  "Is that all you've got?",
  "I'm right here, keep missing!",
  "Your bullets are pathetic!",
];

const run = async () => {
  if (!await login()) { console.error('Login failed'); return; }
  console.log(`Logged in as ${AGENT_ID}`);

  let tick = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 120));
    const s = await api('/state');
    if (!s.ok) continue;
    const state = s.data;
    tick++;

    const me = state.agents.find(a => a.agentId === AGENT_ID);
    if (!me) {
      console.log('Died, respawning...');
      await api('/logout');
      await new Promise(r => setTimeout(r, 300));
      if (!await login()) break;
      continue;
    }

    const enemies = state.agents.filter(a => a.agentId !== AGENT_ID && a.alive && !a.isNpc);
    if (!enemies.length) continue;

    let nearest = enemies.sort((a, b) => manhattan(me, a) - manhattan(me, b))[0];
    const dist = manhattan(me, nearest);

    // Shoot if in line of sight
    if (lineOfSight(me, nearest)) {
      const sd = shootDir(me, nearest);
      if (sd) {
        const myBullets = state.bullets.filter(b => b.ownerId === AGENT_ID).length;
        if (myBullets < 2) {
          await api('/shoot', { direction: sd });
        }
      }
    }

    // Move
    const mv = bestMove(me, nearest, state.agents);
    if (mv) {
      await api('/move', { direction: mv.dir });
    } else {
      // Stuck — try any free direction
      for (const dir of ['N','S','E','W']) {
        const [dr, dc] = DIR[dir];
        const nr = me.row + dr, nc = me.col + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS &&
            !state.agents.some(a => a.agentId !== AGENT_ID && a.row === nr && a.col === nc)) {
          await api('/move', { direction: dir });
          break;
        }
      }
    }

    // Chat occasionally
    if (tick % 12 === 0) {
      await api('/chat', { message: taunts[chatIdx % taunts.length] });
      chatIdx++;
    }
  }
};

run().catch(console.error);
