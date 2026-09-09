import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import { listChats, deleteChat, setChatArchived, setChatPinned } from '../services/chatService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset, archived } = req.query;
    const data = await listChats(req.params.sessionId, {
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
      archived: archived === undefined ? undefined : archived === 'true',
    });
    ok(res, data);
  })
);

router.patch(
  '/:chatJid/archive',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const jid = toJid(req.params.chatJid);
    const archived = !!req.body.archived;
    await sock.chatModify({ archive: archived, lastMessages: req.body.lastMessages || [] }, jid);
    await setChatArchived(req.params.sessionId, jid, archived);
    ok(res, { archived });
  })
);

router.patch(
  '/:chatJid/pin',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const jid = toJid(req.params.chatJid);
    const pinned = !!req.body.pinned;
    await sock.chatModify({ pin: pinned }, jid);
    await setChatPinned(req.params.sessionId, jid, pinned);
    ok(res, { pinned });
  })
);

router.patch(
  '/:chatJid/mute',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const jid = toJid(req.params.chatJid);
    const { muteEndTimeMs } = req.body; // null/0 to unmute, or epoch ms in the future
    await sock.chatModify({ mute: muteEndTimeMs || null }, jid);
    ok(res, { muted: !!muteEndTimeMs });
  })
);

router.delete(
  '/:chatJid',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const jid = toJid(req.params.chatJid);
    await sock.chatModify({ delete: true, lastMessages: req.body.lastMessages || [] }, jid);
    await deleteChat(req.params.sessionId, jid);
    ok(res, { deleted: true });
  })
);

router.post(
  '/:chatJid/presence-subscribe',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    await sock.presenceSubscribe(toJid(req.params.chatJid));
    ok(res, { subscribed: true });
  })
);

router.post(
  '/:chatJid/presence',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { presence = 'available' } = req.body; // available|unavailable|composing|recording|paused
    await sock.sendPresenceUpdate(presence, toJid(req.params.chatJid));
    ok(res, { presence });
  })
);

export default router;
