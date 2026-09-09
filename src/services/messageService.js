import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';
import { toJid } from '../utils/jid.js';
import { buildOutgoingMediaContent, persistIncomingMedia, extractMediaMeta } from './mediaService.js';
import { touchChatLastMessage } from './chatService.js';

function tsToIso(ts) {
  const n = typeof ts === 'object' && ts?.toNumber ? ts.toNumber() : Number(ts);
  return n ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

/** Pulls a flat, searchable text body out of any message type. */
export function flattenText(content) {
  if (!content) return null;
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedId ||
    content.pollCreationMessage?.name ||
    null
  );
}

function detectMessageType(content) {
  if (!content) return 'unknown';
  const keys = Object.keys(content);
  return keys.find((k) => k !== 'messageContextInfo') || 'unknown';
}

/**
 * Persists an inbound or outbound WAMessage into wa_messages, downloading +
 * storing media as needed. Called from the messages.upsert handler and from
 * our own send helpers (so sent messages show up immediately too).
 */
export async function persistMessage({ sessionId, sock, message }) {
  const log = sessionLogger(sessionId);
  const chatJid = message.key.remoteJid;
  const msgType = detectMessageType(message.message);
  const textBody = flattenText(message.message);

  let mediaRow = null;
  if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(msgType)) {
    mediaRow = await persistIncomingMedia({ sessionId, sock, message, chatJid }).catch((err) => {
      log.error({ err }, 'media persistence failed, continuing without it');
      return null;
    });
  }

  const row = {
    session_id: sessionId,
    id: message.key.id,
    chat_jid: chatJid,
    sender_jid: message.key.participant || (message.key.fromMe ? undefined : chatJid),
    from_me: !!message.key.fromMe,
    message_type: msgType,
    content: sanitizeContent(message.message),
    text_body: textBody,
    media_id: mediaRow?.id || null,
    quoted_message_id:
      message.message?.extendedTextMessage?.contextInfo?.stanzaId ||
      message.message?.imageMessage?.contextInfo?.stanzaId ||
      null,
    mentions: extractMentions(message.message),
    status: message.key.fromMe ? 'sent' : 'delivered',
    timestamp: tsToIso(message.messageTimestamp),
    raw: sanitizeContent(message),
  };

  const { error } = await supabase.from('wa_messages').upsert(row, { onConflict: 'session_id,id,chat_jid' });
  if (error) log.error({ err: error }, 'failed to persist message');

  await touchChatLastMessage(sessionId, chatJid, message.key.id, row.timestamp);

  return row;
}

/** Strip large/binary fields before storing raw content as JSONB. */
function sanitizeContent(obj) {
  if (!obj) return obj;
  const clone = JSON.parse(
    JSON.stringify(obj, (key, value) => {
      if (key === 'mediaKey' || key === 'fileEncSha256' || key === 'fileSha256' || key === 'jpegThumbnail') {
        return undefined; // drop binary buffers, keep the row light
      }
      if (value?.type === 'Buffer') return undefined;
      return value;
    })
  );
  return clone;
}

function extractMentions(content) {
  const ctx =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo;
  return ctx?.mentionedJid || null;
}

// ---------------------------------------------------------------------------
// SENDING — every message type
// ---------------------------------------------------------------------------

export async function sendText(sock, sessionId, to, text, { quoted, mentions } = {}) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { text, mentions }, { quoted });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendMedia(sock, sessionId, to, opts) {
  const jid = toJid(to);
  const content = buildOutgoingMediaContent(opts);
  const msg = await sock.sendMessage(jid, content, { quoted: opts.quoted });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendLocation(sock, sessionId, to, { latitude, longitude, name, address }) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address } });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendContact(sock, sessionId, to, { displayName, vcard }) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { contacts: { displayName, contacts: [{ vcard }] } });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendPoll(sock, sessionId, to, { name, values, selectableCount = 1 }) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { poll: { name, values, selectableCount } });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendButtons(sock, sessionId, to, { text, footer, buttons }) {
  const jid = toJid(to);
  // buttons: [{ buttonId, buttonText: { displayText }, type: 1 }]
  const msg = await sock.sendMessage(jid, { text, footer, buttons, headerType: 1 });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function sendList(sock, sessionId, to, { text, footer, title, buttonText, sections }) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { text, footer, title, buttonText, sections });
  return persistMessage({ sessionId, sock, message: msg });
}

export async function forwardMessage(sock, sessionId, to, messageToForward) {
  const jid = toJid(to);
  const msg = await sock.sendMessage(jid, { forward: messageToForward });
  return persistMessage({ sessionId, sock, message: msg });
}

// ---------------------------------------------------------------------------
// MESSAGE ACTIONS — react, delete, edit, star
// ---------------------------------------------------------------------------

export async function reactToMessage(sock, sessionId, chatJid, messageKey, emoji) {
  await sock.sendMessage(chatJid, { react: { text: emoji, key: messageKey } });
  await logAction(sessionId, chatJid, messageKey.id, 'reaction', { emoji });
}

/** Delete for everyone (revoke) — only works on your own messages within WA's time window. */
export async function deleteMessageForEveryone(sock, sessionId, chatJid, messageKey) {
  await sock.sendMessage(chatJid, { delete: messageKey });
  await supabase
    .from('wa_messages')
    .update({ deleted_at: new Date().toISOString() })
    .match({ session_id: sessionId, id: messageKey.id, chat_jid: chatJid });
  await logAction(sessionId, chatJid, messageKey.id, 'delete', {});
}

export async function editMessage(sock, sessionId, chatJid, messageKey, newText) {
  const msg = await sock.sendMessage(chatJid, { text: newText, edit: messageKey });
  await supabase
    .from('wa_messages')
    .update({ text_body: newText, edited_at: new Date().toISOString() })
    .match({ session_id: sessionId, id: messageKey.id, chat_jid: chatJid });
  await logAction(sessionId, chatJid, messageKey.id, 'edit', { newText });
  return msg;
}

export async function starMessage(sock, sessionId, chatJid, messageKey, star = true) {
  await sock.chatModify(
    { star: { messages: [{ id: messageKey.id, fromMe: messageKey.fromMe }], star } },
    chatJid
  );
  await supabase.from('wa_messages').update({ starred: star }).match({ session_id: sessionId, id: messageKey.id, chat_jid: chatJid });
  await logAction(sessionId, chatJid, messageKey.id, star ? 'star' : 'unstar', {});
}

export async function markMessagesRead(sock, sessionId, keys) {
  await sock.readMessages(keys);
  const ids = keys.map((k) => k.id);
  await supabase.from('wa_messages').update({ status: 'read' }).eq('session_id', sessionId).in('id', ids);
}

async function logAction(sessionId, chatJid, messageId, actionType, payload) {
  const { error } = await supabase.from('wa_message_actions').insert({
    session_id: sessionId,
    chat_jid: chatJid,
    message_id: messageId,
    action_type: actionType,
    payload,
  });
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to log message action');
}

// ---------------------------------------------------------------------------
// QUERIES
// ---------------------------------------------------------------------------

export async function listMessages(sessionId, chatJid, { limit = 50, before } = {}) {
  let q = supabase
    .from('wa_messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('chat_jid', chatJid)
    .order('timestamp', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('timestamp', before);
  const { data, error } = await q;
  if (error) throw error;
  return data.reverse();
}

export async function searchMessages(sessionId, query, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('wa_messages')
    .select('*')
    .eq('session_id', sessionId)
    .textSearch('text_body', query, { type: 'plain' })
    .order('timestamp', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export function updateMessageStatus(sessionId, chatJid, messageId, status) {
  return supabase.from('wa_messages').update({ status }).match({ session_id: sessionId, id: messageId, chat_jid: chatJid });
}
