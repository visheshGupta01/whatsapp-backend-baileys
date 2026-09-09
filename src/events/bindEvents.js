import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';
import { upsertChats, markChatRead, touchChatLastMessage, deleteChat } from '../services/chatService.js';
import { upsertContacts, updateContactProfilePic } from '../services/contactService.js';
import { upsertGroupMetadata, syncGroupMetadata } from '../services/groupService.js';
import { persistMessage, updateMessageStatus } from '../services/messageService.js';
import { recordPresenceUpdate } from '../services/presenceService.js';
import { initHistorySyncState, handleHistorySyncChunk } from '../services/historySyncService.js';
import { env } from '../config/env.js';

/**
 * Binds every Baileys event we care about for one session's socket (`sock`)
 * to (a) Supabase persistence and (b) real-time Socket.IO emission so any
 * connected frontend gets live updates, exactly like WhatsApp Web itself.
 *
 * `emit(event, payload)` is provided by the socket gateway and broadcasts to
 * the room for this sessionId only (so 10 accounts never cross-talk).
 */
export function bindSessionEvents({ sessionId, sock, emit }) {
  const log = sessionLogger(sessionId);
  const { ev } = sock;

  // -------------------------------------------------------------------
  // CREDENTIALS — must be wired by the caller too (saveCreds), but we also
  // notify the frontend so a "linked" indicator can update instantly.
  // -------------------------------------------------------------------
  ev.on('creds.update', () => {
    emit('creds.update', { sessionId });
  });

  // -------------------------------------------------------------------
  // HISTORY SYNC — chats/contacts/messages delivered in chunks right after
  // linking (or on first reconnect after a gap). Runs fully in the
  // background; never blocks message send/receive.
  // -------------------------------------------------------------------
  ev.on('messaging-history.set', async (payload) => {
    const { chats, contacts, messages, isLatest, progress, syncType } = payload;
    try {
      await handleHistorySyncChunk({ sessionId, sock, chats, contacts, messages, isLatest, progress });
      emit('history.sync', {
        chatsCount: chats?.length || 0,
        contactsCount: contacts?.length || 0,
        messagesCount: messages?.length || 0,
        isLatest: !!isLatest,
        progress,
        syncType,
      });
    } catch (err) {
      log.error({ err }, 'error handling history sync chunk');
    }
  });

  // -------------------------------------------------------------------
  // CONTACTS
  // -------------------------------------------------------------------
  ev.on('contacts.upsert', async (contacts) => {
    await upsertContacts(sessionId, contacts);
    emit('contacts.upsert', contacts.map((c) => ({ id: c.id, name: c.name, notify: c.notify })));

    // Warm profile-picture cache in the background (rate-limited, best effort)
    for (const c of contacts) {
      sock.profilePictureUrl(c.id, 'image').then(
        (url) => updateContactProfilePic(sessionId, c.id, url),
        () => {}
      );
    }
  });

  ev.on('contacts.update', async (updates) => {
    await upsertContacts(sessionId, updates);
    emit('contacts.update', updates);
  });

  // -------------------------------------------------------------------
  // CHATS
  // -------------------------------------------------------------------
  ev.on('chats.upsert', async (chats) => {
    await upsertChats(sessionId, chats);
    emit('chats.upsert', chats);
  });

  ev.on('chats.update', async (updates) => {
    await upsertChats(sessionId, updates);
    emit('chats.update', updates);
    for (const u of updates) {
      if (u.unreadCount === 0) await markChatRead(sessionId, u.id, 0);
    }
  });

  ev.on('chats.delete', async (jids) => {
    for (const jid of jids) await deleteChat(sessionId, jid);
    emit('chats.delete', jids);
  });

  // -------------------------------------------------------------------
  // MESSAGES — the core of "just like WhatsApp": receive, persist, notify
  // -------------------------------------------------------------------
  ev.on('messages.upsert', async ({ messages, type }) => {
    // type: 'notify' (new realtime message) | 'append' (history/backfill)
    for (const message of messages) {
      if (!message.message) continue; // protocol/reaction-only stub, ignore
      try {
        const row = await persistMessage({ sessionId, sock, message });
        if (type === 'notify') {
          emit('messages.new', row);

          // Auto mark-as-read is opt-in (WhatsApp Web itself only reads when
          // the chat is actually open in a client) - left to the frontend by
          // default, but you can flip AUTO_MARK_ONLINE to mirror "always on".
          if (env.autoMarkOnline && !message.key.fromMe) {
            sock.readMessages([message.key]).catch(() => {});
          }
        }
      } catch (err) {
        log.error({ err, id: message.key?.id }, 'failed to process incoming message');
      }
    }
  });

  // message edits/deletes/reactions delivered as protocol messages
  ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status !== undefined) {
        await updateMessageStatus(sessionId, key.remoteJid, key.id, mapAckToStatus(update.status));
      }
      if (update.message === null) {
        await supabase
          .from('wa_messages')
          .update({ deleted_at: new Date().toISOString() })
          .match({ session_id: sessionId, id: key.id, chat_jid: key.remoteJid });
      }
    }
    emit('messages.update', updates);
  });

  ev.on('messages.delete', async (item) => {
    if ('keys' in item) {
      for (const key of item.keys) {
        await supabase
          .from('wa_messages')
          .update({ deleted_at: new Date().toISOString() })
          .match({ session_id: sessionId, id: key.id, chat_jid: key.remoteJid });
      }
    }
    emit('messages.delete', item);
  });

  ev.on('messages.reaction', (reactions) => {
    emit('messages.reaction', reactions);
  });

  ev.on('message-receipt.update', (updates) => {
    emit('message-receipt.update', updates);
  });

  // -------------------------------------------------------------------
  // GROUPS
  // -------------------------------------------------------------------
  ev.on('groups.upsert', async (groups) => {
    for (const g of groups) await upsertGroupMetadata(sessionId, g);
    emit('groups.upsert', groups);
  });

  ev.on('groups.update', async (updates) => {
    for (const g of updates) {
      if (g.id) {
        try {
          await syncGroupMetadata(sock, sessionId, g.id);
        } catch (err) {
          log.warn({ err, jid: g.id }, 'could not refresh full group metadata, storing partial update');
          await upsertGroupMetadata(sessionId, g);
        }
      }
    }
    emit('groups.update', updates);
  });

  ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      await syncGroupMetadata(sock, sessionId, id);
    } catch (err) {
      log.warn({ err, id }, 'failed to refresh group metadata after participant update');
    }
    emit('group-participants.update', { id, participants, action });
  });

  // -------------------------------------------------------------------
  // PRESENCE
  // -------------------------------------------------------------------
  ev.on('presence.update', async (update) => {
    await recordPresenceUpdate(sessionId, update);
    emit('presence.update', update);
  });

  // -------------------------------------------------------------------
  // BLOCKLIST / PRIVACY-ADJACENT
  // -------------------------------------------------------------------
  ev.on('blocklist.set', (data) => emit('blocklist.set', data));
  ev.on('blocklist.update', (data) => emit('blocklist.update', data));

  // -------------------------------------------------------------------
  // LABELS (WhatsApp Business chat/message labels, if the account has them)
  // -------------------------------------------------------------------
  ev.on('labels.edit', (label) => emit('labels.edit', label));
  ev.on('labels.association', (assoc) => emit('labels.association', assoc));
}

function mapAckToStatus(ack) {
  // Baileys WAMessageStatus: ERROR=-1, PENDING=0, SERVER_ACK=1, DELIVERY_ACK=2, READ=3, PLAYED=4
  switch (ack) {
    case -1:
      return 'failed';
    case 0:
      return 'pending';
    case 1:
      return 'sent';
    case 2:
      return 'delivered';
    case 3:
      return 'read';
    case 4:
      return 'played';
    default:
      return 'pending';
  }
}
