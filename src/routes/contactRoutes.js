import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import { listContacts, getContact, resolveDisplayName, refreshProfilePicture } from '../services/contactService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const data = await listContacts(req.params.sessionId, { limit: Number(limit) || 100, offset: Number(offset) || 0 });
    ok(res, data.map((c) => ({ ...c, displayName: resolveDisplayName(c) })));
  })
);

router.get(
  '/:jid',
  asyncHandler(async (req, res) => {
    const jid = toJid(req.params.jid);
    const contact = await getContact(req.params.sessionId, jid);
    if (!contact) throw new ApiError('Contact not found', 404);
    ok(res, { ...contact, displayName: resolveDisplayName(contact) });
  })
);

router.post(
  '/:jid/refresh-picture',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const url = await refreshProfilePicture(sock, req.params.sessionId, toJid(req.params.jid));
    ok(res, { imgUrl: url });
  })
);

export default router;
