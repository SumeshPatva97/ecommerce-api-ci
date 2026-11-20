/**
 * Category routes — API_DOCUMENTATION.md §4.4 (admin) and §3.3 (public tree/detail).
 * Admin router is mounted under `/api/v1/admin` after `authenticate('admin')` + `admin-read`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import { publicCache } from '../catalog-common/catalog.http.js';
import type { CategoriesController } from './categories.controller.js';
import {
  CategoryIdParams,
  CategoryListQuery,
  CategorySlugParams,
  CreateCategoryBody,
  PublicCategoryTreeQuery,
  ReorderCategoriesBody,
  ReplaceCategoryAttributesBody,
  UpdateCategoryBody,
} from './categories.schemas.js';

export function createCategoriesAdminRouter(c: AppContainer, ctl: CategoriesController): Router {
  const requirePermission = (...keys: string[]) => c.auth.requirePermission(...keys);
  const write = c.rateLimit('admin-write');
  const router = Router();

  router.get(
    '/categories',
    requirePermission('categories.view'),
    validate({ query: CategoryListQuery }),
    ctl.list,
  );
  router.post(
    '/categories',
    requirePermission('categories.create'),
    write,
    validate({ body: CreateCategoryBody }),
    respondsWith(201),
    ctl.create,
  );
  // Added detail: sibling drag-reorder (ADMIN_WIREFRAMES categories tree; `categories.update`
  // "Edit categories, reorder"). Re-parenting uses PATCH `parentId`.
  router.post(
    '/categories/reorder',
    requirePermission('categories.update'),
    write,
    validate({ body: ReorderCategoriesBody }),
    ctl.reorder,
  );
  router.get(
    '/categories/:categoryId',
    requirePermission('categories.view'),
    validate({ params: CategoryIdParams }),
    ctl.get,
  );
  router.patch(
    '/categories/:categoryId',
    requirePermission('categories.update'),
    write,
    validate({ params: CategoryIdParams, body: UpdateCategoryBody }),
    ctl.update,
  );
  router.delete(
    '/categories/:categoryId',
    requirePermission('categories.delete'),
    write,
    validate({ params: CategoryIdParams }),
    ctl.remove,
  );
  // Added detail (OQ-39 "restore or rename"): restore reverses a soft delete → same permission.
  router.post(
    '/categories/:categoryId/restore',
    requirePermission('categories.delete'),
    write,
    validate({ params: CategoryIdParams }),
    ctl.restore,
  );
  router.get(
    '/categories/:categoryId/attributes',
    requirePermission('categories.view'),
    validate({ params: CategoryIdParams }),
    ctl.getAttributes,
  );
  router.put(
    '/categories/:categoryId/attributes',
    requirePermission('categories.update'),
    write,
    validate({ params: CategoryIdParams, body: ReplaceCategoryAttributesBody }),
    ctl.replaceAttributes,
  );
  return router;
}

export function createCategoriesPublicRouter(c: AppContainer, ctl: CategoriesController): Router {
  const router = Router();
  const read = c.rateLimit('public-read');
  router.get(
    '/categories',
    read,
    publicCache,
    validate({ query: PublicCategoryTreeQuery }),
    ctl.publicTree,
  );
  router.get(
    '/categories/:slug',
    read,
    publicCache,
    validate({ params: CategorySlugParams }),
    ctl.publicDetail,
  );
  return router;
}
