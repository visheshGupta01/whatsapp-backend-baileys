import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

/**
 * Baileys' signal protocol needs to persist:
 *   - `creds`            a single JSON blob (identity keys, registration info, etc.)
 *   - `keys`              a large, ever-growing keyed store (pre-keys, sessions,
 *                          sender-keys, app-state-sync-keys...) addressed by (type, id)
 *
 * useMultiFileAuthState() (the default helper) does this with one JSON file per
 * key on local disk. That's fine for a single box, but it means:
 *   - session is lost on redeploy/ephemeral filesystems (Heroku, containers, etc.)
 *   - you can't run more than one instance / can't move a session between machines
 *   - no natural place to observe "this session is stuck logged-out"
 *
 * This module gives Baileys the exact same `{ state, saveCreds }` shape but
 * persists everything to Supabase Postgres instead, so:
 *   - the user only ever scans the QR ONCE — creds survive restarts/redeploys
 *   - multiple sessions (10 accounts) live safely side by side, keyed by session_id
 *   - you get a durable audit trail of the auth state changing
 *
 * IMPORTANT: keys are stored using Baileys' own BufferJSON (de)serializer so
 * Buffers/Uint8Arrays round-trip correctly through JSONB.
 */

const serialize = (data) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));
const deserialize = (data) => JSON.parse(JSON.stringify(data), BufferJSON.reviver);

export async function useSupabaseAuthState(sessionId) {
  const log = sessionLogger(sessionId);

  // --- creds -----------------------------------------------------------
  async function readCreds() {
    const { data, error } = await supabase
      .from('wa_auth_creds')
      .select('creds')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error) {
      log.error({ err: error }, 'failed to read auth creds from supabase');
      return null;
    }
    return data?.creds ? deserialize(data.creds) : null;
  }

  async function writeCreds(creds) {
    const { error } = await supabase
      .from('wa_auth_creds')
      .upsert(
        { session_id: sessionId, creds: serialize(creds), updated_at: new Date().toISOString() },
        { onConflict: 'session_id' }
      );
    if (error) log.error({ err: error }, 'failed to persist auth creds');
  }

  // --- keys --------------------------------------------------------------
  async function getKeys(type, ids) {
    if (!ids.length) return {};
    const { data, error } = await supabase
      .from('wa_auth_keys')
      .select('key_id, value')
      .eq('session_id', sessionId)
      .eq('key_type', type)
      .in('key_id', ids);

    if (error) {
      log.error({ err: error, type }, 'failed to read auth keys');
      return {};
    }

    const result = {};
    for (const row of data || []) {
      let value = deserialize(row.value);
      if (type === 'app-state-sync-key' && value) {
        // Baileys expects this specific proto class for app-state-sync-key
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }
      result[row.key_id] = value;
    }
    return result;
  }

  async function setKeys(data) {
    const upserts = [];
    const deletes = [];

    for (const type of Object.keys(data)) {
      for (const id of Object.keys(data[type])) {
        const value = data[type][id];
        if (value) {
          upserts.push({
            session_id: sessionId,
            key_type: type,
            key_id: id,
            value: serialize(value),
            updated_at: new Date().toISOString(),
          });
        } else {
          deletes.push({ type, id });
        }
      }
    }

    if (upserts.length) {
      const { error } = await supabase
        .from('wa_auth_keys')
        .upsert(upserts, { onConflict: 'session_id,key_type,key_id' });
      if (error) log.error({ err: error }, 'failed to upsert auth keys');
    }

    for (const { type, id } of deletes) {
      const { error } = await supabase
        .from('wa_auth_keys')
        .delete()
        .match({ session_id: sessionId, key_type: type, key_id: id });
      if (error) log.error({ err: error, type, id }, 'failed to delete auth key');
    }
  }

  const existingCreds = await readCreds();
  const creds = existingCreds || initAuthCreds();
  if (!existingCreds) await writeCreds(creds);

  return {
    state: {
      creds,
      keys: {
        get: getKeys,
        set: setKeys,
      },
    },
    saveCreds: () => writeCreds(creds),
    /** Wipe everything for this session — call on explicit logout only. */
    clearState: async () => {
      await supabase.from('wa_auth_keys').delete().eq('session_id', sessionId);
      await supabase.from('wa_auth_creds').delete().eq('session_id', sessionId);
    },
  };
}
