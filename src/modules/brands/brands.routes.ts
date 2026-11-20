/**
 * Brand routes — API_DOCUMENTATION.md §4.4 (admin) and §3.3 (public `GET /brands`).
 * Admin router is mounted under `/api/v1/admin` after `authenticate('admin')` + `admin-read`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import { publicCache } from '../catalog-common/catalog.http.js';
import type { BrandsController } from './brands.controller.js';
import {
  BrandIdParams,
  BrandListQuery,
  CreateBrandBody,
  UpdateBrandBody,
} from './brands.schemas.js';

export function createBrandsAdminRouter(c: AppContainer, ctl: BrandsController): Router {
  const requirePermission = (...keys: string[]) => c.auth.requirePermission(...keys);
  const write = c.rateLimit('admin-write');
  const router = Router();
  router.get(
    '/brands',
    requirePermission('brands.view'),
    validate({ query: BrandListQuery }),
    ctl.list,
  );
  router.post(
    '/brands',
    requirePermission('brands.create'),
    write,
    validate({ body: CreateBrandBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get(
    '/brands/:brandId',
    requirePermission('brands.view'),
    validate({ params: BrandIdParams }),
    ctl.get,
  );
  router.patch(
    '/brands/:brandId',
    requirePermission('brands.update'),
    write,
    validate({ params: BrandIdParams, body: UpdateBrandBody }),
    ctl.update,
  );
  router.delete(
    '/brands/:brandId',
    requirePermission('brands.delete'),
    write,
    validate({ params: BrandIdParams }),
    ctl.remove,
  );
  // Added detail (OQ-39 "restore or rename"): restore reverses a soft delete → same permission.
  router.post(
    '/brands/:brandId/restore',
    requirePermission('brands.delete'),
    write,
    validate({ params: BrandIdParams }),
    ctl.restore,
  );
  return router;
}

export function createBrandsPublicRouter(c: AppContainer, ctl: BrandsController): Router {
  const router = Router();
  router.get('/brands', c.rateLimit('public-read'), publicCache, ctl.listPublic);
  return router;
}
