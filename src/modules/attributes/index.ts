/**
 * Attributes module (B2 catalog masters) — admin CRUD for attributes and their values.
 */
import type { ModuleFactory } from '../types.js';
import { createAttributesController } from './attributes.controller.js';
import { createAttributesRepository } from './attributes.repository.js';
import { createAttributesAdminRouter } from './attributes.routes.js';
import { createAttributesService } from './attributes.service.js';

export const createAttributesModule: ModuleFactory = (container) => {
  const service = createAttributesService(container, createAttributesRepository());
  return {
    name: 'attributes',
    adminRouter: createAttributesAdminRouter(container, createAttributesController(service)),
  };
};

export { createAttributesService, type AttributesService } from './attributes.service.js';
