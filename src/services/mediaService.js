import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadMediaMessage } from 'baileys';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import { sessionLogger } from '../config/logger.js';

const MEDIA_TYPE_BY_MSG_KEY = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
};

export function extractMediaMeta(message) {
  const content = message.message || {};
  for (const key of Object.keys(MEDIA_TYPE_BY_MSG_KEY)) {
    if (content[key]) {
      const m = content[key];
      const isPtt = key === 'audioMessage' && m.ptt;
      return {
        type: isPtt ? 'ptt' : MEDIA_TYPE_BY_MSG_KEY[key],
        mimetype: m.mimetype,
        fileName: m.fileName,
        caption: m.caption,
        seconds: m.seconds,
        width: m.width,
        height: m.height,
        fileLength: m.fileLength ? Number(m.fileLength) : undefined,
      };
    }
  }
  return null;
}

function sessionDir(sessionId) {
  return path.join(env.mediaLocalPath, sessionId);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * Downloads media from a WAMessage, writes it to local disk under
 * storage/media/<sessionId>/<yyyy-mm-dd>/<uuid>.<ext>, optionally mirrors
 * to Supabase Storage, and records metadata in wa_media. Handles retryable
 * decrypt failures by re-fetching via the message key when needed.
 */
export async function persistIncomingMedia({ sessionId, sock, message, chatJid }) {
  const log = sessionLogger(sessionId);
  const meta = extractMediaMeta(message);
  if (!meta) return null;

  let buffer;
  try {
    buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: log,
        reuploadRequest: sock.updateMediaMessage,
      }
    );
  } catch (err) {
    log.error({ err, id: message.key?.id }, 'media download failed');
    return null;
  }

  if (buffer.length > env.mediaMaxSizeMb * 1024 * 1024) {
    log.warn({ id: message.key?.id, size: buffer.length }, 'media exceeds max size, skipping persist');
    return null;
  }

  const ext = mime.extension(meta.mimetype) || 'bin';
  const dateFolder = new Date().toISOString().slice(0, 10);
  const dir = path.join(sessionDir(sessionId), dateFolder);
  await ensureDir(dir);

  const fileId = uuidv4();
  const fileName = meta.fileName ? `${fileId}-${meta.fileName}` : `${fileId}.${ext}`;
  const fullPath = path.join(dir, fileName);
  await fsp.writeFile(fullPath, buffer);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  let storageUrl = null;
  if (env.mediaUploadToSupabase) {
    storageUrl = await uploadToSupabaseStorage({
      sessionId,
      localPath: fullPath,
      buffer,
      mimetype: meta.mimetype,
      fileName,
    });
  }

  const { data, error } = await supabase
    .from('wa_media')
    .insert({
      session_id: sessionId,
      message_id: message.key?.id,
      chat_jid: chatJid,
      media_type: meta.type,
      mime_type: meta.mimetype,
      file_name: meta.fileName || fileName,
      file_size: buffer.length,
      width: meta.width,
      height: meta.height,
      duration_seconds: meta.seconds,
      storage_path: fullPath,
      storage_url: storageUrl,
      sha256,
      caption: meta.caption,
    })
    .select()
    .single();

  if (error) {
    log.error({ err: error }, 'failed to record media metadata');
    return null;
  }

  log.info({ mediaId: data.id, type: meta.type, size: buffer.length }, 'media persisted');
  return data;
}

async function uploadToSupabaseStorage({ sessionId, buffer, mimetype, fileName }) {
  const objectPath = `${sessionId}/${new Date().toISOString().slice(0, 10)}/${fileName}`;
  const { error } = await supabase.storage
    .from(env.supabaseMediaBucket)
    .upload(objectPath, buffer, { contentType: mimetype, upsert: true });

  if (error) {
    sessionLogger(sessionId).error({ err: error }, 'supabase storage upload failed');
    return null;
  }

  const { data } = supabase.storage.from(env.supabaseMediaBucket).getPublicUrl(objectPath);
  return data?.publicUrl || null;
}

/** Read a previously persisted media file back off local disk as a stream. */
export function readMediaStream(storagePath) {
  return fs.createReadStream(storagePath);
}

export async function getMediaById(sessionId, mediaId) {
  const { data, error } = await supabase
    .from('wa_media')
    .select('*')
    .eq('session_id', sessionId)
    .eq('id', mediaId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Prepares an outgoing media payload for sock.sendMessage() from a local
 * file path, remote URL, or base64 string — used by the send-media route.
 */
export function buildOutgoingMediaContent({ type, source, mimetype, fileName, caption, ptt, gifPlayback }) {
  let mediaRef;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    mediaRef = { url: source };
  } else if (source.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(source.slice(0, 50)) === false) {
    mediaRef = { url: source }; // local path fallback
  } else {
    mediaRef = { buffer: Buffer.from(source, 'base64') };
  }

  switch (type) {
    case 'image':
      return { image: mediaRef, caption, mimetype };
    case 'video':
      return { video: mediaRef, caption, mimetype, gifPlayback: !!gifPlayback };
    case 'audio':
      return { audio: mediaRef, mimetype: mimetype || 'audio/mp4', ptt: !!ptt };
    case 'document':
      return { document: mediaRef, mimetype, fileName };
    case 'sticker':
      return { sticker: mediaRef };
    default:
      throw new Error(`Unsupported media type: ${type}`);
  }
}
