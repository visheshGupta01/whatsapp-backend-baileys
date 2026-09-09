import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { requireActiveSocket } from '../services/sessionManager.js';
import {
  listGroups,
  createGroup,
  addParticipants,
  removeParticipants,
  promoteParticipants,
  demoteParticipants,
  updateGroupSubject,
  updateGroupDescription,
  updateGroupSettings,
  leaveGroup,
  getInviteCode,
  revokeInviteCode,
  joinGroupViaInvite,
  syncGroupMetadata,
} from '../services/groupService.js';
import { toJid } from '../utils/jid.js';

const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    ok(res, await listGroups(req.params.sessionId));
  })
);

router.get(
  '/:groupJid',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const meta = await syncGroupMetadata(sock, req.params.sessionId, toJid(req.params.groupJid));
    ok(res, meta);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { subject, participants } = req.body;
    if (!subject || !participants?.length) throw new ApiError('`subject` and `participants[]` are required');
    const meta = await createGroup(sock, req.params.sessionId, subject, participants);
    ok(res, meta, 201);
  })
);

router.post(
  '/:groupJid/participants',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { groupJid } = req.params;
    const { participants, action } = req.body; // action: add|remove|promote|demote
    if (!participants?.length || !action) throw new ApiError('`participants[]` and `action` are required');

    const fn = { add: addParticipants, remove: removeParticipants, promote: promoteParticipants, demote: demoteParticipants }[
      action
    ];
    if (!fn) throw new ApiError('`action` must be one of add|remove|promote|demote');

    const result = await fn(sock, req.params.sessionId, toJid(groupJid), participants);
    ok(res, result);
  })
);

router.patch(
  '/:groupJid/subject',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { subject } = req.body;
    if (!subject) throw new ApiError('`subject` is required');
    await updateGroupSubject(sock, req.params.sessionId, toJid(req.params.groupJid), subject);
    ok(res, { updated: true });
  })
);

router.patch(
  '/:groupJid/description',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { description } = req.body;
    await updateGroupDescription(sock, req.params.sessionId, toJid(req.params.groupJid), description || '');
    ok(res, { updated: true });
  })
);

router.patch(
  '/:groupJid/settings',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { setting } = req.body; // announcement|not_announcement|locked|unlocked
    if (!setting) throw new ApiError('`setting` is required');
    await updateGroupSettings(sock, req.params.sessionId, toJid(req.params.groupJid), setting);
    ok(res, { updated: true });
  })
);

router.post(
  '/:groupJid/leave',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    await leaveGroup(sock, req.params.sessionId, toJid(req.params.groupJid));
    ok(res, { left: true });
  })
);

router.get(
  '/:groupJid/invite-code',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const code = await getInviteCode(sock, toJid(req.params.groupJid));
    ok(res, { code, link: `https://chat.whatsapp.com/${code}` });
  })
);

router.post(
  '/:groupJid/invite-code/revoke',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const code = await revokeInviteCode(sock, req.params.sessionId, toJid(req.params.groupJid));
    ok(res, { code, link: `https://chat.whatsapp.com/${code}` });
  })
);

router.post(
  '/join',
  asyncHandler(async (req, res) => {
    const sock = requireActiveSocket(req.params.sessionId);
    const { code } = req.body;
    if (!code) throw new ApiError('`code` is required');
    const result = await joinGroupViaInvite(sock, code);
    ok(res, result);
  })
);

export default router;
