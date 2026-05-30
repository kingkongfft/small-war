// worker.js — Cloudflare Workers entry point
//
// Routes:
//   /login /logout /move /shoot /chat /state /ws  → GameRoom Durable Object
//   everything else                               → Workers Assets (public/)

export { GameRoom } from './game-do.js';

// Paths that belong to the game API / WebSocket
const API_PATHS = new Set(['/login', '/logout', '/move', '/shoot', '/chat', '/state', '/ws']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (API_PATHS.has(url.pathname)) {
      // All game requests are handled by a single global Durable Object instance.
      const id   = env.GAME_ROOM.idFromName('global');
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Serve static files from public/
    return env.ASSETS.fetch(request);
  },
};
