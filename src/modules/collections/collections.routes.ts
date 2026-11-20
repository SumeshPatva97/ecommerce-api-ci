/**
 * Collection routes — API_DOCUMENTATION.md §4.4 (admin) and §3.3 (public reads).
 * Admin router is mounted under `/api/v1/admin` after `authenticate('admin')` + `admin-read`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import { publicCache } from '../catalog-common/catalog.http.js';
import type { CollectionsController } from './collections.controller.js';
import {
  CollectionIdParams,
  CollectionListQuery,
  CollectionSlugParams,
  CreateCollectionBody,
  PublicCollectionListQuery,
  ReplaceCollectionProductsBody,
  UpdateCollectionBody,
} from './collections.schemas.js';

export function createCollectionsAdminRouter(c: AppContainer, ctl: CollectionsController): Router {
  const requirePermission = (...keys: string[]) => c.auth.requirePermission(...keys);
  const write = c.rateLimit('admin-write');
  const router = Router();
  router.get(
    '/collections',
    requirePermission('collections.view'),
    validate({ query: CollectionListQuery }),
    ctl.list,
  );
  router.post(
    '/collections',
    requirePermission('collections.create'),
    write,
    validate({ body: CreateCollectionBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get(
    '/collections/:collectionId',
    requirePermission('collections.view'),
    validate({ params: CollectionIdParams }),
    ctl.get,
  );
  router.patch(
    '/collections/:collectionId',
    requirePermission('collections.update'),
    write,
    validate({ params: CollectionIdParams, body: UpdateCollectionBody }),
    ctl.update,
  );
  router.delete(
    '/collections/:collectionId',
    requirePermission('collections.delete'),
    write,
    validate({ params: CollectionIdParams }),
    ctl.remove,
  );
  // Added detail (OQ-39 "restore or rename"): restore reverses a soft delete → same permission.
  router.post(
    '/collections/:collectionId/restore',
    requirePermission('collections.delete'),
    write,
    validate({ params: CollectionIdParams }),
    ctl.restore,
  );
  router.put(
    '/collections/:collectionId/products',
    requirePermission('collections.update'),
    write,
    validate({ params: CollectionIdParams, body: ReplaceCollectionProductsBody }),
    ctl.replaceProducts,
  );
  return router;
}

export function createCollectionsPublicRouter(c: AppContainer, ctl: CollectionsController): Router {
  const router = Router();
  const read = c.rateLimit('public-read');
  router.get(
    '/collections',
    read,
    publicCache,
    validate({ query: PublicCollectionListQuery }),
    ctl.listPublic,
  );
  router.get(
    '/collections/:slug',
    read,
    publicCache,
    validate({ params: CollectionSlugParams }),
    ctl.getPublic,
  );
  return router;
}
