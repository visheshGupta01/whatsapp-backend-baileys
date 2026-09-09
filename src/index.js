import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { env, assertRequiredEnv } from './config/env.js';
import { logger } from './config/logger.js';
import { mountRoutes } from './routes/index.js';
import { apiKeyAuth } from './middleware/auth.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { initSocketGateway } from './socket/socketGateway.js';
import { resumeAllSessions } from './services/sessionManager.js';

assertRequiredEnv();

const app = express();
const httpServer = http.createServer(app);

app.use(helmet());
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json({ limit: '50mb' })); // generous limit - base64 media payloads can be large
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Every /api/* route requires the API key (set API_KEY in .env)
app.use('/api', apiKeyAuth);
mountRoutes(app);

app.use(notFoundHandler);
app.use(errorHandler);

initSocketGateway(httpServer);

httpServer.listen(env.port, async () => {
  logger.info(`Server listening on port ${env.port} (${env.nodeEnv})`);
  try {
    await resumeAllSessions();
    logger.info('Resumed all previously linked sessions');
  } catch (err) {
    logger.error({ err }, 'failed to resume sessions on boot');
  }
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down gracefully');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));
