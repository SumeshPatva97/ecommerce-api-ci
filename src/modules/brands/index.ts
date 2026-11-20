/**
 * Brands module (B2 catalog masters) — admin CRUD + public `GET /brands`.
 */
import type { ModuleFactory } from '../types.js';
import { createBrandsController } from './brands.controller.js';
import { createBrandsRepository } from './brands.repository.js';
import { createBrandsAdminRouter, createBrandsPublicRouter } from './brands.routes.js';
import { createBrandsService } from './brands.service.js';

export const createBrandsModule: ModuleFactory = (container) => {
  const service = createBrandsService(container, createBrandsRepository());
  const controller = createBrandsController(service);
  return {
    name: 'brands',
    adminRouter: createBrandsAdminRouter(container, controller),
    publicRouter: createBrandsPublicRouter(container, controller),
  };
};

export { createBrandsService, type BrandsService } from './brands.service.js';
