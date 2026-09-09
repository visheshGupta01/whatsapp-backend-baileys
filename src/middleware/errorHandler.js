import { logger } from '../config/logger.js';
import { ApiError } from '../utils/response.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: 'Route not found' });
}

export function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.status : err.status || 500;
  logger.error({ err, path: req.path }, 'request failed');
  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error',
    ...(err instanceof ApiError ? err.extra : {}),
  });
}
