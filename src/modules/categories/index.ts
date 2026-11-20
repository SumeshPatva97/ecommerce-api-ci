/**
 * Categories module (B2 catalog masters) — admin CRUD, tree moves, reorder, category-attribute
 * rules; public tree and category detail.
 */
import type { ModuleFactory } from '../types.js';
import { createCategoriesController } from './categories.controller.js';
import { createCategoriesRepository } from './categories.repository.js';
import { createCategoriesAdminRouter, createCategoriesPublicRouter } from './categories.routes.js';
import { createCategoriesService } from './categories.service.js';

export const createCategoriesModule: ModuleFactory = (container) => {
  const service = createCategoriesService(container, createCategoriesRepository());
  const controller = createCategoriesController(service);
  return {
    name: 'categories',
    adminRouter: createCategoriesAdminRouter(container, controller),
    publicRouter: createCategoriesPublicRouter(container, controller),
  };
};

export { createCategoriesService, type CategoriesService } from './categories.service.js';
