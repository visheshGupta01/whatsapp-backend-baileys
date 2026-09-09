import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import {
  sendText,
  sendMedia,
  sendLocation,
  sendContact,
  sendPoll,
  sendButtons,
  sendList,
  reactToMessage,
  deleteMessageForEveryone,
  editMessage,
  starMessage,
  markMessagesRead,
  listMessages,
  searchMessages,
} from '../services/messageService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

// ---- send ------------------------------------------------------------
router.post(
  '/text',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, text, quoted, mentions } = req.body;
    if (!to || !text) throw new ApiError('`to` and `text` are required');
    const msg = await sendText(sock, req.params.sessionId, to, text, { quoted, mentions });
    ok(res, msg, 201);
  })
);

router.post(
  '/media',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, type, source, mimetype, fileName, caption, ptt, gifPlayback, quoted } = req.body;
    if (!to || !type || !source) throw new ApiError('`to`, `type`, and `source` are required');
    const msg = await sendMedia(sock, req.params.sessionId, to, {
      type,
      source,
      mimetype,
      fileName,
      caption,
      ptt,
      gifPlayback,
      quoted,
    });
    ok(res, msg, 201);
  })
);

router.post(
  '/location',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || latitude === undefined || longitude === undefined) {
      throw new ApiError('`to`, `latitude`, and `longitude` are required');
    }
    const msg = await sendLocation(sock, req.params.sessionId, to, { latitude, longitude, name, address });
    ok(res, msg, 201);
  })
);

router.post(
  '/contact',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, displayName, vcard } = req.body;
    if (!to || !vcard) throw new ApiError('`to` and `vcard` are required');
    const msg = await sendContact(sock, req.params.sessionId, to, { displayName, vcard });
    ok(res, msg, 201);
  })
);

router.post(
  '/poll',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, name, values, selectableCount } = req.body;
    if (!to || !name || !values?.length) throw new ApiError('`to`, `name`, and `values[]` are required');
    const msg = await sendPoll(sock, req.params.sessionId, to, { name, values, selectableCount });
    ok(res, msg, 201);
  })
);

router.post(
  '/buttons',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, text, footer, buttons } = req.body;
    if (!to || !text || !buttons?.length) throw new ApiError('`to`, `text`, and `buttons[]` are required');
    const msg = await sendButtons(sock, req.params.sessionId, to, { text, footer, buttons });
    ok(res, msg, 201);
  })
);

router.post(
  '/list',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { to, text, footer, title, buttonText, sections } = req.body;
    if (!to || !sections?.length) throw new ApiError('`to` and `sections[]` are required');
    const msg = await sendList(sock, req.params.sessionId, to, { text, footer, title, buttonText, sections });
    ok(res, msg, 201);
  })
);

// ---- read/query --------------------------------------------------------
router.get(
  '/:chatJid',
  asyncHandler(async (req, res) => {
    const { sessionId, chatJid } = req.params;
    const { limit, before } = req.query;
    const data = await listMessages(sessionId, toJid(chatJid), { limit: Number(limit) || 50, before });
    ok(res, data);
  })
);

router.get(
  '/search/:query',
  asyncHandler(async (req, res) => {
    const data = await searchMessages(req.params.sessionId, req.params.query, { limit: Number(req.query.limit) || 50 });
    ok(res, data);
  })
);

router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { keys } = req.body; // [{ remoteJid, id, fromMe, participant? }]
    if (!keys?.length) throw new ApiError('`keys[]` is required');
    await markMessagesRead(sock, req.params.sessionId, keys);
    ok(res, { read: true });
  })
);

// ---- actions ------------------------------------------------------------
router.post(
  '/:chatJid/:messageId/react',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { chatJid, messageId } = req.params;
    const { emoji, fromMe = true, participant } = req.body;
    await reactToMessage(sock, req.params.sessionId, toJid(chatJid), {
      id: messageId,
      remoteJid: toJid(chatJid),
      fromMe,
      participant,
    }, emoji);
    ok(res, { reacted: true });
  })
);

router.delete(
  '/:chatJid/:messageId',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { chatJid, messageId } = req.params;
    const { fromMe = true, participant } = req.body;
    await deleteMessageForEveryone(sock, req.params.sessionId, toJid(chatJid), {
      id: messageId,
      remoteJid: toJid(chatJid),
      fromMe,
      participant,
    });
    ok(res, { deleted: true });
  })
);

router.patch(
  '/:chatJid/:messageId',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { chatJid, messageId } = req.params;
    const { text, fromMe = true } = req.body;
    if (!text) throw new ApiError('`text` is required');
    const msg = await editMessage(sock, req.params.sessionId, toJid(chatJid), {
      id: messageId,
      remoteJid: toJid(chatJid),
      fromMe,
    }, text);
    ok(res, msg);
  })
);

router.post(
  '/:chatJid/:messageId/star',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { chatJid, messageId } = req.params;
    const { fromMe = true, star = true } = req.body;
    await starMessage(sock, req.params.sessionId, toJid(chatJid), { id: messageId, fromMe }, star);
    ok(res, { starred: star });
  })
);

export default router;
