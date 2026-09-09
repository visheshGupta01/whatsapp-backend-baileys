import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import { checkNumbersOnWhatsApp, fetchStatus } from '../services/usyncService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

// Bulk-check whether numbers are registered on WhatsApp before you try to
// message them - avoids wasted sends and lets the UI show "not on WhatsApp".
router.post(
  '/check-numbers',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { numbers } = req.body;
    if (!numbers?.length) throw new ApiError('`numbers[]` is required');
    const results = await checkNumbersOnWhatsApp(sock, req.params.sessionId, numbers);
    ok(res, results);
  })
);

router.get(
  '/status/:jid',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const status = await fetchStatus(sock, toJid(req.params.jid));
    ok(res, { status });
  })
);

export default router;
