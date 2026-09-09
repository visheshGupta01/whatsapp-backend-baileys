import pino from 'pino';
import { env } from './env.js';

/**
 * Root application logger. Pretty-printed in dev, JSON (for log aggregators)
 * in production.
 */
export const logger = pino({
  level: env.logLevel,
  transport:
    env.nodeEnv !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
  base: { service: 'wa-backend' },
});

/**
 * A dedicated logger instance passed into makeWASocket({ logger }).
 * Kept quieter than the app logger by default since Baileys is chatty,
 * but still namespaced per session so you can grep by sessionId.
 */
export function makeBaileysLogger(sessionId) {
  return pino({
    level: env.baileysLogLevel,
    transport:
      env.nodeEnv !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  }).child({ service: 'baileys', sessionId });
}

export function sessionLogger(sessionId) {
  return logger.child({ sessionId });
}
