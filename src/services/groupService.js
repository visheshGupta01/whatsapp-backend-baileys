import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';
import { toJid } from '../utils/jid.js';

function mapParticipants(participants = []) {
  return participants.map((p) => ({
    jid: p.id,
    admin: p.admin || null, // 'admin' | 'superadmin' | null
  }));
}

export async function upsertGroupMetadata(sessionId, meta) {
  if (!meta?.id) return;
  const { error } = await supabase.from('wa_groups').upsert(
    {
      session_id: sessionId,
      jid: meta.id,
      subject: meta.subject,
      description: meta.desc || null,
      owner_jid: meta.owner || null,
      creation_ts: meta.creation ? new Date(meta.creation * 1000).toISOString() : null,
      participants: mapParticipants(meta.participants),
      restrict_mode: !!meta.restrict,
      announce_mode: !!meta.announce,
      is_community: !!meta.isCommunity,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'session_id,jid' }
  );
  if (error) sessionLogger(sessionId).error({ err: error }, 'failed to upsert group metadata');
}

/** Pulls full metadata from WhatsApp and syncs it to the DB. */
export async function syncGroupMetadata(sock, sessionId, groupJid) {
  const meta = await sock.groupMetadata(groupJid);
  await upsertGroupMetadata(sessionId, meta);
  return meta;
}

export async function listGroups(sessionId) {
  const { data, error } = await supabase.from('wa_groups').select('*').eq('session_id', sessionId);
  if (error) throw error;
  return data;
}

export async function createGroup(sock, sessionId, subject, participantJids) {
  const participants = participantJids.map(toJid);
  const meta = await sock.groupCreate(subject, participants);
  await upsertGroupMetadata(sessionId, meta);
  return meta;
}

export async function addParticipants(sock, sessionId, groupJid, participantJids) {
  const result = await sock.groupParticipantsUpdate(groupJid, participantJids.map(toJid), 'add');
  await syncGroupMetadata(sock, sessionId, groupJid);
  return result;
}

export async function removeParticipants(sock, sessionId, groupJid, participantJids) {
  const result = await sock.groupParticipantsUpdate(groupJid, participantJids.map(toJid), 'remove');
  await syncGroupMetadata(sock, sessionId, groupJid);
  return result;
}

export async function promoteParticipants(sock, sessionId, groupJid, participantJids) {
  const result = await sock.groupParticipantsUpdate(groupJid, participantJids.map(toJid), 'promote');
  await syncGroupMetadata(sock, sessionId, groupJid);
  return result;
}

export async function demoteParticipants(sock, sessionId, groupJid, participantJids) {
  const result = await sock.groupParticipantsUpdate(groupJid, participantJids.map(toJid), 'demote');
  await syncGroupMetadata(sock, sessionId, groupJid);
  return result;
}

export async function updateGroupSubject(sock, sessionId, groupJid, subject) {
  await sock.groupUpdateSubject(groupJid, subject);
  await syncGroupMetadata(sock, sessionId, groupJid);
}

export async function updateGroupDescription(sock, sessionId, groupJid, description) {
  await sock.groupUpdateDescription(groupJid, description);
  await syncGroupMetadata(sock, sessionId, groupJid);
}

export async function updateGroupSettings(sock, sessionId, groupJid, setting) {
  // setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'
  await sock.groupSettingUpdate(groupJid, setting);
  await syncGroupMetadata(sock, sessionId, groupJid);
}

export async function leaveGroup(sock, sessionId, groupJid) {
  await sock.groupLeave(groupJid);
  await supabase.from('wa_groups').delete().match({ session_id: sessionId, jid: groupJid });
}

export async function getInviteCode(sock, groupJid) {
  return sock.groupInviteCode(groupJid);
}

export async function revokeInviteCode(sock, sessionId, groupJid) {
  const code = await sock.groupRevokeInvite(groupJid);
  await syncGroupMetadata(sock, sessionId, groupJid);
  return code;
}

export async function joinGroupViaInvite(sock, code) {
  return sock.groupAcceptInvite(code);
}
