import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ok, ApiError } from '../utils/response.js';
import { getMediaById, readMediaStream } from '../services/mediaService.js';
import { env } from '../config/env.js';

const router = Router({ mergeParams: true });

const upload = multer({
  dest: path.join(env.mediaLocalPath, '_uploads'),
  limits: { fileSize: env.mediaMaxSizeMb * 1024 * 1024 },
});

// Stream a previously received/sent media file back to the client.
router.get(
  '/:mediaId',
  asyncHandler(async (req, res) => {
    const media = await getMediaById(req.params.sessionId, req.params.mediaId);
    if (!media) throw new ApiError('Media not found', 404);
    res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
    if (media.file_name) res.setHeader('Content-Disposition', `inline; filename="${media.file_name}"`);
    readMediaStream(media.storage_path).pipe(res);
  })
);

router.get(
  '/:mediaId/info',
  asyncHandler(async (req, res) => {
    const media = await getMediaById(req.params.sessionId, req.params.mediaId);
    if (!media) throw new ApiError('Media not found', 404);
    ok(res, media);
  })
);

// Upload a local file to use as the `source` for POST /messages/media
// (returns a base64 payload the frontend can pass straight through, or you
// can extend this to return a pre-signed path instead).
router.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError('`file` is required (multipart/form-data)');
    ok(res, { path: req.file.path, mimetype: req.file.mimetype, size: req.file.size, originalName: req.file.originalname });
  })
);

export default router;
