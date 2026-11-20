/**
 * Collections module (B2 catalog masters) — admin CRUD + membership, public list/detail.
 * Collection products are listed via `GET /products?collection=<slug>` (products module).
 */
import type { ModuleFactory } from '../types.js';
import { createCollectionsController } from './collections.controller.js';
import { createCollectionsRepository } from './collections.repository.js';
import {
  createCollectionsAdminRouter,
  createCollectionsPublicRouter,
} from './collections.routes.js';
import { createCollectionsService } from './collections.service.js';

export const createCollectionsModule: ModuleFactory = (container) => {
  const service = createCollectionsService(container, createCollectionsRepository());
  const controller = createCollectionsController(service);
  return {
    name: 'collections',
    adminRouter: createCollectionsAdminRouter(container, controller),
    publicRouter: createCollectionsPublicRouter(container, controller),
  };
};

export { createCollectionsService, type CollectionsService } from './collections.service.js';
