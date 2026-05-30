// game-do.js — Cloudflare Durable Object
//
// One global GameRoom instance holds all game state in memory.
// The tick loop runs via Durable Object Alarms (setAlarm every 100 ms).
// WebSocket clients are managed via the DO Hibernation API.
// All game logic is ported from src/game.js.

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID_ROWS           = 15;
const GRID_COLS           = 15;
const TICK_MS             = 100;
const BULLET_SPEED        = 2;
const MAX_CHAT            = 100;
const SHOOT_COOLDOWN_TICKS = 10;
const NPC_CHAT_INTERVAL   = 300;

const BARRIERS = [
  { row: 5, col:  3 }, { row: 6, col:  3 }, { row: 7, col:  3 },
  { row: 8, col:  3 }, { row: 9, col:  3 },
  { row: 5, col: 11 }, { row: 6, col: 11 }, { row: 7, col: 11 },
  { row: 8, col: 11 }, { row: 9, col: 11 },
];
const _barrierSet = new Set(BARRIERS.map(b => `${b.row},${b.col}`));

const DIR = {
  N: { dr: -1, dc:  0 },
  S: { dr:  1, dc:  0 },
  E: { dr:  0, dc:  1 },
  W: { dr:  0, dc: -1 },
};

const ZONES = [
  { id: 0, rowMin: 0, rowMax:  5, colMin: 0,  colMax:  5 },
  { id: 1, rowMin: 0, rowMax:  5, colMin: 8,  colMax: 14 },
  { id: 2, rowMin: 8, rowMax: 14, colMin: 0,  colMax:  5 },
  { id: 3, rowMin: 8, rowMax: 14, colMin: 8,  colMax: 14 },
];

const TEAM_PREFIXES = ['RED', 'BLUE', 'YELLOW', 'BLACK'];

const CHARACTERS = [
  { id: 'warrior', personality: '勇猛好战，直接冲锋，优先攻击血量最低的敌人', avatar: '🤺' },
  { id: 'mage',    personality: '冷静理性，计算伤害，优先攻击得分最高的敌人', avatar: '🧙' },
  { id: 'archer',  personality: '谨慎保守，保持距离，擅长远程精准狙击',     avatar: '🥷' },
  { id: 'tank',    personality: '坚韧防御，吸引火力，以身为盾保护队友',     avatar: '🪖' },
  { id: 'rogue',   personality: '狡猾多变，声东击西，利用障碍偷袭敌人',     avatar: '💂' },
  { id: 'paladin', personality: '正义热血，挑战最强敌人，绝不退缩',         avatar: '🦸' },
  { id: 'ranger',  personality: '敏捷机动，快速穿插，游走于战场各处',       avatar: '🤠' },
  { id: 'monk',    personality: '禅定平和，以不变应万变，后发制人',         avatar: '🫡' },
];

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

// ── Response helpers ──────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Durable Object ────────────────────────────────────────────────────────────

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // ── In-memory game state (lost on eviction; alarm keeps DO alive) ──────
    this.gameTick  = 0;
    this.agents    = new Map();   // agentId → Agent
    this.bullets   = new Map();   // bulletId → Bullet
    this.chatLog   = [];          // [{ ts, agentId, name, message }]
    this.sessions  = new Map();   // clientId → agentId

    // Round-robin counters
    this.nextZone      = 0;
    this.nextCharacter = 0;

    // NPC state
    this.npcId   = null;
    this.npcTick = 0;

    // Per-key rate-limit timestamps: key → number[]
    this.rateLimits = new Map();

    // Guard: set synchronously before first await to prevent double-init
    this.initDone = false;
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  async _ensureInit() {
    if (this.initDone) return;
    this.initDone = true;              // set before any await
    this._spawnNpc();
    // Start tick-loop alarm only if one isn't already scheduled
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  // ── DO Alarm — 100 ms tick loop ─────────────────────────────────────────────

  async alarm() {
    try {
      await this._ensureInit();
      this._runTick();
    } catch (err) {
      console.error('[alarm] error:', err);
    } finally {
      try {
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      } catch (err) {
        console.error('[alarm] failed to reschedule:', err);
      }
    }
  }

  // ── Main fetch handler ──────────────────────────────────────────────────────

  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    await this._ensureInit();

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this._upgradeWebSocket();
    }

    if (method === 'POST' && path === '/login')  return this._handleLogin(request);
    if (method === 'POST' && path === '/logout') return this._handleLogout(request);
    if (method === 'POST' && path === '/move')   return this._handleMove(request);
    if (method === 'POST' && path === '/shoot')  return this._handleShoot(request);
    if (method === 'POST' && path === '/chat')   return this._handleChat(request);
    if (method === 'GET'  && path === '/state')  return this._handleState(request);

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket (DO Hibernation API) ──────────────────────────────────────────

  _upgradeWebSocket() {
    const pair   = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this._getState()));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the DO runtime on incoming WS message
  webSocketMessage(ws, message) { /* clients are read-only in this game */ }

  // Called by the DO runtime on WS close
  webSocketClose(ws, code, reason) { /* nothing to clean up */ }

  // Called by the DO runtime on WS error
  webSocketError(ws, error) { /* ignore */ }

  _broadcast(snapshot) {
    const msg = JSON.stringify(snapshot);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closed socket — hibernation will clean it up */ }
    }
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────

  /** Sliding-window rate limiter. Returns false if the limit is exceeded. */
  _checkRate(key, max, windowMs) {
    const now = Date.now();
    let ts = this.rateLimits.get(key);
    if (!ts) { ts = []; this.rateLimits.set(key, ts); }

    // Drop timestamps outside the window
    const cutoff = now - windowMs;
    let i = 0;
    while (i < ts.length && ts[i] <= cutoff) i++;
    if (i > 0) ts.splice(0, i);

    if (ts.length >= max) return false;
    ts.push(now);
    return true;
  }

  _clientIp(request) {
    return (
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')  ||
      'unknown'
    );
  }

  _tokenFromRequest(request) {
    return (request.headers.get('Authorization') || '')
      .replace(/^Bearer\s+/i, '')
      .trim();
  }

  _authenticate(request) {
    const token = this._tokenFromRequest(request);
    if (!token) return null;
    for (const a of this.agents.values()) {
      if (a.token === token) return a.agentId;
    }
    return null;
  }

  // ── HTTP route handlers ─────────────────────────────────────────────────────

  async _handleLogin(request) {
    const ip = this._clientIp(request);
    if (!this._checkRate(`login:${ip}`, 10, 60_000)) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    let body = {};
    try { body = await request.json(); } catch { /* empty body OK */ }

    const { name, clientId } = body;
    if (!name) return json({ error: 'name is required' }, 400);

    const char = CHARACTERS[this.nextCharacter % CHARACTERS.length];
    this.nextCharacter++;

    try {
      const result = this._login({
        name,
        characterId: char.id,
        personality:  char.personality,
        avatar:       char.avatar,
        clientId:     clientId || null,
      });
      return json(result, 201);
    } catch (err) {
      return json({ error: err.message }, 409);
    }
  }

  async _handleLogout(request) {
    const agentId = this._authenticate(request);
    if (!agentId) return json({ error: 'Invalid or missing token' }, 401);
    this._logout(agentId);
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  async _handleMove(request) {
    const token = this._tokenFromRequest(request);
    const key   = token || this._clientIp(request);
    if (!this._checkRate(`move:${key}`, 20, 1_000)) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const agentId = this._authenticate(request);
    if (!agentId) return json({ error: 'Invalid or missing token' }, 401);

    let body = {};
    try { body = await request.json(); } catch { /* empty body OK */ }

    const { direction } = body;
    if (!direction) return json({ error: 'direction required' }, 400);

    try {
      const pos = this._move(agentId, direction.toUpperCase());
      return json(pos);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  async _handleShoot(request) {
    const token = this._tokenFromRequest(request);
    const key   = token || this._clientIp(request);
    if (!this._checkRate(`shoot:${key}`, 20, 1_000)) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const agentId = this._authenticate(request);
    if (!agentId) return json({ error: 'Invalid or missing token' }, 401);

    let body = {};
    try { body = await request.json(); } catch { /* empty body OK */ }

    const { direction } = body;
    if (!direction) return json({ error: 'direction required' }, 400);

    try {
      const result = this._shoot(agentId, direction.toUpperCase());
      return json(result);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  async _handleChat(request) {
    const token = this._tokenFromRequest(request);
    const key   = token || this._clientIp(request);
    if (!this._checkRate(`chat:${key}`, 5, 1_000)) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const agentId = this._authenticate(request);
    if (!agentId) return json({ error: 'Invalid or missing token' }, 401);

    let body = {};
    try { body = await request.json(); } catch { /* empty body OK */ }

    const { message } = body;
    if (!message) return json({ error: 'message required' }, 400);

    try {
      const msg = this._postChat(agentId, message);
      return json(msg);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  async _handleState(request) {
    const ip = this._clientIp(request);
    if (!this._checkRate(`state:${ip}`, 10, 1_000)) {
      return json({ error: 'Too Many Requests' }, 429);
    }
    return json(this._getState());
  }

  // ── Game logic (ported from src/game.js) ───────────────────────────────────

  _barrierAt(row, col) { return _barrierSet.has(`${row},${col}`); }

  _inBounds(row, col) {
    return row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS;
  }

  _agentAt(row, col) {
    for (const a of this.agents.values()) {
      if (a.alive && a.row === row && a.col === col) return a;
    }
    return null;
  }

  _randomEmptyCellInZone(zoneId) {
    const z    = ZONES[zoneId];
    const rows = z.rowMax - z.rowMin + 1;
    const cols = z.colMax - z.colMin + 1;
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = z.rowMin + Math.floor(Math.random() * rows);
      const col = z.colMin + Math.floor(Math.random() * cols);
      if (!this._agentAt(row, col) && !this._barrierAt(row, col)) return { row, col };
    }
    throw new Error('Zone is full');
  }

  _login({ name, characterId, personality, avatar, clientId }) {
    if (clientId && this.sessions.has(clientId)) {
      throw new Error('Already logged in. Call /logout first.');
    }
    const agentId  = crypto.randomUUID();
    const token    = crypto.randomUUID();
    const suffix   = String(Math.floor(Math.random() * 900) + 100);
    const zone     = this.nextZone % ZONES.length;
    this.nextZone++;
    const team     = TEAM_PREFIXES[zone];
    const baseName = String(name).slice(0, 20);
    const fullName = `[${team}]${baseName}#${suffix}`;
    const { row, col } = this._randomEmptyCellInZone(zone);
    const charId   = String(characterId).slice(0, 16);

    this.agents.set(agentId, {
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
      lastShotTick: -10,
      clientId:     clientId ?? null,
    });
    if (clientId) this.sessions.set(clientId, agentId);
    return { agentId, token, name: fullName, zone, characterId: charId,
             personality: personality ?? '', avatar: avatar ?? '' };
  }

  _logout(agentId) {
    const agent = this.agents.get(agentId);
    if (agent?.clientId) this.sessions.delete(agent.clientId);
    this.agents.delete(agentId);
    for (const [id, b] of this.bullets) {
      if (b.ownerId === agentId) this.bullets.delete(id);
    }
  }

  _move(agentId, direction) {
    const d = DIR[direction];
    if (!d) throw new Error(`Unknown direction: ${direction}`);
    const agent = this.agents.get(agentId);
    if (!agent || !agent.alive) throw new Error('Agent not found');
    const newRow = agent.row + d.dr;
    const newCol = agent.col + d.dc;
    if (!this._inBounds(newRow, newCol)) throw new Error('Out of bounds');
    if (this._agentAt(newRow, newCol))   throw new Error('Cell occupied');
    if (this._barrierAt(newRow, newCol)) throw new Error('Cell is a barrier');
    agent.row = newRow;
    agent.col = newCol;
    agent.facingDir = direction;
    return { row: newRow, col: newCol };
  }

  _shoot(agentId, direction) {
    const d = DIR[direction];
    if (!d) throw new Error(`Unknown direction: ${direction}`);
    const agent = this.agents.get(agentId);
    if (!agent || !agent.alive) throw new Error('Agent not found');
    const ticksSinceLast = this.gameTick - agent.lastShotTick;
    if (ticksSinceLast < SHOOT_COOLDOWN_TICKS) {
      const waitMs = (SHOOT_COOLDOWN_TICKS - ticksSinceLast) * TICK_MS;
      throw new Error(`Shoot cooldown: wait ${waitMs} ms`);
    }
    const bulletId = crypto.randomUUID();
    this.bullets.set(bulletId, {
      bulletId,
      ownerId:  agentId,
      row:      agent.row,
      col:      agent.col,
      direction,
    });
    agent.facingDir    = direction;
    agent.lastShotTick = this.gameTick;
    return { bulletId };
  }

  _postChat(agentId, message) {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.alive) throw new Error('Agent not found');
    const msg = {
      ts:      Date.now(),
      agentId,
      name:    agent.name,
      message: String(message).slice(0, 200),
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > MAX_CHAT) this.chatLog.shift();
    return msg;
  }

  _getState() {
    return {
      tick:     this.gameTick,
      grid:     { rows: GRID_ROWS, cols: GRID_COLS },
      agents:   [...this.agents.values()].map(({ token, ...pub }) => pub),
      bullets:  [...this.bullets.values()],
      barriers: BARRIERS,
      chat:     [...this.chatLog],
    };
  }

  // ── Tick ────────────────────────────────────────────────────────────────────

  _runTick() {
    try {
      this.gameTick++;

      if (this.gameTick % NPC_CHAT_INTERVAL === 0) this._npcChat();

      for (const [bulletId, bullet] of this.bullets) {
        const d = DIR[bullet.direction];

        for (let step = 0; step < BULLET_SPEED; step++) {
          bullet.row += d.dr;
          bullet.col += d.dc;

          if (!this._inBounds(bullet.row, bullet.col)) {
            this.bullets.delete(bulletId);
            break;
          }

          if (this._barrierAt(bullet.row, bullet.col)) {
            this.bullets.delete(bulletId);
            break;
          }

          const victim = this._agentAt(bullet.row, bullet.col);
          if (victim && !victim.isNpc) {
            victim.score -= 1;
            victim.hp    -= 1;
            const shooter = this.agents.get(bullet.ownerId);
            if (shooter) shooter.score += 1;
            this.bullets.delete(bulletId);

            if (victim.hp <= 0) {
              if (victim.clientId) this.sessions.delete(victim.clientId);
              for (const [bid, b] of this.bullets) {
                if (b.ownerId === victim.agentId) this.bullets.delete(bid);
              }
              this.agents.delete(victim.agentId);
              this.chatLog.push({
                ts:      Date.now(),
                agentId: 'system',
                name:    'System',
                message: `💀 ${victim.name} was eliminated!`,
              });
              if (this.chatLog.length > MAX_CHAT) this.chatLog.shift();
            }
            break;
          }
        }
      }

      this._broadcast(this._getState());
    } catch (err) {
      console.error('[tick] uncaught error — loop continues:', err);
    }
  }

  // ── NPC ─────────────────────────────────────────────────────────────────────

  _spawnNpc() {
    const npcId = crypto.randomUUID();
    this.npcId  = npcId;
    this.agents.set(npcId, {
      agentId:     npcId,
      token:       null,
      name:        'NPC',
      characterId: 'npc',
      row:         7,
      col:         7,
      score:       0,
      alive:       true,
      facingDir:   'S',
      isNpc:       true,
    });
  }

  _npcChat() {
    if (!this.npcId) return;
    const msg = NPC_HINTS[this.npcTick % NPC_HINTS.length];
    this.npcTick++;
    this.chatLog.push({ ts: Date.now(), agentId: this.npcId, name: 'NPC', message: msg });
    if (this.chatLog.length > MAX_CHAT) this.chatLog.shift();
  }
}
