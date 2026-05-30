// server.js — Fastify HTTP + WebSocket server

import Fastify from 'fastify';
import fastifyWs from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { login, logout, move, shoot, chat, getState, resolveToken, startLoop, spawnNpcs } from './game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const logFile = join(__dirname, '..', 'logs', 'server.log');
import { mkdirSync, createWriteStream } from 'fs';
mkdirSync(join(__dirname, '..', 'logs'), { recursive: true });
const logStream = createWriteStream(logFile, { flags: 'a' });

const fastify = Fastify({
  logger: {
    level: 'warn',
    stream: { write: (msg) => { process.stdout.write(msg); logStream.write(msg); } },
  },
});

// ── Global crash guards ───────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  fastify.log.fatal({ err }, 'uncaughtException — server would have crashed');
});
process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'unhandledRejection');
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
await fastify.register(fastifyRateLimit, {
  global: false,          // apply per-route only; we set limits explicitly below
  keyGenerator: (req) => {
    // For authenticated routes, key by token so limits are per-agent, not per-IP
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    return token || req.ip;
  },
});

// Allow POST requests with no body / no Content-Type (e.g. /logout)
// Also override application/json to handle empty bodies gracefully
fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, body ? JSON.parse(body) : {}); } catch { done(null, {}); }
});
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, body ? JSON.parse(body) : {}); } catch { done(null, {}); }
});

await fastify.register(fastifyWs);
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
});

// ── Auth middleware helper ────────────────────────────────────────────────────

function authenticate(request, reply) {
  const auth = request.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const agentId = resolveToken(token);
  if (!agentId) {
    reply.code(401).send({ error: 'Invalid or missing token' });
    return null;
  }
  return agentId;
}

// ── REST routes ───────────────────────────────────────────────────────────────

// Each character has a fixed role id, personality description, and avatar emoji.
// Assigned round-robin at login; client-provided characterId is ignored.
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

let _nextCharacter = 0; // round-robin character assignment counter

// POST /login  { name, clientId? }
fastify.post('/login', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip } },
}, async (request, reply) => {
  const { name, clientId } = request.body ?? {};
  if (!name) {
    return reply.code(400).send({ error: 'name is required' });
  }
  // Round-robin character assignment — client-provided characterId is ignored
  const char = CHARACTERS[_nextCharacter % CHARACTERS.length];
  _nextCharacter++;
  try {
    const result = login({
      name,
      characterId: char.id,
      personality:  char.personality,
      avatar:       char.avatar,
      clientId:     clientId || null,
    });
    return reply.code(201).send(result);
  } catch (err) {
    return reply.code(409).send({ error: err.message });
  }
});

// POST /logout  (no body — token in Authorization header only)
fastify.post('/logout', async (request, reply) => {
  const agentId = authenticate(request, reply);
  if (!agentId) return;
  logout(agentId);
  return reply.code(204).send();
});

// POST /move  { direction: "N"|"S"|"E"|"W" }
fastify.post('/move', {
  config: { rateLimit: { max: 20, timeWindow: '1 second' } },
}, async (request, reply) => {
  const agentId = authenticate(request, reply);
  if (!agentId) return;
  const { direction } = request.body ?? {};
  if (!direction) return reply.code(400).send({ error: 'direction required' });
  try {
    const pos = move(agentId, direction.toUpperCase());
    return reply.send(pos);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// POST /shoot  { direction: "N"|"S"|"E"|"W" }
fastify.post('/shoot', {
  config: { rateLimit: { max: 20, timeWindow: '1 second' } },
}, async (request, reply) => {
  const agentId = authenticate(request, reply);
  if (!agentId) return;
  const { direction } = request.body ?? {};
  if (!direction) return reply.code(400).send({ error: 'direction required' });
  try {
    const result = shoot(agentId, direction.toUpperCase());
    return reply.send(result);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// POST /chat  { message: "hello" }
fastify.post('/chat', {
  config: { rateLimit: { max: 5, timeWindow: '1 second' } },
}, async (request, reply) => {
  const agentId = authenticate(request, reply);
  if (!agentId) return;
  const { message } = request.body ?? {};
  if (!message) return reply.code(400).send({ error: 'message required' });
  try {
    const msg = chat(agentId, message);
    return reply.send(msg);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// GET /state  — full snapshot (useful for polling agents)
fastify.get('/state', {
  config: { rateLimit: { max: 10, timeWindow: '1 second', keyGenerator: (req) => req.ip } },
}, async () => getState());

// ── WebSocket broadcast ───────────────────────────────────────────────────────

const wsClients = new Set();

fastify.get('/ws', { websocket: true }, (socket) => {
  wsClients.add(socket);
  fastify.log.info({ total: wsClients.size }, 'WS client connected');
  // Send current state immediately on connect
  socket.send(JSON.stringify(getState()));
  socket.on('close', () => {
    wsClients.delete(socket);
    fastify.log.info({ total: wsClients.size }, 'WS client disconnected');
  });
  socket.on('error', (err) => {
    fastify.log.warn({ err }, 'WS client error');
    wsClients.delete(socket);
  });
});

function broadcast(stateSnapshot) {
  const msg = JSON.stringify(stateSnapshot);
  for (const client of wsClients) {
    try { client.send(msg); } catch { wsClients.delete(client); }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

spawnNpcs();
startLoop(broadcast);

await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
