import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, fail, ApiError } from '../utils/response.js';
import {
  startSession,
  getSessionRow,
  listSessionRows,
  logoutSession,
  stopSession,
  isSessionActive,
} from '../services/sessionManager.js';
import { getHistorySyncState } from '../services/historySyncService.js';

const router = Router();

// Create (or resume) a session. If credentials already exist, this reconnects
// silently with no QR; otherwise a QR is emitted over Socket.IO on the
// `session:<id>` room and also returned here once generated (poll GET /qr).
router.post(
  '/:sessionId',
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    await startSession(sessionId);
    const row = await getSessionRow(sessionId);
    ok(res, row, 201);
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listSessionRows();
    ok(res, rows);
  })
);

router.get(
  '/:sessionId',
  asyncHandler(async (req, res) => {
    const row = await getSessionRow(req.params.sessionId);
    if (!row) throw new ApiError('Session not found', 404);
    ok(res, { ...row, isActive: isSessionActive(req.params.sessionId) });
  })
);

router.get(
  '/:sessionId/qr',
  asyncHandler(async (req, res) => {
    const row = await getSessionRow(req.params.sessionId);
    if (!row) throw new ApiError('Session not found', 404);
    if (row.status !== 'qr' || !row.qr) return ok(res, { qr: null, status: row.status });
    ok(res, { qr: row.qr, status: row.status });
  })
);

router.get(
  '/:sessionId/history-sync',
  asyncHandler(async (req, res) => {
    const state = await getHistorySyncState(req.params.sessionId);
    ok(res, state || { is_syncing: false });
  })
);

// Soft stop - keeps credentials, can be resumed with POST /:sessionId again.
router.post(
  '/:sessionId/stop',
  asyncHandler(async (req, res) => {
    await stopSession(req.params.sessionId);
    ok(res, { stopped: true });
  })
);

// Hard logout - unlinks the WhatsApp device and wipes credentials. A new QR
// scan will be required to reconnect this sessionId afterwards.
router.post(
  '/:sessionId/logout',
  asyncHandler(async (req, res) => {
    await logoutSession(req.params.sessionId);
    ok(res, { loggedOut: true });
  })
);

export default router;
