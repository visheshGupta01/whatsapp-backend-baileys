import { env } from '../config/env.js';
import { fail } from '../utils/response.js';

export function apiKeyAuth(req, res, next) {
  if (!env.apiKey) return next(); // auth disabled if not configured (dev only)
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== env.apiKey) return fail(res, 'Unauthorized', 401);
  next();
}
