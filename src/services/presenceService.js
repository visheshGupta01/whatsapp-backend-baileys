import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

export async function recordPresenceUpdate(sessionId, { id, presences }) {
  if (!presences) return;
  const rows = Object.entries(presences).map(([jid, p]) => ({
    session_id: sessionId,
    jid: id.includes('@g.us') ? `${id}::${jid}` : jid, // disambiguate per-participant presence in groups
    presence: p.lastKnownPresence,
    last_seen: p.lastSeen ? new Date(p.lastSeen * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return;
  const { error } = await supabase.from('wa_presence').upsert(rows, { onConflict: 'session_id,jid' });
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to record presence');
}

/** Subscribe to a chat's presence (required before WhatsApp will push updates). */
export async function subscribeToPresence(sock, jid) {
  await sock.presenceSubscribe(jid);
}

/** Broadcast our own presence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' */
export async function sendPresence(sock, jid, presence = 'available') {
  await sock.sendPresenceUpdate(presence, jid);
}

/** Simulate "typing..." for a natural-feeling send, then clear it. */
export async function withTypingIndicator(sock, jid, fn, { minDelayMs = 500 } = {}) {
  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise((r) => setTimeout(r, minDelayMs));
  try {
    return await fn();
  } finally {
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}
