import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';
import { upsertChats } from './chatService.js';
import { upsertContacts } from './contactService.js';
import { persistMessage } from './messageService.js';

/**
 * WhatsApp pushes chat/contact/message history in chunks after linking
 * (`messaging-history.set` events). This can be a LOT of data for accounts
 * with years of history, so we:
 *   - process each chunk as it arrives (never block the socket event loop
 *     waiting on the *entire* history)
 *   - persist progress so the app/UI can show "syncing 42%..."
 *   - never re-request full history on every reconnect (Baileys only sends
 *     it once per fresh login unless syncFullHistory is forced)
 */
export async function initHistorySyncState(sessionId) {
  await supabase.from('wa_history_sync_state').upsert(
    { session_id: sessionId, is_syncing: true, progress: 0, chunks_received: 0, completed_at: null },
    { onConflict: 'session_id' }
  );
}

export async function handleHistorySyncChunk({ sessionId, sock, chats, contacts, messages, isLatest, progress }) {
  const log = sessionLogger(sessionId);
  log.info(
    { chats: chats?.length || 0, contacts: contacts?.length || 0, messages: messages?.length || 0, isLatest, progress },
    'history sync chunk received'
  );

  // Fire these concurrently but don't let one slow type block the others.
  await Promise.allSettled([
    upsertChats(sessionId, chats || []),
    upsertContacts(sessionId, contacts || []),
    persistMessagesInBackground(sessionId, sock, messages || []),
  ]);

  const { data: current } = await supabase
    .from('wa_history_sync_state')
    .select('chunks_received')
    .eq('session_id', sessionId)
    .maybeSingle();

  await supabase.from('wa_history_sync_state').upsert(
    {
      session_id: sessionId,
      is_syncing: !isLatest,
      progress: progress ?? undefined,
      chunks_received: (current?.chunks_received || 0) + 1,
      is_latest: !!isLatest,
      last_chunk_at: new Date().toISOString(),
      completed_at: isLatest ? new Date().toISOString() : null,
    },
    { onConflict: 'session_id' }
  );
}

/**
 * Message history can be huge (thousands of rows); persist it in small
 * batches on a background microtask queue so we never block the Baileys
 * event loop or overwhelm Supabase with one giant insert.
 */
async function persistMessagesInBackground(sessionId, sock, messages) {
  const BATCH = 25;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    await Promise.allSettled(batch.map((m) => persistMessage({ sessionId, sock, message: m })));
    // yield back to the event loop between batches
    await new Promise((r) => setImmediate(r));
  }
}

export async function getHistorySyncState(sessionId) {
  const { data, error } = await supabase
    .from('wa_history_sync_state')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
