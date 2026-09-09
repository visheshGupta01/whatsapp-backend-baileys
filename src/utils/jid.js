import { jidNormalizedUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, jidDecode } from 'baileys';

/**
 * Accepts a phone number ("919999999999"), a bare JID, or an already
 * well-formed JID and returns a normalized `<number>@s.whatsapp.net` /
 * `<id>@g.us` JID that Baileys expects everywhere.
 */
export function toJid(input) {
  if (!input) return input;
  const str = String(input).trim();
  if (str.includes('@')) return jidNormalizedUser(str);
  const digits = str.replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

export function isGroupJid(jid) {
  return isJidGroup(jid);
}

export function isUserJid(jid) {
  const decoded = jidDecode(jid);
  return decoded?.server === 's.whatsapp.net' || decoded?.server === 'lid';
}

export function isBroadcastJid(jid) {
  return isJidBroadcast(jid) || isJidStatusBroadcast(jid);
}

export function jidToPhoneNumber(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}
