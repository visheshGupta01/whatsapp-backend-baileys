import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let io = null;

export function initSocketGateway(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, methods: ['GET', 'POST'] },
  });

  // Simple API-key auth on the handshake - swap for JWT/session auth as needed.
  io.use((socket, next) => {
    const key = socket.handshake.auth?.apiKey || socket.handshake.headers['x-api-key'];
    if (!env.apiKey || key === env.apiKey) return next();
    next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'socket connected');

    // Clients join the room for whichever session(s) they want live updates for.
    socket.on('subscribe', (sessionId) => {
      if (typeof sessionId === 'string') socket.join(roomFor(sessionId));
    });

    socket.on('unsubscribe', (sessionId) => {
      if (typeof sessionId === 'string') socket.leave(roomFor(sessionId));
    });

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'socket disconnected');
    });
  });

  return io;
}

function roomFor(sessionId) {
  return `session:${sessionId}`;
}

/** Returns an `emit(event, payload)` function scoped to one session's room. */
export function emitterFor(sessionId) {
  return (event, payload) => {
    if (!io) return;
    io.to(roomFor(sessionId)).emit(event, payload);
  };
}

export function getIo() {
  return io;
}
