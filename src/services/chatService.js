import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

function tsToIso(ts) {
  if (!ts) return null;
  const n = typeof ts === 'object' && ts.toNumber ? ts.toNumber() : Number(ts);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

export async function upsertChats(sessionId, chats) {
  if (!chats?.length) return;
  const log = sessionLogger(sessionId);

  const rows = chats.map((c) => ({
    session_id: sessionId,
    jid: c.id,
    name: c.name || c.subject || undefined,
    is_group: c.id?.endsWith('@g.us') || false,
    unread_count: c.unreadCount ?? undefined,
    archived: c.archived ?? undefined,
    pinned: !!c.pinned,
    muted_until: c.muteEndTime ? tsToIso(c.muteEndTime) : undefined,
    conversation_timestamp: c.conversationTimestamp
      ? Number(c.conversationTimestamp?.toNumber ? c.conversationTimestamp.toNumber() : c.conversationTimestamp)
      : undefined,
    last_message_ts: c.conversationTimestamp ? tsToIso(c.conversationTimestamp) : undefined,
    ephemeral_expiration: c.ephemeralExpiration ?? undefined,
    updated_at: new Date().toISOString(),
  }));

  // Strip undefined keys so we don't clobber existing columns with nulls
  const cleaned = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));

  const { error } = await supabase.from('wa_chats').upsert(cleaned, { onConflict: 'session_id,jid' });
  if (error) log.error({ err: error }, 'failed to upsert chats');
}

export async function markChatRead(sessionId, jid, unreadCount = 0) {
  const { error } = await supabase
    .from('wa_chats')
    .update({ unread_count: unreadCount, updated_at: new Date().toISOString() })
    .match({ session_id: sessionId, jid });
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to mark chat read');
}

export async function touchChatLastMessage(sessionId, jid, messageId, timestampIso) {
  const { error } = await supabase
    .from('wa_chats')
    .upsert(
      {
        session_id: sessionId,
        jid,
        last_message_id: messageId,
        last_message_ts: timestampIso,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,jid' }
    );
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to touch chat last message');
}

export async function listChats(sessionId, { limit = 50, offset = 0, archived } = {}) {
  let q = supabase
    .from('wa_chats')
    .select('*')
    .eq('session_id', sessionId)
    .order('last_message_ts', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (archived !== undefined) q = q.eq('archived', archived);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function deleteChat(sessionId, jid) {
  const { error } = await supabase.from('wa_chats').delete().match({ session_id: sessionId, jid });
  if (error) throw error;
}

export async function setChatArchived(sessionId, jid, archived) {
  const { error } = await supabase
    .from('wa_chats')
    .update({ archived, updated_at: new Date().toISOString() })
    .match({ session_id: sessionId, jid });
  if (error) throw error;
}

export async function setChatPinned(sessionId, jid, pinned) {
  const { error } = await supabase
    .from('wa_chats')
    .update({ pinned, updated_at: new Date().toISOString() })
    .match({ session_id: sessionId, jid });
  if (error) throw error;
}
