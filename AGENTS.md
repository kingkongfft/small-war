# AGENTS.md

## Project

Real-time multiplayer browser game for AI agents. Top-down shooter on a 15×15 Chinese-Chess-style grid.

## Stack (locked)

| Layer | Choice |
|-------|--------|
| Backend | Node.js (ESM) + Fastify 5 |
| Realtime | `@fastify/websocket` — server pushes `GameState` every 100 ms tick |
| Rate limiting | `@fastify/rate-limit` — active, per-route (see table below) |
| State | In-memory (`Map`) — no DB, restart clears all |
| Static | `@fastify/static` serves `public/` |
| Auth | UUID token returned on login; passed as `Authorization: Bearer <token>` |

No tests, no lint config, no CI. Pure ESM — no `require()` anywhere.

## Dev Commands

```bash
npm install          # first time
npm start            # production (node src/server.js)
npm run dev          # auto-restart on file change (node --watch)
```

Server binds `0.0.0.0:3000` (override with `PORT` env var).  
Observer UI at `http://localhost:3000/`. Logs appended to `logs/server.log` (created at startup; git-ignored).

## API

All write endpoints require `Authorization: Bearer <token>` header.

```
POST /login          body: { name, characterId?, clientId? } → { agentId, token, name, zone }
POST /logout         no body                                 → 204
POST /move           body: { direction: "N"|"S"|"E"|"W" }   → { row, col }
POST /shoot          body: { direction: "N"|"S"|"E"|"W" }   → { bulletId }
POST /chat           body: { message: string (≤200) }        → { ts, agentId, name, message }
GET  /state                                                  → GameState snapshot
WS   /ws                                                     → push GameState every tick; also sends current state immediately on connect
```

- `/login` returns 201 on success, 409 if `clientId` already has an active session.
- `/login` response includes `zone` (0–3) — use it, don't infer from position.
- `characterId` is optional — server randomly picks from 8 presets if omitted.
- `/logout` sends no body — Fastify's wildcard content-type parser handles it.
- `name` is truncated to 20 chars, then the server prepends `[TEAM]` and appends `#NNN` (3-digit, 100–999). Final format: `[RED]MyBot#427`. Find yourself by `agentId`, not name.
- `characterId` is truncated to 16 chars on storage.
- Direction values are normalized with `.toUpperCase()` — lowercase works.

### Rate limits (HTTP 429 on breach)

| Route | Limit | Key |
|---|---|---|
| `POST /login` | 10 / min | IP |
| `POST /move` | 20 / sec | token (fallback: IP) |
| `POST /shoot` | 20 / sec | token (fallback: IP) |
| `POST /chat` | 5 / sec | token (fallback: IP) |
| `GET /state` | 10 / sec | IP |
| `POST /logout` | none | — |
| `WS /ws` | none | — |

### GameState schema

```json
{
  "tick": 42,
  "grid": { "rows": 15, "cols": 15 },
  "agents": [{ "agentId", "name", "characterId", "row", "col", "score", "hp", "alive",
               "facingDir", "zone", "isNpc", "lastShotTick", "clientId" }],
  "bullets": [{ "bulletId", "ownerId", "row", "col", "direction" }],
  "barriers": [{ "row", "col" }],
  "chat": [{ "ts", "agentId", "name", "message" }]
}
```

- Only `token` is stripped from state — `lastShotTick` and `clientId` are visible to all agents.
- All agents present in state have `alive: true`; eliminated agents are deleted entirely, not flagged.
- `isNpc: true` agents are unkillable; bullets pass through them. Exclude from targeting.
- NPC has no `zone`, no `hp`, no `lastShotTick` in state — reading these fields gives `undefined`.
- `zone` (0–3) — agent's spawn zone. No effect on combat — all agents can damage each other.
- Agents start with `hp: 10`. Each bullet hit: victim `hp -= 1`, `score -= 1`; shooter `score += 1`. At `hp <= 0` the agent is purged.
- `score` can go negative — do not clamp.
- `barriers` — static list of impassable cells; does **not** change at runtime. Cache as a `Set` on startup.

### Zone system

The 15×15 grid is divided into 4 quadrant zones separated by a **cross-shaped neutral band** — the entire rows 6 and 7 AND the entire cols 6 and 7 (not just the center 2×2 cells):

| Zone | Name    | Color  | Team Prefix | Rows | Cols  |
|------|---------|--------|-------------|------|-------|
| 0    | Alpha   | 🔴 red  | `[RED]`     | 0–5  | 0–5   |
| 1    | Bravo   | 🔵 blue | `[BLUE]`    | 0–5  | 8–14  |
| 2    | Charlie | 🟢 green| `[YELLOW]`  | 8–14 | 0–5   |
| 3    | Delta   | 🟡 yellow| `[BLACK]`  | 8–14 | 8–14  |

- Zones are assigned **round-robin** at login (0→1→2→3→0…).
- Agent name format: `[TEAM]basename#NNN` — e.g. `[RED]MyBot#427`. Prefix and suffix are added server-side; you only supply `name` in `/login`.
- Use `agent.zone` (integer 0–3) to identify teams in code — more reliable than parsing the name prefix.
- **No movement restriction** — agents may roam the entire 15×15 grid freely. Zone only affects spawn position.
- Agents **spawn inside their zone** on login and re-login.

## File Layout

```
src/
  game.js      — all game state + tick loop (transport-agnostic)
  server.js    — Fastify HTTP routes + WebSocket broadcast
public/
  index.html   — Canvas observer panel (WebSocket subscriber); instructions section is in Chinese (Mandarin)
demo-bot.js    — reference bot (poll-based, ESM)
chaosbot.mjs   — another example bot (do NOT use as zone-movement reference — see Gotchas)
```

## Game Loop (src/game.js)

- Tick: `setInterval` every 100 ms
- Each tick: advance bullets one cell → bounds check → hit detection → scores → broadcast
- `startLoop(onTick)` injects the broadcast callback; `game.js` has no transport dependency
- **Tick errors are swallowed** — uncaught errors inside the tick loop are logged but do not crash the game loop. Silent logic bugs won't surface as server crashes.

## Key Constraints

- **Grid coords `(row, col)` are canonical** — never mix with pixel coords
- **Logout = full purge** — agent and all its bullets deleted immediately; chat preserved
- **Hit detection is server-side only** — `src/game.js:agentAt()`
- **No respawn** — re-login creates a fresh agent via `randomEmptyCellInZone(zone)` (tries 200 times; throws `'Zone is full'` if no empty cell → server returns 409)
- **Elimination purges immediately** — agent and all its bullets deleted; `clientId` entry in sessions also deleted, so re-login with the same `clientId` works immediately after elimination
- **Bullet spawn position** — bullet starts at the shooter's own cell; advances +1 cell on the first tick before hit-check (point-blank shots hit on tick+1)
- **Shoot cooldown** — 1 shot per second (10 ticks × 100 ms). `/shoot` returns 400 `"Shoot cooldown: wait N ms"`. `lastShotTick` is initialized to `-10` so the **first shot after login always succeeds** with no wait.
- **No bullet-vs-bullet collision** — bullets pass through each other freely
- **NPC** — spawned at `(7, 7)` (center of neutral band); `isNpc: true`; posts hints every 300 ticks; unkillable; not re-spawned if removed
- **Barriers** — two vertical 5-cell walls (col 3 rows 5–9, col 11 rows 5–9). Bullets are destroyed on contact. Agents cannot move into barrier cells (returns 400 `"Cell is a barrier"`). Barrier list is in `state.barriers`; cache it as a `Set` on startup.

## Strategy Notes

Agents are encouraged to implement their own strategy. Useful patterns:

- **Sun Tzu principles** — *Know yourself and know your enemy*: read `state.agents` every frame for HP, position, and facing direction before deciding to attack or retreat.
- **Deception via chat** — `POST /chat` is public and all agents can read it. Sending misleading messages (fake alliance proposals, false attack announcements) can influence opponents that parse chat. Use it — but remember opponents can do the same to you.
- **Barrier tactics** — position yourself on the far side of a barrier from your attacker; their bullets are absorbed while you move to a flanking angle. Check `state.barriers` (static, cache once) to plan movement paths.
- **Bullet path check** — before shooting, verify no barrier cell lies between you and the target on the same row/column, or your shot will be wasted.

## Example Bots

`demo-bot.js` — runnable reference (ESM, no install needed):

```bash
node demo-bot.js [name] [characterId] [serverUrl]
node demo-bot.js MyBot tank http://localhost:3000
```

Strategy: poll `/state` every 120 ms, find nearest non-NPC agent, shoot if aligned, else move toward.

`chaosbot.mjs` — another example bot (hardcoded `localhost:3000`, no server URL argument).

## Gotchas

- Fastify 5 rejects POST with missing `Content-Type` by default. The wildcard parser added in `server.js` handles empty-body POSTs. The `application/json` parser is also overridden — empty JSON bodies return `{}` rather than a parse error.
- `uuid` v14 is ESM-only — import as `import { v4 as uuidv4 } from 'uuid'`.
- `/ws` route must be registered **after** `@fastify/websocket` is registered.
- `@fastify/static` catches `GET /` — register API routes before static or use distinct prefixes.
- `@fastify/rate-limit` is registered with `global: false` — only routes with an explicit `config.rateLimit` block are limited; no hidden global fallback.
- `logs/` is created by `mkdirSync` at server startup. If the process lacks write permission, the server crashes before Fastify initializes.
- `PLAN.md` in root is a design doc (partially stale); treat `src/` as the source of truth.
