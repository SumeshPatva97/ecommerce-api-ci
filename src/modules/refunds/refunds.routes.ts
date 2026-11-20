/**
 * Admin refund routes (mounted at `/api/v1/admin`) — API_DOCUMENTATION.md §4.11, PROJECT_CONTEXT
 * §15 R-13 / R-15 / R-16 / R-18.
 *
 * | GET  /refunds                      | refunds.view                  | admin-read                 |
 * | GET  /refunds/:refundId            | refunds.view                  | admin-read                 |
 * | POST /refunds                      | refunds.create                | admin-write · Idempotency  |
 * | POST /refunds/:refundId/approve    | refunds.approve + re-auth     | admin-write · Idempotency  |
 * | POST /refunds/:refundId/reject     | refunds.approve               | admin-write                |
 * | POST /refunds/:refundId/retry      | refunds.update + re-auth      | admin-write · Idempotency  |
 * | POST /refunds/:refundId/complete   | refunds.update + re-auth      | admin-write · Idempotency  |
 *
 * Re-auth on retry follows R-15 ("refund approve/retry/complete"), which supersedes the
 * API_DOCUMENTATION table (no re-auth listed for retry).
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import {
  ApproveRefundBody,
  CompleteRefundBody,
  CreateRefundBody,
  RefundIdParams,
  RefundListQuery,
  RejectRefundBody,
  RetryRefundBody,
} from './refunds.schemas.js';
import type { RefundsService, StaffContext } from './refunds.service.js';

export function staffContext(req: Request): StaffContext {
  const authz = requireAuthz(req);
  return { actor: actorFromRequest(req), userId: authz.userId, isSuperadmin: authz.isSuperadmin };
}

export function createRefundsAdminRouter(c: AppContainer, service: RefundsService): Router {
  const router = Router();
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const idem = () => c.idempotency({ required: true });
  const refundId = (req: Request): string => getValidated(req, 'params', RefundIdParams).refundId;

  router.get(
    '/refunds',
    perm('refunds.view'),
    validate({ query: RefundListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', RefundListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/refunds/:refundId',
    perm('refunds.view'),
    validate({ params: RefundIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.get(refundId(req)));
    },
  );
  router.post(
    '/refunds',
    perm('refunds.create'),
    write,
    idem(),
    validate({ body: CreateRefundBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateRefundBody);
      ok(req, res, await service.create(staffContext(req), body), { status: 201 });
    },
  );
  router.post(
    '/refunds/:refundId/approve',
    perm('refunds.approve'),
    c.auth.requireReauth(),
    write,
    idem(),
    validate({ params: RefundIdParams, body: ApproveRefundBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', ApproveRefundBody);
      ok(req, res, await service.approve(staffContext(req), refundId(req), body));
    },
  );
  router.post(
    '/refunds/:refundId/reject',
    perm('refunds.approve'),
    write,
    validate({ params: RefundIdParams, body: RejectRefundBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { reason } = getValidated(req, 'body', RejectRefundBody);
      ok(req, res, await service.reject(staffContext(req), refundId(req), reason));
    },
  );
  router.post(
    '/refunds/:refundId/retry',
    perm('refunds.update'),
    c.auth.requireReauth(),
    write,
    idem(),
    validate({ params: RefundIdParams, body: RetryRefundBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { note } = getValidated(req, 'body', RetryRefundBody);
      ok(req, res, await service.retry(staffContext(req), refundId(req), note));
    },
  );
  router.post(
    '/refunds/:refundId/complete',
    perm('refunds.update'),
    c.auth.requireReauth(),
    write,
    idem(),
    validate({ params: RefundIdParams, body: CompleteRefundBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CompleteRefundBody);
      ok(req, res, await service.complete(staffContext(req), refundId(req), body));
    },
  );
  return router;
}
