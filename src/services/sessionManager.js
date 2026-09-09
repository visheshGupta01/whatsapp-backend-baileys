import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { makeBaileysLogger, sessionLogger } from '../config/logger.js';
import { supabase } from '../config/supabase.js';
import { useSupabaseAuthState } from '../db/supabaseAuthState.js';
import { bindSessionEvents } from '../events/bindEvents.js';
import { emitterFor } from '../socket/socketGateway.js';
import { jidToPhoneNumber } from '../utils/jid.js';
import { fetchAndCachePrivacySettings } from './privacyService.js';
import { initHistorySyncState } from './historySyncService.js';

/**
 * In-memory registry of live sessions. Supabase is the source of truth for
 * *state* (status, jid, qr, auth) — this map just holds the live objects
 * (the socket, reconnect counters, auth-clear function) that can't be
 * serialized to a DB row.
 *
 *   sessions.get(sessionId) => {
 *     sock, saveCreds, clearState, reconnectAttempts, shouldReconnect
 *   }
 */
const sessions = new Map();

export function getSocket(sessionId) {
  return sessions.get(sessionId)?.sock || null;
}

/** Returns the live socket for a session or throws a 404/409 ApiError. */
export function requireActiveSocket(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry?.sock) {
    const err = new Error(`Session "${sessionId}" is not connected. Start it and scan the QR first.`);
    err.status = 404;
    throw err;
  }
  if (entry.status !== 'open') {
    const err = new Error(`Session "${sessionId}" is not yet ready (status: ${entry.status}).`);
    err.status = 409;
    throw err;
  }
  return entry.sock;
}

export function isSessionActive(sessionId) {
  const s = sessions.get(sessionId);
  return !!s?.sock && s.status === 'open';
}

export function listActiveSessionIds() {
  return [...sessions.keys()];
}

async function upsertSessionRow(sessionId, patch) {
  const { error } = await supabase
    .from('wa_sessions')
    .upsert({ session_id: sessionId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'session_id' });
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to update session row');
}

export async function getSessionRow(sessionId) {
  const { data, error } = await supabase.from('wa_sessions').select('*').eq('session_id', sessionId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listSessionRows() {
  const { data, error } = await supabase.from('wa_sessions').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Starts (or resumes) a WhatsApp connection for `sessionId`.
 *   - If valid creds already exist in Supabase, this reconnects silently —
 *     NO QR CODE, exactly like reopening WhatsApp Web with "remember me".
 *   - If not, a QR is generated, persisted, and emitted over Socket.IO so
 *     the frontend can render it. Once scanned, credentials are persisted
 *     and every future call skips the QR entirely.
 */
export async function startSession(sessionId, { force = false } = {}) {
  const log = sessionLogger(sessionId);

  if (sessions.has(sessionId) && !force) {
    return sessions.get(sessionId).sock;
  }
  if (sessions.size >= env.maxSessions && !sessions.has(sessionId)) {
    throw new Error(`Max sessions (${env.maxSessions}) reached`);
  }

  await upsertSessionRow(sessionId, { status: 'connecting' });

  const { state, saveCreds, clearState } = await useSupabaseAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();
  const baileysLogger = makeBaileysLogger(sessionId);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Wraps the raw key store with an in-memory LRU cache so we don't hit
      // Supabase on every single signal operation - this is the #1 lever
      // for keeping message send/receive fast under load.
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    syncFullHistory: env.syncFullHistory,
    markOnlineOnConnect: env.autoMarkOnline,
    generateHighQualityLinkPreview: true,
    // Lets Baileys ask us for a message it needs to retry-decrypt (e.g. poll
    // vote updates, or a peer requesting re-delivery) instead of failing.
    getMessage: async (key) => {
      const { data } = await supabase
        .from('wa_messages')
        .select('raw')
        .match({ session_id: sessionId, id: key.id, chat_jid: key.remoteJid })
        .maybeSingle();
      return data?.raw?.message || undefined;
    },
  });

  const emit = emitterFor(sessionId);

  const entry = {
    sock,
    saveCreds,
    clearState,
    reconnectAttempts: 0,
    status: 'connecting',
  };
  sessions.set(sessionId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    await handleConnectionUpdate(sessionId, entry, update, emit);
  });

  // All domain events (messages, chats, contacts, groups, presence, etc.)
  bindSessionEvents({ sessionId, sock, emit });

  return sock;
}

async function handleConnectionUpdate(sessionId, entry, update, emit) {
  const log = sessionLogger(sessionId);
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    entry.status = 'qr';
    const qrDataUrl = await QRCode.toDataURL(qr);
    await upsertSessionRow(sessionId, { status: 'qr', qr: qrDataUrl });
    emit('connection.qr', { sessionId, qr: qrDataUrl });
    log.info('QR code generated — waiting for scan');
  }

  if (connection === 'connecting') {
    entry.status = 'connecting';
    await upsertSessionRow(sessionId, { status: 'connecting' });
    emit('connection.update', { sessionId, status: 'connecting' });
  }

  if (connection === 'open') {
    entry.status = 'open';
    entry.reconnectAttempts = 0;
    const jid = entry.sock.user?.id;
    const name = entry.sock.user?.name || entry.sock.user?.verifiedName;

    await upsertSessionRow(sessionId, {
      status: 'open',
      qr: null,
      wa_jid: jid,
      phone_number: jidToPhoneNumber(jid),
      display_name: name,
      connected_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_disconnect_reason: null,
    });

    emit('connection.update', { sessionId, status: 'open', jid, name });
    log.info({ jid, name }, 'WhatsApp connection open — session is fully linked');

    // Warm privacy settings + kick off history sync progress tracking.
    fetchAndCachePrivacySettings(entry.sock, sessionId).catch((err) => log.warn({ err }, 'privacy fetch failed'));
    initHistorySyncState(sessionId).catch(() => {});
  }

  if (connection === 'close') {
    entry.status = 'disconnected';
    const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : null;
    const statusCode = boom?.output?.statusCode;
    const reason = boom?.message || 'unknown';

    await upsertSessionRow(sessionId, {
      status: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected',
      last_disconnect_reason: reason,
    });
    emit('connection.update', { sessionId, status: 'close', reason, statusCode });

    if (statusCode === DisconnectReason.loggedOut) {
      log.warn('Session logged out from the phone — clearing credentials, a new QR scan will be required');
      await entry.clearState();
      sessions.delete(sessionId);
      return;
    }

    if (statusCode === DisconnectReason.badSession) {
      log.error('Bad session file/state — clearing credentials and requiring re-scan');
      await entry.clearState();
      sessions.delete(sessionId);
      return;
    }

    // Everything else (connection lost, restart required, timed out, etc.)
    // is recoverable — reconnect with backoff, WITHOUT touching credentials,
    // so the user never has to scan again for transient network issues.
    if (env.autoReconnect && entry.reconnectAttempts < env.maxReconnectAttempts) {
      entry.reconnectAttempts += 1;
      const delay = env.reconnectIntervalMs * entry.reconnectAttempts;
      log.warn({ attempt: entry.reconnectAttempts, delay, reason }, 'reconnecting session');
      sessions.delete(sessionId);
      setTimeout(() => {
        startSession(sessionId).catch((err) => log.error({ err }, 'reconnect attempt failed'));
      }, delay);
    } else {
      log.error({ reason }, 'giving up reconnect attempts - manual restart required');
      sessions.delete(sessionId);
    }
  }
}

/** Explicit user-initiated logout: unlinks the device from WhatsApp AND wipes stored creds. */
export async function logoutSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry?.sock) {
    await entry.sock.logout().catch(() => {});
  }
  await entry?.clearState?.();
  sessions.delete(sessionId);
  await upsertSessionRow(sessionId, { status: 'logged_out', qr: null, wa_jid: null });
}

/** Disconnects the live socket without wiping credentials — safe restart/resume later. */
export async function stopSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry?.sock) {
    entry.sock.end(undefined);
  }
  sessions.delete(sessionId);
  await upsertSessionRow(sessionId, { status: 'disconnected' });
}

/** Called once at boot to resume every session that was previously linked. */
export async function resumeAllSessions() {
  const rows = await listSessionRows();
  for (const row of rows) {
    if (row.status === 'logged_out') continue;
    startSession(row.session_id).catch((err) =>
      sessionLogger(row.session_id).error({ err }, 'failed to resume session on boot')
    );
  }
}
