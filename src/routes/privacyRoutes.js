import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import {
  getCachedPrivacySettings,
  fetchAndCachePrivacySettings,
  updatePrivacySetting,
  blockContact,
  unblockContact,
  fetchBlocklist,
} from '../services/privacyService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const cached = await getCachedPrivacySettings(req.params.sessionId);
    ok(res, cached);
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const settings = await fetchAndCachePrivacySettings(sock, req.params.sessionId);
    ok(res, settings);
  })
);

router.patch(
  '/:key',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { value } = req.body;
    if (value === undefined) throw new ApiError('`value` is required');
    const settings = await updatePrivacySetting(sock, req.params.sessionId, req.params.key, value);
    ok(res, settings);
  })
);

router.get(
  '/blocklist',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    ok(res, await fetchBlocklist(sock));
  })
);

router.post(
  '/blocklist/:jid/block',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    await blockContact(sock, toJid(req.params.jid));
    ok(res, { blocked: true });
  })
);

router.post(
  '/blocklist/:jid/unblock',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    await unblockContact(sock, toJid(req.params.jid));
    ok(res, { blocked: false });
  })
);

export default router;
