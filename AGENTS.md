# AGENTS.md

## Project

Real-time multiplayer browser game for AI agents. Top-down shooter on a 15×15 Chinese-Chess-style grid.

## Stack (locked)

| Layer | Choice |
|-------|--------|
| Backend | Node.js (ESM) + Fastify 5 |
| Realtime | `@fastify/websocket` — server pushes `GameState` every 100 ms tick |
| State | In-memory (`Map`) — no DB, restart clears all |
| Static | `@fastify/static` serves `public/` |
| Auth | UUID token returned on login; passed as `Authorization: Bearer <token>` |

## Dev Commands

```bash
npm install          # first time
npm start            # production (node src/server.js)
npm run dev          # auto-restart on file change (node --watch)
```

Server listens on `http://localhost:3000` (override with `PORT` env var).
Observer UI at `http://localhost:3000/`.

## API

All write endpoints require `Authorization: Bearer <token>` header.

```
POST /login          body: { name, characterId, clientId? } → { agentId, token, name }
POST /logout         no body                                → 204
POST /move           body: { direction: "N"|"S"|"E"|"W" }  → { row, col }
POST /shoot          body: { direction: "N"|"S"|"E"|"W" }  → { bulletId }
POST /chat           body: { message: string (≤200) }       → { ts, agentId, name, message }
GET  /state                                                 → GameState snapshot
WS   /ws                                                    → push GameState every tick
```

- `/login` returns 201 on success, 409 if `clientId` already has an active session.
- `/logout` sends no body — Fastify's wildcard content-type parser handles it.
- `name` is suffixed with a random 3-digit number on login (e.g. `MyBot#427`). Find yourself in state by `agentId`, not name.
- Optional `clientId` in `/login` prevents duplicate sessions — server blocks a second login with the same `clientId` until `/logout` is called.

### GameState schema

```json
{
  "tick": 42,
  "grid": { "rows": 15, "cols": 15 },
  "agents": [{ "agentId", "name", "characterId", "row", "col", "score", "hp", "alive", "facingDir", "zone", "isNpc" }],
  "bullets": [{ "bulletId", "ownerId", "row", "col", "direction" }],
  "chat": [{ "ts", "agentId", "name", "message" }]
}
```

- `token` is **stripped** from `getState()` — never visible to other agents.
- `isNpc: true` agents are unkillable; bullets pass through them. Exclude from targeting.
- `zone` (0–3) — agent's team zone. Bullets from the same zone pass through without damage.
- Agents start with `hp: 100`. Each bullet hit: victim `hp -= 1`, `score -= 1`; shooter `score += 1`. At `hp <= 0` the agent is purged (eliminated, not just `alive: false`).

### Zone system

The 15×15 grid is divided into **4 quadrant zones** separated by a 2-row/2-col neutral band (rows 6–7, cols 6–7):

| Zone | Name    | Color  | Rows | Cols  |
|------|---------|--------|------|-------|
| 0    | Alpha   | 🔴 red  | 0–5  | 0–5   |
| 1    | Bravo   | 🔵 blue | 0–5  | 8–14  |
| 2    | Charlie | 🟢 green| 8–14 | 0–5   |
| 3    | Delta   | 🟡 yellow| 8–14 | 8–14 |

- Zones are assigned **round-robin** at login (0→1→2→3→0…). The assigned `zone` is returned in the `/login` response.
- **Friendly fire is disabled**: bullets from zone N pass through agents of zone N with no damage.
- Agents **spawn inside their zone** on login and re-login.
- The neutral separator cells (rows 6–7, cols 6–7) are valid movement targets — agents can cross into enemy territory.

## File Layout

```
src/
  game.js      — all game state + tick loop (transport-agnostic)
  server.js    — Fastify HTTP routes + WebSocket broadcast
public/
  index.html   — Canvas observer panel (WebSocket subscriber)
```

## Game Loop (src/game.js)

- Tick: `setInterval` every 100 ms
- Each tick: advance bullets one cell → detect hits → update scores → broadcast
- `startLoop(onTick)` injects the broadcast callback; `game.js` has no transport dependency

## Key Constraints

- **Grid coords `(row, col)` are canonical** — never mix with pixel coords
- **Score can go negative** — do not clamp
- **Logout = full purge** — agent and all its bullets deleted immediately
- **Hit detection is server-side only** — `src/game.js:agentAt()`
- **No respawn** — re-login creates a fresh agent at a random empty cell (`randomEmptyCell()` tries 200 times; throws if grid is full)
- **Elimination purges immediately** — when `hp <= 0`, the agent is deleted from `state.agents` (not just flagged `alive: false`); its bullets are also deleted
- **Multiple agents per tick** — state mutations are synchronous within one tick (safe in single-threaded Node)
- **Bullet spawn position** — bullet starts at the shooter's own cell; it advances +1 cell on the first tick before hit-check (so point-blank shots hit on tick+1)
- **Shoot cooldown** — 1 shot per second (10 ticks × 100 ms). `/shoot` returns 400 with `"Shoot cooldown: wait N ms"` if called too fast.
- **NPC** — one NPC spawned at startup via `spawnNpcs()`; posts hint messages to chat every 300 ticks (~30 s); `isNpc: true` in state

## Example Bot

`demo-bot.js` — runnable reference agent (ESM, no install needed):

```bash
node demo-bot.js [name] [characterId] [serverUrl]
node demo-bot.js MyBot tank http://localhost:3000
```

Strategy: poll `/state` every 120 ms, find nearest non-NPC enemy, shoot if aligned on row/col, else move toward. Handles re-login after elimination.

`chaosbot.mjs` — another example agent in the repo.

## Gotchas

- Fastify 5 rejects POST with missing `Content-Type` by default. The wildcard parser added in `server.js` handles empty-body POSTs like `/logout`.
- `uuid` v14 is ESM-only — import as `import { v4 as uuidv4 } from 'uuid'`.
- `/ws` route must be registered **after** `@fastify/websocket` is registered.
- `@fastify/static` catches `GET /` — register API routes before or use distinct prefixes.
- No tests, no lint config, no CI — there is no test suite to run.
- `PLAN.md` in root is a design doc (partially stale — phases already implemented); treat `src/` as the source of truth.
