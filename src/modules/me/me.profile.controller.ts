/**
 * `/me` profile + change-password controller (API_DOCUMENTATION.md §3.2).
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import { requestMeta } from '../auth/auth.http.js';
import type { PasswordService } from '../auth/password.service.js';
import { ChangePasswordBody, UpdateMeBody } from './me.profile.schemas.js';
import type { MeProfileService } from './me.profile.service.js';

const AUDIENCE = 'storefront';

export function createMeProfileController(profile: MeProfileService, passwords: PasswordService) {
  return {
    get: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await profile.get(requireAuthz(req).userId));
    },

    update: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      const body = getValidated(req, 'body', UpdateMeBody);
      ok(req, res, await profile.update(ctx.userId, body, requestMeta(req, AUDIENCE)));
    },

    changePassword: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      const body = getValidated(req, 'body', ChangePasswordBody);
      await passwords.change({
        userId: ctx.userId,
        sid: ctx.sid,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        signOutOtherDevices: body.signOutOtherDevices,
        meta: requestMeta(req, AUDIENCE),
      });
      ok(req, res, { changed: true });
    },
  };
}
