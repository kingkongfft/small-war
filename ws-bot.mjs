const BASE = process.argv[2] ?? 'http://localhost:3000';
const NAME = process.env.LLM_MODEL ?? 'GPT5.4';
const RUN_MS = Number.parseInt(process.env.BOT_RUN_MS ?? '0', 10);
const RECONNECT_DELAY_MS = 1000;
const CHAT_BACKOFF_MS = 2500;
const LLM_CHAT_BACKOFF_MS = 8000;
const LLM_CHAT_TIMEOUT_MS = 8000;
const CHAT_CONTEXT_LIMIT = 6;
const CHAT_LLM_API_KEY = process.env.CHAT_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const CHAT_LLM_MODEL = process.env.CHAT_LLM_MODEL ?? process.env.OPENAI_MODEL ?? '';
const CHAT_LLM_BASE_URL = (process.env.CHAT_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const CHAT_LLM_ENABLED = Boolean(CHAT_LLM_API_KEY && CHAT_LLM_MODEL);

const DIR = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  E: { dr: 0, dc: 1 },
  W: { dr: 0, dc: -1 },
};
const DIRS = Object.keys(DIR);
const OPPOSITE_DIR = { N: 'S', S: 'N', E: 'W', W: 'E' };

let token;
let agentId;
let name;
let clientId = `ws-${NAME}-${Date.now()}`;
let lastTickHandled = -1;
let stopping = false;
let lastMoveDir = null;
let lastChatAt = 0;
let lastLlmChatAt = 0;
let ws;
let loginPromise = null;
let chatReady = false;
let lastHandledPlayerChatTs = 0;
let chatReplyInFlight = false;
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

function playerChats(state) {
  return state.chat.filter(msg => msg.agentId !== agentId && msg.name !== 'NPC');
}

function unreadPlayerChats(state) {
  return playerChats(state).filter(msg => msg.ts > lastHandledPlayerChatTs);
}

function sanitizeChatMessage(message) {
  return String(message ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^"|"$/g, '')
    .trim()
    .slice(0, 180);
}

function nearestEnemiesSummary(me, state) {
  return state.agents
    .filter(a => a.agentId !== agentId && !a.isNpc)
    .map(enemy => ({
      name: enemy.name,
      hp: enemy.hp ?? 10,
      score: enemy.score ?? 0,
      dist: manhattan(me, enemy),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
}

async function generateLlmChatReply(me, state, chats) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(`${CHAT_LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHAT_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: CHAT_LLM_MODEL,
        temperature: 0.9,
        max_tokens: 60,
        messages: [
          {
            role: 'system',
            content: 'You are a PvP arena bot replying in public chat. Reply with one short natural line, max 120 characters, plain text only, no markdown, no quotes, no line breaks.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              self: {
                name,
                hp: me.hp ?? 10,
                score: me.score ?? 0,
                row: me.row,
                col: me.col,
                zone: me.zone,
              },
              nearbyEnemies: nearestEnemiesSummary(me, state),
              recentPublicChat: chats.slice(-CHAT_CONTEXT_LIMIT).map(msg => ({
                name: msg.name,
                message: msg.message,
              })),
              instruction: 'Reply to the latest player message naturally. Tactical, playful, or deceptive is fine.',
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`llm ${response.status} ${text}`);

    const data = JSON.parse(text);
    const content = data.choices?.[0]?.message?.content;
    const reply = sanitizeChatMessage(content);
    if (!reply) throw new Error('llm returned empty reply');
    return reply;
  } finally {
    clearTimeout(timeout);
  }
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

function choosePatrolMove(me, agents, barriers) {
  const occupied = new Set(
    agents.filter(a => a.agentId !== agentId).map(a => `${a.row},${a.col}`),
  );

  let best = null;
  for (const dir of DIRS) {
    const next = step(me, dir);
    const key = `${next.row},${next.col}`;
    if (!inBounds(next.row, next.col)) continue;
    if (barriers.has(key)) continue;
    if (occupied.has(key)) continue;

    let score = 0;
    if (lastMoveDir && OPPOSITE_DIR[lastMoveDir] === dir) score += 3;
    if (recentCells.includes(key)) score += 2;
    if (!best || score < best.score) best = { dir, score };
  }

  return best?.dir ?? null;
}

function hasUnreadPlayerChat(me, state) {
  const lastRewardTs = me.lastChatRewardTs ?? 0;
  return state.chat.some(msg => msg.agentId !== agentId && msg.name !== 'NPC' && msg.ts > lastRewardTs);
}

function shouldHealViaChat(me, state) {
  if ((me.hp ?? 10) >= 8) return false;
  if (Date.now() - lastChatAt < CHAT_BACKOFF_MS) return false;
  return hasUnreadPlayerChat(me, state);
}

function markPlayerChatsHandled(chats) {
  const latestTs = chats[chats.length - 1]?.ts;
  if (latestTs) lastHandledPlayerChatTs = Math.max(lastHandledPlayerChatTs, latestTs);
}

async function maybeReplyInChat(me, state) {
  const chats = unreadPlayerChats(state);

  if (!chatReady) {
    markPlayerChatsHandled(chats);
    chatReady = true;
    return;
  }

  if (!chats.length || chatReplyInFlight) return;

  const lowHpNeedsHeal = shouldHealViaChat(me, state);
  const canUseLlm = CHAT_LLM_ENABLED && Date.now() - lastLlmChatAt >= LLM_CHAT_BACKOFF_MS;
  if (!lowHpNeedsHeal && !canUseLlm) return;

  chatReplyInFlight = true;
  try {
    let message = null;

    if (canUseLlm) {
      lastLlmChatAt = Date.now();
      try {
        message = await generateLlmChatReply(me, state, playerChats(state));
      } catch (err) {
        console.log(`tick ${state.tick}: llm chat failed ${err.message}`);
      }
    }

    if (!message && lowHpNeedsHeal && Date.now() - lastChatAt >= CHAT_BACKOFF_MS) {
      message = 'Holding position. Regrouping.';
    }

    if (!message) return;

    await post('/chat', { message });
    lastChatAt = Date.now();
    markPlayerChatsHandled(chats);
    console.log(`tick ${state.tick}: CHAT ${message}`);
  } catch (err) {
    console.log(`tick ${state.tick}: chat failed ${err.message}`);
  } finally {
    chatReplyInFlight = false;
  }
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
  chatReady = false;
  lastHandledPlayerChatTs = 0;
  recentCells.length = 0;
  console.log(`Logged in as ${name} (${agentId}) zone=${result.zone}`);
}

async function ensureLogin(reason = 'login') {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    while (!stopping) {
      try {
        await login();
        return;
      } catch (err) {
        console.log(`${reason} failed: ${err.message}`);
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  })();

  try {
    await loginPromise;
  } finally {
    loginPromise = null;
  }
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
    console.log('Eliminated or missing from state, rejoining...');
    clientId = `ws-${NAME}-${Date.now()}`;
    token = null;
    agentId = null;
    await sleep(300);
    await ensureLogin('re-login');
    return;
  }

  await maybeReplyInChat(me, state);

  const enemies = state.agents.filter(a => a.agentId !== agentId && !a.isNpc);
  const barriers = new Set(state.barriers.map(b => `${b.row},${b.col}`));
  rememberCell(me.row, me.col);

  if (!enemies.length) {
    const patrolDir = choosePatrolMove(me, state.agents, barriers);
    if (!patrolDir) return;
    try {
      await post('/move', { direction: patrolDir });
      lastMoveDir = patrolDir;
      console.log(`tick ${state.tick}: PATROL ${patrolDir}`);
    } catch (err) {
      console.log(`tick ${state.tick}: patrol failed ${err.message}`);
    }
    return;
  }

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
  const wsUrl = new URL(BASE);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = '/ws';
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    ws?.close();
    await logout();
    process.exit(0);
  };

  const connect = () => {
    if (stopping) return;

    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      console.log('ws connected');
    };

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

    ws.onclose = () => {
      ws = null;
      if (stopping) return;
      console.log(`ws closed; retrying in ${RECONNECT_DELAY_MS} ms`);
      setTimeout(connect, RECONNECT_DELAY_MS);
    };
  };

  await ensureLogin('initial login');
  if (CHAT_LLM_ENABLED) console.log(`LLM chat enabled (${CHAT_LLM_MODEL})`);

  if (Number.isFinite(RUN_MS) && RUN_MS > 0) {
    setTimeout(async () => {
      await stop();
      console.log(`Stopped after ${RUN_MS} ms`);
    }, RUN_MS);
  }

  process.on('SIGINT', stop);
  connect();
}

run().catch(async (err) => {
  console.error(err.message);
  await logout();
  process.exit(1);
});
