import { toJid } from '../utils/jid.js';
import { sessionLogger } from '../config/logger.js';

/**
 * USync ("user sync") is the WhatsApp protocol query used to check, in bulk,
 * whether phone numbers are registered on WhatsApp, resolve their JIDs/LIDs,
 * and fetch lightweight profile info without opening a chat. Baileys exposes
 * the common case via `sock.onWhatsApp()`, which is backed by a USync query
 * under the hood. We wrap it here so the rest of the app has one place to
 * validate numbers before sending (avoids wasted sends to non-WA numbers).
 */
export async function checkNumbersOnWhatsApp(sock, sessionId, numbers) {
  const log = sessionLogger(sessionId);
  const jids = numbers.map(toJid);
  try {
    const results = await sock.onWhatsApp(...jids);
    // results: [{ jid, exists, lid? }]
    return results;
  } catch (err) {
    log.error({ err }, 'usync onWhatsApp query failed');
    throw err;
  }
}

/** Convenience: returns just the valid, WhatsApp-normalized JID or null. */
export async function resolveValidJid(sock, sessionId, numberOrJid) {
  const [result] = await checkNumbersOnWhatsApp(sock, sessionId, [numberOrJid]);
  return result?.exists ? result.jid : null;
}

/** Fetch the "status" (about text) for a JID — also served over USync/IQ. */
export async function fetchStatus(sock, jid) {
  try {
    const res = await sock.fetchStatus(jid);
    return res?.status ?? null;
  } catch {
    return null;
  }
}
