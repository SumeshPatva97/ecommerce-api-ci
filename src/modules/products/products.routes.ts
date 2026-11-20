/**
 * Admin product routes — API_DOCUMENTATION.md §4.3 / §7 (permission matrix). Mounted under
 * `/api/v1/admin` after `authenticate('admin')` + `admin-read`; mutations add `admin-write`.
 *
 * `products.delete` single deletes are not critical (only a bulk delete would be — no bulk route
 * is documented, so none is exposed).
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { ProductsController } from './products.controller.js';
import {
  AddImagesBody,
  AdminProductListQuery,
  AxisVariantBody,
  CheckDuplicateQuery,
  CreateProductBody,
  GenerateModeQuery,
  GenerateVariantsBody,
  ImageOrderBody,
  ImageParams,
  ProductIdParams,
  ProductStatusBody,
  UpdateImageBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantIdParams,
} from './products.schemas.js';

export function createProductsAdminRouter(c: AppContainer, ctl: ProductsController): Router {
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const router = Router();

  // Static paths first: `check-duplicate` must not be captured by `:productId`.
  router.get(
    '/products/check-duplicate',
    perm('products.view'),
    validate({ query: CheckDuplicateQuery }),
    ctl.checkDuplicate,
  );
  router.get(
    '/products',
    perm('products.view'),
    validate({ query: AdminProductListQuery }),
    ctl.list,
  );
  router.post(
    '/products',
    perm('products.create'),
    write,
    validate({ body: CreateProductBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get(
    '/products/:productId',
    perm('products.view'),
    validate({ params: ProductIdParams }),
    ctl.get,
  );
  router.patch(
    '/products/:productId',
    perm('products.update'),
    write,
    validate({ params: ProductIdParams, body: UpdateProductBody }),
    ctl.update,
  );
  router.delete(
    '/products/:productId',
    perm('products.delete'),
    write,
    validate({ params: ProductIdParams }),
    ctl.remove,
  );
  router.patch(
    '/products/:productId/status',
    perm('products.update'),
    write,
    validate({ params: ProductIdParams, body: ProductStatusBody }),
    ctl.changeStatus,
  );

  // Variants
  router.get(
    '/products/:productId/variants',
    perm('products.view'),
    validate({ params: ProductIdParams }),
    ctl.listVariants,
  );
  router.post(
    '/products/:productId/variants',
    perm('products.create'),
    write,
    validate({ params: ProductIdParams, body: AxisVariantBody }),
    respondsWith(201),
    ctl.addVariant,
  );
  router.post(
    '/products/:productId/variants/generate',
    perm('products.create'),
    write,
    validate({ params: ProductIdParams, query: GenerateModeQuery, body: GenerateVariantsBody }),
    respondsWith(200, 201),
    ctl.generateVariants,
  );
  router.patch(
    '/product-variants/:variantId',
    perm('products.update'),
    write,
    validate({ params: VariantIdParams, body: UpdateVariantBody }),
    ctl.updateVariant,
  );
  router.delete(
    '/product-variants/:variantId',
    perm('products.delete'),
    write,
    validate({ params: VariantIdParams }),
    ctl.removeVariant,
  );

  // Images (all `products.update`, API §4.3 table)
  router.post(
    '/products/:productId/images',
    perm('products.update'),
    write,
    validate({ params: ProductIdParams, body: AddImagesBody }),
    respondsWith(201),
    ctl.addImages,
  );
  router.put(
    '/products/:productId/images/order',
    perm('products.update'),
    write,
    validate({ params: ProductIdParams, body: ImageOrderBody }),
    ctl.reorderImages,
  );
  router.patch(
    '/products/:productId/images/:imageId',
    perm('products.update'),
    write,
    validate({ params: ImageParams, body: UpdateImageBody }),
    ctl.updateImage,
  );
  router.delete(
    '/products/:productId/images/:imageId',
    perm('products.update'),
    write,
    validate({ params: ImageParams }),
    ctl.removeImage,
  );
  return router;
}
