/**
 * Media module (B3) — `POST /admin/media/upload-signature` (Cloudinary signed direct upload).
 * Route-level guard: anyOf every purpose permission (API_DOCUMENTATION.md §4.3); the service then
 * enforces the permission set of the requested `purpose`. Rate class `media-signature`.
 */
import { Router, type Request, type Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import type { ModuleFactory } from '../types.js';
import { UploadSignatureBody } from './media.schemas.js';
import { createMediaService, UPLOAD_SIGNATURE_PERMISSIONS } from './media.service.js';

export const createMediaModule: ModuleFactory = (container) => {
  const service = createMediaService(container);
  const adminRouter = Router();
  adminRouter.post(
    '/media/upload-signature',
    container.auth.requireAnyPermission(...UPLOAD_SIGNATURE_PERMISSIONS),
    container.rateLimit('media-signature'),
    validate({ body: UploadSignatureBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UploadSignatureBody);
      ok(req, res, await service.createUploadSignature(requireAuthz(req), body));
    },
  );
  return { name: 'media', adminRouter };
};

export { createMediaService, type MediaService } from './media.service.js';
