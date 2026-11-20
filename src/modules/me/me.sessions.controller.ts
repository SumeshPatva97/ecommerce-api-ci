/**
 * `/me/sessions` controller — PROJECT_CONTEXT §15 R-13, API_DOCUMENTATION.md §3.2.
 * One session = one storefront refresh-token family; ownership enforced in the service (404).
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import { requestMeta } from '../auth/auth.http.js';
import type { SessionService } from '../auth/session.service.js';
import { SessionIdParams } from './me.profile.schemas.js';

const AUDIENCE = 'storefront';

export function createMeSessionsController(sessions: SessionService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      ok(req, res, await sessions.list(ctx.userId, AUDIENCE, ctx.sid));
    },

    revoke: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      const { sessionId } = getValidated(req, 'params', SessionIdParams);
      await sessions.revokeOwn(ctx.userId, AUDIENCE, sessionId, requestMeta(req, AUDIENCE));
      ok(req, res, { id: sessionId, deleted: true, current: sessionId === ctx.sid });
    },
  };
}
