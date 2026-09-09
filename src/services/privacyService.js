import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

/**
 * WhatsApp privacy categories exposed by Baileys' account.* API:
 *   last seen, online, profile photo, status, read receipts, groups add,
 *   calls, and "default disappearing messages" duration.
 */
export async function fetchAndCachePrivacySettings(sock, sessionId) {
  const settings = await sock.fetchPrivacySettings(true);
  const { error } = await supabase
    .from('wa_privacy_settings')
    .upsert({ session_id: sessionId, settings, updated_at: new Date().toISOString() }, { onConflict: 'session_id' });
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to cache privacy settings');
  return settings;
}

export async function getCachedPrivacySettings(sessionId) {
  const { data, error } = await supabase
    .from('wa_privacy_settings')
    .select('settings')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return data?.settings || null;
}

const SETTERS = {
  lastSeen: (sock, v) => sock.updateLastSeenPrivacy(v), // 'all' | 'contacts' | 'contact_blacklist' | 'none'
  online: (sock, v) => sock.updateOnlinePrivacy(v), // 'all' | 'match_last_seen'
  profilePicture: (sock, v) => sock.updateProfilePicturePrivacy(v), // 'all' | 'contacts' | 'contact_blacklist' | 'none'
  status: (sock, v) => sock.updateStatusPrivacy(v),
  readReceipts: (sock, v) => sock.updateReadReceiptsPrivacy(v), // 'all' | 'none'
  groupsAdd: (sock, v) => sock.updateGroupsAddPrivacy(v), // 'all' | 'contacts' | 'contact_blacklist' | 'none'
  defaultDisappearingMode: (sock, v) => sock.updateDefaultDisappearingMode(v), // seconds, e.g. 86400
};

export async function updatePrivacySetting(sock, sessionId, key, value) {
  const setter = SETTERS[key];
  if (!setter) throw new Error(`Unknown privacy setting: ${key}`);
  await setter(sock, value);
  return fetchAndCachePrivacySettings(sock, sessionId);
}

export async function blockContact(sock, jid) {
  await sock.updateBlockStatus(jid, 'block');
}

export async function unblockContact(sock, jid) {
  await sock.updateBlockStatus(jid, 'unblock');
}

export async function fetchBlocklist(sock) {
  return sock.fetchBlocklist();
}
