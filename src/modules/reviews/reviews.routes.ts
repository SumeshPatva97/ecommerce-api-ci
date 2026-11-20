/**
 * Review routes — API_DOCUMENTATION.md §3.3, §3.7, §4.13.
 *
 * | POST   /products/:productId/reviews      | customer        | review-create |
 * | GET    /me/reviews                       | customer        | general       |
 * | GET    /products/:slug/reviews           | public          | public-read   |
 * | GET    /admin/reviews                    | reviews.view    | admin-read    |
 * | POST   /admin/reviews/:reviewId/approve  | reviews.approve | admin-write   |
 * | POST   /admin/reviews/:reviewId/reject   | reviews.approve | admin-write   |
 * | DELETE /admin/reviews/:reviewId          | reviews.delete  | admin-write   |
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { publicCache } from '../catalog-common/catalog.http.js';
import {
  AdminReviewsQuery,
  CreateReviewBody,
  MyReviewsQuery,
  ProductIdParams,
  ProductSlugParams,
  PublicReviewsQuery,
  RejectReviewBody,
  ReviewIdParams,
} from './reviews.schemas.js';
import type { ReviewsService } from './reviews.service.js';

export function createReviewsPublicRouter(c: AppContainer, service: ReviewsService): Router {
  const router = Router();
  const auth = c.auth.authenticate('storefront');
  router.post(
    '/products/:productId/reviews',
    auth,
    c.rateLimit('review-create'),
    validate({ params: ProductIdParams, body: CreateReviewBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const { productId } = getValidated(req, 'params', ProductIdParams);
      const body = getValidated(req, 'body', CreateReviewBody);
      ok(req, res, await service.create(requireAuthz(req).userId, productId, body), {
        status: 201,
      });
    },
  );
  router.get(
    '/me/reviews',
    auth,
    validate({ query: MyReviewsQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.listMine(
        requireAuthz(req).userId,
        getValidated(req, 'query', MyReviewsQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/products/:slug/reviews',
    c.rateLimit('public-read'),
    publicCache,
    validate({ params: ProductSlugParams, query: PublicReviewsQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { slug } = getValidated(req, 'params', ProductSlugParams);
      const { items, meta } = await service.listPublic(
        slug,
        getValidated(req, 'query', PublicReviewsQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  return router;
}

export function createReviewsAdminRouter(c: AppContainer, service: ReviewsService): Router {
  const router = Router();
  const write = c.rateLimit('admin-write');
  router.get(
    '/reviews',
    c.auth.requirePermission('reviews.view'),
    validate({ query: AdminReviewsQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.listAdmin(
        getValidated(req, 'query', AdminReviewsQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/reviews/:reviewId/approve',
    c.auth.requirePermission('reviews.approve'),
    write,
    validate({ params: ReviewIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      const { reviewId } = getValidated(req, 'params', ReviewIdParams);
      ok(req, res, await service.approve(actorFromRequest(req), reviewId));
    },
  );
  router.post(
    '/reviews/:reviewId/reject',
    c.auth.requirePermission('reviews.approve'),
    write,
    validate({ params: ReviewIdParams, body: RejectReviewBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { reviewId } = getValidated(req, 'params', ReviewIdParams);
      const body = getValidated(req, 'body', RejectReviewBody);
      ok(req, res, await service.reject(actorFromRequest(req), reviewId, body));
    },
  );
  router.delete(
    '/reviews/:reviewId',
    c.auth.requirePermission('reviews.delete'),
    write,
    validate({ params: ReviewIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      const { reviewId } = getValidated(req, 'params', ReviewIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), reviewId));
    },
  );
  return router;
}
