/**
 * Products module (B3) — admin products, variants (incl. generate preview/commit) and images.
 * Public listing/detail lives in the `catalog` module; signed uploads in `media`.
 */
import type { ModuleFactory } from '../types.js';
import { deliveryFromConfig } from '../media/cloudinary.js';
import { createImagesService } from './images.service.js';
import { createProductsController } from './products.controller.js';
import { createProductsRepository } from './products.repository.js';
import { createProductsAdminRouter } from './products.routes.js';
import { createProductsService } from './products.service.js';
import type { ProductsDeps } from './products.support.js';
import { createVariantsService } from './variants.service.js';

export const createProductsModule: ModuleFactory = (container) => {
  const media = container.config.integrations.media;
  const deps: ProductsDeps = {
    db: container.db,
    audit: container.audit,
    clock: container.clock,
    store: container.store,
    delivery: deliveryFromConfig(media),
    uploadFolder: media.uploadFolder,
    repo: createProductsRepository(),
  };
  const controller = createProductsController(
    createProductsService(deps),
    createVariantsService(deps),
    createImagesService(deps),
  );
  return { name: 'products', adminRouter: createProductsAdminRouter(container, controller) };
};

export { createProductsService, type ProductsService } from './products.service.js';
export { createProductsRepository, type ProductsRepository } from './products.repository.js';
