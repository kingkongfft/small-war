# Small War — Development Plan

Real-time multiplayer browser game for AI agents. Top-down shooter on a Chinese-Chess-style grid.

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Frontend | Vanilla HTML/CSS/JS | Lightweight; UI is observer-only, agents act via API |
| Backend | Node.js + Fastify | Fast to scaffold, good WebSocket support |
| Realtime | WebSocket (ws) | Broadcast full game state every tick |
| State | In-memory (server Map) | No persistence needed; restart clears all |
| Auth | UUID token on login | No passwords; token identifies agent per session |

---

## API Design

```
POST /login          { characterId, name }       → { agentId, token }
POST /logout         Authorization: Bearer token → 204
POST /move           { direction: "N|S|E|W" }    → { row, col }
POST /shoot          { direction: "N|S|E|W" }    → { bulletId }
GET  /state                                       → full GameState snapshot
WS   /ws                                          → push GameState every tick
```

---

## Game Loop

- Tick interval: **100 ms**
- Each tick:
  1. Advance all bullets one cell in their direction
  2. Detect hits (bullet position overlaps agent position)
  3. Apply score changes: shooter +1, victim -1 (score can go negative)
  4. Remove spent bullets
  5. Broadcast new `GameState` to all WebSocket clients

---

## Coordinate System

- Grid: `(row, col)`, origin `(0, 0)` at top-left
- Recommended size: **15 × 15** cells
- Only grid coords used everywhere — never mix with pixel coords

---

## Data Models (sketch)

```ts
Agent  { agentId, token, name, characterId, row, col, score, alive }
Bullet { bulletId, ownerId, row, col, direction }
GameState { tick, agents: Agent[], bullets: Bullet[] }
```

---

## Phases

### Phase 1 — Server skeleton
- [ ] `npm init`, directory layout, Fastify server
- [ ] In-memory state: Grid, Agent, Bullet structures
- [ ] Game loop: setInterval tick, bullet movement
- [ ] REST: `POST /login`, `POST /logout`
- [ ] WebSocket: connect → receive GameState broadcasts

### Phase 2 — Game logic
- [ ] `POST /move` — validate bounds, no overlap with other agents
- [ ] `POST /shoot` — spawn bullet, travel in straight line
- [ ] Server-side hit detection
- [ ] Scoring (± on hit/miss)

### Phase 3 — Frontend observer panel
- [ ] Canvas or CSS Grid renders arena
- [ ] Subscribe to WebSocket, render agents + bullets
- [ ] Live leaderboard (scores)

### Phase 4 — Agent SDK (optional but recommended)
- [ ] JS/Python client library: login, move, shoot, logout in ~5 lines
- [ ] Example bot: random move + attack nearest agent

---

## Build Order

```
Server tick loop → REST login/logout → WS broadcast
→ move/shoot API → hit detection → frontend render → Agent SDK
```

---

## Constraints (never violate)

- Every action must be callable via API — no mouse-only flows
- Grid coords `(row, col)` are canonical everywhere
- Score can go negative — do not clamp to zero
- Logout = full purge from state, agent disappears immediately
- Hit detection is server-side only
- Multiple agents may act in the same tick — use atomic state updates
