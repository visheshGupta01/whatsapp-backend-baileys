import 'dotenv/config';
import path from 'node:path';

function bool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true';
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export const env = {
  port: int(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseMediaBucket: process.env.SUPABASE_MEDIA_BUCKET || 'wa-media',

  mediaLocalPath: path.resolve(process.env.MEDIA_LOCAL_PATH || './storage/media'),
  mediaUploadToSupabase: bool(process.env.MEDIA_UPLOAD_TO_SUPABASE, false),
  mediaMaxSizeMb: int(process.env.MEDIA_MAX_SIZE_MB, 100),

  maxSessions: int(process.env.MAX_SESSIONS, 10),
  autoReconnect: bool(process.env.AUTO_RECONNECT, true),
  reconnectIntervalMs: int(process.env.RECONNECT_INTERVAL_MS, 3000),
  maxReconnectAttempts: int(process.env.MAX_RECONNECT_ATTEMPTS, 10),
  syncFullHistory: bool(process.env.SYNC_FULL_HISTORY, false),
  autoMarkOnline: bool(process.env.AUTO_MARK_ONLINE, false),

  logLevel: process.env.LOG_LEVEL || 'info',
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL || 'warn',
};

export function assertRequiredEnv() {
  const missing = [];
  if (!env.supabaseUrl) missing.push('SUPABASE_URL');
  if (!env.supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.apiKey) missing.push('API_KEY');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
