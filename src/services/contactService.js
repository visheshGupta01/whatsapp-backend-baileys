import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

/**
 * WhatsApp resolves a "display name" for a chat using this priority
 * (mirroring what WhatsApp Web/mobile itself does):
 *   1. A name YOU saved for them in your phone contacts (contact.name)
 *   2. Their business verified name (verifiedName), if it's a business
 *   3. The push name they broadcast on messages (notify / pushName)
 *   4. Fallback to the phone number
 * This is what gives you "person's saved name" instead of just a number.
 */
export function resolveDisplayName(contact) {
  if (!contact) return null;
  return (
    contact.name ||
    contact.short_name ||
    contact.verified_name ||
    contact.notify ||
    null
  );
}

export async function upsertContacts(sessionId, contacts) {
  if (!contacts?.length) return;
  const log = sessionLogger(sessionId);

  const rows = contacts
    .filter((c) => !!c.id)
    .map((c) => ({
      session_id: sessionId,
      jid: c.id,
      name: c.name ?? undefined,
      notify: c.notify ?? undefined,
      verified_name: c.verifiedName ?? undefined,
      short_name: c.shortName ?? undefined,
      is_business: c.isBusiness ?? undefined,
      is_enterprise: c.isEnterprise ?? undefined,
      status: c.status ?? undefined,
      last_synced_at: new Date().toISOString(),
    }))
    .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));

  if (!rows.length) return;

  const { error } = await supabase.from('wa_contacts').upsert(rows, { onConflict: 'session_id,jid' });
  if (error) log.error({ err: error }, 'failed to upsert contacts');
}

export async function updateContactProfilePic(sessionId, jid, imgUrl) {
  const { error } = await supabase
    .from('wa_contacts')
    .upsert(
      { session_id: sessionId, jid, img_url: imgUrl, last_synced_at: new Date().toISOString() },
      { onConflict: 'session_id,jid' }
    );
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to update profile pic');
}

export async function getContact(sessionId, jid) {
  const { data, error } = await supabase
    .from('wa_contacts')
    .select('*')
    .match({ session_id: sessionId, jid })
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listContacts(sessionId, { limit = 100, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('session_id', sessionId)
    .order('name', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

/** Fetch and cache a contact's profile picture URL via the live socket. */
export async function refreshProfilePicture(sock, sessionId, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    await updateContactProfilePic(sessionId, jid, url);
    return url;
  } catch {
    return null; // no picture set / privacy restricted
  }
}
